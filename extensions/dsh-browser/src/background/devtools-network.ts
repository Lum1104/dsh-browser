/**
 * Network capture for the developer-tools group: folds `Network.*` CDP events
 * into a bounded in-memory request log, plus the bounded console log the
 * `Runtime` domain emits.
 *
 * The store is deliberately passive — it never issues commands — so the same
 * instance can be fed from unit tests with synthetic event payloads.
 *
 * @module
 */

import {
  formatConsoleArguments,
  formatException,
  summarizeTiming,
  type CdpHeader,
  type TimingSummary,
} from './devtools-serialization.ts'

/**
 * Normalize a CDP header collection.
 *
 * `Network.requestWillBeSent` reports headers as an array of name/value pairs
 * while the extra-info and response events report a plain map; both shapes reach
 * this store, so the array form is the single internal representation.
 */
export function toHeaderList(value: unknown): CdpHeader[] {
  if (Array.isArray(value)) return value as CdpHeader[]
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value as Record<string, unknown>).map(([name, header]) => ({
      name,
      value: String(header),
    }))
  }
  return []
}

/** Entries kept per attached tab; the oldest are dropped first. */
export const NETWORK_BUFFER_LIMIT = 200

/** Console entries kept per attached tab. */
export const CONSOLE_BUFFER_LIMIT = 500

/** Redirect hops kept per entry. */
const REDIRECT_LIMIT = 10

/** One captured request/response pair. */
export interface NetworkEntry {
  /** Monotonic index inside the current capture generation; stable for the model. */
  index: number
  requestId: string
  url: string
  method: string
  /** CDP resource type (Document, XHR, Fetch, …). */
  resourceType?: string
  requestHeaders: CdpHeader[]
  /** Request payload when the browser reported it inline. */
  postData?: string
  hasPostData: boolean
  /** Wall-clock-ish monotonic timestamp of `requestWillBeSent` (seconds). */
  startTime: number
  frameId?: string
  initiator?: string
  redirects: { url: string; status: number }[]
  status?: number
  statusText?: string
  mimeType?: string
  responseHeaders: CdpHeader[]
  /** `Network.loadingFinished.encodedDataLength`. */
  encodedDataLength?: number
  /** `Response.encodedDataLength` observed before the body finished loading. */
  headerSize?: number
  timing?: TimingSummary
  fromDiskCache: boolean
  fromServiceWorker: boolean
  /** `Network.loadingFailed` detail, when the request never completed. */
  failed?: string
  blockedReason?: string
  /** Duration in ms between request start and finish/failure. */
  durationMs?: number
  finished: boolean
  /**
   * True while only the extra-info/response events have been seen, so the
   * method and URL may still be stale. Reported to the model rather than
   * silently presented as authoritative.
   */
  pendingRequestEvent?: boolean
}

/** Console event kinds the extension records. */
export type ConsoleLevel = 'log' | 'info' | 'warning' | 'error' | 'exception'

/** One recorded console entry. */
export interface ConsoleEntry {
  index: number
  level: ConsoleLevel
  timestamp: number
  text: string
}

/** Which capture generation a store currently holds; the model can detect resets. */
export interface CaptureState {
  attached: boolean
  tabId?: number
  entries: number
  generation: number
}

/** Either wire shape: the array form or the map form. */
type HeaderList = readonly CdpHeader[] | Record<string, string> | undefined

interface RequestWillBeSentParams {
  requestId?: string
  request?: { url?: string; method?: string; headers?: HeaderList; postData?: string; hasPostData?: boolean }
  type?: string
  timestamp?: number
  frameId?: string
  initiator?: { type?: string; url?: string }
  redirectResponse?: { url?: string; status?: number }
}

/**
 * `Network.requestWillBeSentExtraInfo`.
 *
 * Chrome emits this for requests whose main `Network.requestWillBeSent` event
 * is withheld or arrives late (observed on live pages); it carries the request
 * headers and the request id, which is enough to start tracking the request.
 */
interface RequestExtraInfoParams {
  requestId?: string
  headers?: HeaderList
}

