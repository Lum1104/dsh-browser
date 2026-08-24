/**
 * Console and network visibility through the DevTools protocol.
 *
 * When a click "does nothing", the answer is almost always in a console
 * exception or a failed request — neither of which is visible in a DOM
 * snapshot. Without them the model can only guess and retry; with them the
 * failure is a fact it can act on.
 *
 * There is a second, larger win: the page usually already fetched the data as
 * JSON. Reading that response is cheaper and cleaner than scraping the
 * rendering of it, so response bodies are part of what this returns.
 *
 * Recording is always a bounded session — attach, enable the domains, collect,
 * detach — because `chrome.debugger` shows a banner on the tab while attached
 * and only reports events from `enable` onward. A session therefore either
 * wraps an action (capture what my click caused) or wraps a reload (capture
 * what the page loads).
 *
 * @module
 */

import { renderWindowFooter, windowText } from '@yuxianglin/dsh-bridge-browser/src/text-window.ts'

/** One console message or uncaught exception. */
export interface ConsoleEntry {
  level: 'error' | 'warning' | 'info' | 'log' | 'debug'
  text: string
  /** Source location, when the protocol reported one. */
  source?: string
}

/** One network request observed during the session. */
export interface RequestEntry {
  requestId: string
  method: string
  url: string
  status?: number
  mimeType?: string
  bytes?: number
  ms?: number
  /** Why it failed, when it did. */
  failure?: string
}

/** One retrieved response body. */
export interface BodyEntry {
  url: string
  status?: number
  mimeType?: string
  text: string
}

/** Everything one session observed. */
export interface InspectionReport {
  console: ConsoleEntry[]
  requests: RequestEntry[]
  bodies: BodyEntry[]
  dropped: { console: number; requests: number }
}

/** What a session should collect before detaching. */
export interface InspectionOptions {
  /** Fetch response bodies for up to {@link MAX_BODIES} text/JSON responses. */
  bodies?: boolean
  /** Only report requests whose URL contains this substring. */
  filter?: string
}

/** Chrome seams, injected so the protocol conversation is testable. */
export interface InspectDeps {
  hasPermission(): Promise<boolean>
  attach(target: chrome.debugger.Debuggee, version: string): Promise<void>
  detach(target: chrome.debugger.Debuggee): Promise<void>
  send(target: chrome.debugger.Debuggee, method: string, params?: object): Promise<unknown>
  /** Subscribe to protocol events; returns an unsubscribe function. */
  onEvent(listener: (source: chrome.debugger.Debuggee, method: string, params?: object) => void): () => void
  delay(ms: number): Promise<void>
}

/** A refusal the model should read and act on. */
export class InspectError extends Error {
  constructor(readonly code: 'permission-missing' | 'attach-failed', message: string) {
    super(message)
    this.name = 'InspectError'
  }
}

const PROTOCOL_VERSION = '1.3'
/** Caps: a report is evidence, not a log file. */
const MAX_CONSOLE = 40
const MAX_REQUESTS = 30
const MAX_BODIES = 3
const MAX_BODY_CHARS = 20_000
/** Mime types worth returning as text. */
const TEXT_MIME = /^(?:application\/(?:json|.*\+json|xml|javascript|x-www-form-urlencoded)|text\/)/i

/** A recording in progress. */
export interface InspectionSession {
  /** Collect, detach, and return what was observed. */
  finish(options?: InspectionOptions): Promise<InspectionReport>
  /** Detach without collecting (used when the wrapped action threw). */
  abort(): Promise<void>
}

/**
 * Attach to one tab and start recording console and network activity.
 *
 * @param tabId - the tab to observe.
 * @param deps - Chrome seams.
 * @returns the live session.
 * @throws InspectError when the permission is absent or attaching fails.
 */
