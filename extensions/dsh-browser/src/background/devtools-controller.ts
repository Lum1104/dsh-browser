/**
 * The developer-tools controller: owns the debugger sessions, folds CDP events
 * into the network/console stores, and implements the nine devtools operations
 * as text-producing handlers.
 *
 * Everything volatile (tabs, attachments, buffers) lives here, and the Chrome
 * debugger API is injected, so the whole capability is testable against a
 * scripted debugger surface.
 *
 * @module
 */

import {
  DebuggerSession,
  DevToolsError,
  debuggerApi,
  devToolsSupported,
} from './debugger-session.ts'
import {
  NetworkCapture,
  type NetworkEntry,
} from './devtools-network.ts'
import {
  FrameRegistry,
  attributeRisk,
  attributeValue,
  frameContextId,
  inspectElement,
  resolveNodeId,
  setAttribute,
  setInlineStyle,
  setMatchedRuleStyle,
  shortIdentity,
  syncFrames,
} from './devtools-elements.ts'
import {
  REDACTED,
  formatBody,
  formatEvaluation,
  isSensitiveBodyUrl,
  truncateText,
} from './devtools-serialization.ts'
import {
  renderAttributeResult,
  renderBody,
  renderCaptureState,
  renderConsoleLogs,
  renderElement,
  renderRequestDetail,
  renderRequestList,
  renderStyleEdit,
} from './devtools-format.ts'

/** Default output budget for one developer-tools result. */
export const DEFAULT_DEVTOOLS_OUTPUT_CHARS = 24_000

/** Response/request body bytes fetched per call; CDP buffers keep them bounded. */
const BODY_CHAR_CAP = 65_536

/** One controlled tab the developer tools can attach to. */
export interface DevToolsTarget {
  tabId: number
  url?: string
  title?: string
}

/** Runtime facts the controller needs from its owner (the background worker). */
export interface DevToolsControllerOptions {
  /** Resolve the tab the calling session is bound to. */
  resolveTarget: (sessionId?: string) => Promise<DevToolsTarget | undefined>
  /** Debugger surface override for tests; defaults to the real `chrome.debugger`. */
  api?: import('./debugger-session.ts').DebuggerApi
  /** Output budget override. */
  maxChars?: number
  /** Command timeout override (tests). */
  commandTimeoutMs?: number
  /** Notified whenever attachment state changes, so the panel can reflect it. */
  onStateChange?: (state: DevToolsState) => void
}

/** Attachment state reported to the user interfaces. */
export interface DevToolsState {
  supported: boolean
  attached: boolean
  tabId?: number
  error?: string
}

/** The controller surface the background dispatcher uses. */
export interface DevToolsController {
  /**
   * Whether the platform can serve developer tools at all.
   *
   * User consent is deliberately NOT checked here: the background's approval
   * gate decides (a per-call dialog, or the user's standing allowance), and a
   * second hard gate would make that dialog unreachable.
   */
  supported(): boolean
  /** Current attachment state. */
  state(): DevToolsState
  /** Handle one devtools tool call by name. */
  handle(name: string, args: Record<string, unknown>, sessionId?: string): Promise<{ text: string }>
  /** Drop the attachment for a tab (tab closed, binding changed). */
  releaseTab(tabId: number): void
  /** Detach everything and disable further commands (setting revoked). */
  revoke(): Promise<void>
  /** Detach every attachment while keeping the capability usable. */
  detachAll(): Promise<void>
  /** Allow commands again after the user re-enables the setting. */
  resume(): void
  /**
   * Attach to a tab ahead of any tool call so network capture starts before the
   * page issues traffic. Only called once the user has enabled the allowance.
   */
  prewarm(tabId: number): Promise<void>
}

interface TabContext {
  tabId: number
  session: DebuggerSession
  capture: NetworkCapture
  frames: FrameRegistry
  detachedReason?: string
  /** Per-method CDP event tally, so a silent capture can be explained. */
  cdpEvents: Record<string, number>
  /** CDP domains this session enabled successfully. */
  domains: string[]
  /** Which `Network.*` event kinds this page emitted, and how often. */
  networkEvents: Record<string, number>
}