/** `Network.responseReceivedExtraInfo`: headers and status without a `Response`. */
interface ResponseExtraInfoParams {
  requestId?: string
  headers?: HeaderList
  statusCode?: number
  headersText?: string
}

interface ResponseReceivedParams {
  requestId?: string
  type?: string
  response?: {
    url?: string
    status?: number
    statusText?: string
    mimeType?: string
    headers?: HeaderList
    encodedDataLength?: number
    timing?: unknown
    fromDiskCache?: boolean
    fromServiceWorker?: boolean
  }
}

interface LoadingFinishedParams {
  requestId?: string
  timestamp?: number
  encodedDataLength?: number
}

interface LoadingFailedParams {
  requestId?: string
  timestamp?: number
  errorText?: string
  blockedReason?: string
}

interface ConsoleApiParams {
  type?: string
  args?: unknown[]
  timestamp?: number
}

/**
 * Bounded network + console capture for one attached tab.
 *
 * A generation counter increments whenever the log resets (attach or a
 * top-level navigation), so the model can tell "no such index" from "the page
 * navigated and the log started over".
 */
export class NetworkCapture {
  private entries = new Map<string, NetworkEntry>()
  private order: string[] = []
  private sequence = 0
  private generation = 0
  private tabId: number | undefined
  private attached = false
  private consoleEntries: ConsoleEntry[] = []
  private consoleSequence = 0

  /** Mark capture active for a tab and reset the log (a fresh attachment). */
  start(tabId: number): void {
    this.tabId = tabId
    this.attached = true
    this.clear()
  }

  /** Mark capture inactive; the log stays readable until the next start. */
  stop(): void {
    this.attached = false
  }

  /** Drop every captured entry and start a new generation. */
  clear(): void {
    this.entries.clear()
    this.order = []
    this.sequence = 0
    this.consoleEntries = []
    this.consoleSequence = 0
    this.generation += 1
  }

  /** Current capture state for status reporting. */
  state(): CaptureState {
    return {
      attached: this.attached,
      ...(this.tabId === undefined ? {} : { tabId: this.tabId }),
      entries: this.order.length,
      generation: this.generation,
    }
  }

  /** Captured requests in arrival order. */
  list(): NetworkEntry[] {
    return this.order.map((id) => this.entries.get(id)).filter((entry): entry is NetworkEntry => entry !== undefined)
  }

  /** One captured request by its model-facing index. */
  get(index: number): NetworkEntry | undefined {
    return this.order
      .map((id) => this.entries.get(id))
      .find((entry) => entry !== undefined && entry.index === index)
  }

  /** Recorded console entries in arrival order. */
  consoleLog(): ConsoleEntry[] {
    return [...this.consoleEntries]
  }

  /**
   * Fold one CDP event into the store. Unknown methods are ignored so the
   * session can forward everything it observes.
   * @param method - CDP event name.
   * @param params - CDP event payload.
   */
  ingest(method: string, params: unknown): void {
    switch (method) {
      case 'Network.requestWillBeSent':
        this.onRequestWillBeSent(params as RequestWillBeSentParams)
        break
      case 'Network.requestWillBeSentExtraInfo':
        this.onRequestExtraInfo(params as RequestExtraInfoParams)
        break
      case 'Network.responseReceived':
        this.onResponseReceived(params as ResponseReceivedParams)
        break
      case 'Network.responseReceivedExtraInfo':
        this.onResponseExtraInfo(params as ResponseExtraInfoParams)
        break
      case 'Network.loadingFinished':
        this.onLoadingFinished(params as LoadingFinishedParams)
        break
      case 'Network.loadingFailed':
        this.onLoadingFailed(params as LoadingFailedParams)
        break
      case 'Runtime.consoleAPICalled':
        this.onConsoleApi(params as ConsoleApiParams)
        break
      case 'Runtime.exceptionThrown':
        this.onExceptionThrown(params)
        break
      default:
        break
    }
  }

  /** A new top-level document means every previous index is stale. */
  ingestNavigation(): void {
    this.clear()
  }