export async function startInspection(tabId: number, deps: InspectDeps): Promise<InspectionSession> {
  if (!await deps.hasPermission()) {
    throw new InspectError(
      'permission-missing',
      'Console and network inspection needs the browser debugging permission, which is not granted. Ask the user to enable it in the dsh side panel settings.',
    )
  }
  const target: chrome.debugger.Debuggee = { tabId }
  try {
    await deps.attach(target, PROTOCOL_VERSION)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    throw new InspectError(
      'attach-failed',
      /already attached|another debugger/i.test(message)
        ? 'The browser debugger is already attached to this tab (DevTools may be open). Close DevTools and try again.'
        : `The browser debugger could not attach to this tab: ${message}`,
    )
  }

  const consoleEntries: ConsoleEntry[] = []
  const requests = new Map<string, RequestEntry>()
  const startedAt = new Map<string, number>()
  let droppedConsole = 0
  let droppedRequests = 0

  const unsubscribe = deps.onEvent((source, method, params) => {
    if (source.tabId !== tabId || params === undefined) return
    switch (method) {
      case 'Runtime.consoleAPICalled':
        push(consoleEntries, consoleFromApiCall(params), () => { droppedConsole += 1 })
        break
      case 'Runtime.exceptionThrown':
        push(consoleEntries, consoleFromException(params), () => { droppedConsole += 1 })
        break
      case 'Log.entryAdded':
        push(consoleEntries, consoleFromLogEntry(params), () => { droppedConsole += 1 })
        break
      case 'Network.requestWillBeSent': {
        const entry = requestFromWillBeSent(params)
        if (entry === undefined) break
        if (requests.size >= MAX_REQUESTS * 4) { droppedRequests += 1; break }
        requests.set(entry.requestId, entry)
        const timestamp = (params as { timestamp?: unknown }).timestamp
        if (typeof timestamp === 'number') startedAt.set(entry.requestId, timestamp)
        break
      }
      case 'Network.responseReceived':
        applyResponse(requests, params)
        break
      case 'Network.loadingFinished':
        applyFinished(requests, startedAt, params)
        break
      case 'Network.loadingFailed':
        applyFailed(requests, startedAt, params)
        break
      default:
        break
    }
  })

  // Enable after subscribing, so nothing between the two is missed.
  for (const domain of ['Runtime.enable', 'Log.enable', 'Network.enable']) {
    try {
      await deps.send(target, domain)
    } catch {
      // A domain the browser refuses simply yields no events of that kind.
    }
  }

  let settled = false
  const release = async (): Promise<void> => {
    settled = true
    unsubscribe()
    try {
      await deps.detach(target)
    } catch {
      // The tab may have closed; there is nothing left to detach from.
    }
  }

  return {
    async finish(options: InspectionOptions = {}): Promise<InspectionReport> {
      if (settled) return emptyReport()
      const filtered = [...requests.values()].filter((entry) => options.filter === undefined
        || entry.url.toLowerCase().includes(options.filter.toLowerCase()))
      const ordered = rankRequests(filtered)
      const bodies = options.bodies === true
        ? await collectBodies(target, ordered, deps)
        : []
      await release()
      return {
        console: consoleEntries.slice(0, MAX_CONSOLE),
        requests: ordered.slice(0, MAX_REQUESTS),
        bodies,
        dropped: {
          console: droppedConsole + Math.max(0, consoleEntries.length - MAX_CONSOLE),
          requests: droppedRequests + Math.max(0, ordered.length - MAX_REQUESTS),
        },
      }
    },
    abort: release,
  }
}

function emptyReport(): InspectionReport {
  return { console: [], requests: [], bodies: [], dropped: { console: 0, requests: 0 } }
}

function push<T>(target: T[], entry: T | undefined, onDrop: () => void): void {
  if (entry === undefined) return
  if (target.length >= MAX_CONSOLE * 4) {
    onDrop()
    return
  }
  target.push(entry)
}

/** CDP console levels are looser than ours; map them onto the reported set. */
function normalizeLevel(value: unknown): ConsoleEntry['level'] {
  switch (value) {
    case 'error':
    case 'assert':
      return 'error'
    case 'warning':
    case 'warn':
      return 'warning'
    case 'info':
      return 'info'
    case 'debug':
    case 'verbose':
      return 'debug'
    default:
      return 'log'
  }
}

/** Render one CDP RemoteObject argument as short text. */
function describeArgument(value: unknown): string {
  if (typeof value !== 'object' || value === null) return String(value)
  const object = value as { value?: unknown; description?: unknown; unserializableValue?: unknown; type?: unknown }
  if (object.value !== undefined) {
    return typeof object.value === 'string' ? object.value : JSON.stringify(object.value)
  }
  if (typeof object.description === 'string') return object.description
  if (typeof object.unserializableValue === 'string') return object.unserializableValue
  return typeof object.type === 'string' ? `[${object.type}]` : '[object]'
}

function firstFrame(stack: unknown): string | undefined {
  if (typeof stack !== 'object' || stack === null) return undefined
  const frames = (stack as { callFrames?: unknown }).callFrames
  if (!Array.isArray(frames) || frames.length === 0) return undefined
  const frame = frames[0] as { url?: unknown; lineNumber?: unknown; columnNumber?: unknown }
  if (typeof frame.url !== 'string' || frame.url === '') return undefined
  const line = typeof frame.lineNumber === 'number' ? frame.lineNumber + 1 : undefined
  const column = typeof frame.columnNumber === 'number' ? frame.columnNumber + 1 : undefined
  return `${frame.url}${line === undefined ? '' : `:${line}${column === undefined ? '' : `:${column}`}`}`
}

