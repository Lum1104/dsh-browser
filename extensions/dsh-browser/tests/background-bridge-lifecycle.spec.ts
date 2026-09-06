// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 3
  static instances: FakeWebSocket[] = []

  readyState = FakeWebSocket.CONNECTING
  readonly sent: unknown[] = []

  constructor(readonly url: string) {
    super()
    FakeWebSocket.instances.push(this)
  }

  send(value: string): void {
    this.sent.push(JSON.parse(value))
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN
    this.dispatchEvent(new Event('open'))
  }

  receive(frame: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(frame) }))
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === FakeWebSocket.CLOSED) return
    this.readyState = FakeWebSocket.CLOSED
    this.dispatchEvent(new CloseEvent('close', { code, reason }))
  }
}

function chromeEvent<T extends unknown[]>() {
  const listeners = new Set<(...args: T) => void>()
  return {
    addListener: vi.fn((listener: (...args: T) => void) => { listeners.add(listener) }),
    emit: (...args: T) => { for (const listener of listeners) listener(...args) },
  }
}

function panelPort() {
  const onMessage = chromeEvent<[unknown]>()
  const onDisconnect = chromeEvent<[]>()
  const postMessage = vi.fn()
  const port = {
    name: 'dsh-panel',
    postMessage,
    onMessage,
    onDisconnect,
  } as unknown as chrome.runtime.Port
  return { onDisconnect, onMessage, port, postMessage }
}

function mockChrome(options: {
  localGet?: () => Promise<Record<string, unknown>>
  localSet?: (items: Record<string, unknown>) => Promise<void>
  tabGet?: (tabId: number) => Promise<chrome.tabs.Tab>
  tabQuery?: (queryInfo: chrome.tabs.QueryInfo) => Promise<chrome.tabs.Tab[]>
  tabRemove?: (tabId: number) => Promise<void>
  tabSendMessage?: (tabId: number, message: unknown) => Promise<unknown>
  executeScript?: () => Promise<unknown>
} = {}) {
  const onConnect = chromeEvent<[chrome.runtime.Port]>()
  const onAlarm = chromeEvent<[chrome.alarms.Alarm]>()
  const alarms = {
    create: vi.fn(),
    clear: vi.fn(async () => true),
    onAlarm,
  }
  vi.stubGlobal('chrome', {
    alarms,
    notifications: {
      create: vi.fn(async () => ''),
      clear: vi.fn(async () => true),
      onClicked: chromeEvent<[string]>(),
    },
    runtime: {
      id: 'test-extension',
      getURL: (path: string) => `chrome-extension://test/${path}`,
      onConnect,
      onMessage: chromeEvent<[unknown, chrome.runtime.MessageSender, (response: unknown) => void]>(),
    },
    sidePanel: {
      open: vi.fn(async () => {}),
      setPanelBehavior: vi.fn(async () => {}),
    },
    storage: {
      local: {
        get: vi.fn(options.localGet ?? (async () => ({}))),
        set: vi.fn(options.localSet ?? (async () => {})),
      },
      session: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => {}),
        remove: vi.fn(async () => {}),
      },
    },
    tabs: {
      get: vi.fn(options.tabGet ?? (async (tabId: number) => ({ id: tabId, windowId: 1, title: 'Tab', url: 'https://example.com/' } as chrome.tabs.Tab))),
      query: vi.fn(options.tabQuery ?? (async () => [{ id: 1, windowId: 1, title: 'Tab', url: 'https://example.com/' }] as chrome.tabs.Tab[])),
      remove: vi.fn(options.tabRemove ?? (async () => {})),
      sendMessage: vi.fn(options.tabSendMessage ?? (async () => {})),
      onActivated: chromeEvent<[{ tabId: number; windowId: number }]>(),
      onUpdated: chromeEvent<[number, chrome.tabs.TabChangeInfo, chrome.tabs.Tab]>(),
      onReplaced: chromeEvent<[number, number]>(),
      onRemoved: chromeEvent<[number]>(),
    },
    webNavigation: {
      getAllFrames: vi.fn(async () => [{
        tabId: 1,
        frameId: 0,
        parentFrameId: -1,
        documentId: 'document-1',
        url: 'https://example.com/',
      }]),
      onCommitted: chromeEvent<[{ tabId: number; frameId: number }]>(),
    },
    scripting: {
      executeScript: vi.fn(options.executeScript ?? (async () => [])),
    },
    windows: {
      WINDOW_ID_NONE: -1,
      onFocusChanged: chromeEvent<[number]>(),
      onRemoved: chromeEvent<[number]>(),
    },
  } as unknown as typeof chrome)
  return { alarms, onConnect, tabs: chrome.tabs }
}

