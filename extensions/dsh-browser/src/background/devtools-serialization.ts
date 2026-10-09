/**
 * Pure formatting helpers for the developer-tools tools.
 *
 * Everything a CDP command or event returns is either page-authored, transport
 * detail, or a protocol object; this module turns those into bounded,
 * model-readable text. It is deliberately free of Chrome APIs and of I/O so the
 * whole presentation layer is unit-testable.
 *
 * @module
 */

/** Header names whose values never reach the model unless the user opts in per call. */
const SENSITIVE_HEADERS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'proxy-authorization',
  'x-csrf-token',
  'x-xsrf-token',
  'x-api-key',
  'api-key',
  'x-auth-token',
  'x-access-token',
  'x-session-token',
])

/** URL shapes whose bodies are redacted by default (credentials travel there). */
const SENSITIVE_BODY_URL = /(?:^|[^a-z])(auth|login|logout|signin|sign-in|signup|register|oauth|token|session|password|passwd|credential|apikey|api-key)(?:[^a-z]|$)/i

/** One CDP header entry as `Network`/`Fetch` report it. */
export interface CdpHeader {
  name: string
  value: string
}

/** Redaction marker used in place of a hidden value. */
export const REDACTED = '[redacted]'

/** Whether a header name is treated as a credential carrier. */
export function isSensitiveHeader(name: string): boolean {
  return SENSITIVE_HEADERS.has(name.trim().toLowerCase())
}

/** Whether a request URL suggests a body that should be redacted by default. */
export function isSensitiveBodyUrl(url: string): boolean {
  return SENSITIVE_BODY_URL.test(url)
}

/**
 * Render a CDP header list as indented lines.
 * @param headers - header entries in wire order.
 * @param sensitive - when false (default) credential-bearing values are masked.
 * @returns one line per header.
 */
export function formatHeaders(headers: readonly CdpHeader[] | undefined, sensitive = false): string[] {
  if (headers === undefined || headers.length === 0) return ['  (none)']
  return headers.map((header) => {
    const value = !sensitive && isSensitiveHeader(header.name) ? REDACTED : header.value
    return `  ${header.name}: ${value}`
  })
}