export function consoleFromApiCall(params: object): ConsoleEntry | undefined {
  const event = params as { type?: unknown; args?: unknown; stackTrace?: unknown }
  const args = Array.isArray(event.args) ? event.args.map(describeArgument) : []
  const text = args.join(' ').trim()
  if (text === '') return undefined
  const source = firstFrame(event.stackTrace)
  return { level: normalizeLevel(event.type), text, ...(source === undefined ? {} : { source }) }
}

export function consoleFromException(params: object): ConsoleEntry | undefined {
  const details = (params as { exceptionDetails?: unknown }).exceptionDetails
  if (typeof details !== 'object' || details === null) return undefined
  const event = details as { text?: unknown; exception?: unknown; stackTrace?: unknown; url?: unknown; lineNumber?: unknown }
  const thrown = event.exception === undefined ? undefined : describeArgument(event.exception)
  const text = [typeof event.text === 'string' ? event.text : '', thrown ?? ''].filter((part) => part !== '').join(' ')
  if (text === '') return undefined
  const source = firstFrame(event.stackTrace)
    ?? (typeof event.url === 'string' && event.url !== ''
      ? `${event.url}${typeof event.lineNumber === 'number' ? `:${event.lineNumber + 1}` : ''}`
      : undefined)
  return { level: 'error', text, ...(source === undefined ? {} : { source }) }
}

export function consoleFromLogEntry(params: object): ConsoleEntry | undefined {
  const entry = (params as { entry?: unknown }).entry
  if (typeof entry !== 'object' || entry === null) return undefined
  const event = entry as { level?: unknown; text?: unknown; url?: unknown; lineNumber?: unknown }
  if (typeof event.text !== 'string' || event.text === '') return undefined
  const source = typeof event.url === 'string' && event.url !== ''
    ? `${event.url}${typeof event.lineNumber === 'number' ? `:${event.lineNumber + 1}` : ''}`
    : undefined
  return { level: normalizeLevel(event.level), text: event.text, ...(source === undefined ? {} : { source }) }
}

function requestFromWillBeSent(params: object): RequestEntry | undefined {
  const event = params as { requestId?: unknown; request?: unknown }
  const request = event.request
  if (typeof event.requestId !== 'string' || typeof request !== 'object' || request === null) return undefined
  const detail = request as { url?: unknown; method?: unknown }
  if (typeof detail.url !== 'string') return undefined
  return {
    requestId: event.requestId,
    method: typeof detail.method === 'string' ? detail.method : 'GET',
    url: detail.url,
  }
}

function applyResponse(requests: Map<string, RequestEntry>, params: object): void {
  const event = params as { requestId?: unknown; response?: unknown }
  if (typeof event.requestId !== 'string') return
  const entry = requests.get(event.requestId)
  if (entry === undefined || typeof event.response !== 'object' || event.response === null) return
  const response = event.response as { status?: unknown; mimeType?: unknown }
  if (typeof response.status === 'number') entry.status = response.status
  if (typeof response.mimeType === 'string') entry.mimeType = response.mimeType
}

function applyFinished(requests: Map<string, RequestEntry>, startedAt: Map<string, number>, params: object): void {
  const event = params as { requestId?: unknown; encodedDataLength?: unknown; timestamp?: unknown }
  if (typeof event.requestId !== 'string') return
  const entry = requests.get(event.requestId)
  if (entry === undefined) return
  if (typeof event.encodedDataLength === 'number') entry.bytes = Math.round(event.encodedDataLength)
  const start = startedAt.get(event.requestId)
  if (typeof event.timestamp === 'number' && start !== undefined) {
    entry.ms = Math.max(0, Math.round((event.timestamp - start) * 1000))
  }
}

function applyFailed(requests: Map<string, RequestEntry>, startedAt: Map<string, number>, params: object): void {
  const event = params as { requestId?: unknown; errorText?: unknown; blockedReason?: unknown; canceled?: unknown; timestamp?: unknown }
  if (typeof event.requestId !== 'string') return
  const entry = requests.get(event.requestId)
  if (entry === undefined) return
  const reason = typeof event.blockedReason === 'string' && event.blockedReason !== ''
    ? `blocked: ${event.blockedReason}`
    : typeof event.errorText === 'string' && event.errorText !== ''
      ? event.errorText
      : event.canceled === true ? 'canceled' : 'failed'
  entry.failure = reason
  const start = startedAt.get(event.requestId)
  if (typeof event.timestamp === 'number' && start !== undefined) {
    entry.ms = Math.max(0, Math.round((event.timestamp - start) * 1000))
  }
}

