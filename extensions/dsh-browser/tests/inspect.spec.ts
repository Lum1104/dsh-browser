// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  consoleFromApiCall,
  consoleFromException,
  consoleFromLogEntry,
  isTextResponse,
  rankRequests,
  renderInspection,
  startInspection,
  InspectError,
  type InspectDeps,
  type InspectionReport,
} from '../src/background/inspect.ts'

type EventListener = (source: chrome.debugger.Debuggee, method: string, params?: object) => void

function makeDeps(overrides: Partial<InspectDeps> = {}) {
  const listeners = new Set<EventListener>()
  const sent: { method: string; params?: object }[] = []
  const lifecycle: string[] = []
  const deps: InspectDeps = {
    hasPermission: async () => true,
    attach: async () => { lifecycle.push('attach') },
    detach: async () => { lifecycle.push('detach') },
    send: async (_target, method, params) => {
      sent.push({ method, ...(params === undefined ? {} : { params }) })
      if (method === 'Network.getResponseBody') return { body: '{"ok":true}', base64Encoded: false }
      return undefined
    },
    onEvent: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    delay: async () => {},
    ...overrides,
  }
  const emit = (method: string, params: object, tabId = 7): void => {
    for (const listener of [...listeners]) listener({ tabId }, method, params)
  }
  return { deps, emit, sent, lifecycle, listeners }
}

