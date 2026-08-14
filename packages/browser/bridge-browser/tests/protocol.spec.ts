import { describe, expect, it } from 'vitest'
import { isClientFrame, isServerFrame, parseBridgeFrame } from '../src/protocol.ts'

describe('parseBridgeFrame', () => {
  it('parses a valid hello frame', () => {
    const frame = parseBridgeFrame(JSON.stringify({ t: 'hello', token: 'abc123', caps: { textOnly: true, snapshotMaxChars: 12000, maxInteractiveItems: 60 } }))
    expect(frame).toEqual({ t: 'hello', token: 'abc123', caps: { textOnly: true, snapshotMaxChars: 12000, maxInteractiveItems: 60 } })
  })

  it('rejects hello with wrong caps shape', () => {
    expect(parseBridgeFrame(JSON.stringify({ t: 'hello', token: 'x', caps: { textOnly: false, snapshotMaxChars: 100, maxInteractiveItems: 10 } }))).toBeUndefined()
    expect(parseBridgeFrame(JSON.stringify({ t: 'hello', token: 'x', caps: { textOnly: true } }))).toBeUndefined()
    expect(parseBridgeFrame(JSON.stringify({ t: 'hello', token: 'x', caps: { textOnly: true, snapshotMaxChars: 0, maxInteractiveItems: 10 } }))).toBeUndefined()
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
    expect(parseBridgeFrame(JSON.stringify({ t: 'tool.call', id: '4', name: 'browser_click', args: { index: 1 } })))
      .toEqual({ t: 'tool.call', id: '4', name: 'browser_click', args: { index: 1 } })
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

  it('parses respond (interaction answer) success and error forms', () => {
    expect(parseBridgeFrame(JSON.stringify({ t: 'respond', id: 'r1', rpcId: 'q1', result: { ok: true, value: { sessionId: 's', answer: { answers: [] } } } })))
      .toEqual({ t: 'respond', id: 'r1', rpcId: 'q1', result: { ok: true, value: { sessionId: 's', answer: { answers: [] } } } })
    expect(parseBridgeFrame(JSON.stringify({ t: 'respond', id: 'r2', rpcId: 'q2', result: { ok: false, error: { code: 'cancelled', message: 'closed' } } })))
      .toEqual({ t: 'respond', id: 'r2', rpcId: 'q2', result: { ok: false, error: { code: 'cancelled', message: 'closed' } } })
    // ok:false without a well-formed error, or ok:true with an error, are malformed.
    expect(parseBridgeFrame(JSON.stringify({ t: 'respond', id: 'r3', rpcId: 'q3', result: { ok: false } }))).toBeUndefined()
    expect(parseBridgeFrame(JSON.stringify({ t: 'respond', id: 'r4', rpcId: 'q4', result: { ok: true, error: { code: 'x', message: 'm' } } }))).toBeUndefined()
    expect(parseBridgeFrame(JSON.stringify({ t: 'respond', id: 'r5', result: { ok: true } }))).toBeUndefined()
    expect(parseBridgeFrame(JSON.stringify({ t: 'respond', rpcId: 'q6', result: { ok: true } }))).toBeUndefined()
  })

  it('parses respond.result success and error forms', () => {
    expect(parseBridgeFrame(JSON.stringify({ t: 'respond.result', id: 'r1', ok: true, result: { accepted: true } })))
      .toEqual({ t: 'respond.result', id: 'r1', ok: true, result: { accepted: true } })
    expect(parseBridgeFrame(JSON.stringify({ t: 'respond.result', id: 'r2', ok: false, error: { code: 'http', message: 'boom' } })))
      .toEqual({ t: 'respond.result', id: 'r2', ok: false, error: { code: 'http', message: 'boom' } })
    expect(parseBridgeFrame(JSON.stringify({ t: 'respond.result', id: 'r3', ok: true }))).toBeUndefined()
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
    const server = parseBridgeFrame(JSON.stringify({ t: 'tool.call', id: '1', name: 'browser_click', args: {} }))!
    const client = parseBridgeFrame(JSON.stringify({ t: 'hello', token: 't', caps: { textOnly: true, snapshotMaxChars: 100, maxInteractiveItems: 10 } }))!
    expect(isServerFrame(server)).toBe(true)
    expect(isClientFrame(server)).toBe(false)
    expect(isServerFrame(client)).toBe(false)
    expect(isClientFrame(client)).toBe(true)
    for (const t of ['hello.ok', 'rpc.result', 'respond.result', 'event', 'tool.call', 'ping', 'error'] as const) {
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
  })
})

/** Minimal valid shape per server-side frame type (for classification tests). */
function serverShape(t: 'hello.ok' | 'rpc.result' | 'respond.result' | 'event' | 'tool.call' | 'ping' | 'error'): Record<string, unknown> {
  switch (t) {
    case 'hello.ok': return { t, caps: { textOnly: true, snapshotMaxChars: 100, maxInteractiveItems: 10 } }
    case 'rpc.result': return { t, id: '1', ok: true, result: {} }
    case 'respond.result': return { t, id: '1', ok: true, result: { accepted: true } }
    case 'event': return { t, frame: { rpcId: 'r', method: 'x', payload: {} } }
    case 'tool.call': return { t, id: '1', name: 'x', args: {} }
    case 'ping': return { t }
    case 'error': return { t, code: 'x', message: 'm' }
  }
}

/** Minimal valid shape per client-side frame type (for classification tests). */
function clientShape(t: 'hello' | 'rpc' | 'respond' | 'tool.result' | 'pong'): Record<string, unknown> {
  switch (t) {
    case 'hello': return { t, token: 'x', caps: { textOnly: true, snapshotMaxChars: 100, maxInteractiveItems: 10 } }
    case 'rpc': return { t, id: '1', method: 'x', payload: {} }
    case 'respond': return { t, id: '1', rpcId: 'q', result: { ok: true, value: {} } }
    case 'tool.result': return { t, id: '1', ok: true, result: {} }
    case 'pong': return { t }
  }
}
