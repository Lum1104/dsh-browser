// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'

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

function tab(tabId: number): chrome.tabs.Tab {
  return {
    id: tabId,
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
    title: `Tab ${tabId}`,
    url: `https://example.com/${tabId}`,
  }
}

function mockChrome() {
  const onConnect = chromeEvent<[chrome.runtime.Port]>()
  const query = vi.fn(async () => [tab(1)])
  vi.stubGlobal('chrome', {
    alarms: {
      create: vi.fn(),
      clear: vi.fn(async () => true),
      onAlarm: chromeEvent<[chrome.alarms.Alarm]>(),
    },
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
        set: vi.fn(async () => {}),
      },
      session: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => {}),
        remove: vi.fn(async () => {}),
      },
    },
    tabs: {
      get: vi.fn(async (tabId: number) => tab(tabId)),
      query,
      sendMessage: vi.fn(async () => {}),
      onActivated: chromeEvent<[{ tabId: number; windowId: number }]>(),
      onUpdated: chromeEvent<[number, chrome.tabs.TabChangeInfo, chrome.tabs.Tab]>(),
      onReplaced: chromeEvent<[number, number]>(),
      onRemoved: chromeEvent<[number]>(),
    },
    windows: {
      WINDOW_ID_NONE: -1,
      onFocusChanged: chromeEvent<[number]>(),
    },
  } as unknown as typeof chrome)
  return { onConnect, query }
}

async function connectPanelForTest() {
  const chromeMock = mockChrome()
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })))
  await import('../src/background/index.ts')
  await vi.waitFor(() => { expect(chromeMock.query).toHaveBeenCalled() })

  const panel = panelPort()
  chromeMock.onConnect.emit(panel.port)
  await vi.waitFor(() => {
    expect(panel.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'tab-affinity' }))
  })
  panel.postMessage.mockClear()
  return { ...chromeMock, ...panel }
}

afterEach(() => {
  vi.useRealTimers()
  vi.resetModules()
  vi.unstubAllGlobals()
})

describe('background tab-affinity rebind protocol', () => {
  it('acknowledges only after control has moved to the freshly queried active tab', async () => {
    const { onMessage, postMessage, query } = await connectPanelForTest()
    query.mockResolvedValue([tab(2)])

    onMessage.emit({ type: 'tab-affinity.rebind', id: 'rebind-1' })

    await vi.waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith({ type: 'tab-affinity.rebind.result', id: 'rebind-1', ok: true })
    })
    const messages = postMessage.mock.calls.map(([message]) => message as { type?: string; state?: unknown })
    const resultIndex = messages.findIndex((message) => message.type === 'tab-affinity.rebind.result')
    const affinityIndex = messages.map((message) => message.type).lastIndexOf('tab-affinity', resultIndex)
    expect(affinityIndex).toBeGreaterThanOrEqual(0)
    expect(resultIndex).toBeGreaterThan(affinityIndex)
    expect(messages[affinityIndex]?.state).toMatchObject({
      status: 'following',
      controlled: { tabId: 2 },
      active: { tabId: 2 },
    })
  })

  it('reports an active-tab query failure and leaves the existing binding unchanged', async () => {
    const { onMessage, postMessage, query } = await connectPanelForTest()
    onMessage.emit({ type: 'tab-affinity.rebind', id: 'initial-bind' })
    await vi.waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith({ type: 'tab-affinity.rebind.result', id: 'initial-bind', ok: true })
    })
    postMessage.mockClear()
    query.mockRejectedValue(new Error('query failed'))

    onMessage.emit({ type: 'tab-affinity.rebind', id: 'failed-rebind' })

    await vi.waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
        type: 'tab-affinity.rebind.result',
        id: 'failed-rebind',
        ok: false,
        error: expect.objectContaining({ code: 'no-active-tab' }),
      }))
    })
    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'tab-affinity' }))

    onMessage.emit({ type: 'request-status' })
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'tab-affinity',
      state: expect.objectContaining({ status: 'following', controlled: expect.objectContaining({ tabId: 1 }) }),
    }))
  })

  it('owns the deadline in the background and ignores a query that resolves after timeout', async () => {
    const { onMessage, postMessage, query } = await connectPanelForTest()
    onMessage.emit({ type: 'tab-affinity.rebind', id: 'initial-bind' })
    await vi.waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith({ type: 'tab-affinity.rebind.result', id: 'initial-bind', ok: true })
    })
    postMessage.mockClear()

    let finishQuery!: (tabs: chrome.tabs.Tab[]) => void
    query.mockImplementationOnce(async () => await new Promise<chrome.tabs.Tab[]>((resolve) => {
      finishQuery = resolve
    }))
    vi.useFakeTimers()
    onMessage.emit({ type: 'tab-affinity.rebind', id: 'slow-rebind' })
    await vi.advanceTimersByTimeAsync(10_000)

    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'tab-affinity.rebind.result',
      id: 'slow-rebind',
      ok: false,
      error: expect.objectContaining({ code: 'timeout' }),
    }))
    postMessage.mockClear()

    finishQuery([tab(2)])
    await Promise.resolve()
    await Promise.resolve()
    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'tab-affinity' }))

    onMessage.emit({ type: 'request-status' })
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'tab-affinity',
      state: expect.objectContaining({ status: 'following', controlled: expect.objectContaining({ tabId: 1 }) }),
    }))
  })

  it('cancels an in-flight rebind when its panel disconnects', async () => {
    const { onDisconnect, onMessage, postMessage, query } = await connectPanelForTest()
    onMessage.emit({ type: 'tab-affinity.rebind', id: 'initial-bind' })
    await vi.waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith({ type: 'tab-affinity.rebind.result', id: 'initial-bind', ok: true })
    })
    postMessage.mockClear()

    let finishQuery!: (tabs: chrome.tabs.Tab[]) => void
    query.mockImplementationOnce(async () => await new Promise<chrome.tabs.Tab[]>((resolve) => {
      finishQuery = resolve
    }))
    onMessage.emit({ type: 'tab-affinity.rebind', id: 'disconnected-rebind' })
    await vi.waitFor(() => { expect(query).toHaveBeenCalledTimes(4) })
    onDisconnect.emit()
    finishQuery([tab(2)])
    await Promise.resolve()
    await Promise.resolve()

    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'tab-affinity' }))
    onMessage.emit({ type: 'request-status' })
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'tab-affinity',
      state: expect.objectContaining({ status: 'following', controlled: expect.objectContaining({ tabId: 1 }) }),
    }))
  })
})