describe('startInspection', () => {
  it('enables the domains it needs and detaches when finished', async () => {
    const { deps, sent, lifecycle, listeners } = makeDeps()
    const session = await startInspection(7, deps)
    expect(sent.map((entry) => entry.method)).toEqual(['Runtime.enable', 'Log.enable', 'Network.enable'])

    await session.finish()
    expect(lifecycle).toEqual(['attach', 'detach'])
    // The listener must go with the attachment, or a later session double-counts.
    expect(listeners.size).toBe(0)
  })

  it('refuses without the optional permission, and never attaches', async () => {
    const { deps, lifecycle } = makeDeps({ hasPermission: async () => false })
    await expect(startInspection(7, deps)).rejects.toThrow(InspectError)
    expect(lifecycle).toEqual([])
  })

  it('explains an attach conflict with DevTools', async () => {
    const { deps } = makeDeps({ attach: async () => { throw new Error('Another debugger is already attached') } })
    await expect(startInspection(7, deps)).rejects.toThrow(/DevTools may be open/)
  })

  it('collects console output, exceptions, and browser log entries', async () => {
    const { deps, emit } = makeDeps()
    const session = await startInspection(7, deps)

    emit('Runtime.consoleAPICalled', {
      type: 'error',
      args: [{ type: 'string', value: 'save failed' }, { type: 'number', value: 42 }],
      stackTrace: { callFrames: [{ url: 'https://app.example/main.js', lineNumber: 10, columnNumber: 4 }] },
    })
    emit('Runtime.exceptionThrown', {
      exceptionDetails: {
        text: 'Uncaught',
        exception: { description: 'TypeError: x is not a function' },
        stackTrace: { callFrames: [{ url: 'https://app.example/a.js', lineNumber: 0 }] },
      },
    })
    emit('Log.entryAdded', { entry: { level: 'warning', text: 'CSP violation', url: 'https://app.example/' } })

    const report = await session.finish()
    expect(report.console).toEqual([
      { level: 'error', text: 'save failed 42', source: 'https://app.example/main.js:11:5' },
      { level: 'error', text: 'Uncaught TypeError: x is not a function', source: 'https://app.example/a.js:1' },
      { level: 'warning', text: 'CSP violation', source: 'https://app.example/' },
    ])
  })

  it('ignores events from other tabs', async () => {
    const { deps, emit } = makeDeps()
    const session = await startInspection(7, deps)
    emit('Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'mine' }] }, 7)
    emit('Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'theirs' }] }, 99)
    const report = await session.finish()
    expect(report.console.map((entry) => entry.text)).toEqual(['mine'])
  })

  it('assembles a request from its lifecycle events', async () => {
    const { deps, emit } = makeDeps()
    const session = await startInspection(7, deps)
    emit('Network.requestWillBeSent', {
      requestId: 'r1',
      timestamp: 100,
      request: { url: 'https://api.example/orders', method: 'POST' },
    })
    emit('Network.responseReceived', { requestId: 'r1', response: { status: 500, mimeType: 'application/json' } })
    emit('Network.loadingFinished', { requestId: 'r1', timestamp: 100.34, encodedDataLength: 1234 })

    const report = await session.finish()
    expect(report.requests).toEqual([
      { requestId: 'r1', method: 'POST', url: 'https://api.example/orders', status: 500, mimeType: 'application/json', bytes: 1234, ms: 340 },
    ])
  })

  it('records why a request failed, which is the whole point', async () => {
    const { deps, emit } = makeDeps()
    const session = await startInspection(7, deps)
    emit('Network.requestWillBeSent', { requestId: 'r1', request: { url: 'https://a.example/x' } })
    emit('Network.loadingFailed', { requestId: 'r1', errorText: 'net::ERR_CONNECTION_REFUSED' })
    emit('Network.requestWillBeSent', { requestId: 'r2', request: { url: 'https://tracker.example/t' } })
    emit('Network.loadingFailed', { requestId: 'r2', blockedReason: 'inspector' })

    const report = await session.finish()
    expect(report.requests.map((entry) => entry.failure)).toEqual(['net::ERR_CONNECTION_REFUSED', 'blocked: inspector'])
  })

  it('filters by URL and fetches only text bodies', async () => {
    const { deps, emit, sent } = makeDeps()
    const session = await startInspection(7, deps)
    emit('Network.requestWillBeSent', { requestId: 'json', request: { url: 'https://api.example/data' } })
    emit('Network.responseReceived', { requestId: 'json', response: { status: 200, mimeType: 'application/json' } })
    emit('Network.requestWillBeSent', { requestId: 'png', request: { url: 'https://api.example/logo.png' } })
    emit('Network.responseReceived', { requestId: 'png', response: { status: 200, mimeType: 'image/png' } })
    emit('Network.requestWillBeSent', { requestId: 'other', request: { url: 'https://cdn.other/x.js' } })
    emit('Network.responseReceived', { requestId: 'other', response: { status: 200, mimeType: 'text/javascript' } })

    const report = await session.finish({ bodies: true, filter: 'api.example' })
    expect(report.requests.map((entry) => entry.requestId)).toEqual(['json', 'png'])
    expect(report.bodies).toEqual([
      { url: 'https://api.example/data', status: 200, mimeType: 'application/json', text: '{"ok":true}' },
    ])
    const bodyCalls = sent.filter((entry) => entry.method === 'Network.getResponseBody')
    expect(bodyCalls).toHaveLength(1)
  })

  it('detaches on abort without collecting', async () => {
    const { deps, lifecycle, listeners } = makeDeps()
    const session = await startInspection(7, deps)
    await session.abort()
    expect(lifecycle).toEqual(['attach', 'detach'])
    expect(listeners.size).toBe(0)
    // A finish after an abort is inert rather than a second detach.
    expect(await session.finish()).toMatchObject({ console: [], requests: [] })
    expect(lifecycle).toEqual(['attach', 'detach'])
  })

  it('survives a domain the browser refuses to enable', async () => {
    const { deps } = makeDeps({
      send: async (_t, method) => {
        if (method === 'Log.enable') throw new Error('not supported')
        return undefined
      },
    })
    const session = await startInspection(7, deps)
    expect(await session.finish()).toBeDefined()
  })
})

describe('rankRequests', () => {
  it('puts failures first, then error statuses, then JSON', () => {
    const ordered = rankRequests([
      { requestId: 'a', method: 'GET', url: 'a', status: 200, mimeType: 'text/html' },
      { requestId: 'b', method: 'GET', url: 'b', status: 200, mimeType: 'application/json' },
      { requestId: 'c', method: 'GET', url: 'c', status: 404, mimeType: 'text/html' },
      { requestId: 'd', method: 'GET', url: 'd', failure: 'net::ERR' },
    ])
    expect(ordered.map((entry) => entry.requestId)).toEqual(['d', 'c', 'b', 'a'])
  })
})

describe('isTextResponse', () => {
  it('accepts JSON, XML, and text, and rejects binary or failed responses', () => {
    const base = { requestId: 'r', method: 'GET', url: 'u', status: 200 }
    expect(isTextResponse({ ...base, mimeType: 'application/json' })).toBe(true)
    expect(isTextResponse({ ...base, mimeType: 'application/vnd.api+json' })).toBe(true)
    expect(isTextResponse({ ...base, mimeType: 'text/html' })).toBe(true)
    expect(isTextResponse({ ...base, mimeType: 'image/png' })).toBe(false)
    expect(isTextResponse({ ...base, mimeType: 'application/json', failure: 'net::ERR' })).toBe(false)
    expect(isTextResponse(base)).toBe(false)
  })
})

describe('parsers', () => {
  it('drop events that carry nothing readable', () => {
    expect(consoleFromApiCall({ type: 'log', args: [] })).toBeUndefined()
    expect(consoleFromException({})).toBeUndefined()
    expect(consoleFromLogEntry({ entry: { level: 'info' } })).toBeUndefined()
  })

  it('normalize unfamiliar console levels instead of passing them through', () => {
    expect(consoleFromApiCall({ type: 'assert', args: [{ value: 'x' }] })?.level).toBe('error')
    expect(consoleFromApiCall({ type: 'table', args: [{ value: 'x' }] })?.level).toBe('log')
    expect(consoleFromApiCall({ type: 'verbose', args: [{ value: 'x' }] })?.level).toBe('debug')
  })
})

describe('renderInspection', () => {
  const empty: InspectionReport = { console: [], requests: [], bodies: [], dropped: { console: 0, requests: 0 } }

  it('says a page was quiet rather than returning an empty block', () => {
    const text = renderInspection(empty, 'Recorded 2500ms:')
    expect(text).toContain('Console: no messages.')
    expect(text).toContain('Network: no requests.')
  })

  it('reports counts, drops, and the body hint', () => {
    const text = renderInspection({
      console: [{ level: 'error', text: 'boom', source: 'app.js:1' }],
      requests: [
        { requestId: 'a', method: 'POST', url: 'https://api.example/x', status: 500, mimeType: 'application/json', bytes: 2048, ms: 120 },
      ],
      bodies: [],
      dropped: { console: 5, requests: 3 },
    }, 'Recorded:')
    expect(text).toContain('[error] boom  (app.js:1)')
    expect(text).toContain('5 more dropped')
    expect(text).toContain('3 more dropped')
    expect(text).toContain('POST 500 application/json 2.0 KB 120ms https://api.example/x')
    expect(text).toContain('Pass bodies: true')
  })

  it('marks a failure so it cannot be mistaken for a status', () => {
    const text = renderInspection({
      ...empty,
      requests: [{ requestId: 'a', method: 'GET', url: 'https://a.example/x', failure: 'net::ERR_FAILED' }],
    }, 'Recorded:')
    expect(text).toContain('! net::ERR_FAILED')
  })

  it('includes a body with its source labelled', () => {
    const text = renderInspection({
      ...empty,
      requests: [{ requestId: 'a', method: 'GET', url: 'https://api.example/d', status: 200, mimeType: 'application/json' }],
      bodies: [{ url: 'https://api.example/d', status: 200, mimeType: 'application/json', text: '{"a":1}' }],
    }, 'Recorded:')
    expect(text).toContain('--- body of https://api.example/d (200, application/json) ---')
    expect(text).toContain('{"a":1}')
    expect(text).not.toContain('Pass bodies: true')
  })
})
