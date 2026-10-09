// @vitest-environment jsdom
/**
 * Developer-tools serialization: RemoteObject/exception rendering, header and
 * body redaction, timing breakdowns, and bounded text.
 */

import { describe, expect, it } from 'vitest'
import {
  describeRemoteObject,
  formatBody,
  formatBytes,
  formatConsoleArguments,
  formatEvaluation,
  formatEvaluationResult,
  formatException,
  formatHeaders,
  formatTiming,
  isSensitiveBodyUrl,
  isSensitiveHeader,
  previewProperties,
  safeStringify,
  summarizeTiming,
  truncateText,
} from '../src/background/devtools-serialization.ts'

describe('header and body redaction', () => {
  it('treats credential carriers as sensitive, case-insensitively', () => {
    expect(isSensitiveHeader('Authorization')).toBe(true)
    expect(isSensitiveHeader(' set-cookie ')).toBe(true)
    expect(isSensitiveHeader('X-Api-Key')).toBe(true)
    expect(isSensitiveHeader('content-type')).toBe(false)
  })

  it('masks sensitive values unless the caller opted in', () => {
    const headers = [
      { name: 'authorization', value: 'Bearer secret' },
      { name: 'accept', value: 'application/json' },
    ]
    expect(formatHeaders(headers)).toEqual([
      '  authorization: [redacted]',
      '  accept: application/json',
    ])
    expect(formatHeaders(headers, true)).toContain('  authorization: Bearer secret')
    expect(formatHeaders(undefined)).toEqual(['  (none)'])
  })

  it('flags authentication-shaped URLs for body redaction', () => {
    expect(isSensitiveBodyUrl('https://example.com/oauth/token')).toBe(true)
    expect(isSensitiveBodyUrl('https://example.com/api/login')).toBe(true)
    expect(isSensitiveBodyUrl('https://example.com/session')).toBe(true)
    expect(isSensitiveBodyUrl('https://example.com/api/items')).toBe(false)
  })
})

describe('text formatting', () => {
  it('truncates with the original length stated', () => {
    const text = 'x'.repeat(50)
    const cut = truncateText(text, 10)
    expect(cut.startsWith('x'.repeat(10))).toBe(true)
    expect(cut).toContain('50 characters total')
    expect(truncateText('short', 10)).toBe('short')
  })

  it('pretty-prints JSON bodies only when they parse', () => {
    expect(formatBody('{"a":1}')).toEqual({ text: '{\n  "a": 1\n}', json: true })
    expect(formatBody('not json')).toEqual({ text: 'not json', json: false })
    expect(formatBody('<html/>')).toEqual({ text: '<html/>', json: false })
  })

  it('formats byte counts', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.00 MB')
    expect(formatBytes(undefined)).toBe('?')
  })

  it('never throws while stringifying exotic values', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(safeStringify(cyclic)).toBe('[object Object]')
    expect(safeStringify({ a: 1 })).toBe('{"a":1}')
  })
})

