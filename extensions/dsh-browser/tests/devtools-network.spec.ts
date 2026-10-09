// @vitest-environment jsdom
/**
 * Developer-tools network capture: folding CDP events into a bounded request
 * log, plus the console buffer the same session feeds.
 */

import { describe, expect, it } from 'vitest'
import { CONSOLE_BUFFER_LIMIT, NETWORK_BUFFER_LIMIT, NetworkCapture } from '../src/background/devtools-network.ts'

function capture(): NetworkCapture {
  const store = new NetworkCapture()
  store.start(7)
  return store
}

const REQUEST = {
  requestId: 'r1',
  request: { url: 'https://example.com/api/items', method: 'POST', headers: [{ name: 'accept', value: '*/*' }], postData: '{"a":1}', hasPostData: true },
  type: 'Fetch',
  timestamp: 10,
  frameId: 'frame-1',
  initiator: { type: 'script', url: 'https://example.com/app.js' },
}

describe('NetworkCapture', () => {
  it('assembles one request/response pair', () => {
    const store = capture()
    store.ingest('Network.requestWillBeSent', REQUEST)
    store.ingest('Network.responseReceived', {
      requestId: 'r1',
      type: 'Fetch',
      response: {
        url: 'https://example.com/api/items',
        status: 201,
        statusText: 'Created',
        mimeType: 'application/json',
        headers: [{ name: 'content-type', value: 'application/json' }],
        encodedDataLength: 128,
        fromServiceWorker: true,
      },
    })
    store.ingest('Network.loadingFinished', { requestId: 'r1', timestamp: 10.25, encodedDataLength: 512 })

    const entries = store.list()
    expect(entries).toHaveLength(1)
    const entry = entries[0]!
    expect(entry.index).toBe(1)
    expect(entry.method).toBe('POST')
    expect(entry.status).toBe(201)
    expect(entry.mimeType).toBe('application/json')
    expect(entry.postData).toBe('{"a":1}')
    expect(entry.requestHeaders).toEqual([{ name: 'accept', value: '*/*' }])
    expect(entry.responseHeaders).toEqual([{ name: 'content-type', value: 'application/json' }])
    expect(entry.encodedDataLength).toBe(512)
    expect(entry.durationMs).toBe(250)
    expect(entry.fromServiceWorker).toBe(true)
    expect(entry.finished).toBe(true)
    expect(store.get(1)).toBe(entry)
    expect(store.get(2)).toBeUndefined()
  })

  it('records failures with the blocking reason', () => {
    const store = capture()
    store.ingest('Network.requestWillBeSent', REQUEST)
    store.ingest('Network.loadingFailed', { requestId: 'r1', timestamp: 10.1, errorText: 'net::ERR_BLOCKED_BY_CLIENT', blockedReason: 'inspector' })
    const entry = store.list()[0]!
    expect(entry.failed).toBe('net::ERR_BLOCKED_BY_CLIENT')
    expect(entry.blockedReason).toBe('inspector')
    expect(entry.durationMs).toBe(100)
  })

  it('keeps one entry per redirect chain and records each hop', () => {
    const store = capture()
    store.ingest('Network.requestWillBeSent', {
      requestId: 'r1',
      request: { url: 'https://example.com/a', method: 'GET', headers: [] },
      timestamp: 1,
      type: 'Document',
    })
    store.ingest('Network.requestWillBeSent', {
      requestId: 'r1',
      request: { url: 'https://example.com/b', method: 'GET', headers: [] },
      timestamp: 1.05,
      type: 'Document',
      redirectResponse: { url: 'https://example.com/a', status: 302 },
    })
    const entries = store.list()
    expect(entries).toHaveLength(1)
    expect(entries[0]!.url).toBe('https://example.com/b')
    expect(entries[0]!.redirects).toEqual([{ url: 'https://example.com/a', status: 302 }])
  })

  it('drops the oldest entries past the ring-buffer limit', () => {
    const store = capture()
    for (let index = 0; index < NETWORK_BUFFER_LIMIT + 5; index += 1) {
      store.ingest('Network.requestWillBeSent', {
        requestId: `r${index}`,
        request: { url: `https://example.com/${index}`, method: 'GET', headers: [] },
        timestamp: index,
        type: 'XHR',
      })
    }
    const entries = store.list()
    expect(entries).toHaveLength(NETWORK_BUFFER_LIMIT)
    expect(entries[0]!.url).toBe('https://example.com/5')
    expect(entries.at(-1)!.index).toBe(NETWORK_BUFFER_LIMIT + 5)
  })

  it('resets the log and bumps the generation on navigation', () => {
    const store = capture()
    store.ingest('Network.requestWillBeSent', REQUEST)
    expect(store.state()).toMatchObject({ attached: true, tabId: 7, entries: 1, generation: 1 })
    store.ingestNavigation()
    expect(store.state()).toMatchObject({ entries: 0, generation: 2 })
    expect(store.list()).toEqual([])
    // Index numbering restarts with the new generation.
    store.ingest('Network.requestWillBeSent', { ...REQUEST, requestId: 'r2' })
    expect(store.list()[0]!.index).toBe(1)
  })

  it('stops capturing without dropping the captured entries', () => {
    const store = capture()
    store.ingest('Network.requestWillBeSent', REQUEST)
    store.stop()
    expect(store.state().attached).toBe(false)
    expect(store.list()).toHaveLength(1)
  })

  it('records console calls and uncaught exceptions with levels', () => {
    const store = capture()
    store.ingest('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: 'hello' }, { type: 'number', value: 2 }], timestamp: 1 })
    store.ingest('Runtime.consoleAPICalled', { type: 'warning', args: [{ type: 'string', value: 'careful' }], timestamp: 2 })
    store.ingest('Runtime.exceptionThrown', {
      timestamp: 3,
      exceptionDetails: { text: 'Uncaught', exception: { description: 'TypeError: boom' }, url: 'https://example.com/app.js', lineNumber: 4 },
    })
    const entries = store.consoleLog()
    expect(entries).toHaveLength(3)
    expect(entries[0]).toMatchObject({ index: 1, level: 'log', text: 'hello 2' })
    expect(entries[1]).toMatchObject({ index: 2, level: 'warning', text: 'careful' })
    expect(entries[2]!.level).toBe('exception')
    expect(entries[2]!.text).toContain('TypeError: boom')
    expect(entries[2]!.text).toContain('app.js:5')
  })

  it('ignores console types the extension does not surface', () => {
    const store = capture()
    store.ingest('Runtime.consoleAPICalled', { type: 'trace', args: [], timestamp: 1 })
    expect(store.consoleLog()).toEqual([])
  })

  it('caps the console buffer', () => {
    const store = capture()
    for (let index = 0; index < CONSOLE_BUFFER_LIMIT + 10; index += 1) {
      store.ingest('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: `line ${index}` }], timestamp: index })
    }
    const entries = store.consoleLog()
    expect(entries).toHaveLength(CONSOLE_BUFFER_LIMIT)
    expect(entries.at(-1)!.text).toBe(`line ${CONSOLE_BUFFER_LIMIT + 9}`)
    expect(entries[0]!.index).toBe(11)
  })

  it('tracks a request from the extra-info events when Chrome withholds the main one', () => {
    // Verbatim shape observed on a live page: `requestWillBeSent` never fired,
    // only `requestWillBeSentExtraInfo` / `responseReceivedExtraInfo` /
    // `responseReceived`. The old store dropped all three and reported zero.
    const store = capture()
    store.ingest('Network.requestWillBeSentExtraInfo', {
      requestId: 'BFCA0E052B79',
      associatedCookies: [],
      headers: { 'accept': '*/*' },
      connectTiming: { requestTime: 1 },
    })
    expect(store.state().entries).toBe(1)

    store.ingest('Network.responseReceivedExtraInfo', {
      requestId: 'BFCA0E052B79',
      blockedCookies: [],
      headers: { 'content-type': 'application/json' },
      resourceIPAddressSpace: 'Public',
      statusCode: 200,
    })
    store.ingest('Network.responseReceived', {
      requestId: 'BFCA0E052B79',
      type: 'Fetch',
      response: {
        url: 'https://platform.deepseek.com/api/v0/users/get_api_keys',
        status: 200,
        statusText: 'OK',
        mimeType: 'application/json',
        headers: { 'content-type': 'application/json' },
      },
    })
    store.ingest('Network.loadingFinished', { requestId: 'BFCA0E052B79', encodedDataLength: 48 })

    const entry = store.list()[0]!
    expect(entry.index).toBe(1)
    expect(entry.url).toBe('https://platform.deepseek.com/api/v0/users/get_api_keys')
    expect(entry.status).toBe(200)
    expect(entry.mimeType).toBe('application/json')
    expect(entry.resourceType).toBe('Fetch')
    expect(entry.requestHeaders).toEqual([{ name: 'accept', value: '*/*' }])
    expect(entry.encodedDataLength).toBe(48)
    // The main request event never arrived, so the entry stays flagged as
    // incomplete instead of presenting a guessed method as fact.
    expect(entry.pendingRequestEvent).toBe(true)
  })

  it('clears the incomplete flag once the main request event arrives', () => {
    const store = capture()
    store.ingest('Network.requestWillBeSentExtraInfo', { requestId: 'r1', headers: { accept: '*/*' } })
    expect(store.get(1)!.pendingRequestEvent).toBe(true)
    // The main event may arrive late; when it does, the entry is no longer a
    // reconstruction and the flag must go away.
    store.ingest('Network.requestWillBeSent', {
      requestId: 'r1',
      request: { url: 'https://example.com/late', method: 'POST', headers: [{ name: 'accept', value: '*/*' }] },
      type: 'Fetch',
      timestamp: 3,
    })
    const entry = store.get(1)!
    expect(entry.pendingRequestEvent).toBe(false)
    expect(entry.method).toBe('POST')
    expect(entry.url).toBe('https://example.com/late')
  })

  it('adopts a response that arrives with no request event at all', () => {
    const store = capture()
    store.ingest('Network.responseReceived', {
      requestId: 'r-orphan',
      type: 'Document',
      response: { url: 'https://example.com/a', status: 304, statusText: '', mimeType: 'text/html', headers: {} },
    })
    const entry = store.list()[0]!
    expect(entry.url).toBe('https://example.com/a')
    expect(entry.status).toBe(304)
    expect(entry.pendingRequestEvent).toBe(true)
  })

  it('ignores unknown methods and malformed payloads', () => {
    const store = capture()
    store.ingest('Network.webSocketFrameReceived', { requestId: 'r1' })
    store.ingest('Network.responseReceived', {})
    store.ingest('Network.loadingFinished', { requestId: 'missing' })
    expect(store.list()).toEqual([])
    expect(store.state().entries).toBe(0)
  })
})
