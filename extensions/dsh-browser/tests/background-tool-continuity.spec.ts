// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { PAGE_SESSION_CONTEXT_STORAGE_KEY } from '../src/background/session-continuity.ts'

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
    removeListener: vi.fn((listener: (...args: T) => void) => { listeners.delete(listener) }),
    emit: (...args: T) => { for (const listener of listeners) listener(...args) },
  }
}

function panelPort() {
  const onMessage = chromeEvent<[unknown]>()
  const onDisconnect = chromeEvent<[]>()
  const port = { name: 'dsh-panel', postMessage: vi.fn(), onMessage, onDisconnect } as unknown as chrome.runtime.Port
  return { onDisconnect, onMessage, port }
}

function browserTab(url: string): chrome.tabs.Tab {
  return {
    id: 1,
    index: 0,
    pinned: false,
    highlighted: true,
    active: true,
    incognito: false,
    selected: true,
    discarded: false,
    autoDiscardable: true,
    groupId: -1,
    windowId: 1,
    title: 'Page',
    url,
  }
}

function storedUrlKey(sessionData: Record<string, unknown>): string | undefined {
  return (sessionData[PAGE_SESSION_CONTEXT_STORAGE_KEY] as {
    tabs?: Record<string, { urlKey?: string }>
  } | undefined)?.tabs?.[1]?.urlKey
}

afterEach(() => {
  vi.resetModules()
  vi.unstubAllGlobals()
  FakeWebSocket.instances = []
})

describe('tool-driven session checkpoints', () => {
  it('updates only after a successful navigation candidate', async () => {
    let currentTab = browserTab('https://example.com/start')
    let action: (name: string) => Promise<unknown> = async () => ({ ok: true, result: { text: 'snapshot' } })
    const onConnect = chromeEvent<[chrome.runtime.Port]>()
    const sessionData: Record<string, unknown> = {}
    const sendMessage = vi.fn(async (_tabId: number, message: unknown) => {
      const name = (message as { action?: string }).action
      return name === undefined ? undefined : await action(name)
    })
    vi.stubGlobal('chrome', {
      alarms: { create: vi.fn(), clear: vi.fn(async () => true), onAlarm: chromeEvent<[chrome.alarms.Alarm]>() },
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
      sidePanel: { open: vi.fn(async () => {}), setPanelBehavior: vi.fn(async () => {}) },
      storage: {
        local: {
          get: vi.fn(async () => ({
            dshSettings: {
              bridgeUrl: 'wss://bridge.example/ext/bridge',
              sharePageContent: 'auto',
              trustedActionOrigins: ['https://example.com'],
            },
          })),
          set: vi.fn(async () => {}),
        },
        session: {
          get: vi.fn(async (key: string) => ({ [key]: sessionData[key] })),
          set: vi.fn(async (items: Record<string, unknown>) => { Object.assign(sessionData, items) }),
          remove: vi.fn(async (key: string) => { delete sessionData[key] }),
        },
      },
      tabs: {
        get: vi.fn(async () => currentTab),
        query: vi.fn(async () => [currentTab]),
        sendMessage,
        onActivated: chromeEvent<[{ tabId: number; windowId: number }]>(),
        onUpdated: chromeEvent<[number, chrome.tabs.TabChangeInfo, chrome.tabs.Tab]>(),
        onReplaced: chromeEvent<[number, number]>(),
        onRemoved: chromeEvent<[number]>(),
      },
      scripting: { executeScript: vi.fn(async () => []) },
      webNavigation: {
        getAllFrames: vi.fn(async () => [{
          tabId: 1,
          frameId: 0,
          parentFrameId: -1,
          documentId: 'document-1',
          url: currentTab.url!,
        }]),
        onCommitted: chromeEvent<[{ tabId: number; frameId: number }]>(),
      },
      windows: {
        WINDOW_ID_NONE: -1,
        onFocusChanged: chromeEvent<[number]>(),
        onRemoved: chromeEvent<[number]>(),
      },
    } as unknown as typeof chrome)
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')

    const panel = panelPort()
    onConnect.emit(panel.port)
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    await vi.waitFor(() => { expect(socket.sent).toContainEqual(expect.objectContaining({ t: 'hello' })) })
    socket.receive({
      t: 'hello.ok',
      caps: { textOnly: true, snapshotMaxChars: 32_000, maxInteractiveItems: 60 },
    })
    panel.onMessage.emit({ type: 'session.active', sessionId: 'session-live', isNew: true })
    await vi.waitFor(() => { expect(storedUrlKey(sessionData)).toBe('https://example.com/start') })
    panel.onDisconnect.emit()

    const call = async (id: string, name: string): Promise<void> => {
      socket.receive({
        t: 'tool.call',
        id,
        name,
        args: name === 'browser_navigate' ? { url: 'https://example.com/target' } : {},
        expiresAt: Date.now() + 10_000,
        sessionId: 'session-live',
      })
      await vi.waitFor(() => {
        expect(socket.sent).toContainEqual(expect.objectContaining({ t: 'tool.result', id }))
      })
    }

    action = async (name) => {
      if (name === 'browser_navigate') {
        currentTab = browserTab('https://example.com/failed')
        return { ok: false, error: { code: 'action-failed', message: 'navigation failed' } }
      }
      return { ok: true, result: { text: 'snapshot' } }
    }
    await call('failed', 'browser_navigate')
    expect(storedUrlKey(sessionData)).toBe('https://example.com/start')

    action = async () => {
      currentTab = browserTab('https://example.com/non-navigation')
      return { ok: true, result: { text: 'snapshot' } }
    }
    await call('snapshot', 'browser_snapshot')
    expect(storedUrlKey(sessionData)).toBe('https://example.com/start')

    let finishCommitted!: () => void
    action = async () => await new Promise((resolve) => {
      finishCommitted = () => resolve({ ok: true, result: { text: 'navigated' } })
    })
    socket.receive({
      t: 'tool.call',
      id: 'committed',
      name: 'browser_navigate',
      args: { url: 'https://example.com/target' },
      expiresAt: Date.now() + 10_000,
      sessionId: 'session-live',
    })
    await vi.waitFor(() => { expect(finishCommitted).toBeTypeOf('function') })
    currentTab = browserTab('https://example.com/committed')
    socket.receive({ t: 'tool.cancel', id: 'committed' })
    finishCommitted()
    await vi.waitFor(() => {
      expect(socket.sent).toContainEqual(expect.objectContaining({ t: 'tool.result', id: 'committed', ok: true }))
    })
    await vi.waitFor(() => { expect(storedUrlKey(sessionData)).toBe('https://example.com/committed') })

    action = async () => {
      currentTab = browserTab('https://example.com/success?step=2#done')
      return { ok: true, result: { text: 'navigated' } }
    }
    await call('success', 'browser_navigate')
    await vi.waitFor(() => { expect(storedUrlKey(sessionData)).toBe('https://example.com/success') })
  })
})