describe('evaluation rendering', () => {
  it('reports primitives by value', () => {
    expect(formatEvaluationResult({ type: 'string', value: 'hi' }, { maxChars: 100, includePreview: false })).toEqual({ text: 'hi', byValue: true })
    expect(formatEvaluationResult({ type: 'number', value: 42 }, { maxChars: 100, includePreview: false })).toEqual({ text: '42', byValue: true })
    expect(formatEvaluationResult({ type: 'boolean', value: false }, { maxChars: 100, includePreview: false })).toEqual({ text: 'false', byValue: true })
    expect(formatEvaluationResult({ type: 'undefined' }, { maxChars: 100, includePreview: false }).text).toContain('undefined')
    expect(formatEvaluationResult({ type: 'object', subtype: 'null', value: null }, { maxChars: 100, includePreview: false }).text).toBe('null')
    expect(formatEvaluationResult(undefined, { maxChars: 100, includePreview: false }).text).toBe('undefined')
  })

  it('serializes object values as JSON and functions as source', () => {
    const object = formatEvaluationResult({ type: 'object', value: { a: 1 } }, { maxChars: 200, includePreview: false })
    expect(object.text).toBe('{\n  "a": 1\n}')
    expect(object.byValue).toBe(false)
    const fn = formatEvaluationResult({ type: 'function', description: 'function f() {}' }, { maxChars: 200, includePreview: false })
    expect(fn.text).toContain('function: function f() {}')
  })

  it('appends previews only when requested', () => {
    const remote = { type: 'object', description: 'Object', preview: { properties: [{ name: 'a', type: 'number', value: '1' }] } }
    expect(formatEvaluationResult(remote, { maxChars: 200, includePreview: false }).text).not.toContain('{a: 1}')
    expect(formatEvaluationResult(remote, { maxChars: 200, includePreview: true }).text).toContain('{a: 1}')
    expect(previewProperties(remote)).toBe('{a: 1}')
    expect(previewProperties({})).toBe('')
  })

  it('describes unserializable remote objects', () => {
    // `description` already names the type; prefixing it produced "object Object".
    expect(describeRemoteObject({ type: 'object', subtype: 'node', description: 'div#app' })).toBe('div#app')
    expect(describeRemoteObject({ type: 'object', className: 'Map', description: 'Map(2)' })).toBe('Map(2)')
    expect(describeRemoteObject({ type: 'object', description: 'Object' })).toBe('Object')
    // Only a value-less object with no description needs the type as a label.
    expect(describeRemoteObject({ type: 'object' })).toBe('object')
    expect(describeRemoteObject(null)).toBe('undefined')
  })

  it('surfaces exceptions with stack frames instead of a value', () => {
    const result = formatEvaluation({
      exceptionDetails: {
        text: 'Uncaught',
        exception: { description: 'TypeError: boom' },
        url: 'https://example.com/app.js',
        lineNumber: 3,
        columnNumber: 11,
        stackTrace: { callFrames: [{ functionName: 'go', url: 'https://example.com/app.js', lineNumber: 3, columnNumber: 11 }] },
      },
    }, { maxChars: 500, includePreview: false })
    expect(result.ok).toBe(false)
    expect(result.text).toContain('TypeError: boom')
    expect(result.text).toContain('app.js:4:12')
    expect(formatException(null)).toContain('no details')
  })

  it('renders console arguments as one line', () => {
    expect(formatConsoleArguments([
      { type: 'string', value: 'a' },
      { type: 'number', value: 1 },
      { type: 'object', description: 'Object' },
      { type: 'undefined' },
    ])).toBe('a 1 Object undefined')
    expect(formatConsoleArguments([])).toBe('(no arguments)')
    expect(formatConsoleArguments(undefined)).toBe('(no arguments)')
  })
})

describe('timing', () => {
  it('converts CDP seconds into relative millisecond phases', () => {
    // All values share CDP's monotonic seconds clock.
    const timing = summarizeTiming({
      requestTime: 0,
      dnsStart: 0.004,
      dnsEnd: 0.008,
      connectStart: 0.008,
      connectEnd: 0.014,
      sslStart: 0.010,
      sslEnd: 0.013,
      sendStart: 0.014,
      sendEnd: 0.015,
      receiveHeadersStart: 0.015,
      receiveHeadersEnd: 0.025,
    })
    expect(timing).toMatchObject({ dns: 4, connect: 6, tls: 3, wait: 10, total: 25 })
    expect(formatTiming(timing)).toContain('dns 4ms')
  })

  it('falls back to the measured duration when phases report no total', () => {
    // A cache hit reports zeroed phases; "total 0ms" reads as instant and is
    // wrong, so the measured duration stands in.
    expect(formatTiming({ dns: 0, connect: 0, tls: 0, wait: 0, receive: 0, total: 0 }, 41.2)).toContain('total 41.2ms')
    expect(formatTiming({ dns: 0, connect: 0, tls: 0, wait: 1, receive: 0, total: 1 }, 41.2)).toContain('total 1ms')
    expect(formatTiming({ dns: 0, connect: 0, tls: 0, wait: 0, receive: 0, total: 0 })).toContain('total unavailable')
    expect(formatTiming(undefined, 41.2)).toContain('measured 41.2ms')
  })

  it('reports unavailable timing without throwing', () => {
    expect(summarizeTiming(undefined)).toBeUndefined()
    expect(summarizeTiming({})).toBeUndefined()
    expect(formatTiming(undefined)).toBe('timing unavailable')
    // Negative and missing phases collapse to zero rather than nonsense.
    expect(summarizeTiming({ requestTime: 0.010, dnsStart: -1, dnsEnd: 0.005 })).toMatchObject({ dns: 0 })
    // A missing receive phase must not invent a total.
    expect(summarizeTiming({ requestTime: 0.01, dnsStart: 0.011, dnsEnd: 0.012 })).toMatchObject({ total: 0 })
  })
})