afterEach(() => {
  vi.resetModules()
  vi.unstubAllGlobals()
  FakeWebSocket.instances = []
})

describe('background bridge lifecycle', () => {
  it('does not probe, connect, or arm keepalive just because the extension loads', async () => {
    const chromeMock = mockChrome()
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      wsUrl: 'ws://127.0.0.1:3080/ext/bridge',
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('WebSocket', FakeWebSocket)

    await import('../src/background/index.ts')
    await vi.waitFor(() => { expect(chrome.storage.local.get).toHaveBeenCalled() })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(FakeWebSocket.instances).toHaveLength(0)
    expect(chromeMock.alarms.create).not.toHaveBeenCalled()
    expect(chromeMock.alarms.clear).toHaveBeenCalledWith('bridge-keepalive')
  })

  it('abandons an in-flight discovery when the last panel closes', async () => {
    const chromeMock = mockChrome()
    let finishDiscovery!: (response: Response) => void
    const fetchMock = vi.fn(async () => await new Promise<Response>((resolve) => {
      finishDiscovery = resolve
    }))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')
    chromeMock.alarms.clear.mockClear()

    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    await vi.waitFor(() => { expect(fetchMock).toHaveBeenCalledOnce() })
    expect(chromeMock.alarms.create).toHaveBeenCalledWith('bridge-keepalive', { periodInMinutes: 0.5 })

    panel.onDisconnect.emit()
    finishDiscovery(new Response(null, { status: 503 }))
    await vi.waitFor(() => { expect(chromeMock.alarms.clear).toHaveBeenCalledWith('bridge-keepalive') })

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(FakeWebSocket.instances).toHaveLength(0)
  })

  it('does not let keepalive reclaim a bridge that replaced this client', async () => {
    const chromeMock = mockChrome()
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      wsUrl: 'ws://127.0.0.1:3080/ext/bridge',
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')

    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    await Promise.resolve()
    socket.receive({
      t: 'hello.ok',
      caps: { textOnly: true, snapshotMaxChars: 32_000, maxInteractiveItems: 60 },
    })
    await Promise.resolve()
    socket.close(4000, 'replaced')

    chromeMock.alarms.onAlarm.emit({ name: 'bridge-keepalive', scheduledTime: Date.now() })
    await new Promise((resolve) => { setTimeout(resolve, 0) })

    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('invalidates stale connection settings when their save outlives the panel', async () => {
    let finishSettingsWrite!: () => void
    const settingsWrite = new Promise<void>((resolve) => { finishSettingsWrite = resolve })
    const chromeMock = mockChrome({ localSet: async () => await settingsWrite })
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      wsUrl: 'ws://127.0.0.1:3080/ext/bridge',
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')

    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const originalSocket = FakeWebSocket.instances[0]!
    originalSocket.open()
    await Promise.resolve()
    originalSocket.receive({
      t: 'hello.ok',
      caps: { textOnly: true, snapshotMaxChars: 32_000, maxInteractiveItems: 60 },
    })
    await vi.waitFor(() => {
      expect(panel.port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ state: 'connected' }))
    })

    panel.onMessage.emit({
      type: 'settings',
      settings: { bridgeUrl: 'ws://127.0.0.1:3081', token: 'new-token' },
    })
    await vi.waitFor(() => { expect(chrome.storage.local.set).toHaveBeenCalledOnce() })
    panel.onDisconnect.emit()
    expect(originalSocket.readyState).toBe(FakeWebSocket.OPEN)

    finishSettingsWrite()
    await vi.waitFor(() => { expect(originalSocket.readyState).toBe(FakeWebSocket.CLOSED) })

    const reopened = panelPort()
    chromeMock.onConnect.emit(reopened.port)
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(2) })
    expect(FakeWebSocket.instances[1]!.url).toBe('ws://127.0.0.1:3081/ext/bridge')
  })

  it('acknowledges a policy setting only after persistence without restarting the bridge', async () => {
    let finishSettingsWrite!: () => void
    const settingsWrite = new Promise<void>((resolve) => { finishSettingsWrite = resolve })
    const chromeMock = mockChrome({
      localGet: async () => ({ dshSettings: { bridgeUrl: 'wss://bridge.example/ext/bridge' } }),
      localSet: async () => { await settingsWrite },
    })
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')

    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    await Promise.resolve()
    socket.receive({
      t: 'hello.ok',
      caps: { textOnly: true, snapshotMaxChars: 32_000, maxInteractiveItems: 60 },
    })

    panel.onMessage.emit({
      type: 'settings',
      id: 'settings-1',
      settings: { unrestrictedBrowserAccess: true },
    })
    await vi.waitFor(() => { expect(chrome.storage.local.set).toHaveBeenCalledOnce() })
    panel.onMessage.emit({
      type: 'settings',
      id: 'settings-2',
      settings: { approvalNotifications: false },
    })
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(chrome.storage.local.set).toHaveBeenCalledOnce()
    expect(panel.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'settings.result',
      id: 'settings-1',
    }))
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(socket.readyState).toBe(FakeWebSocket.OPEN)

    finishSettingsWrite()
    await vi.waitFor(() => {
      expect(panel.postMessage).toHaveBeenCalledWith({ type: 'settings.result', id: 'settings-1', ok: true })
      expect(panel.postMessage).toHaveBeenCalledWith({ type: 'settings.result', id: 'settings-2', ok: true })
    })
    expect(chrome.storage.local.set).toHaveBeenCalledTimes(2)
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(socket.readyState).toBe(FakeWebSocket.OPEN)
  })

  it('reports a settings persistence failure to the requesting panel', async () => {
    let settingsWrites = 0
    const chromeMock = mockChrome({
      localGet: async () => ({ dshSettings: { bridgeUrl: 'wss://bridge.example/ext/bridge' } }),
      localSet: async () => {
        settingsWrites += 1
        if (settingsWrites === 1) throw new Error('Storage is unavailable')
      },
    })
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')

    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    await Promise.resolve()
    socket.receive({
      t: 'hello.ok',
      caps: { textOnly: true, snapshotMaxChars: 32_000, maxInteractiveItems: 60 },
    })
    panel.onMessage.emit({
      type: 'settings',
      id: 'settings-failed',
      settings: { unrestrictedBrowserAccess: true },
    })

    await vi.waitFor(() => {
      expect(panel.postMessage).toHaveBeenCalledWith({
        type: 'settings.result',
        id: 'settings-failed',
        ok: false,
        error: { message: 'Storage is unavailable' },
      })
    })

    panel.onMessage.emit({
      type: 'settings',
      id: 'unrelated-setting-after-failure',
      settings: { approvalNotifications: false },
    })
    await vi.waitFor(() => {
      expect(panel.postMessage).toHaveBeenCalledWith({
        type: 'settings.result',
        id: 'unrelated-setting-after-failure',
        ok: true,
      })
    })

    socket.receive({
      t: 'tool.call',
      id: 'close-after-failed-enable',
      name: 'browser_close_tab',
      args: { tabId: 1 },
      expiresAt: Date.now() + 10_000,
    })
    await vi.waitFor(() => {
      expect(panel.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'approval.request' }))
    })
    expect(chromeMock.tabs.remove).not.toHaveBeenCalled()
  })

  it('disarms selection capture as soon as unrestricted access is disabled', async () => {
    let finishSettingsWrite!: () => void
    const settingsWrite = new Promise<void>((resolve) => { finishSettingsWrite = resolve })
    const chromeMock = mockChrome({
      localGet: async () => ({
        dshSettings: {
          bridgeUrl: 'wss://bridge.example/ext/bridge',
          unrestrictedBrowserAccess: true,
          sharePageContent: 'off',
        },
      }),
      localSet: async () => { await settingsWrite },
    })
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')

    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    panel.onMessage.emit({ type: 'panel.window', windowId: 1 })
    await vi.waitFor(() => {
      expect(chromeMock.tabs.sendMessage).toHaveBeenCalledWith(1, expect.objectContaining({
        type: 'DSH_SELECTION_WATCH',
        enabled: true,
      }))
    })
    vi.mocked(chromeMock.tabs.sendMessage).mockClear()

    panel.onMessage.emit({
      type: 'settings',
      id: 'disable-selection',
      settings: { unrestrictedBrowserAccess: false },
    })
    await vi.waitFor(() => {
      expect(chromeMock.tabs.sendMessage).toHaveBeenCalledWith(1, expect.objectContaining({
        type: 'DSH_SELECTION_WATCH',
        enabled: false,
      }))
    })
    expect(panel.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'settings.result',
      id: 'disable-selection',
    }))

    finishSettingsWrite()
    await vi.waitFor(() => {
      expect(panel.postMessage).toHaveBeenCalledWith({ type: 'settings.result', id: 'disable-selection', ok: true })
    })
  })

  it('cancels in-flight unrestricted calls before persisting revocation', async () => {
    let finishTabLookup!: (tab: chrome.tabs.Tab) => void
    const tabLookup = new Promise<chrome.tabs.Tab>((resolve) => { finishTabLookup = resolve })
    const chromeMock = mockChrome({
      localGet: async () => ({
        dshSettings: {
          bridgeUrl: 'wss://bridge.example/ext/bridge',
          unrestrictedBrowserAccess: true,
        },
      }),
      tabGet: async () => await tabLookup,
    })
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')

    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    await Promise.resolve()
    socket.receive({
      t: 'hello.ok',
      caps: { textOnly: true, snapshotMaxChars: 32_000, maxInteractiveItems: 60 },
    })
    await Promise.resolve()
    socket.receive({
      t: 'tool.call',
      id: 'close-in-flight',
      name: 'browser_close_tab',
      args: { tabId: 1 },
      expiresAt: Date.now() + 10_000,
    })
    await vi.waitFor(() => { expect(chromeMock.tabs.get).toHaveBeenCalledWith(1) })

    panel.onMessage.emit({
      type: 'settings',
      settings: { unrestrictedBrowserAccess: false },
    })
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(chrome.storage.local.set).not.toHaveBeenCalled()
    panel.onMessage.emit({
      type: 'settings',
      settings: { approvalNotifications: false },
    })
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(chrome.storage.local.set).not.toHaveBeenCalled()

    finishTabLookup({ id: 1, windowId: 1, title: 'Tab', url: 'https://example.com/' } as chrome.tabs.Tab)
    await vi.waitFor(() => {
      expect(socket.sent).toContainEqual({
        t: 'tool.result',
        id: 'close-in-flight',
        ok: false,
        error: { code: 'action-failed', message: 'Tool call was cancelled' },
      })
      expect(chrome.storage.local.set).toHaveBeenCalledWith(expect.objectContaining({
        dshSettings: expect.objectContaining({ unrestrictedBrowserAccess: false }),
      }))
    })
    await vi.waitFor(() => { expect(chrome.storage.local.set).toHaveBeenCalledTimes(2) })

    expect(chromeMock.tabs.remove).not.toHaveBeenCalled()
  })

  it('settles a committed unrestricted action before persisting revocation', async () => {
    const events: string[] = []
    let finishClose!: () => void
    const close = new Promise<void>((resolve) => { finishClose = resolve })
    const chromeMock = mockChrome({
      localGet: async () => ({
        dshSettings: {
          bridgeUrl: 'wss://bridge.example/ext/bridge',
          unrestrictedBrowserAccess: true,
        },
      }),
      localSet: async () => { events.push('saved') },
      tabRemove: async () => {
        await close
        events.push('closed')
      },
    })
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')

    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    await Promise.resolve()
    socket.receive({
      t: 'hello.ok',
      caps: { textOnly: true, snapshotMaxChars: 32_000, maxInteractiveItems: 60 },
    })
    await Promise.resolve()
    socket.receive({
      t: 'tool.call',
      id: 'close-committed',
      name: 'browser_close_tab',
      args: { tabId: 1 },
      expiresAt: Date.now() + 10_000,
    })
    await vi.waitFor(() => { expect(chromeMock.tabs.remove).toHaveBeenCalledWith(1) })

    panel.onMessage.emit({
      type: 'settings',
      settings: { unrestrictedBrowserAccess: false },
    })
    await Promise.resolve()
    expect(chrome.storage.local.set).not.toHaveBeenCalled()
    expect(socket.sent).not.toContainEqual(expect.objectContaining({
      t: 'tool.result',
      id: 'close-committed',
      ok: false,
    }))

    finishClose()
    await vi.waitFor(() => {
      expect(socket.sent).toContainEqual(expect.objectContaining({
        t: 'tool.result',
        id: 'close-committed',
        ok: true,
      }))
      expect(chrome.storage.local.set).toHaveBeenCalledWith(expect.objectContaining({
        dshSettings: expect.objectContaining({ unrestrictedBrowserAccess: false }),
      }))
    })
    expect(events).toEqual(['closed', 'saved'])
  })

  it('keeps a rapid re-enable restricted until revocation settles and persists toggles in order', async () => {
    let finishFirstClose!: () => void
    const firstClose = new Promise<void>((resolve) => { finishFirstClose = resolve })
    const persistedAccess: boolean[] = []
    const chromeMock = mockChrome({
      localGet: async () => ({
        dshSettings: {
          bridgeUrl: 'wss://bridge.example/ext/bridge',
          unrestrictedBrowserAccess: true,
        },
      }),
      localSet: async (items) => {
        persistedAccess.push((items.dshSettings as { unrestrictedBrowserAccess: boolean }).unrestrictedBrowserAccess)
      },
      tabGet: async (tabId) => ({ id: tabId, windowId: 1, title: `Tab ${tabId}`, url: `https://example.com/${tabId}` } as chrome.tabs.Tab),
      tabRemove: async (tabId) => {
        if (tabId === 1) await firstClose
      },
    })
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')

    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    await Promise.resolve()
    socket.receive({
      t: 'hello.ok',
      caps: { textOnly: true, snapshotMaxChars: 32_000, maxInteractiveItems: 60 },
    })
    await Promise.resolve()
    socket.receive({
      t: 'tool.call',
      id: 'close-before-toggle',
      name: 'browser_close_tab',
      args: { tabId: 1 },
      expiresAt: Date.now() + 10_000,
    })
    await vi.waitFor(() => { expect(chromeMock.tabs.remove).toHaveBeenCalledWith(1) })

    panel.onMessage.emit({ type: 'settings', id: 'disable-fast', settings: { unrestrictedBrowserAccess: false } })
    panel.onMessage.emit({ type: 'settings', id: 'enable-fast', settings: { unrestrictedBrowserAccess: true } })
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    socket.receive({
      t: 'tool.call',
      id: 'close-during-revocation',
      name: 'browser_close_tab',
      args: { tabId: 2 },
      expiresAt: Date.now() + 10_000,
    })

    const approval = await vi.waitFor(() => {
      const message = panel.postMessage.mock.calls
        .map((args: unknown[]) => args[0] as { type?: string; request?: { id?: string } })
        .find((value) => value.type === 'approval.request')
      expect(message?.request?.id).toBeTypeOf('string')
      return message!
    })
    expect(chromeMock.tabs.remove).not.toHaveBeenCalledWith(2)
    expect(chrome.storage.local.set).not.toHaveBeenCalled()

    finishFirstClose()
    await vi.waitFor(() => {
      expect(panel.postMessage).toHaveBeenCalledWith({ type: 'settings.result', id: 'disable-fast', ok: true })
      expect(panel.postMessage).toHaveBeenCalledWith({ type: 'settings.result', id: 'enable-fast', ok: true })
    })
    expect(persistedAccess).toEqual([false, true])
    expect(FakeWebSocket.instances).toHaveLength(1)

    panel.onMessage.emit({
      type: 'approval.response',
      id: approval.request!.id,
      decision: 'allow-once',
    })
    await vi.waitFor(() => { expect(chromeMock.tabs.remove).toHaveBeenCalledWith(2) })
  })

  it('waits for disconnected committed actions during revocation and drops their results', async () => {
    let finishClose!: () => void
    const close = new Promise<void>((resolve) => { finishClose = resolve })
    const chromeMock = mockChrome({
      localGet: async () => ({
        dshSettings: {
          bridgeUrl: 'wss://bridge.example/ext/bridge',
          unrestrictedBrowserAccess: true,
        },
      }),
      tabRemove: async () => { await close },
    })
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')

    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const originalSocket = FakeWebSocket.instances[0]!
    originalSocket.open()
    await Promise.resolve()
    originalSocket.receive({
      t: 'hello.ok',
      caps: { textOnly: true, snapshotMaxChars: 32_000, maxInteractiveItems: 60 },
    })
    await Promise.resolve()
    originalSocket.receive({
      t: 'tool.call',
      id: 'old-close',
      name: 'browser_close_tab',
      args: { tabId: 1 },
      expiresAt: Date.now() + 10_000,
    })
    await vi.waitFor(() => { expect(chromeMock.tabs.remove).toHaveBeenCalledWith(1) })

    panel.onMessage.emit({
      type: 'settings',
      settings: { bridgeUrl: 'wss://replacement.example/ext/bridge' },
    })
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(2) })
    const replacementSocket = FakeWebSocket.instances[1]!
    replacementSocket.open()
    await Promise.resolve()
    replacementSocket.receive({
      t: 'hello.ok',
      caps: { textOnly: true, snapshotMaxChars: 32_000, maxInteractiveItems: 60 },
    })
    await Promise.resolve()

    panel.onMessage.emit({
      type: 'settings',
      id: 'disable-after-reconnect',
      settings: { unrestrictedBrowserAccess: false },
    })
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    const savedBeforeClose = vi.mocked(chrome.storage.local.set).mock.calls.some(([items]) => (
      (items.dshSettings as { unrestrictedBrowserAccess?: boolean }).unrestrictedBrowserAccess === false
    ))
    finishClose()
    await vi.waitFor(() => {
      expect(panel.postMessage).toHaveBeenCalledWith({ type: 'settings.result', id: 'disable-after-reconnect', ok: true })
    })
    expect(savedBeforeClose).toBe(false)

    expect(originalSocket.sent).not.toContainEqual(expect.objectContaining({ t: 'tool.result', id: 'old-close' }))
    expect(replacementSocket.sent).not.toContainEqual(expect.objectContaining({ t: 'tool.result', id: 'old-close' }))
  })

  it('does not send a navigation result across a reconnect during its checkpoint', async () => {
    const tab = { id: 1, windowId: 1, title: 'New tab', url: 'chrome://newtab/' } as chrome.tabs.Tab
    let pauseCheckpoint = false
    let checkpointStarted = false
    let finishCheckpoint!: (tab: chrome.tabs.Tab) => void
    const checkpoint = new Promise<chrome.tabs.Tab>((resolve) => { finishCheckpoint = resolve })
    const chromeMock = mockChrome({
      localGet: async () => ({ dshSettings: {
        bridgeUrl: 'wss://bridge.example/ext/bridge',
        unrestrictedBrowserAccess: true,
      } }),
      tabQuery: async () => [tab],
      tabGet: async () => {
        if (!pauseCheckpoint) return tab
        checkpointStarted = true
        return checkpoint
      },
    })
    chrome.tabs.reload = vi.fn(async () => { pauseCheckpoint = true })
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')
    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const original = FakeWebSocket.instances[0]!
    original.open()
    await Promise.resolve()
    original.receive({ t: 'hello.ok', caps: { textOnly: true, snapshotMaxChars: 32_000, maxInteractiveItems: 60 } })
    await Promise.resolve()
    original.receive({
      t: 'tool.call', id: 'follow-before-reload', name: 'browser_follow_tab',
      sessionId: 'checkpoint-session', args: { tabId: 1 }, expiresAt: Date.now() + 10_000,
    })
    await vi.waitFor(() => {
      expect(original.sent).toContainEqual(expect.objectContaining({ t: 'tool.result', id: 'follow-before-reload', ok: true }))
    })
    original.receive({
      t: 'tool.call', id: 'old-reload', name: 'browser_reload',
      sessionId: 'checkpoint-session', args: {}, expiresAt: Date.now() + 10_000,
    })
    await vi.waitFor(() => { expect(checkpointStarted).toBe(true) })
    panel.onMessage.emit({ type: 'settings', settings: { bridgeUrl: 'wss://replacement.example/ext/bridge' } })
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(2) })
    const replacement = FakeWebSocket.instances[1]!
    replacement.open()
    await Promise.resolve()
    replacement.receive({ t: 'hello.ok', caps: { textOnly: true, snapshotMaxChars: 32_000, maxInteractiveItems: 60 } })
    await Promise.resolve()
    finishCheckpoint(tab)
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    for (const socket of [original, replacement]) {
      expect(socket.sent).not.toContainEqual(expect.objectContaining({ t: 'tool.result', id: 'old-reload' }))
    }
  })

  it('cancels unrestricted recovery after an undelivered action rolls back its commit', async () => {
    let finishInjection!: () => void
    const injection = new Promise<void>((resolve) => { finishInjection = resolve })
    const actionMessages: unknown[] = []
    const chromeMock = mockChrome({
      localGet: async () => ({
        dshSettings: {
          bridgeUrl: 'wss://bridge.example/ext/bridge',
          unrestrictedBrowserAccess: true,
        },
      }),
      tabSendMessage: async (_tabId, message) => {
        if ((message as { type?: unknown }).type !== 'DSH_ACTION') return undefined
        actionMessages.push(message)
        throw new Error('Could not establish connection. Receiving end does not exist.')
      },
      executeScript: async () => { await injection },
    })
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')

    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    await Promise.resolve()
    socket.receive({
      t: 'hello.ok',
      caps: { textOnly: true, snapshotMaxChars: 32_000, maxInteractiveItems: 60 },
    })
    await Promise.resolve()
    socket.receive({
      t: 'tool.call',
      id: 'recovering-action',
      name: 'browser_press',
      args: { key: 'Enter' },
      expiresAt: Date.now() + 10_000,
    })
    await vi.waitFor(() => { expect(chrome.scripting.executeScript).toHaveBeenCalledOnce() })

    panel.onMessage.emit({
      type: 'settings',
      settings: { unrestrictedBrowserAccess: false },
    })
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(chrome.storage.local.set).not.toHaveBeenCalled()

    finishInjection()
    await vi.waitFor(() => {
      expect(socket.sent).toContainEqual(expect.objectContaining({
        t: 'tool.result',
        id: 'recovering-action',
        ok: false,
      }))
      expect(chrome.storage.local.set).toHaveBeenCalledWith(expect.objectContaining({
        dshSettings: expect.objectContaining({ unrestrictedBrowserAccess: false }),
      }))
    })
    expect(actionMessages).toHaveLength(1)
  })

  it('keeps an already-started restricted call under approval across access toggles', async () => {
    let holdTarget = false
    let releaseTarget!: (tabs: chrome.tabs.Tab[]) => void
    const target = new Promise<chrome.tabs.Tab[]>((resolve) => { releaseTarget = resolve })
    const tab = { id: 1, windowId: 1, title: 'Tab', url: 'https://example.com/' } as chrome.tabs.Tab
    const chromeMock = mockChrome({
      localGet: async () => ({
        dshSettings: {
          bridgeUrl: 'wss://bridge.example/ext/bridge',
          unrestrictedBrowserAccess: false,
          sharePageContent: 'auto',
        },
      }),
      tabQuery: async (queryInfo) => holdTarget && queryInfo.active === true ? await target : [tab],
      tabSendMessage: async (_tabId, message) => (message as { type?: unknown }).type === 'DSH_ACTION'
        ? { ok: true, result: { text: 'Pressed Enter.' } }
        : undefined,
    })
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')

    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    await Promise.resolve()
    socket.receive({
      t: 'hello.ok',
      caps: { textOnly: true, snapshotMaxChars: 32_000, maxInteractiveItems: 60 },
    })
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    holdTarget = true
    socket.receive({
      t: 'tool.call',
      id: 'restricted-across-toggle',
      name: 'browser_press',
      args: { key: 'Enter' },
      expiresAt: Date.now() + 10_000,
    })
    await vi.waitFor(() => {
      expect(chromeMock.tabs.query).toHaveBeenCalledWith({ active: true, lastFocusedWindow: true })
    })

    panel.onMessage.emit({ type: 'settings', settings: { unrestrictedBrowserAccess: true } })
    await vi.waitFor(() => { expect(chrome.storage.local.set).toHaveBeenCalledOnce() })
    releaseTarget([tab])
    const approval = await vi.waitFor(() => {
      const message = panel.postMessage.mock.calls
        .map((args: unknown[]) => args[0] as { type?: string; request?: { id?: string } })
        .find((value) => value.type === 'approval.request')
      expect(message?.request?.id).toBeTypeOf('string')
      return message!
    })

    panel.onMessage.emit({ type: 'settings', settings: { unrestrictedBrowserAccess: false } })
    await vi.waitFor(() => { expect(chrome.storage.local.set).toHaveBeenCalledTimes(2) })
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(socket.sent).not.toContainEqual(expect.objectContaining({
      t: 'tool.result',
      id: 'restricted-across-toggle',
    }))

    panel.onMessage.emit({
      type: 'approval.response',
      id: approval.request!.id,
      decision: 'allow-once',
    })
    await vi.waitFor(() => {
      expect(socket.sent).toContainEqual(expect.objectContaining({
        t: 'tool.result',
        id: 'restricted-across-toggle',
        ok: true,
      }))
    })
  })

  it('waits for and suppresses an unrestricted automatic snapshot during revocation', async () => {
    let finishSnapshot!: (answer: unknown) => void
    const snapshot = new Promise<unknown>((resolve) => { finishSnapshot = resolve })
    const chromeMock = mockChrome({
      localGet: async () => ({
        dshSettings: {
          bridgeUrl: 'wss://bridge.example/ext/bridge',
          unrestrictedBrowserAccess: true,
          sharePageContent: 'off',
        },
      }),
      tabSendMessage: async (_tabId, message) => (message as { type?: unknown }).type === 'DSH_ACTION'
        ? await snapshot
        : undefined,
    })
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')

    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    await Promise.resolve()
    socket.receive({
      t: 'hello.ok',
      caps: { textOnly: true, snapshotMaxChars: 32_000, maxInteractiveItems: 60 },
    })
    await Promise.resolve()
    panel.onMessage.emit({ type: 'session.active', sessionId: 'session-refresh', isNew: true })
    await vi.waitFor(() => {
      expect(chromeMock.tabs.sendMessage).toHaveBeenCalledWith(1, expect.objectContaining({
        type: 'DSH_ACTION',
        action: 'browser_snapshot',
      }), expect.any(Object))
    })

    panel.onMessage.emit({
      type: 'settings',
      id: 'disable-refresh',
      settings: { unrestrictedBrowserAccess: false },
    })
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(chrome.storage.local.set).not.toHaveBeenCalled()

    finishSnapshot({ ok: true, result: { text: 'private page snapshot' } })
    await vi.waitFor(() => {
      expect(panel.postMessage).toHaveBeenCalledWith({ type: 'settings.result', id: 'disable-refresh', ok: true })
    })
    expect(socket.sent).not.toContainEqual(expect.objectContaining({
      t: 'rpc',
      method: 'bridge.injectBrowserSnapshot',
    }))
  })
})
