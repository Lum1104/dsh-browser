// @vitest-environment jsdom
/**
 * Developer-tools controller: tool dispatch over a scripted debugger, capture
 * lifecycle, the user-allowance gate, and detach recovery.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDevToolsController, undebuggableReason, type DevToolsController } from '../src/background/devtools-controller.ts'
import type { DebuggerApi } from '../src/background/debugger-session.ts'

type Handler = (params: Record<string, unknown>) => unknown

interface Harness {
  controller: DevToolsController
  commands: [string, Record<string, unknown> | undefined][]
  /** Scripted CDP command results, keyed by method. */
  handlers: Map<string, Handler>
  emit: (method: string, params?: unknown) => void
  attach: ReturnType<typeof vi.fn>
  detach: ReturnType<typeof vi.fn>
  setTargetUrl: (url: string | undefined) => void
  setAttachError: (error: Error | undefined) => void
  target: { tabId: number; url?: string }
}

function harness(): Harness {
  const commands: [string, Record<string, unknown> | undefined][] = []
  const handlers = new Map<string, Handler>()
  const eventListeners = new Set<(source: { tabId?: number }, method: string, params?: unknown) => void>()
  const detachListeners = new Set<(source: { tabId?: number }, reason: string) => void>()
  let attachError: Error | undefined
  const attach = vi.fn(async () => {
    if (attachError !== undefined) throw attachError
  })
  const detach = vi.fn(async () => undefined)
  const sendCommand = vi.fn(async (_target: { tabId: number }, method: string, params?: Record<string, unknown>) => {
    commands.push([method, params])
    return handlers.get(method)?.(params ?? {}) ?? {}
  })
  const api: DebuggerApi = {
    attach,
    detach,
    sendCommand: sendCommand as unknown as DebuggerApi['sendCommand'],
    onEvent: {
      addListener: (listener) => { eventListeners.add(listener) },
      removeListener: (listener) => { eventListeners.delete(listener) },
    },
    onDetach: {
      addListener: (listener) => { detachListeners.add(listener) },
      removeListener: (listener) => { detachListeners.delete(listener) },
    },
  }
  const target: { tabId: number; url?: string } = { tabId: 42, url: 'https://example.com/page' }
  // The controller probes the platform before anything else; present a debugger
  // surface so the supported path is what these tests exercise.
  vi.stubGlobal('chrome', { debugger: api })
  const controller = createDevToolsController({
    api,
    resolveTarget: async () => ({
      tabId: target.tabId,
      ...(target.url === undefined ? {} : { url: target.url }),
    }),
    commandTimeoutMs: 200,
  })
  return {
    controller,
    commands,
    handlers,
    emit: (method, params) => { for (const listener of eventListeners) listener({ tabId: 42 }, method, params) },
    attach,
    detach,
    setTargetUrl: (url) => {
      if (url === undefined) delete target.url
      else target.url = url
    },
    setAttachError: (error) => { attachError = error },
    target,
  }
}

