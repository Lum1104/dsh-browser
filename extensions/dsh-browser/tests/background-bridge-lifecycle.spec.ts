// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 3
  static instances: FakeWebSocket[] = []

  readyState = FakeWebSocket.CONNECTING

  constructor(readonly url: string) {
    super()
    FakeWebSocket.instances.push(this)
  }

  send(): void {}

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
  const port = {
    name: 'dsh-panel',
    postMessage: vi.fn(),
    onMessage,
    onDisconnect,
  } as unknown as chrome.runtime.Port
  return { onDisconnect, onMessage, port }
}

function mockChrome(options: {
  localSet?: (items: Record<string, unknown>) => Promise<void>
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
    action: {
      onClicked: chromeEvent<[chrome.tabs.Tab]>(),
    },
    notifications: {
      create: vi.fn(async () => ''),
      clear: vi.fn(async () => true),
      onClicked: chromeEvent<[string]>(),
    },
    runtime: {
      getURL: (path: string) => `chrome-extension://test/${path}`,
      onConnect,
    },
    sidePanel: {
      open: vi.fn(async () => {}),
      setPanelBehavior: vi.fn(async () => {}),
    },
    storage: {
      local: {
        get: vi.fn(async () => ({})),
        set: vi.fn(options.localSet ?? (async () => {})),
      },
      session: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => {}),
        remove: vi.fn(async () => {}),
      },
    },
    tabs: {
      get: vi.fn(async (tabId: number) => ({ id: tabId, windowId: 1, title: 'Tab', url: 'https://example.com/' })),
      query: vi.fn(async () => [{ id: 1, windowId: 1, title: 'Tab', url: 'https://example.com/' }]),
      sendMessage: vi.fn(async () => {}),
      onActivated: chromeEvent<[{ tabId: number; windowId: number }]>(),
      onUpdated: chromeEvent<[number, chrome.tabs.TabChangeInfo, chrome.tabs.Tab]>(),
      onReplaced: chromeEvent<[number, number]>(),
      onRemoved: chromeEvent<[number]>(),
    },
    windows: {
      WINDOW_ID_NONE: -1,
      onFocusChanged: chromeEvent<[number]>(),
      onRemoved: chromeEvent<[number]>(),
    },
  } as unknown as typeof chrome)
  return { alarms, onConnect }
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
})