/** Problems first: a failure or an error status is why the model asked. */
export function rankRequests(entries: readonly RequestEntry[]): RequestEntry[] {
  const weight = (entry: RequestEntry): number => {
    if (entry.failure !== undefined) return 0
    if (entry.status !== undefined && entry.status >= 400) return 1
    if (entry.mimeType !== undefined && /json/i.test(entry.mimeType)) return 2
    return 3
  }
  return [...entries].sort((left, right) => weight(left) - weight(right))
}

/** Whether this response is worth returning as text. */
export function isTextResponse(entry: RequestEntry): boolean {
  return entry.failure === undefined && entry.mimeType !== undefined && TEXT_MIME.test(entry.mimeType)
}

async function collectBodies(
  target: chrome.debugger.Debuggee,
  ordered: readonly RequestEntry[],
  deps: InspectDeps,
): Promise<BodyEntry[]> {
  const bodies: BodyEntry[] = []
  for (const entry of ordered) {
    if (bodies.length >= MAX_BODIES) break
    if (!isTextResponse(entry)) continue
    try {
      const result = await deps.send(target, 'Network.getResponseBody', { requestId: entry.requestId }) as
        { body?: unknown; base64Encoded?: unknown } | undefined
      if (typeof result?.body !== 'string') continue
      const decoded = result.base64Encoded === true ? safeAtob(result.body) : result.body
      if (decoded === undefined || decoded === '') continue
      const view = windowText(decoded, 0, MAX_BODY_CHARS)
      bodies.push({
        url: entry.url,
        ...(entry.status === undefined ? {} : { status: entry.status }),
        ...(entry.mimeType === undefined ? {} : { mimeType: entry.mimeType }),
        text: `${view.text}${renderWindowFooter(view, `browser_get_text on the page, or re-run with filter: "${entry.url.slice(0, 60)}"`)}`,
      })
    } catch {
      // A body already evicted from the protocol buffer is simply unavailable.
    }
  }
  return bodies
}

function safeAtob(value: string): string | undefined {
  try {
    return atob(value)
  } catch {
    return undefined
  }
}

function shortUrl(url: string): string {
  return url.length <= 140 ? url : `${url.slice(0, 137)}…`
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Render a report as the model-facing text.
 *
 * @param report - what the session observed.
 * @param heading - one line describing what was being observed.
 * @returns model-facing text; a quiet page says so rather than returning nothing.
 */
export function renderInspection(report: InspectionReport, heading: string): string {
  const lines: string[] = [heading]

  if (report.console.length === 0) lines.push('Console: no messages.')
  else {
    lines.push(`Console (${report.console.length}${report.dropped.console > 0 ? `, ${report.dropped.console} more dropped` : ''}):`)
    for (const entry of report.console) {
      lines.push(`  [${entry.level}] ${entry.text}${entry.source === undefined ? '' : `  (${entry.source})`}`)
    }
  }

  if (report.requests.length === 0) lines.push('Network: no requests.')
  else {
    lines.push(`Network (${report.requests.length}${report.dropped.requests > 0 ? `, ${report.dropped.requests} more dropped` : ''}; problems first):`)
    for (const entry of report.requests) {
      const status = entry.failure !== undefined
        ? `! ${entry.failure}`
        : entry.status === undefined ? 'pending' : String(entry.status)
      const facts = [
        entry.mimeType,
        entry.bytes === undefined ? undefined : formatBytes(entry.bytes),
        entry.ms === undefined ? undefined : `${entry.ms}ms`,
      ].filter((fact) => fact !== undefined).join(' ')
      lines.push(`  ${entry.method} ${status} ${facts} ${shortUrl(entry.url)}`.replace(/\s+/g, ' '))
    }
  }

  for (const body of report.bodies) {
    lines.push('')
    lines.push(`--- body of ${shortUrl(body.url)} (${body.status ?? '?'}, ${body.mimeType ?? 'unknown'}) ---`)
    lines.push(body.text)
  }
  if (report.bodies.length === 0 && report.requests.some(isTextResponse)) {
    lines.push('(Pass bodies: true to read the JSON or text responses above instead of scraping the page.)')
  }
  return lines.join('\n')
}

/** The live Chrome implementation of the seams above. */
export function chromeInspectDeps(): InspectDeps {
  return {
    hasPermission: () => chrome.permissions.contains({ permissions: ['debugger'] }),
    attach: (target, version) => chrome.debugger.attach(target, version),
    detach: (target) => chrome.debugger.detach(target),
    send: (target, method, params) => chrome.debugger.sendCommand(target, method, params),
    onEvent: (listener) => {
      chrome.debugger.onEvent.addListener(listener)
      return () => { chrome.debugger.onEvent.removeListener(listener) }
    },
    delay: (ms) => new Promise((resolve) => { setTimeout(resolve, ms) }),
  }
}