function defaultDebuggerHandlers(h: Harness): void {
  h.handlers.set('DOM.describeNode', () => ({ node: { localName: 'div', attributes: ['id', 'main'], parentId: 0 } }))
  h.handlers.set('DOM.getDocument', () => ({ root: { nodeId: 1 } }))
  h.handlers.set('DOM.querySelector', () => ({ nodeId: 9 }))
  h.handlers.set('CSS.getComputedStyleForNode', () => ({ computedStyle: [{ name: 'display', value: 'block' }] }))
  h.handlers.set('CSS.getMatchedStylesForNode', () => ({
    inlineStyle: { cssProperties: [{ name: 'color', value: 'red' }] },
    matchedCSSRules: [],
  }))
  h.handlers.set('DOM.getBoxModel', () => ({ model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } }))
  h.handlers.set('DOM.getAttributes', () => ({ attributes: ['data-x', 'old'] }))
  h.handlers.set('Runtime.evaluate', () => ({ result: { type: 'number', value: 7 } }))
  h.handlers.set('Runtime.releaseObject', () => ({}))
  h.handlers.set('CSS.setStyleTexts', () => ({}))
  h.handlers.set('CSS.getStyleSheetText', () => ({ text: '.a { color: red; }' }))
  h.handlers.set('CSS.setStyleSheetText', () => ({}))
  h.handlers.set('DOM.setAttributeValue', () => ({}))
  h.handlers.set('DOM.removeAttribute', () => ({}))
  h.handlers.set('Network.getResponseBody', () => ({ body: '{"ok":true}' }))
  h.handlers.set('Network.getRequestPostData', () => ({ postData: 'a=1' }))
  h.handlers.set('Page.getFrameTree', () => ({ frameTree: { frame: { id: 'frame-top' } } }))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('developer-tools controller', () => {
  it('refuses browser-internal pages without attempting an attach', async () => {
    const h = harness()
    defaultDebuggerHandlers(h)

    for (const url of ['chrome://extensions/', 'chrome-untrusted://frame', 'devtools://devtools/bundled/x.html']) {
      h.setTargetUrl(url)
      await expect(h.controller.handle('browser_console_logs', {})).rejects.toThrow(/chrome\.debugger refuses/)
      // Enabling the switch on an internal page is not an error: prewarm has
      // nothing to attach and must not leave a failure pinned in the panel.
      await expect(h.controller.prewarm(42)).resolves.toBeUndefined()
      expect(h.controller.state().error).toBeUndefined()
    }
    // The refusal never reached the debugger API.
    expect(h.attach).not.toHaveBeenCalled()

    // A normal page on the same tab is served again.
    h.setTargetUrl('https://example.com/page')
    await expect(h.controller.handle('browser_console_logs', {})).resolves.toBeTruthy()
  })

  it('classifies URL schemes by whether a debugger can attach', () => {
    expect(undebuggableReason(undefined)).toBeUndefined()
    expect(undebuggableReason('')).toBeUndefined()
    expect(undebuggableReason('https://example.com/x')).toBeUndefined()
    expect(undebuggableReason('http://127.0.0.1:8080/x')).toBeUndefined()
    expect(undebuggableReason('file:///tmp/x.html')).toBeUndefined()
    expect(undebuggableReason('chrome://newtab/')).toContain('chrome://')
    expect(undebuggableReason('about:blank')).toContain('about://')
  })

  it('stops reporting an earlier attach failure once the page works again', async () => {
    const h = harness()
    defaultDebuggerHandlers(h)

    // First attempt fails with the conflict the user saw in the panel.
    h.setAttachError(new Error('Another debugger is already attached to the tab with id: 42'))
    await expect(h.controller.handle('browser_console_logs', {})).rejects.toThrow(/Close DevTools for this tab/)
    expect(h.controller.state().error).toContain('Close DevTools for this tab')

    // The user closes DevTools; the next successful call must clear the note.
    h.setAttachError(undefined)
    await h.controller.handle('browser_console_logs', {})
    expect(h.controller.state().error).toBeUndefined()
    expect(h.controller.state().attached).toBe(true)

    // An internal page reports its own reason, and clearing it clears the note.
    await h.controller.detachAll()
    h.setTargetUrl('chrome://newtab/')
    await expect(h.controller.handle('browser_console_logs', {})).rejects.toThrow(/cannot be debugged/)
    expect(h.controller.state().error).toMatch(/cannot be debugged/)
    h.setTargetUrl('https://example.com/page')
    await h.controller.handle('browser_console_logs', {})
    expect(h.controller.state().error).toBeUndefined()
  })

  it('runs devtools calls so the approval dialog stays reachable', async () => {
    const h = harness()
    defaultDebuggerHandlers(h)
    // The user has NOT enabled the standing allowance. The controller must not
    // refuse on its own: the background's approval gate is what asks the user,
    // and a second hard gate would make that dialog unreachable.
    await expect(h.controller.handle('browser_devtools_elements', { selector: 'body' })).resolves.toBeTruthy()
    expect(h.attach).toHaveBeenCalledWith({ tabId: 42 }, '1.3')
  })

  it('reports unsupported platforms before touching the tab', async () => {
    const h = harness()
    vi.stubGlobal('chrome', {})
    await expect(h.controller.handle('browser_console_logs', {})).rejects.toThrow(/debugger API is unavailable/)
  })

  it('surfaces the actionable message when another debugger holds the tab', async () => {
    const h = harness()
    defaultDebuggerHandlers(h)
    h.setAttachError(new Error('Another debugger is already attached to the tab with id: 42'))
    await expect(h.controller.handle('browser_console_logs', {})).rejects.toThrow(/Close DevTools for this tab/)
  })

  it('dispatches every tool to the debugger and renders text', async () => {
    const h = harness()
    defaultDebuggerHandlers(h)

    const elements = await h.controller.handle('browser_devtools_elements', { selector: '#main', properties: ['display'] })
    expect(elements.text).toContain('div#main')
    expect(elements.text).toContain('display: block')

    const style = await h.controller.handle('browser_devtools_set_element_style', {
      selector: '#main',
      properties: [{ name: 'color', value: 'blue' }],
    })
    expect(style.text).toContain('color: blue')
    // The scripted inline style exposes no editable range, so the edit lands on
    // the style attribute (the documented CDP fallback path).
    expect(h.commands.some((command) => command[0] === 'DOM.setAttributeValue')).toBe(true)

    const attributeRead = await h.controller.handle('browser_devtools_set_element_attribute', { selector: '#main', name: 'data-x' })
    expect(attributeRead.text).toContain('Before: old')
    expect(attributeRead.text).not.toContain('After:')

    const attributeWrite = await h.controller.handle('browser_devtools_set_element_attribute', {
      selector: '#main',
      name: 'data-x',
      value: 'new',
    })
    expect(attributeWrite.text).toContain('After: new')

    const evaluation = await h.controller.handle('browser_console_eval', { expression: '1 + 6' })
    expect(evaluation.text).toContain('Evaluation result:')
    expect(evaluation.text).toContain('7')

    const logs = await h.controller.handle('browser_console_logs', {})
    expect(logs.text).toContain('No console entries recorded')
  })

  it('reads console output without a sinceIndex window', async () => {
    const h = harness()
    defaultDebuggerHandlers(h)
    await h.controller.handle('browser_devtools_network', { action: 'start' })
    h.emit('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: 'first line' }], timestamp: 1 })
    const logs = await h.controller.handle('browser_console_logs', {})
    expect(logs.text).toContain('[1] log: first line')
    const windowed = await h.controller.handle('browser_console_logs', { sinceIndex: 1 })
    expect(windowed.text).toContain('No console entries recorded')
  })

  it('reports an evaluation that throws instead of a value', async () => {
    const h = harness()
    defaultDebuggerHandlers(h)
    h.handlers.set('Runtime.evaluate', () => ({
      result: { type: 'object' },
      exceptionDetails: { exception: { description: 'SyntaxError: Unexpected token' } },
    }))
    const response = await h.controller.handle('browser_console_eval', { expression: '({)' })
    expect(response.text).toContain('SyntaxError')
    expect(response.text).not.toContain('Evaluation result')
  })

  it('refuses script-capable attribute writes', async () => {
    const h = harness()
    defaultDebuggerHandlers(h)
    await expect(h.controller.handle('browser_devtools_set_element_attribute', {
      selector: '#main',
      name: 'onclick',
      value: 'alert(1)',
    })).rejects.toThrow(/Refusing to write the script-capable attribute/)
    expect(h.commands.some((command) => command[0] === 'DOM.setAttributeValue')).toBe(false)
  })

  it('captures network traffic, filters it, and reads bodies', async () => {
    const h = harness()
    defaultDebuggerHandlers(h)

    const started = await h.controller.handle('browser_devtools_network', { action: 'start' })
    expect(started.text).toContain('Network capture active')

    h.emit('Network.requestWillBeSent', {
      requestId: 'r1',
      request: { url: 'https://example.com/api/login', method: 'POST', headers: [{ name: 'authorization', value: 'Bearer secret' }] },
      type: 'Fetch',
      timestamp: 5,
    })
    h.emit('Network.responseReceived', {
      requestId: 'r1',
      type: 'Fetch',
      response: { url: 'https://example.com/api/login', status: 200, statusText: 'OK', mimeType: 'application/json', headers: [] },
    })
    h.emit('Network.loadingFinished', { requestId: 'r1', timestamp: 5.2, encodedDataLength: 64 })

    const listed = await h.controller.handle('browser_devtools_list_requests', {})
    expect(listed.text).toContain('[1] POST https://example.com/api/login')
    expect(listed.text).toContain('200')

    const filteredOut = await h.controller.handle('browser_devtools_list_requests', { urlPattern: '/nomatch/' })
    expect(filteredOut.text).toContain('No captured requests matched')

    const filteredIn = await h.controller.handle('browser_devtools_list_requests', { resourceType: 'fetch', statusMin: 200, statusMax: 299 })
    expect(filteredIn.text).toContain('api/login')

    const detail = await h.controller.handle('browser_devtools_get_request', { index: 1, includeBody: true })
    expect(detail.text).toContain('authorization: [redacted]')
    expect(detail.text).toContain('application/json')

    // An authentication-shaped URL is redacted unless the caller opts in.
    const redacted = await h.controller.handle('browser_devtools_request_body', { index: 1, kind: 'response' })
    expect(redacted.text).toContain('[redacted]')
    const opted = await h.controller.handle('browser_devtools_request_body', { index: 1, includeSensitiveBody: true })
    expect(opted.text).toContain('"ok": true')

    const stopped = await h.controller.handle('browser_devtools_network', { action: 'stop' })
    expect(stopped.text).toContain('Network capture inactive')
    expect(h.detach).toHaveBeenCalled()

    const status = await h.controller.handle('browser_devtools_network', { action: 'status' })
    expect(status.text).toContain('Network capture inactive')
  })

  it('lists captured requests without a sinceIndex window', async () => {
    // Regression: defaulting `sinceIndex` to 0 dropped every entry, because
    // request indices begin at 1.
    const h = harness()
    defaultDebuggerHandlers(h)
    await h.controller.handle('browser_devtools_network', { action: 'start' })
    h.emit('Network.requestWillBeSent', {
      requestId: 'r1',
      request: { url: 'https://example.com/api/keys', method: 'GET', headers: [] },
      type: 'Fetch',
      timestamp: 1,
    })
    h.emit('Network.responseReceived', {
      requestId: 'r1',
      response: { url: 'https://example.com/api/keys', status: 200, statusText: 'OK', mimeType: 'application/json', headers: [] },
    })

    const listed = await h.controller.handle('browser_devtools_list_requests', {})
    expect(listed.text).toContain('[1] GET https://example.com/api/keys')
    expect(listed.text).toContain('200')

    // The window filter still works when the caller asks for one.
    const after = await h.controller.handle('browser_devtools_list_requests', { sinceIndex: 1 })
    expect(after.text).toContain('No captured requests matched')
  })

  it('explains a stale request index with the capture generation', async () => {
    const h = harness()
    defaultDebuggerHandlers(h)
    await h.controller.handle('browser_devtools_network', { action: 'start' })
    await expect(h.controller.handle('browser_devtools_get_request', { index: 99 }))
      .rejects.toThrow(/No captured request has index 99 in capture generation/)
  })

  it('resets the capture on a top-level navigation', async () => {
    const h = harness()
    defaultDebuggerHandlers(h)
    await h.controller.handle('browser_devtools_network', { action: 'start' })
    h.emit('Network.requestWillBeSent', { requestId: 'r1', request: { url: 'https://example.com/a', method: 'GET' }, timestamp: 1 })
    h.emit('Page.frameNavigated', { frame: { id: 'frame-next' } })
    const listed = await h.controller.handle('browser_devtools_list_requests', {})
    expect(listed.text).toContain('No captured requests matched')
  })

  it('states the pipeline evidence so a silent capture can be explained', async () => {
    const h = harness()
    defaultDebuggerHandlers(h)
    await h.controller.handle('browser_devtools_network', { action: 'start' })
    // Traffic arrives: the store must grow and the event tally must show it.
    h.emit('Network.requestWillBeSent', {
      requestId: 'r1',
      request: { url: 'https://example.com/api', method: 'GET', headers: [] },
      timestamp: 1,
    })
    h.emit('Network.responseReceived', {
      requestId: 'r1',
      response: { url: 'https://example.com/api', status: 200, statusText: 'OK', mimeType: 'application/json', headers: [] },
    })
    const status = await h.controller.handle('browser_devtools_network', { action: 'status' })
    expect(status.text).toContain('Network capture active')
    expect(status.text).toContain('Captured requests: 1')
    expect(status.text).toContain('Pipeline: attached=true')
    expect(status.text).toContain('domains=DOM+CSS+Runtime+Network')
    expect(status.text).toContain('Network.requestWillBeSent×1')

    // The evidence line must name the network event kinds the page emitted, so
    // a capture that Chrome leaves thin is explainable rather than mysterious.
    expect(status.text).toContain('network events=requestWillBeSent×1, responseReceived×1')

    // With no traffic at all the line must say so rather than imply capture broke.
    const quiet = harness()
    defaultDebuggerHandlers(quiet)
    await quiet.controller.handle('browser_devtools_network', { action: 'start' })
    const quietStatus = await quiet.controller.handle('browser_devtools_network', { action: 'status' })
    expect(quietStatus.text).toContain('cdp events=none received')
    expect(quietStatus.text).toContain('network events=none')
  })

  it('reports capture status and detaches on demand', async () => {
    const h = harness()
    defaultDebuggerHandlers(h)
    await h.controller.handle('browser_devtools_network', { action: 'start' })
    expect(h.controller.state()).toMatchObject({ supported: true, attached: true, tabId: 42 })

    await h.controller.detachAll()
    expect(h.controller.state().attached).toBe(false)

    h.controller.releaseTab(42)
    expect(h.controller.state().attached).toBe(false)
  })

  it('revokes and resumes the capability with the setting', async () => {
    const h = harness()
    defaultDebuggerHandlers(h)
    await h.controller.handle('browser_console_logs', {})
    await h.controller.revoke()
    expect(h.detach).toHaveBeenCalled()
    await expect(h.controller.handle('browser_console_logs', {})).rejects.toThrow(/revoked/)
    h.controller.resume()
    await expect(h.controller.handle('browser_console_logs', {})).resolves.toBeTruthy()
  })

  it('prewarms a debuggable controlled tab', async () => {
    const h = harness()
    defaultDebuggerHandlers(h)
    await h.controller.prewarm(42)
    expect(h.attach).toHaveBeenCalledTimes(1)
    expect(h.controller.state().attached).toBe(true)
  })

  it('rejects an unknown operation', async () => {
    const h = harness()
    defaultDebuggerHandlers(h)
    await expect(h.controller.handle('browser_devtools_nope', {})).rejects.toThrow(/Unknown developer-tools operation/)
  })
})
