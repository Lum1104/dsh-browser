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

function mockChrome(options: {
  sidePanel?: boolean
  session?: Record<string, unknown>
  deferBrowserWindowRead?: boolean
} = {}) {
  const sessionData: Record<string, unknown> = { ...options.session }
  let releaseBrowserWindowRead: () => void = () => {}
  const browserWindowRead = options.deferBrowserWindowRead === true
    ? new Promise<void>((resolve) => { releaseBrowserWindowRead = resolve })
    : Promise.resolve()
  const onConnect = chromeEvent<[chrome.runtime.Port]>()
  const onFocusChanged = chromeEvent<[number]>()
  const onActivated = chromeEvent<[{ tabId: number; windowId: number }]>()
  const onWindowRemoved = chromeEvent<[number]>()
  const onActionClicked = chromeEvent<[chrome.tabs.Tab]>()
  const query = vi.fn(async (_info: chrome.tabs.QueryInfo) => [tab(1)])
  // Browsers with no Side Panel API host the panel in a window of its own.
  let resolveCreate: (value: { id: number }) => void = () => {}
  const createWindow = vi.fn(() => new Promise<{ id: number }>((resolve) => { resolveCreate = resolve }))
  vi.stubGlobal('chrome', {
    alarms: {
      create: vi.fn(),
      clear: vi.fn(async () => true),
      onAlarm: chromeEvent<[chrome.alarms.Alarm]>(),
    },
    action: {
      onClicked: onActionClicked,
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
    ...(options.sidePanel === false ? {} : {
      sidePanel: {
        open: vi.fn(async () => {}),
        setPanelBehavior: vi.fn(async () => {}),
      },
    }),
    storage: {
      local: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => {}),
      },
      session: {
        // A real read snapshots when it is issued, so capture the value now and
        // deliver it later; reading after the wait would see writes that
        // happened in between and hide exactly the staleness under test.
        get: vi.fn((key: string) => {
          const snapshot = key in sessionData ? { [key]: sessionData[key] } : {}
          return key === 'dshBrowserWindow'
            ? browserWindowRead.then(() => snapshot)
            : Promise.resolve(snapshot)
        }),
        set: vi.fn(async (items: Record<string, unknown>) => { Object.assign(sessionData, items) }),
        remove: vi.fn(async (key: string) => { delete sessionData[key] }),
      },
    },
    tabs: {
      get: vi.fn(async (tabId: number) => tab(tabId)),
      query,
      sendMessage: vi.fn(async () => {}),
      onActivated,
      onUpdated: chromeEvent<[number, chrome.tabs.TabChangeInfo, chrome.tabs.Tab]>(),
      onReplaced: chromeEvent<[number, number]>(),
      onRemoved: chromeEvent<[number]>(),
    },
    windows: {
      WINDOW_ID_NONE: -1,
      onFocusChanged,
      onRemoved: onWindowRemoved,
      create: createWindow,
      update: vi.fn(async () => ({})),
    },
  } as unknown as typeof chrome)
  return {
    releaseBrowserWindowRead: () => { releaseBrowserWindowRead() },
    sessionData,
    createWindow,
    onActionClicked,
    onActivated,
    onConnect,
    onFocusChanged,
    onWindowRemoved,
    query,
    resolveCreate: (id: number) => { resolveCreate({ id }) },
  }
}

async function connectPanelForTest() {
  const chromeMock = mockChrome()
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })))
  await import('../src/background/index.ts')
  await vi.waitFor(() => { expect(chromeMock.query).toHaveBeenCalled() })

  onFocusChanged = chromeMock.onFocusChanged
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