  private onRequestWillBeSent(params: RequestWillBeSentParams): void {
    const requestId = params.requestId
    if (requestId === undefined) return
    const existing = this.entries.get(requestId)
    if (existing !== undefined && params.redirectResponse !== undefined) {
      // A redirect reuses the request id: keep one entry and record each hop,
      // including where the overwritten request had been heading.
      if (existing.redirects.length < REDIRECT_LIMIT) {
        existing.redirects.push({ url: existing.url, status: params.redirectResponse.status ?? 0 })
      }
      existing.failed = undefined
      delete existing.status
      this.applyRequest(existing, params)
      return
    }
    const entry = existing ?? this.createEntry(requestId, params)
    entry.pendingRequestEvent = false
    this.applyRequest(entry, params)
    if (existing === undefined) this.push(entry)
  }

  /** The one place entry indices are minted. */
  private createEntryFromId(requestId: string): NetworkEntry {
    this.sequence += 1
    return {
      index: this.sequence,
      requestId,
      url: '',
      method: 'GET',
      requestHeaders: [],
      hasPostData: false,
      startTime: 0,
      redirects: [],
      responseHeaders: [],
      fromDiskCache: false,
      fromServiceWorker: false,
      finished: false,
    }
  }

  private createEntry(requestId: string, params: RequestWillBeSentParams): NetworkEntry {
    const entry = this.createEntryFromId(requestId)
    entry.url = params.request?.url ?? ''
    entry.method = params.request?.method ?? 'GET'
    entry.requestHeaders = toHeaderList(params.request?.headers)
    entry.hasPostData = params.request?.hasPostData === true
    entry.startTime = params.timestamp ?? 0
    return entry
  }

  private applyRequest(entry: NetworkEntry, params: RequestWillBeSentParams): void {
    if (params.request?.url !== undefined) entry.url = params.request.url
    if (params.request?.method !== undefined) entry.method = params.request.method
    if (params.request?.headers !== undefined) entry.requestHeaders = toHeaderList(params.request.headers)
    if (params.request?.postData !== undefined) entry.postData = params.request.postData
    if (params.request?.hasPostData === true) entry.hasPostData = true
    if (params.type !== undefined) entry.resourceType = params.type
    if (params.frameId !== undefined) entry.frameId = params.frameId
    if (params.initiator !== undefined) {
      entry.initiator = params.initiator.type === undefined
        ? params.initiator.url
        : `${params.initiator.type}${params.initiator.url === undefined ? '' : ` ${params.initiator.url}`}`
    }
  }

  /**
   * Start tracking a request from its extra-info event when the main
   * `requestWillBeSent` never arrives. Reporting the traffic matters more than
   * insisting on the one event Chrome does not always send.
   */
  private onRequestExtraInfo(params: RequestExtraInfoParams): void {
    const requestId = params.requestId
    if (requestId === undefined) return
    if (this.entries.has(requestId)) {
      const existing = this.entries.get(requestId)!
      if (params.headers !== undefined && existing.requestHeaders.length === 0) {
        existing.requestHeaders = toHeaderList(params.headers)
      }
      return
    }
    const entry = this.createEntryFromId(requestId)
    entry.requestHeaders = toHeaderList(params.headers)
    // Marked so the model knows why the request line has no method or URL yet.
    entry.pendingRequestEvent = true
    this.push(entry)
  }

  private onResponseReceived(params: ResponseReceivedParams): void {
    const requestId = params.requestId
    if (requestId === undefined) return
    const response = params.response
    if (response === undefined) return
    const entry = this.entries.get(requestId) ?? this.adoptResponse(requestId, response, params.type)
    if (entry === undefined) return
    if (response.url !== undefined) entry.url = response.url
    entry.status = response.status
    entry.statusText = response.statusText
    entry.mimeType = response.mimeType
    entry.responseHeaders = toHeaderList(response.headers)
    entry.headerSize = response.encodedDataLength
    entry.fromDiskCache = response.fromDiskCache === true
    entry.fromServiceWorker = response.fromServiceWorker === true
    if (params.type !== undefined) entry.resourceType = params.type
    entry.timing = summarize(response.timing)
  }