/**
 * Browser-internal pages the debugger API refuses, by URL scheme.
 *
 * Detecting them up front turns an opaque `chrome.debugger` failure ("Cannot
 * access a chrome:// URL") into an instruction the model and the user can act
 * on: switch the controlled tab to a normal page.
 */
const UNDEBUGGABLE_SCHEME = /^(chrome|chrome-untrusted|devtools|edge|brave|about):/i

/**
 * Whether the controlled tab can be served by a debugger at all.
 * @param url - the controlled tab's URL, when known.
 * @returns undefined when debuggable, or the user-facing reason.
 */
export function undebuggableReason(url: string | undefined): string | undefined {
  if (url === undefined || url === '') return undefined
  const scheme = UNDEBUGGABLE_SCHEME.exec(url)?.[1]
  if (scheme === undefined) return undefined
  return `This page cannot be debugged: chrome.debugger refuses ${scheme}:// pages. `
    + 'Switch the controlled tab to a normal http(s) page and retry.'
}

/**
 * Create the developer-tools controller.
 * @param options - runtime dependencies and limits.
 * @returns the controller.
 */
export function createDevToolsController(options: DevToolsControllerOptions): DevToolsController {
  const api = options.api ?? debuggerApi()
  const maxChars = options.maxChars ?? DEFAULT_DEVTOOLS_OUTPUT_CHARS
  const contexts = new Map<number, TabContext>()
  let revoked = false

  const supported = (): boolean => api !== undefined && devToolsSupported()

  /** Attachment state that outlives a detached context, so status stays truthful. */
  const attachment: { tabId?: number; attached: boolean; reason?: string } = { attached: false }

  const state = (): DevToolsState => ({
    supported: supported(),
    attached: attachment.attached,
    ...(attachment.tabId === undefined ? {} : { tabId: attachment.tabId }),
    ...(attachment.reason === undefined ? {} : { error: attachment.reason }),
  })

  const markAttached = (tabId: number): void => {
    attachment.tabId = tabId
    attachment.attached = true
    attachment.reason = undefined
  }

  const markDetached = (reason?: string): void => {
    attachment.attached = false
    if (reason !== undefined) attachment.reason = reason
  }

  /**
   * Replace the reported failure. A fresh attach attempt clears an older error
   * instead of leaving it next to a switch the user has since enabled, while a
   * refusal reports its own cause so the user knows what to change.
   */
  const clearFailure = (reason?: string): void => {
    attachment.reason = reason
  }

  const notify = (): void => { options.onStateChange?.(state()) }

  /**
   * Capture state for a status question. The background can ask this after a
   * `stop` dropped the tab context, so it falls back to the shared attachment.
   */
  const statusSnapshot = (tabId?: number): { attached: boolean; tabId?: number; entries: number; generation: number } => {
    const resolved = tabId ?? attachment.tabId
    const context = resolved === undefined ? undefined : contexts.get(resolved)
    const capture = context?.capture.state()
    return {
      attached: context === undefined ? false : context.capture.state().attached && attachment.attached,
      ...(resolved === undefined ? {} : { tabId: resolved }),
      entries: capture?.entries ?? 0,
      generation: capture?.generation ?? 0,
    }
  }

  const contextFor = async (tabId: number): Promise<TabContext> => {
    const existing = contexts.get(tabId)
    if (existing !== undefined) {
      if (!existing.session.isAttached) {
        // Only a real re-attach invalidates the capture; an already attached
        // session keeps accumulating without losing the model's indices.
        await attach(existing, !existing.capture.state().attached)
      }
      return existing
    }
    const session = new DebuggerSession(
      tabId,
      api!,
      {
        onCdpEvent: (method, params) => { handleCdpEvent(contexts.get(tabId), method, params) },
        onDetached: (reason) => {
          const context = contexts.get(tabId)
          if (context !== undefined) context.detachedReason = reason
          markDetached(reason)
          notify()
        },
      },
      options.commandTimeoutMs,
    )
    const context: TabContext = {
      tabId,
      session,
      capture: new NetworkCapture(),
      frames: new FrameRegistry(),
      cdpEvents: {},
      domains: [],
      networkEvents: {},
    }
    contexts.set(tabId, context)
    await attach(context, true)
    return context
  }

  const attach = async (context: TabContext, resetCapture: boolean): Promise<void> => {
    // A new attempt supersedes whatever the previous one reported.
    clearFailure()
    try {
      await tryAttach(context.session)
    } catch (error: unknown) {
      contexts.delete(context.tabId)
      markDetached(error instanceof DevToolsError ? error.message : String(error))
      notify()
      throw error
    }
    context.session.resume()
    context.detachedReason = undefined
    context.domains = [...context.session.domains]
    if (resetCapture) {
      context.capture.clear()
      context.capture.start(context.tabId)
    }
    markAttached(context.tabId)
    // Frame numbering must be known before any index-based address resolves.
    await syncFrames(context.session, context.frames).catch(() => undefined)
    notify()
  }

  /** Attach, recovering from a stale attachment left by a worker restart. */
  const tryAttach = async (session: DebuggerSession): Promise<void> => {
    try {
      await session.attach()
    } catch (error: unknown) {
      if (error instanceof DevToolsError && error.code === 'devtools-conflict') {
        // After an MV3 worker restart the extension believes it is detached
        // while Chrome still holds the attachment. Drop it and retry once; a
        // genuine DevTools user keeps the tab and sees the actionable error.
        try {
          await api!.detach({ tabId: session.tabId })
          await session.attach()
          return
        } catch {
          throw error
        }
      }
      throw error
    }
  }

  const handleCdpEvent = (context: TabContext | undefined, method: string, params: unknown): void => {
    if (context === undefined) return
    context.cdpEvents[method] = (context.cdpEvents[method] ?? 0) + 1
    context.frames.observe(method, params)
    if (method === 'Page.frameNavigated' && (params as { frame?: { parentId?: string } }).frame?.parentId === undefined) {
      // A new top-level document makes every captured index stale.
      context.capture.ingestNavigation()
      void syncFrames(context.session, context.frames).catch(() => undefined)
    }
    if (method.startsWith('Network.')) {
      // Which network event kinds this page actually emits. Chrome withholds
      // the main request event on some pages, and a tally explains a thin
      // capture without dumping payloads into normal output.
      const kind = method.slice('Network.'.length)
      context.networkEvents[kind] = (context.networkEvents[kind] ?? 0) + 1
    }
    context.capture.ingest(method, params)
  }

  const targetFor = async (sessionId?: string): Promise<DevToolsTarget | undefined> => {
    const target = await options.resolveTarget(sessionId)
    return target
  }

  /** Resolve the controlled tab, or the given one when the caller knows it. */
  const resolveTarget = async (tabId?: number, sessionId?: string): Promise<DevToolsTarget | undefined> => {
    const target = await targetFor(sessionId)
    if (target === undefined) return undefined
    return tabId === undefined || target.tabId === tabId ? target : { tabId }
  }

  /**
   * Resolve the tab context for one call, enforcing the user's allowance.
   * @throws {DevToolsError} when unsupported, disabled, or the tab is unknown.
   */
  const requireContext = async (sessionId?: string, allowAttach = true): Promise<{ context?: TabContext; target?: DevToolsTarget }> => {
    if (allowAttach) return requireAttachedContext(sessionId)
    if (!supported() || revoked) return {}
    const target = await targetFor(sessionId)
    const context = target === undefined ? undefined : contexts.get(target.tabId)
    return { ...(context === undefined ? {} : { context }), ...(target === undefined ? {} : { target }) }
  }

  const requireAttachedContext = async (sessionId?: string): Promise<{ context: TabContext; target: DevToolsTarget }> => {
    if (!supported()) {
      throw new DevToolsError(
        'devtools-unavailable',
        'This browser build cannot provide developer tools (the debugger API is unavailable).',
      )
    }
    if (revoked) {
      throw new DevToolsError('devtools-unavailable', 'The developer-tools session was revoked.')
    }
    const target = await targetFor(sessionId)
    if (target === undefined) {
      throw new DevToolsError('devtools-unavailable', 'No controlled tab is available for developer tools.')
    }
    const blocked = undebuggableReason(target.url)
    if (blocked !== undefined) {
      clearFailure(blocked)
      notify()
      throw new DevToolsError('devtools-unavailable', blocked)
    }
    const context = await contextFor(target.tabId)
    return { context, target }
  }

  const finish = (text: string): { text: string } => ({ text: truncateText(text, maxChars) })

  return {
    supported,
    state,
    releaseTab: (tabId) => {
      const context = contexts.get(tabId)
      if (context === undefined) return
      contexts.delete(tabId)
      markDetached()
      void context.session.detach()
      notify()
    },
    revoke: async () => {
      revoked = true
      const pending = [...contexts.values()]
      contexts.clear()
      markDetached()
      await Promise.all(pending.map(async (context) => { await context.session.detach() }))
      notify()
    },
    detachAll: async () => {
      const pending = [...contexts.values()]
      contexts.clear()
      markDetached()
      await Promise.all(pending.map(async (context) => { await context.session.detach() }))
      notify()
    },
    resume: () => {
      revoked = false
      notify()
    },
    prewarm: async (tabId) => {
      if (!supported() || revoked) {
        throw new DevToolsError('devtools-unavailable', 'This browser build cannot provide developer tools.')
      }
      const target = await resolveTarget(tabId)
      if (undebuggableReason(target?.url) !== undefined) {
        // Enabling the switch is not itself a failed operation: an internal
        // page simply has nothing to prewarm, and the first real call reports
        // the reason if the user still has not moved to a debuggable tab.
        clearFailure()
        return
      }
      const context = await contextFor(tabId)
      context.capture.start(tabId)
      notify()
    },
    handle: async (name, args, sessionId) => {
      // `status` must answer without resolving or attaching to a tab, so the
      // panel can show capture state even when the debugger is detached.
      const readOnly = name === 'browser_devtools_network' && args.action === 'status'
      try {
        const { context, target } = await requireContext(sessionId, !readOnly)
        if (context === undefined || target === undefined) {
          // A status question is answerable from the shared state alone.
          if (readOnly) return finish(renderCaptureState(statusSnapshot(target?.tabId), 'status'))
          throw new DevToolsError('devtools-unavailable', 'No controlled tab is available for developer tools.')
        }
        return finish(await dispatch(context, target, name, args))
      } catch (error: unknown) {
        throw toToolError(error)
      }
    },
  }

  /** Route one devtools operation. */
  async function dispatch(
    context: TabContext,
    target: DevToolsTarget,
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    switch (name) {
      case 'browser_devtools_elements':
        return elements(context, args)
      case 'browser_devtools_set_element_style':
        return setStyle(context, args)
      case 'browser_devtools_set_element_attribute':
        return setElementAttribute(context, args)
      case 'browser_console_eval':
        return consoleEval(context, args)
      case 'browser_console_logs':
        return consoleLogs(context, args)
      case 'browser_devtools_network':
        return networkControl(context, target, args)
      case 'browser_devtools_list_requests':
        return listRequests(context, args)
      case 'browser_devtools_get_request':
        return getRequest(context, args)
      case 'browser_devtools_request_body':
        return requestBody(context, args)
      default:
        throw new Error(`Unknown developer-tools operation ${name}.`)
    }
  }

  // ---- Elements ----

  async function elements(context: TabContext, args: Record<string, unknown>): Promise<string> {
    const nodeId = await resolveNodeId(context.session, locatorOf(args), context.frames)
    const properties = stringList(args.properties)
    const view = await inspectElement(context.session, nodeId, properties)
    return renderElement(view)
  }

  async function setStyle(context: TabContext, args: Record<string, unknown>): Promise<string> {
    const declarations = declarationList(args.properties)
    const nodeId = await resolveNodeId(context.session, locatorOf(args), context.frames)
    const node = await context.session.send('DOM.describeNode', { nodeId, depth: 0 }) as { node?: { localName?: string; nodeName?: string; attributes?: string[] } }
    const identity = shortIdentity(node.node ?? {}, pairsOf(node.node?.attributes))
    const mode = args.mode === 'rule' ? 'rule' : 'inline'
    if (mode === 'rule') {
      const edited = await setMatchedRuleStyle(context.session, nodeId, declarations)
      return renderStyleEdit(identity, 'rule', edited.selector, edited.declarations)
    }
    const applied = await setInlineStyle(context.session, nodeId, declarations)
    return renderStyleEdit(identity, 'inline', 'style attribute', applied)
  }

  async function setElementAttribute(context: TabContext, args: Record<string, unknown>): Promise<string> {
    const name = typeof args.name === 'string' ? args.name.trim() : ''
    if (name === '') throw new Error('name is required.')
    const risk = attributeRisk(name)
    if (risk === 'forbidden') throw new Error(`The attribute name "${name}" cannot be written through developer tools.`)
    const remove = args.remove === true
    const value = typeof args.value === 'string' ? args.value : undefined
    if (risk === 'script' && !remove) {
      throw new Error(
        `Refusing to write the script-capable attribute "${name}". `
        + 'Inline handler and resource URL attributes change what the page executes; use browser_console_eval for that.',
      )
    }
    const nodeId = await resolveNodeId(context.session, locatorOf(args), context.frames)
    const before = await attributeValue(context.session, nodeId, name)
    if (!remove && value === undefined) {
      const node = await context.session.send('DOM.describeNode', { nodeId, depth: 0 }) as { node?: { localName?: string; nodeName?: string; attributes?: string[] } }
      const identity = shortIdentity(node.node ?? {}, pairsOf(node.node?.attributes))
      return renderAttributeResult(identity, name, before, undefined, 'read')
    }
    await setAttribute(context.session, nodeId, name, value, remove)
    const after = remove ? undefined : value
    const node = await context.session.send('DOM.describeNode', { nodeId, depth: 0 }) as { node?: { localName?: string; nodeName?: string; attributes?: string[] } }
    const identity = shortIdentity(node.node ?? {}, pairsOf(node.node?.attributes))
    return renderAttributeResult(identity, name, before, after, remove ? 'removed' : 'set')
  }

  // ---- Console ----

  async function consoleEval(context: TabContext, args: Record<string, unknown>): Promise<string> {
    const expression = typeof args.expression === 'string' ? args.expression : ''
    if (expression.trim() === '') throw new Error('expression is required.')
    const frame = numberArg(args.frame) ?? 0
    const contextId = await frameContextId(context.session, frame, context.frames)
    const budget = numberArg(args.maxChars) ?? Math.min(maxChars, 8_000)
    let response: unknown
    try {
      response = await context.session.send('Runtime.evaluate', {
        expression,
        ...(contextId === undefined ? {} : { contextId }),
        awaitPromise: args.awaitPromise === true,
        // CDP hands back an opaque "object Object" for plain objects unless the
        // value is serialized; JSON-compatible results are what the model wants.
        // Classes/functions/DOM nodes still fall back to description + preview.
        returnByValue: true,
        allowUnsafeEvalBlockedByCSP: false,
        userGesture: true,
        includeCommandLineAPI: true,
        generatePreview: args.includePreview === true,
        objectGroup: 'dsh-devtools',
      })
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error)
      return `Evaluation failed:\n${detail}`
    }
    const formatted = formatEvaluation(response, {
      maxChars: Math.max(200, budget),
      includePreview: args.includePreview === true,
    })
    return formatted.ok ? `Evaluation result:\n${formatted.text}` : formatted.text
  }

  function consoleLogs(context: TabContext, args: Record<string, unknown>): string {
    const limit = numberArg(args.limit) ?? 50
    const sinceIndex = numberArg(args.sinceIndex)
    const level = typeof args.level === 'string' ? args.level : undefined
    const entries = context.capture.consoleLog()
      // Entry indices start at 1, so "after 0" must not mean "after nothing":
      // the window filter applies only when the caller actually asks for one.
      .filter((entry) => sinceIndex === undefined || entry.index > sinceIndex)
      .filter((entry) => level === undefined || entry.level === level || (level === 'error' && entry.level === 'exception'))
      .slice(-limit)
    return renderConsoleLogs(entries, sinceIndex ?? 0)
  }

  // ---- Network ----

  async function networkControl(context: TabContext, target: DevToolsTarget, args: Record<string, unknown>): Promise<string> {
    const action = typeof args.action === 'string' ? args.action : 'status'
    if (action === 'stop') {
      context.capture.stop()
      contexts.delete(context.tabId)
      markDetached()
      await context.session.detach()
      notify()
      return renderCaptureState({ ...context.capture.state(), attached: false, tabId: target.tabId }, 'stop')
    }
    if (action === 'start') {
      if (!context.session.isAttached) await attach(context, true)
      else if (context.capture.state().attached !== true) context.capture.start(context.tabId)
      notify()
      return renderCaptureState(context.capture.state(), 'start')
    }
    const state = context.capture.state()
    return `${renderCaptureState(state, 'status')}\n${pipelineEvidence(context)}`
  }

  function listRequests(context: TabContext, args: Record<string, unknown>): string {
    const limit = numberArg(args.limit) ?? 50
    const sinceIndex = numberArg(args.sinceIndex)
    const urlPattern = matcher(args.urlPattern)
    const method = typeof args.method === 'string' && args.method !== '' ? args.method.toUpperCase() : undefined
    const resourceType = typeof args.resourceType === 'string' && args.resourceType !== '' ? args.resourceType.toLowerCase() : undefined
    const statusMin = numberArg(args.statusMin)
    const statusMax = numberArg(args.statusMax)
    const entries = context.capture.list().filter((entry) => {
      // Request indices begin at 1, so the window filter must be opt-in.
      if (sinceIndex !== undefined && entry.index <= sinceIndex) return false
      if (urlPattern !== undefined && !urlPattern(entry.url)) return false
      if (method !== undefined && entry.method.toUpperCase() !== method) return false
      if (resourceType !== undefined && (entry.resourceType ?? '').toLowerCase() !== resourceType) return false
      if (statusMin !== undefined && (entry.status ?? 0) < statusMin) return false
      if (statusMax !== undefined && (entry.status ?? 0) > statusMax) return false
      if (args.failedOnly === true && entry.failed === undefined) return false
      return true
    })
    return renderRequestList(entries, context.capture.state().generation, limit)
  }

  async function getRequest(context: TabContext, args: Record<string, unknown>): Promise<string> {
    const entry = requireEntry(context, args)
    const includeSensitiveHeaders = args.includeSensitiveHeaders === true
    const includeSensitiveBody = args.includeSensitiveBody === true
    let body: string | undefined
    let truncated = false
    if (args.includeBody === true) {
      const fetched = await fetchBody(context, entry, 'response')
      body = fetched.text
      truncated = fetched.truncated
    }
    const detail = renderRequestDetail(entry, { includeSensitiveHeaders, includeSensitiveBody, ...(body === undefined ? {} : { body }), bodyTruncated: truncated })
    return truncateText(detail, numberArg(args.maxChars) ?? maxChars)
  }

  async function requestBody(context: TabContext, args: Record<string, unknown>): Promise<string> {
    const entry = requireEntry(context, args)
    const kind = args.kind === 'request' ? 'request' : 'response'
    const includeSensitiveBody = args.includeSensitiveBody === true
    if (!includeSensitiveBody && isSensitiveBodyUrl(entry.url)) {
      return renderBody(entry, kind, '', { truncated: false, json: false, redacted: true })
    }
    const fetched = await fetchBody(context, entry, kind)
    const limited = truncateText(fetched.text, numberArg(args.maxChars) ?? maxChars)
    return renderBody(entry, kind, limited, { truncated: fetched.truncated, json: fetched.json, redacted: false })
      + (fetched.redactedHeaders === true ? `\n\n(Headers containing credentials were ${REDACTED} in the request detail view.)` : '')
  }

  function requireEntry(context: TabContext, args: Record<string, unknown>): NetworkEntry {
    const index = numberArg(args.index)
    if (index === undefined) throw new Error('index is required and must be a captured request index.')
    const entry = context.capture.get(index)
    if (entry === undefined) {
      const state = context.capture.state()
      throw new Error(
        `No captured request has index ${index} in capture generation ${state.generation} (${state.entries} entries). `
        + 'Call browser_devtools_list_requests again for current indices.',
      )
    }
    return entry
  }

  async function fetchBody(
    context: TabContext,
    entry: NetworkEntry,
    kind: 'request' | 'response',
  ): Promise<{ text: string; truncated: boolean; json: boolean; redactedHeaders?: boolean }> {
    const command = kind === 'request' ? 'Network.getRequestPostData' : 'Network.getResponseBody'
    let raw: { body?: string; postData?: string; base64Encoded?: boolean }
    try {
      raw = (await context.session.send(command, { requestId: entry.requestId })) as typeof raw
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(
        kind === 'request'
          ? `This request has no captured payload (${detail}).`
          : `The response body is no longer available (${detail}). Chrome only keeps bodies for requests it buffered while the debugger was attached.`,
      )
    }
    const text = raw.body ?? raw.postData ?? ''
    if (text === '') throw new Error(kind === 'request' ? 'This request has no payload.' : 'This response has an empty body.')
    const decoded = raw.base64Encoded === true ? `[base64] ${text}` : text
    const sliced = decoded.slice(0, BODY_CHAR_CAP)
    const formatted = formatBody(sliced)
    return { text: formatted.text, truncated: decoded.length > BODY_CHAR_CAP, json: formatted.json }
  }

  /** One line of pipeline evidence attached to every capture status answer. */
  function pipelineEvidence(context: TabContext | undefined): string {
    if (context === undefined) return 'Pipeline: no session has been created for this tab yet.'
    const methods = Object.entries(context.cdpEvents)
      .sort(([, left], [, right]) => right - left)
      .slice(0, 6)
      .map(([method, count]) => `${method}×${count}`)
    const kinds = Object.entries(context.networkEvents)
      .sort(([, left], [, right]) => right - left)
      .map(([kind, count]) => `${kind}×${count}`)
    return `Pipeline: attached=${context.session.isAttached} · domains=${context.domains.join('+') || 'none'}`
      + ` · cdp events=${methods.length === 0 ? 'none received' : methods.join(', ')}`
      + ` · network events=${kinds.length === 0 ? 'none' : kinds.join(', ')}`
  }

  /** Turn any controller failure into the tool-facing error text. */
  function toToolError(error: unknown): Error {
    if (error instanceof DevToolsError) return new Error(error.message)
    if (error instanceof Error) return error
    return new Error(String(error))
  }
}