let onFocusChanged: ReturnType<typeof chromeEvent<[number]>>

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

  it('never binds browser control to the panel document itself', async () => {
    // Browsers with no side-panel API host the panel in a window of its own,
    // whose tab is the active tab while the user types in it. Content scripts
    // never match chrome-extension://, so binding here breaks every tool.
    const { onMessage, postMessage, query } = await connectPanelForTest()
    onMessage.emit({ type: 'tab-affinity.rebind', id: 'initial-bind' })
    await vi.waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith({ type: 'tab-affinity.rebind.result', id: 'initial-bind', ok: true })
    })
    postMessage.mockClear()

    query.mockResolvedValue([{
      ...tab(99),
      windowId: 9,
      title: 'dsh Browser Assistant',
      url: 'chrome-extension://test/panel/index.html',
    }])
    onMessage.emit({ type: 'tab-affinity.rebind', id: 'panel-rebind' })

    await vi.waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
        type: 'tab-affinity.rebind.result',
        id: 'panel-rebind',
        ok: false,
        error: expect.objectContaining({ code: 'no-active-tab' }),
      }))
    })

    onMessage.emit({ type: 'request-status' })
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'tab-affinity',
      state: expect.objectContaining({
        status: 'following',
        controlled: expect.objectContaining({ tabId: 1 }),
      }),
    }))
  })

  it('does not treat focusing the panel window as a tab switch', async () => {
    const { onMessage, postMessage, query } = await connectPanelForTest()
    onMessage.emit({ type: 'tab-affinity.rebind', id: 'initial-bind' })
    await vi.waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith({ type: 'tab-affinity.rebind.result', id: 'initial-bind', ok: true })
    })
    postMessage.mockClear()
    query.mockClear()

    // A focus event carrying the panel's own document must not enter handoff.
    query.mockResolvedValue([{
      ...tab(99),
      windowId: 9,
      title: 'dsh Browser Assistant',
      url: 'chrome-extension://test/panel/index.html',
    }])
    onFocusChanged.emit(9)
    await vi.waitFor(() => { expect(query).toHaveBeenCalled() })

    onMessage.emit({ type: 'request-status' })
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'tab-affinity',
      state: expect.objectContaining({
        status: 'following',
        controlled: expect.objectContaining({ tabId: 1 }),
      }),
    }))
  })

  it('ignores the popup activation that arrives before windows.create resolves', async () => {
    // The browser focuses and activates the new panel window before create()
    // resolves, so its id is still unknown. Marking it focused there would let
    // tabs.onActivated mark a switch — it has no URL yet to reject — handing
    // control to the extension page and cancelling pending approvals.
    const chromeMock = mockChrome({ sidePanel: false })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })))
    await import('../src/background/index.ts')
    await vi.waitFor(() => { expect(chromeMock.query).toHaveBeenCalled() })

    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    await vi.waitFor(() => {
      expect(panel.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'tab-affinity' }))
    })
    panel.onMessage.emit({ type: 'tab-affinity.rebind', id: 'initial-bind' })
    await vi.waitFor(() => {
      expect(panel.postMessage).toHaveBeenCalledWith({
        type: 'tab-affinity.rebind.result', id: 'initial-bind', ok: true,
      })
    })
    panel.postMessage.mockClear()

    // Toolbar click opens the fallback window; create() stays pending.
    chromeMock.onActionClicked.emit(tab(1))
    await vi.waitFor(() => { expect(chromeMock.createWindow).toHaveBeenCalled() })

    // The popup takes focus and activates its own tab, both before create()
    // resolves and therefore before the window has an id to be matched by.
    chromeMock.onFocusChanged.emit(9)
    chromeMock.onActivated.emit({ tabId: 99, windowId: 9 })
    chromeMock.resolveCreate(9)
    await vi.waitFor(() => { expect(chromeMock.createWindow).toHaveBeenCalledOnce() })

    panel.onMessage.emit({ type: 'request-status' })
    expect(panel.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'tab-affinity',
      state: expect.objectContaining({
        status: 'following',
        controlled: expect.objectContaining({ tabId: 1 }),
      }),
    }))
  })

  /** Bind to window 1, then open the fallback popup on top of it. */
  async function bindThenOpenPopup() {
    const chromeMock = mockChrome({ sidePanel: false })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })))
    await import('../src/background/index.ts')
    await vi.waitFor(() => { expect(chromeMock.query).toHaveBeenCalled() })

    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    await vi.waitFor(() => {
      expect(panel.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'tab-affinity' }))
    })

    chromeMock.onFocusChanged.emit(1)
    await vi.waitFor(() => {
      expect(chromeMock.query).toHaveBeenCalledWith(expect.objectContaining({ windowId: 1 }))
    })
    chromeMock.onActionClicked.emit(tab(1))
    await vi.waitFor(() => { expect(chromeMock.createWindow).toHaveBeenCalled() })
    chromeMock.resolveCreate(9)
    return { ...chromeMock, panel }
  }

  it('stops targeting a browser window that has closed', async () => {
    // The popup keeps focus after the originating window closes, and its own
    // focus events are ignored, so nothing else would refresh the stale id.
    const { onWindowRemoved, panel, query } = await bindThenOpenPopup()

    onWindowRemoved.emit(1)
    query.mockClear()

    panel.onMessage.emit({ type: 'tab-affinity.rebind', id: 'after-close' })
    await vi.waitFor(() => { expect(query).toHaveBeenCalled() })

    const targeted = query.mock.calls.map(([info]) => info as chrome.tabs.QueryInfo)
    expect(targeted.some((info) => info.windowId === 1)).toBe(false)
  })

  it('recovers through another window when the remembered one answers nothing', async () => {
    const { panel, query } = await bindThenOpenPopup()
    panel.postMessage.mockClear()

    // Window 1 no longer has an active tab; only a normal-window query finds one.
    const survivor = { ...tab(2), windowId: 2 }
    query.mockImplementation(async (info: chrome.tabs.QueryInfo) => (
      info.windowType === 'normal' ? [survivor] : []
    ))

    panel.onMessage.emit({ type: 'tab-affinity.rebind', id: 'widen' })
    await vi.waitFor(() => {
      expect(panel.postMessage).toHaveBeenCalledWith({
        type: 'tab-affinity.rebind.result', id: 'widen', ok: true,
      })
    })
    expect(panel.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'tab-affinity',
      state: expect.objectContaining({ controlled: expect.objectContaining({ tabId: 2 }) }),
    }))
  })

  it('remembers the originating window across a service-worker restart', async () => {
    // The popup survives an MV3 restart and still answers as lastFocusedWindow,
    // so without the stored id every no-argument sync would have to guess.
    const chromeMock = mockChrome({
      sidePanel: false,
      session: { dshPanelWindow: 9, dshBrowserWindow: 1 },
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })))
    await import('../src/background/index.ts')

    await vi.waitFor(() => {
      expect(chromeMock.query).toHaveBeenCalledWith(expect.objectContaining({ windowId: 1 }))
    })
  })

  it('refuses to guess between several browser windows', async () => {
    // windowType: 'normal' answers for every window at once. Picking one would
    // move browser control silently, so an ambiguous answer binds nothing.
    const chromeMock = mockChrome({ sidePanel: false })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })))
    await import('../src/background/index.ts')
    await vi.waitFor(() => { expect(chromeMock.query).toHaveBeenCalled() })

    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    await vi.waitFor(() => {
      expect(panel.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'tab-affinity' }))
    })
    panel.postMessage.mockClear()

    chromeMock.query.mockImplementation(async (info: chrome.tabs.QueryInfo) => (
      info.windowType === 'normal' ? [{ ...tab(2), windowId: 2 }, { ...tab(3), windowId: 3 }] : []
    ))

    panel.onMessage.emit({ type: 'tab-affinity.rebind', id: 'ambiguous' })
    await vi.waitFor(() => {
      expect(panel.postMessage).toHaveBeenCalledWith(expect.objectContaining({
        type: 'tab-affinity.rebind.result',
        id: 'ambiguous',
        ok: false,
        error: expect.objectContaining({ code: 'no-active-tab' }),
      }))
    })
  })

  it('keeps the clicked window when a stored one arrives late', async () => {
    // A toolbar click can cold-start the worker: the click names its own window
    // while the restore read is still in flight, and is newer than the store.
    const chromeMock = mockChrome({
      sidePanel: false,
      // No stored panel window, so the click opens one and hasPanelWindow()
      // becomes true the same way it would in a real fallback session.
      session: { dshBrowserWindow: 1 },
      deferBrowserWindowRead: true,
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })))
    // Model the real situation: the popup holds focus, so an unfiltered
    // last-focused query answers with the panel document, and two normal
    // windows make the widened query ambiguous. Only the remembered window id
    // can name a page here — which is exactly what the stale read would break.
    const panelTab = { ...tab(99), windowId: 9, url: 'chrome-extension://test/panel/index.html' }
    chromeMock.query.mockImplementation(async (info: chrome.tabs.QueryInfo) => {
      if (info.windowId !== undefined) return [{ ...tab(info.windowId), windowId: info.windowId }]
      if (info.windowType === 'normal') {
        return [{ ...tab(1), windowId: 1 }, { ...tab(5), windowId: 5 }]
      }
      return [panelTab]
    })
    await import('../src/background/index.ts')

    // The click lands first; the stale stored id resolves only afterwards.
    chromeMock.onActionClicked.emit({ ...tab(5), windowId: 5 })
    chromeMock.releaseBrowserWindowRead()
    await vi.waitFor(() => { expect(chromeMock.createWindow).toHaveBeenCalled() })
    chromeMock.resolveCreate(9)

    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    await vi.waitFor(() => {
      expect(panel.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'tab-affinity' }))
    })

    const targeted = chromeMock.query.mock.calls.map(([info]) => info as chrome.tabs.QueryInfo)
    expect(targeted.some((info) => info.windowId === 5)).toBe(true)
    expect(targeted.some((info) => info.windowId === 1)).toBe(false)
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
