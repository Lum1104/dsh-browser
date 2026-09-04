// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { dispatchToolCall, type ToolAnswer, type ToolCall } from '../src/background/tools.ts'

const CALL: ToolCall = { id: 'tool-1', name: 'browser_snapshot', args: {} }
const OK: ToolAnswer = { ok: true, result: { text: 'page' } }

function managedTab(tabId: number, overrides: Partial<chrome.tabs.Tab> = {}): chrome.tabs.Tab {
  return {
    id: tabId,
    windowId: 1,
    index: tabId,
    active: false,
    highlighted: false,
    pinned: false,
    incognito: false,
    selected: false,
    discarded: false,
    autoDiscardable: true,
    groupId: -1,
    url: `https://example.com/${tabId}`,
    title: `Tab ${tabId}`,
    ...overrides,
  }
}

function mockChrome(options: {
  tab?: { id?: number; url?: string }
  tabs?: chrome.tabs.Tab[]
  responses?: Array<unknown>
  injectionError?: Error
  frames?: Array<{ frameId: number; parentFrameId: number; documentId?: string; url: string }>
  respond?: (message: unknown, frameId: number) => unknown
}) {
  const responses = [...(options.responses ?? [OK])]
  const runtimeListeners = new Set<(message: unknown, sender: chrome.runtime.MessageSender) => void>()
  const currentFrames = () => options.frames ?? (options.tab?.id === undefined ? [] : [{
    frameId: 0,
    parentFrameId: -1,
    documentId: `document-${options.tab.id}`,
    url: options.tab.url ?? '',
  }])
  const sendMessage = vi.fn(async (
    _tabId: number,
    message: unknown,
    target?: { frameId?: number; documentId?: string },
  ) => {
    const targetFrameId = target?.frameId
      ?? currentFrames().find((frame) => frame.documentId === target?.documentId)?.frameId
      ?? 0
    const response = options.respond?.(message, targetFrameId) ?? responses.shift()
    if (response instanceof Error) throw response
    return response
  })
  const executeScript = options.injectionError === undefined
    ? vi.fn(async () => [{ frameId: 0, result: undefined }])
    : vi.fn(async () => { throw options.injectionError })
  const query = vi.fn(async (queryInfo?: chrome.tabs.QueryInfo) => Object.keys(queryInfo ?? {}).length === 0
    ? (options.tabs ?? (options.tab === undefined ? [] : [options.tab]))
    : (options.tab === undefined ? [] : [options.tab]))
  const get = vi.fn(async (tabId: number) => {
    const found = (options.tabs ?? (options.tab === undefined ? [] : [options.tab])).find((tab) => tab.id === tabId)
    if (found === undefined) throw new Error(`No tab with id: ${tabId}`)
    return { ...found } as chrome.tabs.Tab
  })
  const update = vi.fn(async (_tabId: number, changes: chrome.tabs.UpdateProperties) => ({ ...options.tab, ...changes }))
  const create = vi.fn(async (properties: chrome.tabs.CreateProperties) => ({
    id: 42,
    windowId: properties.windowId ?? 1,
    url: properties.url,
  }) as chrome.tabs.Tab)
  const goBack = vi.fn(async () => undefined)
  const goForward = vi.fn(async () => undefined)
  const reload = vi.fn(async () => undefined)
  const remove = vi.fn(async () => undefined)
  const getAllFrames = vi.fn(async () => currentFrames())
  vi.stubGlobal('chrome', {
    tabs: { query, get, sendMessage, update, create, goBack, goForward, reload, remove },
    scripting: { executeScript },
    webNavigation: { getAllFrames },
    runtime: {
      onMessage: {
        addListener: (listener: (message: unknown, sender: chrome.runtime.MessageSender) => void) => {
          runtimeListeners.add(listener)
        },
        removeListener: (listener: (message: unknown, sender: chrome.runtime.MessageSender) => void) => {
          runtimeListeners.delete(listener)
        },
      },
    },
  })
  const emitContentReady = (tabId: number, frameId: number, documentId: string): void => {
    for (const listener of runtimeListeners) {
      listener({ type: 'DSH_CONTENT_READY' }, { tab: { id: tabId }, frameId, documentId } as chrome.runtime.MessageSender)
    }
  }
  return { create, emitContentReady, executeScript, get, getAllFrames, goBack, goForward, query, reload, remove, sendMessage, update }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('dispatchToolCall', () => {
  it('uses an already-loaded content script without injecting', async () => {
    const chromeMock = mockChrome({ tab: { id: 7, url: 'https://example.com' } })

    const answer = await dispatchToolCall(CALL, 'auto')
    expect(answer.ok).toBe(true)
    expect((answer.result as { text: string }).text).toContain('page')
    expect((answer.result as { text: string }).text).toContain('UNTRUSTED_PAGE_CONTENT')
    expect(chromeMock.sendMessage).toHaveBeenCalledTimes(1)
    expect(chromeMock.executeScript).not.toHaveBeenCalled()
  })

  it('injects content.js and retries for a page opened before extension load', async () => {
    const budget = { maxItems: 80, maxChars: 16_000 }
    const chromeMock = mockChrome({
      tab: { id: 7, url: 'https://example.com/already-open' },
      responses: [new Error('Could not establish connection. Receiving end does not exist.'), OK],
    })

    const answer = await dispatchToolCall(CALL, 'auto', budget)
    expect(answer.ok).toBe(true)
    expect((answer.result as { text: string }).text).toContain('page')
    expect(chromeMock.executeScript).toHaveBeenCalledWith({
      target: { tabId: 7, allFrames: true },
      files: ['content.js'],
    })
    expect(chromeMock.sendMessage).toHaveBeenCalledTimes(2)
    expect(chromeMock.sendMessage).toHaveBeenLastCalledWith(7, {
      type: 'DSH_ACTION',
      action: 'browser_snapshot',
      args: { delta: false },
      budget,
    }, { documentId: 'document-7' })
  })

  it('returns browser-level metadata without injecting into Chrome internal pages', async () => {
    const chromeMock = mockChrome({
      tab: { id: 8, url: 'chrome://extensions' },
      responses: [new Error('no receiver')],
    })

    const answer = await dispatchToolCall(CALL, 'auto')
    expect(answer).toMatchObject({ ok: true })
    expect((answer.result as { text: string }).text).toContain('browser-level controls')
    expect((answer.result as { text: string }).text).toContain('chrome://extensions')
    expect((answer.result as { text: string }).text).toContain('UNTRUSTED_PAGE_CONTENT')
    expect(chromeMock.sendMessage).not.toHaveBeenCalled()
    expect(chromeMock.executeScript).not.toHaveBeenCalled()
  })

  it('navigates away from a Chrome internal page through the tabs API', async () => {
    const chromeMock = mockChrome({ tab: { id: 8, url: 'chrome://newtab/' } })

    const answer = await dispatchToolCall(
      { id: 'navigate-new-tab', name: 'browser_navigate', args: { url: 'https://example.com/path' } },
      'auto',
      undefined,
      async () => 'approved',
    )

    expect(answer).toMatchObject({
      ok: true,
      result: { text: expect.stringContaining('https://example.com/path') },
    })
    expect(chromeMock.update).toHaveBeenCalledWith(8, { url: 'https://example.com/path' })
    expect(chromeMock.sendMessage).not.toHaveBeenCalled()
    expect(chromeMock.executeScript).not.toHaveBeenCalled()
  })

  it('opens a website in a new foreground tab and hands that tab to the affinity owner', async () => {
    const chromeMock = mockChrome({ tab: { id: 8, url: 'chrome://newtab/', windowId: 3 } as chrome.tabs.Tab })
    const followCreatedTab = vi.fn(async () => undefined)

    const answer = await dispatchToolCall(
      { id: 'open-followed-tab', name: 'browser_open_tab', args: { url: 'https://docs.example/guide' } },
      'auto',
      undefined,
      async () => 'approved',
      undefined,
      { id: 8, url: 'chrome://newtab/', windowId: 3 },
      () => true,
      followCreatedTab,
    )

    expect(answer).toMatchObject({
      ok: true,
      result: { text: expect.stringContaining('made it the controlled tab') },
    })
    expect(chromeMock.create).toHaveBeenCalledWith({
      url: 'https://docs.example/guide',
      active: true,
      windowId: 3,
    })
    expect(followCreatedTab).toHaveBeenCalledWith(expect.objectContaining({
      id: 42,
      windowId: 3,
      url: 'https://docs.example/guide',
    }))
    expect(chromeMock.sendMessage).not.toHaveBeenCalled()
  })

  it('rejects non-web new-tab destinations before creating a tab', async () => {
    const chromeMock = mockChrome({ tab: { id: 8, url: 'chrome://newtab/' } })

    await expect(dispatchToolCall(
      { id: 'open-file-tab', name: 'browser_open_tab', args: { url: 'file:///private.txt' } },
      'auto',
      undefined,
      async () => 'approved',
    )).resolves.toMatchObject({
      ok: false,
      error: { code: 'action-failed', message: expect.stringContaining('Only http and https') },
    })
    expect(chromeMock.create).not.toHaveBeenCalled()
  })

  it('lists every open tab as untrusted metadata after approval', async () => {
    const authorize = vi.fn(async () => 'approved' as const)
    mockChrome({
      tabs: [
        managedTab(11, { active: true, title: 'Inbox', url: 'https://mail.example/inbox' }),
        managedTab(12, { windowId: 2, title: 'Docs', url: 'https://docs.example/guide?draft=1' }),
      ],
    })

    const answer = await dispatchToolCall(
      { id: 'list-tabs', name: 'browser_list_tabs', args: {} },
      'auto',
      undefined,
      authorize,
      undefined,
      undefined,
      undefined,
      undefined,
      { unrestrictedAccess: false, controlledTabId: 12 },
    )

    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'read',
      action: 'browser_list_tabs',
      canTrust: false,
    }))
    const text = (answer.result as { text: string }).text
    expect(text).toContain('UNTRUSTED_PAGE_CONTENT')
    expect(text).toContain('https://mail.example/inbox')
    expect(text).toContain('"controlled": true')
  })

  it('lists tabs without approval when unrestricted browser access is enabled', async () => {
    const authorize = vi.fn(async () => 'denied' as const)
    mockChrome({ tabs: [managedTab(11)] })

    await expect(dispatchToolCall(
      { id: 'list-tabs-unrestricted', name: 'browser_list_tabs', args: {} },
      'ask',
      undefined,
      authorize,
      undefined,
      undefined,
      undefined,
      undefined,
      { unrestrictedAccess: true },
    )).resolves.toMatchObject({ ok: true })
    expect(authorize).not.toHaveBeenCalled()
  })

  it('bypasses page-sharing blocks and action approval in unrestricted mode', async () => {
    const readAuthorization = vi.fn(async () => 'denied' as const)
    mockChrome({ tab: { id: 8, url: 'https://example.com/' } })
    await expect(dispatchToolCall(
      CALL,
      'off',
      undefined,
      readAuthorization,
      undefined,
      undefined,
      undefined,
      undefined,
      { unrestrictedAccess: true },
    )).resolves.toMatchObject({ ok: true })
    expect(readAuthorization).not.toHaveBeenCalled()

    const actionAuthorization = vi.fn(async () => 'denied' as const)
    const chromeMock = mockChrome({ tab: { id: 9, url: 'chrome://newtab/' } })
    await expect(dispatchToolCall(
      { id: 'unrestricted-navigation', name: 'browser_navigate', args: { url: 'https://docs.example/' } },
      'ask',
      undefined,
      actionAuthorization,
      undefined,
      undefined,
      undefined,
      undefined,
      { unrestrictedAccess: true },
    )).resolves.toMatchObject({ ok: true })
    expect(actionAuthorization).not.toHaveBeenCalled()
    expect(chromeMock.update).toHaveBeenCalledWith(9, { url: 'https://docs.example/' })
  })

  it('follows a selected open tab without activating it', async () => {
    const target = managedTab(12, { windowId: 2, title: 'Docs', url: 'https://docs.example/guide' })
    const chromeMock = mockChrome({ tabs: [managedTab(11, { active: true }), target] })
    const followTab = vi.fn(async () => undefined)

    await expect(dispatchToolCall(
      { id: 'follow-tab', name: 'browser_follow_tab', args: { tabId: 12 } },
      'auto',
      undefined,
      async () => 'approved',
      undefined,
      undefined,
      undefined,
      undefined,
      { unrestrictedAccess: false, controlledTabId: 11, followTab },
    )).resolves.toMatchObject({
      ok: true,
      result: { text: expect.stringContaining('now the controlled tab') },
    })
    expect(followTab).toHaveBeenCalledWith(expect.objectContaining({ id: 12 }))
    expect(chromeMock.update).not.toHaveBeenCalled()
  })

  it('closes a selected tab only after revalidating it', async () => {
    const chromeMock = mockChrome({ tabs: [managedTab(12, { url: 'https://docs.example/guide' })] })

    await expect(dispatchToolCall(
      { id: 'close-tab', name: 'browser_close_tab', args: { tabId: 12 } },
      'auto',
      undefined,
      async () => 'approved',
      undefined,
      undefined,
      undefined,
      undefined,
      { unrestrictedAccess: false },
    )).resolves.toMatchObject({ ok: true })
    expect(chromeMock.get).toHaveBeenCalledTimes(2)
    expect(chromeMock.remove).toHaveBeenCalledWith(12)
  })

  it('refuses to follow a tab that navigates while approval is pending', async () => {
    const target = managedTab(12, { url: 'https://docs.example/guide' })
    const followTab = vi.fn(async () => undefined)
    mockChrome({ tabs: [target] })

    await expect(dispatchToolCall(
      { id: 'follow-navigated-tab', name: 'browser_follow_tab', args: { tabId: 12 } },
      'auto',
      undefined,
      async () => {
        target.url = 'https://bank.example/transfer'
        return 'approved'
      },
      undefined,
      undefined,
      undefined,
      undefined,
      { unrestrictedAccess: false, followTab },
    )).resolves.toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('navigated while approval was pending') },
    })
    expect(followTab).not.toHaveBeenCalled()
  })

  it('reports DOM actions as unavailable on Chrome internal pages without requesting approval', async () => {
    const chromeMock = mockChrome({ tab: { id: 8, url: 'chrome://newtab/' } })
    const authorize = vi.fn(async () => 'approved' as const)

    await expect(dispatchToolCall(
      { id: 'click-new-tab', name: 'browser_click', args: { index: 1 } },
      'auto',
      undefined,
      authorize,
    )).resolves.toMatchObject({
      ok: false,
      error: { code: 'content-unavailable', message: expect.stringContaining('DOM is protected') },
    })
    expect(authorize).not.toHaveBeenCalled()
    expect(chromeMock.sendMessage).not.toHaveBeenCalled()
  })

  it('uses browser-level history and reload controls on internal pages', async () => {
    for (const name of ['browser_back', 'browser_forward', 'browser_reload'] as const) {
      const chromeMock = mockChrome({ tab: { id: 8, url: 'chrome://newtab/' } })
      await expect(dispatchToolCall(
        { id: name, name, args: {} },
        'auto',
        undefined,
        async () => 'approved',
      )).resolves.toMatchObject({ ok: true })
      const invoked = name === 'browser_back'
        ? chromeMock.goBack
        : name === 'browser_forward'
          ? chromeMock.goForward
          : chromeMock.reload
      expect(invoked).toHaveBeenCalledWith(8)
      vi.unstubAllGlobals()
    }
  })

  it('falls back to browser-level metadata when recovery injection is blocked', async () => {
    mockChrome({
      tab: { id: 9, url: 'https://chromewebstore.google.com/detail/example' },
      responses: [new Error('no receiver')],
      injectionError: new Error('Cannot access contents of the page'),
    })

    const answer = await dispatchToolCall(CALL, 'auto')
    expect(answer).toMatchObject({ ok: true })
    expect((answer.result as { text: string }).text).toContain('browser-level controls')
    expect((answer.result as { text: string }).text).toContain('chromewebstore.google.com')
  })

  it('keeps the page-sharing privacy boundary ahead of tab access', async () => {
    const chromeMock = mockChrome({ tab: { id: 7, url: 'https://example.com' } })

    await expect(dispatchToolCall(CALL, 'off')).resolves.toMatchObject({
      ok: false,
      error: { code: 'action-failed' },
    })
    expect(chromeMock.query).not.toHaveBeenCalled()
  })

  it('dispatches to an explicitly bound background tab without querying the active tab', async () => {
    const chromeMock = mockChrome({
      tab: { id: 7, url: 'https://active.example/' },
      frames: [{ frameId: 0, parentFrameId: -1, documentId: 'bound-doc', url: 'https://bound.example/' }],
    })

    const answer = await dispatchToolCall(
      CALL,
      'auto',
      undefined,
      undefined,
      undefined,
      { id: 88, url: 'https://bound.example/' },
    )

    expect(answer.ok).toBe(true)
    expect(chromeMock.query).not.toHaveBeenCalled()
    expect(chromeMock.sendMessage).toHaveBeenCalledWith(88, expect.any(Object), { documentId: 'bound-doc' })
  })

  it('aggregates top-level and cross-origin iframe snapshots', async () => {
    const chromeMock = mockChrome({
      tab: { id: 21, url: 'https://app.example/' },
      frames: [
        { frameId: 0, parentFrameId: -1, documentId: 'top-doc', url: 'https://app.example/' },
        { frameId: 4, parentFrameId: 0, documentId: 'child-doc', url: 'https://login.example.net/form' },
      ],
      respond: (_message, frameId) => ({ ok: true, result: { text: frameId === 0 ? 'TOP SNAPSHOT' : 'IFRAME SNAPSHOT' } }),
    })

    const answer = await dispatchToolCall(CALL, 'auto', { maxItems: 10, maxChars: 2_000 })

    expect(answer).toMatchObject({ ok: true })
    const text = (answer.result as { text: string }).text
    expect(text).toContain('TOP SNAPSHOT')
    expect(text).toContain('iframe frame=4 parent=0 origin=https://login.example.net')
    expect(text).toContain('IFRAME SNAPSHOT')
    expect(chromeMock.sendMessage.mock.calls.map((call) => call[2])).toEqual([
      { documentId: 'top-doc' },
      { documentId: 'child-doc' },
    ])
  })

  it('routes an element action to the requested frame and removes routing metadata', async () => {
    const call: ToolCall = { id: 'tool-frame', name: 'browser_click', args: { frame: 8, index: 3 } }
    const chromeMock = mockChrome({
      tab: { id: 22, url: 'https://app.example/' },
      frames: [
        { frameId: 0, parentFrameId: -1, documentId: 'top-doc', url: 'https://app.example/' },
        { frameId: 8, parentFrameId: 0, documentId: 'child-doc', url: 'https://widget.example/' },
      ],
      respond: (message, frameId) => {
        const action = (message as { action?: string }).action
        if (action === 'browser_snapshot') return { ok: true, result: { text: `frame ${frameId}` } }
        return OK
      },
    })

    await dispatchToolCall(CALL, 'auto')
    chromeMock.sendMessage.mockClear()
    await expect(dispatchToolCall(call, 'auto', undefined, async () => 'approved')).resolves.toEqual(OK)
    expect(chromeMock.sendMessage).toHaveBeenCalledWith(22, {
      type: 'DSH_ACTION',
      action: 'browser_click',
      args: { index: 3 },
      budget: expect.objectContaining({ maxItems: 60 }),
      includePageDelta: true,
    }, { documentId: 'child-doc' })
  })

  it('returns automatic action deltas inside a fresh untrusted-content boundary', async () => {
    const call: ToolCall = { id: 'tool-delta', name: 'browser_click', args: { index: 3 } }
    const budget = { maxItems: 10, maxChars: 1_000 }
    const chromeMock = mockChrome({
      tab: { id: 33, url: 'https://app.example/' },
      respond: (message) => (message as { action?: string }).action === 'browser_snapshot'
        ? { ok: true, result: { text: 'Initial page' } }
        : {
            ok: true,
            result: {
              text: 'Clicked [3].',
              pageContent: 'Page change v2\nChanged main content:\nOrder complete',
            },
          },
    })
    await dispatchToolCall(CALL, 'auto', budget)
    chromeMock.sendMessage.mockClear()

    const answer = await dispatchToolCall(call, 'auto', budget, async () => 'approved')

    expect(answer.ok).toBe(true)
    const result = answer.result as { text: string; pageContent?: string }
    expect(result.text).toContain('Clicked [3].')
    expect(result.text).toContain('Continue from this state')
    expect(result.text).toContain('UNTRUSTED_PAGE_CONTENT')
    expect(result.text).toContain('Order complete')
    expect(result.text.length).toBeLessThanOrEqual(budget.maxChars)
    expect(result.pageContent).toBeUndefined()
    expect(chromeMock.sendMessage).toHaveBeenCalledWith(33, {
      type: 'DSH_ACTION',
      action: 'browser_click',
      args: { index: 3 },
      budget,
      includePageDelta: true,
    }, { documentId: 'document-33' })
  })

  it('does not extract or forward an action delta when reads require approval', async () => {
    const call: ToolCall = { id: 'tool-private-delta', name: 'browser_click', args: { index: 2 } }
    const chromeMock = mockChrome({
      tab: { id: 34, url: 'https://private.example/' },
      respond: (message) => (message as { action?: string }).action === 'browser_snapshot'
        ? { ok: true, result: { text: 'Initial private page' } }
        : {
            ok: true,
            result: {
              text: 'Clicked [2].',
              pageContent: 'This content must not cross the sharing boundary',
            },
          },
    })
    await dispatchToolCall(CALL, 'auto')
    chromeMock.sendMessage.mockClear()

    const answer = await dispatchToolCall(call, 'ask', undefined, async () => 'approved')

    expect(answer).toEqual({ ok: true, result: { text: 'Clicked [2].' } })
    expect(chromeMock.sendMessage).toHaveBeenCalledWith(34, {
      type: 'DSH_ACTION',
      action: 'browser_click',
      args: { index: 2 },
    }, { documentId: 'document-34' })
  })

  it('returns the replacement page snapshot in the same navigation tool call', async () => {
    const frames = [
      { frameId: 0, parentFrameId: -1, documentId: 'document-before', url: 'https://app.example/start' },
    ]
    const budget = { maxItems: 10, maxChars: 2_000 }
    const chromeMock = mockChrome({
      tab: { id: 35, url: 'https://app.example/start' },
      frames,
      respond: (message) => (message as { action?: string }).action === 'browser_navigate'
        ? {
            ok: true,
            result: {
              text: 'Navigating to https://app.example/next. Call browser_snapshot again after the page loads.',
              navigationPending: true,
            },
          }
        : { ok: true, result: { text: 'Title: Next page\nURL: https://app.example/next' } },
    })

    const pending = dispatchToolCall(
      { id: 'tool-navigation', name: 'browser_navigate', args: { url: 'https://app.example/next' } },
      'auto',
      budget,
      async () => 'approved',
    )
    await vi.waitFor(() => { expect(chromeMock.sendMessage).toHaveBeenCalledTimes(1) })
    frames[0] = {
      frameId: 0,
      parentFrameId: -1,
      documentId: 'document-after',
      url: 'https://app.example/next',
    }
    chromeMock.emitContentReady(35, 0, 'document-after')

    const answer = await pending
    const text = (answer.result as { text: string }).text
    expect(text).toContain('Navigation completed')
    expect(text).toContain('Title: Next page')
    expect(text).toContain('UNTRUSTED_PAGE_CONTENT')
    expect(text).not.toContain('Call browser_snapshot again')
    expect(text.length).toBeLessThanOrEqual(budget.maxChars)
    expect(chromeMock.sendMessage).toHaveBeenCalledTimes(2)
    expect(chromeMock.sendMessage).toHaveBeenLastCalledWith(35, expect.objectContaining({
      action: 'browser_snapshot',
      args: { delta: false },
      budget: expect.objectContaining({ maxChars: expect.any(Number) }),
    }), { documentId: 'document-after' })
  })

  it('does not wait for or return navigation page content when reads are not automatic', async () => {
    const chromeMock = mockChrome({
      tab: { id: 36, url: 'https://app.example/start' },
      respond: () => ({
        ok: true,
        result: {
          text: 'Navigating to https://app.example/next. Call browser_snapshot again after the page loads.',
          navigationPending: true,
        },
      }),
    })

    const answer = await dispatchToolCall(
      { id: 'tool-private-navigation', name: 'browser_navigate', args: { url: 'https://app.example/next' } },
      'ask',
      undefined,
      async () => 'approved',
    )

    expect(answer).toEqual({
      ok: true,
      result: { text: expect.stringContaining('Call browser_snapshot again') },
    })
    expect(chromeMock.sendMessage).toHaveBeenCalledTimes(1)
  })

  it('wraps browser_get_text output in the same untrusted-content boundary', async () => {
    const call: ToolCall = { id: 'tool-text', name: 'browser_get_text', args: {} }
    mockChrome({ tab: { id: 24, url: 'https://app.example/' }, responses: [{ ok: true, result: { text: 'page text' } }] })

    const answer = await dispatchToolCall(call, 'auto', { maxItems: 10, maxChars: 1_000 })

    const text = (answer.result as { text: string }).text
    expect(text).toContain('page text')
    expect(text).toContain('UNTRUSTED_PAGE_CONTENT')
    expect(text.length).toBeLessThanOrEqual(1_000)
  })

  it('returns the explicit user denial before reading', async () => {
    const authorize = vi.fn(async () => 'denied' as const)
    const chromeMock = mockChrome({
      tab: { id: 25, url: 'https://app.example/' },
      frames: [
        { frameId: 0, parentFrameId: -1, documentId: 'top', url: 'https://app.example/' },
        { frameId: 2, parentFrameId: 0, documentId: 'child', url: 'https://embed.example.net/' },
      ],
    })

    const answer = await dispatchToolCall(CALL, 'ask', undefined, authorize)

    expect(answer).toEqual({
      ok: false,
      error: {
        code: 'action-failed',
        message: 'The user denied the browser approval request for "browser_snapshot".',
      },
    })
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'read',
      origins: ['https://app.example', 'https://embed.example.net'],
    }))
    expect(chromeMock.sendMessage).not.toHaveBeenCalled()
  })

  it('reports when no side panel can receive a state-changing approval', async () => {
    const call: ToolCall = { id: 'tool-denied', name: 'browser_press', args: { key: 'Enter' } }
    const chromeMock = mockChrome({ tab: { id: 26, url: 'https://app.example/' } })

    const answer = await dispatchToolCall(call, 'auto')

    expect(answer).toEqual({
      ok: false,
      error: {
        code: 'action-failed',
        message: 'No browser side panel was available to receive or complete the approval request for "browser_press".',
      },
    })
    expect(chromeMock.sendMessage).not.toHaveBeenCalled()
  })

  it('returns an approval timeout without treating it as a user denial', async () => {
    const call: ToolCall = { id: 'tool-timeout', name: 'browser_press', args: { key: 'Enter' } }
    const chromeMock = mockChrome({ tab: { id: 27, url: 'https://app.example/' } })

    const answer = await dispatchToolCall(call, 'auto', undefined, async () => 'timed-out')

    expect(answer).toEqual({
      ok: false,
      error: {
        code: 'timeout',
        message: 'The browser approval request for "browser_press" timed out before the user responded.',
      },
    })
    expect(chromeMock.sendMessage).not.toHaveBeenCalled()
  })

  it('does not dispatch an action after its bridge call is cancelled during approval', async () => {
    const call: ToolCall = { id: 'tool-cancelled', name: 'browser_press', args: { key: 'Enter' } }
    const controller = new AbortController()
    const chromeMock = mockChrome({ tab: { id: 27, url: 'https://app.example/' } })
    const authorize = vi.fn(async () => {
      controller.abort()
      return 'approved' as const
    })

    const answer = await dispatchToolCall(call, 'auto', undefined, authorize, controller.signal)

    expect(answer).toMatchObject({ ok: false, error: { code: 'bridge-closed' } })
    expect(chromeMock.sendMessage).not.toHaveBeenCalled()
  })

  it('does not dispatch an approved action after tab affinity changes', async () => {
    const call: ToolCall = { id: 'tool-switched', name: 'browser_press', args: { key: 'Enter' } }
    let targetAllowed = true
    const chromeMock = mockChrome({ tab: { id: 28, url: 'https://app.example/' } })
    const authorize = vi.fn(async () => {
      targetAllowed = false
      return 'approved' as const
    })

    const answer = await dispatchToolCall(
      call,
      'auto',
      undefined,
      authorize,
      undefined,
      { id: 28, url: 'https://app.example/' },
      () => targetAllowed,
    )

    expect(answer).toMatchObject({ ok: false, error: { message: expect.stringContaining('controlled tab') } })
    expect(chromeMock.sendMessage).not.toHaveBeenCalled()
  })

  it('rejects an element reference after its frame document reloads', async () => {
    const frames = [
      { frameId: 0, parentFrameId: -1, documentId: 'top-doc', url: 'https://app.example/' },
      { frameId: 3, parentFrameId: 0, documentId: 'child-v1', url: 'https://widget.example/form' },
    ]
    const chromeMock = mockChrome({
      tab: { id: 30, url: 'https://app.example/' },
      frames,
      respond: (_message, frameId) => ({ ok: true, result: { text: `frame ${frameId}` } }),
    })
    await dispatchToolCall(CALL, 'auto')
    chromeMock.sendMessage.mockClear()
    frames[1] = { ...frames[1]!, documentId: 'child-v2' }

    const answer = await dispatchToolCall(
      { id: 'stale-click', name: 'browser_click', args: { frame: 3, index: 4 } },
      'auto',
      undefined,
      async () => 'approved',
    )

    expect(answer).toMatchObject({ ok: false, error: { message: expect.stringContaining('Call browser_snapshot again') } })
    expect(chromeMock.sendMessage).not.toHaveBeenCalled()
  })

  it('rejects an action when its target origin changes during approval', async () => {
    const frames = [
      { frameId: 0, parentFrameId: -1, documentId: 'top-v1', url: 'https://app.example/' },
    ]
    const chromeMock = mockChrome({ tab: { id: 31, url: 'https://app.example/' }, frames })
    const authorize = vi.fn(async () => {
      frames[0] = { ...frames[0]!, documentId: 'top-v2', url: 'https://evil.example/' }
      return 'approved' as const
    })

    const answer = await dispatchToolCall(
      { id: 'changed-origin', name: 'browser_press', args: { key: 'Enter' } },
      'auto',
      undefined,
      authorize,
    )

    expect(answer).toMatchObject({ ok: false, error: { message: expect.stringContaining('page changed while approval was pending') } })
    expect(chromeMock.sendMessage).not.toHaveBeenCalled()
  })

  it('rejects an action when the same-origin document changes during approval', async () => {
    const frames = [
      { frameId: 0, parentFrameId: -1, documentId: 'top-v1', url: 'https://app.example/one' },
    ]
    const chromeMock = mockChrome({ tab: { id: 32, url: 'https://app.example/one' }, frames })
    const authorize = vi.fn(async () => {
      frames[0] = { ...frames[0]!, documentId: 'top-v2', url: 'https://app.example/two' }
      return 'approved' as const
    })

    const answer = await dispatchToolCall(
      { id: 'changed-document', name: 'browser_press', args: { key: 'Enter' } },
      'auto',
      undefined,
      authorize,
    )

    expect(answer).toMatchObject({ ok: false, error: { message: expect.stringContaining('page changed while approval was pending') } })
    expect(chromeMock.sendMessage).not.toHaveBeenCalled()
  })

  it('forces a full snapshot for a newly navigated frame before resuming deltas', async () => {
    const frames = [
      { frameId: 0, parentFrameId: -1, documentId: 'top-doc', url: 'https://app.example/' },
      { frameId: 6, parentFrameId: 0, documentId: 'child-v1', url: 'https://widget.example/one' },
    ]
    const seen: Array<{ frameId: number; delta: unknown }> = []
    const chromeMock = mockChrome({
      tab: { id: 23, url: 'https://app.example/' },
      frames,
      respond: (message, frameId) => {
        seen.push({ frameId, delta: (message as { args?: { delta?: unknown } }).args?.delta })
        return { ok: true, result: { text: `frame ${frameId}` } }
      },
    })
    const deltaCall: ToolCall = { ...CALL, id: 'delta', args: { delta: true } }

    await dispatchToolCall(deltaCall, 'auto')
    expect(seen.splice(0)).toEqual([{ frameId: 0, delta: false }, { frameId: 6, delta: false }])

    await dispatchToolCall(deltaCall, 'auto')
    expect(seen.splice(0)).toEqual([{ frameId: 0, delta: true }, { frameId: 6, delta: true }])

    frames[1] = { ...frames[1]!, documentId: 'child-v2', url: 'https://widget.example/two' }
    await dispatchToolCall(deltaCall, 'auto')
    expect(seen).toEqual([{ frameId: 0, delta: true }, { frameId: 6, delta: false }])
    expect(chromeMock.getAllFrames).toHaveBeenCalledTimes(3)
  })
})