/** Truncate text and state the original length when it was cut. */
export function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, Math.max(0, maxChars))}\n…(truncated; ${text.length} characters total)`
}

/**
 * Pretty-print JSON when possible, otherwise return the text unchanged.
 * @param text - candidate JSON text.
 * @returns the formatted body and whether it parsed.
 */
export function formatBody(text: string): { text: string; json: boolean } {
  const trimmed = text.trim()
  if (trimmed === '' || (trimmed[0] !== '{' && trimmed[0] !== '[')) return { text, json: false }
  try {
    return { text: JSON.stringify(JSON.parse(trimmed), null, 2), json: true }
  } catch {
    return { text, json: false }
  }
}

/** Human-readable property list from a CDP `RemoteObject` preview. */
export function previewProperties(value: unknown): string {
  const preview = (value as { preview?: { properties?: { name: string; type: string; value?: string }[]; overflow?: boolean } } | null)?.preview
  if (preview?.properties === undefined || preview.properties.length === 0) return ''
  const parts = preview.properties.map((property) => {
    const rendered = property.value === undefined ? property.type : property.value
    return `${property.name}: ${rendered}`
  })
  return `{${parts.join(', ')}${preview.overflow === true ? ', …' : ''}}`
}

/**
 * A short description of a CDP `RemoteObject` when no value could be returned.
 *
 * `description` already names the type (`Object`, `Map(2)`, a function source),
 * so it is used alone when present; only a value-less object carries a `type`
 * that reads like a label ("object", "function").
 */
export function describeRemoteObject(value: unknown): string {
  const remote = value as { type?: string; subtype?: string; className?: string; description?: string } | null
  if (remote === null || remote === undefined) return 'undefined'
  const description = remote.description ?? remote.className ?? ''
  if (description !== '') return description
  return remote.subtype ?? remote.type ?? 'value'
}

/**
 * Render the value of one `Runtime.evaluate` result.
 * @param result - the command's `result` field.
 * @param options - preview and character budget.
 * @returns the model-facing text plus whether the value round-tripped by value.
 */
export function formatEvaluationResult(
  result: unknown,
  options: { maxChars: number; includePreview: boolean },
): { text: string; byValue: boolean } {
  const remote = result as { type?: string; subtype?: string; value?: unknown; unserializableValue?: string; description?: string } | null
  if (remote === null || remote === undefined) return { text: 'undefined', byValue: true }
  if (remote.type === 'undefined') return { text: 'undefined (the expression produced no value)', byValue: true }
  if (remote.unserializableValue !== undefined) return { text: remote.unserializableValue, byValue: true }
  if (remote.type === 'string') return { text: String(remote.value ?? remote.description ?? ''), byValue: true }
  if (remote.type === 'boolean' || remote.type === 'number' || remote.type === 'bigint') {
    return { text: String(remote.value ?? remote.description ?? ''), byValue: true }
  }
  if (remote.subtype === 'null') return { text: 'null', byValue: true }

  const lines: string[] = []
  if (remote.type === 'function') {
    lines.push(`function: ${remote.description ?? '(anonymous)'}`)
  } else if ('value' in remote && remote.value !== undefined) {
    try {
      lines.push(truncateText(JSON.stringify(remote.value, null, 2), options.maxChars))
    } catch {
      lines.push(describeRemoteObject(remote))
    }
  } else {
    lines.push(describeRemoteObject(remote))
  }
  if (options.includePreview) {
    const preview = previewProperties(remote)
    if (preview !== '') lines.push(preview)
  }
  return { text: lines.join('\n'), byValue: false }
}

/**
 * Render one `Runtime.evaluate` result including its exception, if any.
 * @param response - the raw command result.
 * @param options - preview and character budget.
 * @returns the model-facing text and whether the evaluation completed.
 */
export function formatEvaluation(
  response: unknown,
  options: { maxChars: number; includePreview: boolean },
): { text: string; ok: boolean } {
  const payload = (response ?? {}) as { result?: unknown; exceptionDetails?: unknown }
  if (payload.exceptionDetails !== undefined) {
    return { text: formatException(payload.exceptionDetails), ok: false }
  }
  const formatted = formatEvaluationResult(payload.result, options)
  return { text: formatted.text, ok: true }
}

/** Render CDP `ExceptionDetails` (thrown value, text, stack) as text. */
export function formatException(details: unknown): string {
  const exception = details as {
    text?: string
    lineNumber?: number
    columnNumber?: number
    url?: string
    exception?: { description?: string; value?: unknown }
    stackTrace?: { callFrames?: { functionName?: string; url?: string; lineNumber?: number; columnNumber?: number }[] }
  } | null
  if (exception === null || exception === undefined) return 'Evaluation failed with no details.'
  const lines: string[] = []
  const thrown = exception.exception?.description
    ?? (exception.exception?.value === undefined ? undefined : safeStringify(exception.exception.value))
  lines.push(`Evaluation threw: ${thrown ?? exception.text ?? 'unknown error'}`)
  const location = exception.url === undefined || exception.lineNumber === undefined
    ? ''
    : ` at ${exception.url}:${exception.lineNumber + 1}:${(exception.columnNumber ?? 0) + 1}`
  if (location !== '') lines.push(`Thrown${location}`)
  for (const frame of exception.stackTrace?.callFrames?.slice(0, 8) ?? []) {
    lines.push(`  at ${frame.functionName === '' ? '(anonymous)' : frame.functionName ?? '(anonymous)'} (${frame.url ?? '?'}:${(frame.lineNumber ?? 0) + 1}:${(frame.columnNumber ?? 0) + 1})`)
  }
  return lines.join('\n')
}

/**
 * Render the arguments of one `Runtime.consoleAPICalled` event.
 * @param args - CDP `RemoteObject` arguments.
 * @returns a single readable line body.
 */
export function formatConsoleArguments(args: readonly unknown[] | undefined): string {
  if (args === undefined || args.length === 0) return '(no arguments)'
  return args.map((argument) => {
    const remote = argument as { type?: string; subtype?: string; value?: unknown; description?: string; unserializableValue?: string } | null
    if (remote === null || remote === undefined) return 'undefined'
    if (remote.type === 'string') return String(remote.value ?? '')
    if (remote.unserializableValue !== undefined) return remote.unserializableValue
    if (remote.value !== undefined && (remote.type === 'number' || remote.type === 'boolean')) return String(remote.value)
    if (remote.description !== undefined) return remote.description
    if (remote.value === undefined) return remote.type ?? 'value'
    return safeStringify(remote.value)
  }).join(' ')
}

/** Serializable timing breakdown in milliseconds, relative to request start. */
export interface TimingSummary {
  dns: number
  connect: number
  tls: number
  wait: number
  receive: number
  total: number
}

/**
 * Convert CDP `ResourceTiming` into relative millisecond phases.
 * @param timing - the response timing object.
 * @returns phase durations, or undefined when timing is unavailable.
 */
export function summarizeTiming(timing: unknown): TimingSummary | undefined {
  const value = timing as Partial<{
    requestTime: number
    dnsStart: number
    dnsEnd: number
    connectStart: number
    connectEnd: number
    sslStart: number
    sslEnd: number
    sendStart: number
    sendEnd: number
    receiveHeadersStart: number
    receiveHeadersEnd: number
  }> | null
  if (value === null || value === undefined || typeof value.requestTime !== 'number') return undefined
  const ms = (from: number | undefined, to: number | undefined): number => {
    if (typeof from !== 'number' || typeof to !== 'number' || from < 0 || to < 0 || to < from) return 0
    return Math.round((to - from) * 1000 * 10) / 10
  }
  const dns = ms(value.dnsStart, value.dnsEnd)
  const connect = ms(value.connectStart, value.connectEnd)
  const tls = ms(value.sslStart, value.sslEnd)
  const receiveHeadersStart = typeof value.receiveHeadersStart === 'number' ? value.receiveHeadersStart : value.sendEnd
  const wait = ms(receiveHeadersStart, value.receiveHeadersEnd)
  // `requestTime` and the phase values share the monotonic clock, so the total
  // is request-start to headers-received. Negative deltas (clock skew, missing
  // phases) collapse to zero instead of reporting nonsense.
  const totalMs = typeof value.receiveHeadersEnd === 'number' && value.receiveHeadersEnd >= value.requestTime
    ? Math.round((value.receiveHeadersEnd - value.requestTime) * 1000 * 10) / 10
    : 0
  return {
    dns,
    connect,
    tls,
    wait,
    receive: 0,
    total: totalMs,
  }
}

/**
 * Render a timing breakdown as one line.
 * @param timing - phase breakdown from `ResourceTiming`.
 * @param measuredMs - measured request duration, used when the phases carry no
 *   usable total (a cache hit reports zeros, which reads as "instant").
 */
export function formatTiming(timing: TimingSummary | undefined, measuredMs?: number): string {
  const measured = measuredMs === undefined ? '' : ` · measured ${measuredMs}ms`
  if (timing === undefined) return `timing unavailable${measured}`
  const total = timing.total > 0 ? timing.total : measuredMs
  const renderedTotal = total === undefined || total === 0 ? 'unavailable' : `${total}ms`
  return `dns ${timing.dns}ms · connect ${timing.connect}ms · tls ${timing.tls}ms · wait ${timing.wait}ms · total ${renderedTotal}`
}

/** Format a byte count for display. */
export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '?'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

/** JSON.stringify that never throws on cycles or exotic values. */
export function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return Object.prototype.toString.call(value)
  }
}