/** Extract the element locator from raw tool arguments. */
function locatorOf(args: Record<string, unknown>): { selector?: string; index?: number; frame?: number } {
  const selector = typeof args.selector === 'string' && args.selector.trim() !== '' ? args.selector : undefined
  const index = numberArg(args.index)
  const frame = numberArg(args.frame)
  return {
    ...(selector === undefined ? {} : { selector }),
    ...(index === undefined ? {} : { index }),
    ...(frame === undefined ? {} : { frame }),
  }
}

/** Attribute pairs from a `DOM.describeNode` payload. */
function pairsOf(attributes: string[] | undefined): { name: string; value: string }[] {
  const pairs: { name: string; value: string }[] = []
  const list = attributes ?? []
  for (let index = 0; index + 1 < list.length; index += 2) {
    pairs.push({ name: list[index]!, value: list[index + 1]! })
  }
  return pairs
}

function numberArg(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Serialize the tool's declaration list, rejecting silently wrong shapes. */
function declarationList(value: unknown): { name: string; value: string; important?: boolean }[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('properties must be a non-empty array of { name, value } declarations.')
  }
  return value.map((entry) => {
    const record = entry as { name?: unknown; value?: unknown; important?: unknown }
    if (typeof record?.name !== 'string' || record.name.trim() === '' || typeof record.value !== 'string') {
      throw new Error('Each property needs a CSS name and a string value.')
    }
    return {
      name: record.name.trim(),
      value: record.value,
      ...(record.important === true ? { important: true } : {}),
    }
  })
}

/** A string list argument, ignoring non-strings. */
function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const list = value.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
  return list.length === 0 ? undefined : list
}

/** Build a URL matcher from a substring or `/regex/` pattern. */
function matcher(pattern: unknown): ((url: string) => boolean) | undefined {
  if (typeof pattern !== 'string' || pattern === '') return undefined
  const slash = /^\/(.*)\/([a-z]*)$/i.exec(pattern)
  if (slash !== null) {
    try {
      const regex = new RegExp(slash[1]!, slash[2]!.includes('i') ? 'i' : '')
      return (url) => regex.test(url)
    } catch {
      // An invalid regex is just a substring.
    }
  }
  return (url) => url.includes(pattern)
}

/** Serialize one capture state for the panel. */
export function captureStatusText(capture: NetworkCapture): string {
  const state = capture.state()
  return `Network capture ${state.attached ? 'active' : 'inactive'} · ${state.entries} entries · generation ${state.generation}${state.tabId === undefined ? '' : ` · tab ${state.tabId}`}`
}
