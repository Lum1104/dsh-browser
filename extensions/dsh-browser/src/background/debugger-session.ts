/**
 * Chrome debugger (CDP) session for one controlled tab.
 *
 * The developer-tools features are the only consumers: element/CSS inspection
 * and edits, page-context JavaScript evaluation plus recorded console output,
 * and network capture. One attachment per tab; every command is bounded by a
 * timeout and settles on detach so a tool call can never hang on a dead
 * session.
 *
 * Chrome refuses to attach while DevTools is open on the same tab; that case is
 * reported as {@link DevToolsError} code `devtools-conflict` with an actionable
 * message instead of a raw protocol error.
 *
 * @module
 */

/** Stable failure codes the devtools tools map onto model-facing errors. */
export type DevToolsErrorCode =
  | 'devtools-unavailable'
  | 'devtools-conflict'
  | 'devtools-detached'
  | 'devtools-timeout'
  | 'devtools-command-failed'

/** Typed devtools failure; `code` is the machine identity, `message` the human text. */
export class DevToolsError extends Error {
  constructor(
    readonly code: DevToolsErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'DevToolsError'
  }
}

/** One `chrome.debugger.sendCommand` call, structurally typed for tests. */
export type SendCommand = (target: { tabId: number }, method: string, params?: Record<string, unknown>) => Promise<unknown>

/** The CDP command surface every developer-tools feature module depends on. */
export interface CdpClient {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>
}

/** The subset of `chrome.debugger` this module uses. */
export interface DebuggerApi {
  attach(target: { tabId: number }, version: string): Promise<void>
  detach(target: { tabId: number }): Promise<void>
  sendCommand: SendCommand
  onEvent: {
    addListener(listener: (source: { tabId?: number }, method: string, params?: unknown) => void): void
    removeListener(listener: (source: { tabId?: number }, method: string, params?: unknown) => void): void
  }
  onDetach: {
    addListener(listener: (source: { tabId?: number }, reason: string) => void): void
    removeListener(listener: (source: { tabId?: number }, reason: string) => void): void
  }
}

/** CDP protocol version negotiated by the attachment. */
const CDP_VERSION = '1.3'

/** Per-command budget; a stalled page must fail the tool call, not hang it. */
const DEFAULT_COMMAND_TIMEOUT_MS = 10_000

/** Bounded network buffers so a long page session cannot exhaust extension memory. */
const NETWORK_BUFFERS = { maxTotalBufferSize: 20_000_000, maxResourceBufferSize: 5_000_000, maxPostDataSize: 1_000_000 }

/** Observer hooks the devtools feature modules subscribe to. */
export interface DevToolsSessionListeners {
  onCdpEvent?(method: string, params: unknown): void
  onDetached?(reason: string): void
}

/** One dispatched command awaiting its single settle. */
interface PendingCommand {
  settle(error?: DevToolsError, value?: unknown): void
  timer: ReturnType<typeof setTimeout>
}

/** Read the browser's debugger API, or undefined when the platform lacks it. */
export function debuggerApi(): DebuggerApi | undefined {
  const candidate = (globalThis as { chrome?: { debugger?: unknown } }).chrome?.debugger as DebuggerApi | undefined
  if (candidate === undefined) return undefined
  return typeof candidate.attach === 'function' && typeof candidate.sendCommand === 'function' ? candidate : undefined
}

/** Whether the running browser can serve the developer-tools group at all. */
export function devToolsSupported(): boolean {
  return debuggerApi() !== undefined
}

/**
 * One debugger attachment. Instances are not shared across tabs: the session
 * owns exactly one tab and refuses commands after it detaches.
 */
export class DebuggerSession {
  private pending = new Set<PendingCommand>()
  private attached = false
  private paused = false
  private disposeEvents: (() => void) | undefined
  private enabled: string[] = []

  constructor(
    readonly tabId: number,
    private readonly api: DebuggerApi,
    private readonly listeners: DevToolsSessionListeners = {},
    private readonly commandTimeoutMs: number = DEFAULT_COMMAND_TIMEOUT_MS,
  ) {}

  /** @returns whether this session currently holds the tab's debugger. */
  get isAttached(): boolean {
    return this.attached
  }

  /** Mark the session paused (setting revoked): commands fail until it re-attaches. */
  pause(): void {
    this.paused = true
  }

  /** Allow commands again after a re-attach. */
  resume(): void {
    this.paused = false
  }

