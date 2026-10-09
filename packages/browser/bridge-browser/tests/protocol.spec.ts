import { describe, expect, it } from 'vitest'
import {
  DEVTOOLS_CAPS_VERSION,
  DEVTOOLS_TOOL_NAMES,
  isClientFrame,
  isDevToolsCaps,
  isServerFrame,
  parseBridgeFrame,
} from '../src/protocol.ts'

describe('parseBridgeFrame', () => {
  it('parses a valid hello frame', () => {
    const frame = parseBridgeFrame(JSON.stringify({ t: 'hello', token: 'abc123', caps: { textOnly: true, snapshotMaxChars: 12000, maxInteractiveItems: 60 } }))
    expect(frame).toEqual({ t: 'hello', token: 'abc123', caps: { textOnly: true, snapshotMaxChars: 12000, maxInteractiveItems: 60 } })
  })

  it('accepts the optional developer-tools capability', () => {
    const withDevTools = { textOnly: true, snapshotMaxChars: 12000, maxInteractiveItems: 60, devTools: { version: DEVTOOLS_CAPS_VERSION } }
    expect(parseBridgeFrame(JSON.stringify({ t: 'hello', token: 'x', caps: withDevTools })))
      .toEqual({ t: 'hello', token: 'x', caps: withDevTools })
    // An older extension omits the field and still authenticates.
    const legacy = { textOnly: true, snapshotMaxChars: 12000, maxInteractiveItems: 60 }
    expect(parseBridgeFrame(JSON.stringify({ t: 'hello', token: 'x', caps: legacy }))).toBeDefined()
    // An unknown version is not usable, so the frame is rejected outright.
    expect(parseBridgeFrame(JSON.stringify({ t: 'hello', token: 'x', caps: { ...legacy, devTools: { version: 99 } } }))).toBeUndefined()
    expect(isDevToolsCaps({ version: DEVTOOLS_CAPS_VERSION })).toBe(true)
    expect(isDevToolsCaps({})).toBe(false)
    expect(isDevToolsCaps(undefined)).toBe(false)
  })

  it('exposes the nine documented developer-tools names', () => {
    expect(DEVTOOLS_TOOL_NAMES).toHaveLength(9)
    expect(new Set(DEVTOOLS_TOOL_NAMES).size).toBe(9)
    expect([...DEVTOOLS_TOOL_NAMES]).toContain('browser_console_eval')
  })

  it('rejects hello with wrong caps shape', () => {
    expect(parseBridgeFrame(JSON.stringify({ t: 'hello', token: 'x', caps: { textOnly: false, snapshotMaxChars: 500, maxInteractiveItems: 10 } }))).toBeUndefined()
    expect(parseBridgeFrame(JSON.stringify({ t: 'hello', token: 'x', caps: { textOnly: true } }))).toBeUndefined()
    expect(parseBridgeFrame(JSON.stringify({ t: 'hello', token: 'x', caps: { textOnly: true, snapshotMaxChars: 0, maxInteractiveItems: 10 } }))).toBeUndefined()
    expect(parseBridgeFrame(JSON.stringify({ t: 'hello', token: 'x', caps: { textOnly: true, snapshotMaxChars: 499, maxInteractiveItems: 10 } }))).toBeUndefined()
    expect(parseBridgeFrame(JSON.stringify({ t: 'hello', token: 'x' }))).toBeUndefined()
  })

  it('parses rpc and tool frames', () => {
    expect(parseBridgeFrame(JSON.stringify({ t: 'rpc', id: '1', method: 'session.list', payload: {} })))
      .toEqual({ t: 'rpc', id: '1', method: 'session.list', payload: {} })
    expect(parseBridgeFrame(JSON.stringify({ t: 'tool.result', id: '2', ok: true, result: { text: 'ok' } })))
      .toEqual({ t: 'tool.result', id: '2', ok: true, result: { text: 'ok' } })
    expect(parseBridgeFrame(JSON.stringify({ t: 'tool.result', id: '3', ok: false, error: { code: 'timeout', message: 'm' } })))
      .toEqual({ t: 'tool.result', id: '3', ok: false, error: { code: 'timeout', message: 'm' } })
  })

  it('parses server-side frames the extension receives', () => {
    expect(parseBridgeFrame(JSON.stringify({ t: 'hello.ok', caps: { textOnly: true, snapshotMaxChars: 12000, maxInteractiveItems: 60 } })))
      .toEqual({ t: 'hello.ok', caps: { textOnly: true, snapshotMaxChars: 12000, maxInteractiveItems: 60 } })
    expect(parseBridgeFrame(JSON.stringify({ t: 'event', frame: { rpcId: 'r', method: 'turn/start', payload: {} } })))
      .toEqual({ t: 'event', frame: { rpcId: 'r', method: 'turn/start', payload: {} } })
    expect(parseBridgeFrame(JSON.stringify({ t: 'tool.call', id: '4', name: 'browser_click', args: { index: 1 }, expiresAt: 123, sessionId: 'session-1' })))
      .toEqual({ t: 'tool.call', id: '4', name: 'browser_click', args: { index: 1 }, expiresAt: 123, sessionId: 'session-1' })
    expect(parseBridgeFrame(JSON.stringify({ t: 'tool.cancel', id: '4' })))
      .toEqual({ t: 'tool.cancel', id: '4' })
  })

  it('parses rpc.result success and error forms', () => {
    expect(parseBridgeFrame(JSON.stringify({ t: 'rpc.result', id: '1', ok: true, result: { x: 1 } })))
      .toEqual({ t: 'rpc.result', id: '1', ok: true, result: { x: 1 } })
    expect(parseBridgeFrame(JSON.stringify({ t: 'rpc.result', id: '1', ok: false, error: { code: 'http', message: 'boom' } })))
      .toEqual({ t: 'rpc.result', id: '1', ok: false, error: { code: 'http', message: 'boom' } })
    // ok:true without result, and ok:false without error, are malformed.
    expect(parseBridgeFrame(JSON.stringify({ t: 'rpc.result', id: '1', ok: true }))).toBeUndefined()
    expect(parseBridgeFrame(JSON.stringify({ t: 'rpc.result', id: '1', ok: false }))).toBeUndefined()
  })

  it('parses interaction responses and rejects malformed result unions', () => {
    expect(parseBridgeFrame(JSON.stringify({
      t: 'respond', id: 'response-1', rpcId: 'question-1',
      result: { ok: true, value: { answer: { answers: [] } } },
    }))).toEqual({
      t: 'respond', id: 'response-1', rpcId: 'question-1',
      result: { ok: true, value: { answer: { answers: [] } } },
    })
    expect(parseBridgeFrame(JSON.stringify({
      t: 'respond', id: 'response-2', rpcId: 'question-2',
      result: { ok: false, error: { code: 'cancelled', message: 'closed', details: {} } },
    }))).toEqual({
      t: 'respond', id: 'response-2', rpcId: 'question-2',
      result: { ok: false, error: { code: 'cancelled', message: 'closed', details: {} } },
    })
    expect(parseBridgeFrame(JSON.stringify({
      t: 'respond', id: 'x', rpcId: 'q',
      result: { ok: false, error: { code: 'cancelled', message: 'missing details' } },
    }))).toBeUndefined()
    expect(parseBridgeFrame(JSON.stringify({ t: 'respond', id: 'x', rpcId: 'q', result: { ok: false } }))).toBeUndefined()
    expect(parseBridgeFrame(JSON.stringify({ t: 'respond', id: 'x', rpcId: 'q', result: { ok: true, error: {} } }))).toBeUndefined()
    expect(parseBridgeFrame(JSON.stringify({ t: 'respond', id: 'x', result: { ok: true } }))).toBeUndefined()
  })

  it('parses interaction response receipts', () => {
    expect(parseBridgeFrame(JSON.stringify({ t: 'respond.result', id: 'response-1', ok: true, result: { accepted: true } })))
      .toEqual({ t: 'respond.result', id: 'response-1', ok: true, result: { accepted: true } })
    expect(parseBridgeFrame(JSON.stringify({ t: 'respond.result', id: 'response-2', ok: false, error: { code: 'http', message: 'failed' } })))
      .toEqual({ t: 'respond.result', id: 'response-2', ok: false, error: { code: 'http', message: 'failed' } })
    expect(parseBridgeFrame(JSON.stringify({ t: 'respond.result', id: 'x', ok: true }))).toBeUndefined()
    expect(parseBridgeFrame(JSON.stringify({ t: 'respond.result', id: 'x', ok: false, error: {} }))).toBeUndefined()
  })

  it('parses ping and error frames', () => {
    expect(parseBridgeFrame(JSON.stringify({ t: 'ping' }))).toEqual({ t: 'ping' })
    expect(parseBridgeFrame(JSON.stringify({ t: 'error', code: 'stream-failed', message: 'x' })))
      .toEqual({ t: 'error', code: 'stream-failed', message: 'x' })
    expect(parseBridgeFrame(JSON.stringify({ t: 'error', code: 1, message: 'x' }))).toBeUndefined()
    expect(parseBridgeFrame(JSON.stringify({ t: 'pong' }))).toEqual({ t: 'pong' })
  })

  it('rejects event frames with a non-object payload', () => {
    expect(parseBridgeFrame(JSON.stringify({ t: 'event', frame: null }))).toBeUndefined()
    expect(parseBridgeFrame(JSON.stringify({ t: 'event' }))).toBeUndefined()
  })

  it('classifies frames by sender side', () => {
    const server = parseBridgeFrame(JSON.stringify({ t: 'tool.call', id: '1', name: 'browser_click', args: {}, expiresAt: 123 }))!
    const client = parseBridgeFrame(JSON.stringify({ t: 'hello', token: 't', caps: { textOnly: true, snapshotMaxChars: 500, maxInteractiveItems: 10 } }))!
    expect(isServerFrame(server)).toBe(true)
    expect(isClientFrame(server)).toBe(false)
    expect(isServerFrame(client)).toBe(false)
    expect(isClientFrame(client)).toBe(true)
    for (const t of ['hello.ok', 'rpc.result', 'respond.result', 'event', 'tool.call', 'tool.cancel', 'ping', 'error'] as const) {
      const frame = parseBridgeFrame(JSON.stringify(serverShape(t)))!
      expect(isServerFrame(frame)).toBe(true)
    }
    for (const t of ['hello', 'rpc', 'respond', 'tool.result', 'pong'] as const) {
      const frame = parseBridgeFrame(JSON.stringify(clientShape(t)))!
      expect(isClientFrame(frame)).toBe(true)
    }
  })

  it('rejects malformed payloads', () => {
    expect(parseBridgeFrame('not json')).toBeUndefined()
    expect(parseBridgeFrame(JSON.stringify(null))).toBeUndefined()
    expect(parseBridgeFrame(JSON.stringify([1, 2]))).toBeUndefined()
    expect(parseBridgeFrame(JSON.stringify({}))).toBeUndefined()
    expect(parseBridgeFrame(JSON.stringify({ t: 'nope' }))).toBeUndefined()
    expect(parseBridgeFrame(JSON.stringify({ t: 'rpc', id: 5, method: 'x' }))).toBeUndefined()
    expect(parseBridgeFrame(JSON.stringify({ t: 'tool.result', id: '1', ok: true }))).toBeUndefined()
    expect(parseBridgeFrame(JSON.stringify({ t: 'tool.result', id: 5, ok: true, result: {} }))).toBeUndefined()
    expect(parseBridgeFrame(JSON.stringify({ t: 'rpc.result', id: 5, ok: true, result: {} }))).toBeUndefined()
    expect(parseBridgeFrame(JSON.stringify({ t: 'hello.ok', caps: { textOnly: true } }))).toBeUndefined()
    expect(parseBridgeFrame(JSON.stringify({ t: 'tool.call', id: '1', name: 'x', args: [] }))).toBeUndefined()
    expect(parseBridgeFrame(JSON.stringify({ t: 'tool.call', id: '1', name: 'x', args: {} }))).toBeUndefined()
    expect(parseBridgeFrame(JSON.stringify({ t: 'tool.call', id: '1', name: 'x', args: {}, expiresAt: Number.POSITIVE_INFINITY }))).toBeUndefined()
    expect(parseBridgeFrame(JSON.stringify({ t: 'tool.call', id: '1', name: 'x', args: {}, expiresAt: 123, sessionId: '' }))).toBeUndefined()
    expect(parseBridgeFrame(JSON.stringify({ t: 'tool.cancel', id: 1 }))).toBeUndefined()
  })
})