  /** Fold a headers-only response event into an existing (or new) entry. */
  private onResponseExtraInfo(params: ResponseExtraInfoParams): void {
    const requestId = params.requestId
    if (requestId === undefined) return
    const entry = this.entries.get(requestId) ?? this.createEntryFromId(requestId)
    if (!this.entries.has(requestId)) this.push(entry)
    entry.responseHeaders = toHeaderList(params.headers)
    if (typeof params.statusCode === 'number' && entry.status === undefined) entry.status = params.statusCode
  }

  /** Build an entry from a response alone, when no request event was seen. */
  private adoptResponse(
    requestId: string,
    response: { url?: string; mimeType?: string },
    resourceType?: string,
  ): NetworkEntry | undefined {
    const entry = this.createEntryFromId(requestId)
    if (response.url !== undefined) entry.url = response.url
    if (response.mimeType !== undefined) entry.mimeType = response.mimeType
    if (resourceType !== undefined) entry.resourceType = resourceType
    entry.pendingRequestEvent = true
    this.push(entry)
    return entry
  }

  private onLoadingFinished(params: LoadingFinishedParams): void {
    const requestId = params.requestId
    if (requestId === undefined) return
    const entry = this.entries.get(requestId)
    if (entry === undefined) return
    entry.encodedDataLength = params.encodedDataLength
    entry.finished = true
    if (params.timestamp !== undefined && entry.startTime > 0) {
      entry.durationMs = round(params.timestamp - entry.startTime)
    }
  }

  private onLoadingFailed(params: LoadingFailedParams): void {
    const requestId = params.requestId
    if (requestId === undefined) return
    const entry = this.entries.get(requestId)
    if (entry === undefined) return
    entry.failed = params.errorText ?? 'request failed'
    if (params.blockedReason !== undefined) entry.blockedReason = params.blockedReason
    if (params.timestamp !== undefined && entry.startTime > 0) {
      entry.durationMs = round(params.timestamp - entry.startTime)
    }
  }

  private onConsoleApi(params: ConsoleApiParams): void {
    const level = consoleLevel(params.type)
    if (level === undefined) return
    this.pushConsole(level, params.timestamp ?? 0, params.args)
  }

  private onExceptionThrown(params: unknown): void {
    const payload = (params ?? {}) as { timestamp?: number; exceptionDetails?: unknown }
    this.pushConsole('exception', payload.timestamp ?? 0, formatException(payload.exceptionDetails))
  }

  private pushConsole(level: ConsoleLevel, timestamp: number, args: unknown): void {
    this.consoleSequence += 1
    const text = typeof args === 'string' ? args : formatConsoleArguments(args as readonly unknown[])
    this.consoleEntries.push({ index: this.consoleSequence, level, timestamp, text })
    if (this.consoleEntries.length > CONSOLE_BUFFER_LIMIT) {
      this.consoleEntries.splice(0, this.consoleEntries.length - CONSOLE_BUFFER_LIMIT)
    }
  }

  private push(entry: NetworkEntry): void {
    this.entries.set(entry.requestId, entry)
    this.order.push(entry.requestId)
    while (this.order.length > NETWORK_BUFFER_LIMIT) {
      const dropped = this.order.shift()
      if (dropped !== undefined) this.entries.delete(dropped)
    }
  }
}

/** CDP console types the extension records; `debug`/`trace` stay out of the way. */
function consoleLevel(type: string | undefined): ConsoleLevel | undefined {
  switch (type) {
    case 'log': return 'log'
    case 'info':
    case 'debug': return 'info'
    case 'warning': return 'warning'
    case 'error':
    case 'assert': return 'error'
    default: return undefined
  }
}

function summarize(timing: unknown): TimingSummary | undefined {
  return summarizeTiming(timing)
}

function round(value: number): number {
  return Math.round(value * 1000 * 10) / 10
}