  /**
   * Attach and enable the domains this feature set needs. Idempotent.
   * @throws {DevToolsError} when another debugger owns the tab or the platform refuses.
   */
  async attach(): Promise<void> {
    if (this.attached) return
    try {
      await this.api.attach({ tabId: this.tabId }, CDP_VERSION)
    } catch (error: unknown) {
      throw mapAttachFailure(error)
    }
    this.attached = true
    this.paused = false
    this.bindEvents()
    this.enabled = []
    try {
      await this.send('DOM.enable', {})
      this.enabled.push('DOM')
      await this.send('CSS.enable', {})
      this.enabled.push('CSS')
      await this.send('Runtime.enable', {})
      this.enabled.push('Runtime')
      await this.send('Network.enable', NETWORK_BUFFERS)
      this.enabled.push('Network')
    } catch (error: unknown) {
      // A partial attachment is worse than none: the caller retries cleanly.
      await this.detach()
      throw error
    }
  }

  /** CDP domains this session successfully enabled. */
  get domains(): readonly string[] {
    return [...this.enabled]
  }

  /**
   * Send one CDP command.
   * @param method - CDP method name.
   * @param params - CDP parameters.
   * @returns the command result.
   * @throws {DevToolsError} on timeout, detach, or a CDP error response.
   */
  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.attached || this.paused) {
      return Promise.reject(new DevToolsError('devtools-detached', 'The developer-tools session is not attached to the page.'))
    }
    return new Promise<unknown>((resolve, reject) => {
      let settled = false
      const settle = (error?: DevToolsError, value?: unknown): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.pending.delete(entry)
        if (error === undefined) resolve(value)
        else reject(error)
      }
      const timer = setTimeout(() => {
        settle(new DevToolsError(
          'devtools-timeout',
          `Developer-tools command ${method} did not answer within ${this.commandTimeoutMs}ms.`,
        ))
      }, this.commandTimeoutMs)
      const entry: PendingCommand = { settle, timer }
      this.pending.add(entry)
      let invocation: Promise<unknown>
      try {
        invocation = this.api.sendCommand({ tabId: this.tabId }, method, params) as Promise<unknown>
      } catch (error: unknown) {
        settle(toDevToolsError(error, method))
        return
      }
      if (invocation === undefined || typeof invocation.then !== 'function') {
        // A callback-only API surface cannot be awaited here, so fail fast
        // instead of leaving the caller waiting for the timeout.
        settle(new DevToolsError('devtools-command-failed', `Developer-tools command ${method} could not be dispatched.`))
        return
      }
      invocation.then(
        (value) => { settle(undefined, value) },
        (error: unknown) => { settle(toDevToolsError(error, method)) },
      )
    })
  }

  /** Detach and release every pending command. Safe to call repeatedly. */
  async detach(): Promise<void> {
    if (!this.attached) return
    this.attached = false
    this.releasePending('The developer-tools session detached from the page.')
    this.releaseEvents()
    try {
      await this.api.detach({ tabId: this.tabId })
    } catch {
      // Already detached (tab closed, Chromium took it over): nothing to undo.
    }
  }

  private releasePending(reason: string): void {
    const failure = new DevToolsError('devtools-detached', reason)
    for (const entry of [...this.pending]) entry.settle(failure)
  }

  private bindEvents(): void {
    const onEvent = (source: { tabId?: number }, method: string, params?: unknown): void => {
      if (source.tabId !== this.tabId) return
      this.listeners.onCdpEvent?.(method, params)
    }
    const onDetach = (source: { tabId?: number }, reason: string): void => {
      if (source.tabId !== this.tabId) return
      this.attached = false
      this.releasePending(`The developer-tools session detached from the page (${reason}).`)
      this.releaseEvents()
      this.listeners.onDetached?.(reason)
    }
    this.api.onEvent.addListener(onEvent)
    this.api.onDetach.addListener(onDetach)
    this.disposeEvents = () => {
      this.api.onEvent.removeListener(onEvent)
      this.api.onDetach.removeListener(onDetach)
    }
  }

  private releaseEvents(): void {
    this.disposeEvents?.()
    this.disposeEvents = undefined
  }
}

/** Map an attach failure onto the actionable devtools error vocabulary. */
export function mapAttachFailure(error: unknown): DevToolsError {
  const detail = error instanceof Error ? error.message : String(error)
  if (/another debugger|already attached|debugger is already/i.test(detail)) {
    return new DevToolsError(
      'devtools-conflict',
      'Chrome DevTools (or another debugger) is currently attached to this tab. '
      + 'Close DevTools for this tab and retry, because a page can only be debugged by one client at a time.',
    )
  }
  return new DevToolsError('devtools-command-failed', `The debugger could not attach to this tab: ${detail}`)
}

/** Map a CDP command rejection onto the devtools error vocabulary. */
export function toDevToolsError(error: unknown, method: string): DevToolsError {
  const detail = error instanceof Error ? error.message : String(error)
  return new DevToolsError('devtools-command-failed', `Developer-tools command ${method} failed: ${detail}`)
}