/** Minimal valid shape per server-side frame type (for classification tests). */
function serverShape(t: 'hello.ok' | 'rpc.result' | 'respond.result' | 'event' | 'tool.call' | 'tool.cancel' | 'ping' | 'error'): Record<string, unknown> {
  switch (t) {
    case 'hello.ok': return { t, caps: { textOnly: true, snapshotMaxChars: 500, maxInteractiveItems: 10 } }
    case 'rpc.result': return { t, id: '1', ok: true, result: {} }
    case 'respond.result': return { t, id: '1', ok: true, result: { accepted: true } }
    case 'event': return { t, frame: { rpcId: 'r', method: 'x', payload: {} } }
    case 'tool.call': return { t, id: '1', name: 'x', args: {}, expiresAt: 123 }
    case 'tool.cancel': return { t, id: '1' }
    case 'ping': return { t }
    case 'error': return { t, code: 'x', message: 'm' }
  }
}

/** Minimal valid shape per client-side frame type (for classification tests). */
function clientShape(t: 'hello' | 'rpc' | 'respond' | 'tool.result' | 'pong'): Record<string, unknown> {
  switch (t) {
    case 'hello': return { t, token: 'x', caps: { textOnly: true, snapshotMaxChars: 500, maxInteractiveItems: 10 } }
    case 'rpc': return { t, id: '1', method: 'x', payload: {} }
    case 'respond': return { t, id: '1', rpcId: 'q', result: { ok: true, value: {} } }
    case 'tool.result': return { t, id: '1', ok: true, result: {} }
    case 'pong': return { t }
  }
}
