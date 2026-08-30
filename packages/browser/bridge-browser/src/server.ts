/**
 * Bridge WebSocket carrier: token-authenticated connection registry, gateway
 * RPC dispatch, per-connection event pump, and tool-call dispatch to the
 * connected browser extension.
 *
 * The route this server mounts (`/ext/bridge`) lives OUTSIDE the /api trust
 * fence (which only guards the client-connection routes), so the bridge brings
 * its own authentication: a bearer token presented in the `hello` frame within
 * HELLO_TIMEOUT_MS. Gateway RPCs are dispatched in-process, directly against
 * the same injected Host business services (`sessionController`,
 * `settingsController`, `credentialsController`, `directoryPickerController`)
 * the harness itself composes — see `dispatchRpc` below. Methods the /api
 * carrier pins to loopback (`PRIVILEGED_METHODS`) stay loopback-only here
 * regardless of the token, defense in depth for `--host 0.0.0.0` deployments.
 *
 * One active connection at a time: a new authenticated socket replaces the
 * previous one (the old socket is closed and its in-flight tool calls settle
 * as `bridge-closed`).
 *
 * @module
 */

import { randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'
import type { JsonValue } from '@deepseek-ai/dsh-session/types'
import type { LlmModelDiscoveryRequest } from '@deepseek-ai/dsh-llm'
import type {
  SessionAttachmentRequest,
  SessionCancelRequest,
  SessionCreateRequest,
  SessionListRequest,
  SessionOpenWorkspacePathRequest,
  SessionPromptRequest,
  SessionRenameRequest,
  SessionSelectModelRequest,
  SettingsPathOpView,
  WorkspaceArchiveSessionRequest,
} from './harness-types.ts'
import type { BridgeSessionApi } from './session-api.ts'
import type { BridgeWorkspaceApi } from './workspace-api.ts'
import type { BridgeCredentialsApi, BridgeDirectoryPickerApi, BridgeSettingsApi } from './privileged-api.ts'
import type { BridgeLlmApi } from './llm-api.ts'
import type { SessionEventEnvelope } from './session-events.ts'
import {
  BRIDGE_INJECT_BROWSER_SNAPSHOT_METHOD,
  BRIDGE_SESSION_PURGE_METHOD,
  HELLO_TIMEOUT_MS,
  PING_INTERVAL_MS,
  parseBridgeFrame,
  type BridgeFrame,
  type BridgeCaps,
  type ClientFrame,
  type ToolErrorCode,
} from './protocol.ts'
import { SessionPurgeError } from './session-purge.ts'
import { verifyToken } from './token.ts'

/**
 * Wire methods gated to loopback regardless of token (the bridge's own
 * dot-named mirror of the equivalent slash-named Remote methods the harness
 * itself pins to loopback: `settings/*`, `credentials/*`,
 * `directoryPicker/pick`, `session/openWorkspacePath`).
 */
const PRIVILEGED_METHODS = new Set([
  'host.pickDirectory',
  'host.openPath',
  'settings.describe',
  'settings.openDocument',
  'settings.update',
  'settings.replace',
  'settings.mutate',
  'credentials.describe',
  'credentials.set',
  'credentials.unset',
])

/** Session mutations whose WebSocket arrival order is behaviorally significant. */
const ORDERED_SESSION_METHODS = new Set([
  BRIDGE_INJECT_BROWSER_SNAPSHOT_METHOD,
  'session.prompt',
  'session.cancel',
])

/** Loopback IPv4/IPv6 literals (IPv4-mapped included). Exported for tests and reuse. */
export function isLoopbackAddress(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** Error thrown by requestTool; the tool registry turns it into an isError result. */
export class BridgeToolError extends Error {
  constructor(
    readonly code: ToolErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'BridgeToolError'
  }
}

/** Dependencies the bridge needs from the host. */
export interface BridgeServerDeps {
  /** Bearer token the extension must present in `hello`. */
  token: string
  /** Typed session-call surface (`sessionController`, wrapped by workspace grouping and deferral). */
  sessionApi: BridgeSessionApi
  /** Typed `workspaceController` surface for `workspace.*` methods. */
  workspaceApi: BridgeWorkspaceApi
  /** Typed `settingsController` surface for the loopback-gated `settings.*` methods. */
  settingsApi: BridgeSettingsApi
  /** Typed `credentialsController` surface for the loopback-gated `credentials.*` methods. */
  credentialsApi: BridgeCredentialsApi
  /** Typed `directoryPickerController` surface for the loopback-gated `host.pickDirectory` method. */
  directoryPickerApi: BridgeDirectoryPickerApi
  /** Typed `llm` surface for the extension's model-discovery flow. */
  llmApi: BridgeLlmApi
  /** Per-connection session event stream (in-process cordis event bus adapter; see `session-events.ts`). */
  openSessionEvents: (signal: AbortSignal) => AsyncIterable<SessionEventEnvelope>
  /** Default per-tool-call timeout in ms. */
  toolTimeoutMs: number
  /** Capabilities to echo in `hello.ok` (negotiated snapshot budgets). */
  caps: BridgeCaps
  /** Seed a followed-page snapshot into a live or deferred Agent session. */
  injectBrowserSnapshot: (sessionId: string, snapshot: string) => void | Promise<void>
  /**
   * Permanently delete one session's durable storage. Callers archive the
   * session through the gateway first; this only removes files.
   */
  purgeSession: (sessionId: string) => Promise<void>
  /**
   * Test seam: force the remote address seen by the privilege gate. The
   * sandbox cannot bind arbitrary loopback literals, so the non-loopback
   * branch is exercised through this override; production never sets it.
   */
  remoteAddressOverride?: string
  /** Seconds a fresh socket may present `hello`; defaults to HELLO_TIMEOUT_MS. */
  helloTimeoutMs?: number
  /** Server ping cadence; defaults to PING_INTERVAL_MS. */
  pingIntervalMs?: number
}

/** One in-flight tool call awaiting the extension's `tool.result`. */
interface PendingTool {
  resolve: (result: unknown) => void
  reject: (error: BridgeToolError) => void
  timer: NodeJS.Timeout
}

/** A socket that passed authentication and owns the single active slot. */
interface ReadyConnection {
  ws: WebSocket
  /** Remote address captured at upgrade time (loopback gate for privileged methods). */
  remoteAddress: string | undefined
  abort: AbortController
  pump: Promise<void>
  ping: NodeJS.Timeout
}

function sendFrame(ws: WebSocket, frame: BridgeFrame): void {
  /* v8 ignore next -- teardown race: the socket can die between a pump's
  readiness check and this write; the guard refuses writes on dead sockets */
  if (ws.readyState !== WebSocket.OPEN) return
  ws.send(JSON.stringify(frame))
}

/**
 * Decode one ws message payload to text. Exported so all three delivery
 * shapes (fragmented buffer list, Buffer, ArrayBuffer) are unit-testable
 * directly — node ws only ever delivers Buffers in practice.
 * @param data - ws message payload.
 * @returns the decoded UTF-8 text.
 */
export function messageToText(data: Buffer | ArrayBuffer | Buffer[]): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  return Buffer.from(data).toString('utf8')
}

/**
 * Token-authenticated bridge server. Construct once per plugin instance;
 * dispose with {@link close}.
 */
export class BridgeServer {
  private readonly wss = new WebSocketServer({ noServer: true })
  private current: ReadyConnection | null = null
  private readonly pendingTools = new Map<string, PendingTool>()
  private readonly orderedSessionRpcs = new Map<string, Promise<void>>()
  private closed = false

  constructor(private readonly deps: BridgeServerDeps) {}

  /**
   * Handle one HTTP upgrade for the bridge path.
   * @param req - upgrade request (carries the client's remote address).
   * @param socket - raw socket transferred by the HTTP server.
   * @param head - bytes already read after the upgrade headers.
   */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const remote = this.deps.remoteAddressOverride ?? req.socket.remoteAddress
    const origin = req.headers.origin
    this.wss.handleUpgrade(req, socket, head, (ws) => { this.attach(ws, remote, origin) })
  }

  /**
   * Request one browser action from the connected extension.
   * @param name - tool name (also the wire action name).
   * @param args - validated tool arguments.
   * @param signal - caller cancellation (abort settles the call as cancelled).
   * @param timeoutMs - per-call budget; defaults to the plugin config value.
   * @param sessionId - optional owning Agent session for approval continuity.
   * @returns the extension's action result.
   * @throws BridgeToolError when no extension is connected, the call times
   *   out, is cancelled, or the extension reports a failure.
   */
  requestTool(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
    timeoutMs: number = this.deps.toolTimeoutMs,
    sessionId?: string,
  ): Promise<unknown> {
    const conn = this.current
    if (conn === null) {
      throw new BridgeToolError('bridge-closed', 'no browser extension is connected to the bridge')
    }
    // A caller that already aborted must not dispatch: the abort listener
    // below does not replay for pre-aborted signals, so the call would be
    // sent to the extension and executed despite the cancellation.
    if (signal.aborted) {
      throw new BridgeToolError('bridge-closed', 'tool call cancelled before dispatch')
    }
    const id = randomUUID()
    const expiresAt = Date.now() + timeoutMs
    return new Promise<unknown>((resolve, reject) => {
      let timer: NodeJS.Timeout
      const settle = (error: BridgeToolError): void => {
        clearTimeout(timer)
        this.pendingTools.delete(id)
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
      const cancel = (error: BridgeToolError): void => {
        // The extension may be paused on a user approval after the caller has
        // stopped waiting. Withdraw that approval before settling locally so
        // a late click cannot execute an expired action.
        sendFrame(conn.ws, { t: 'tool.cancel', id })
        settle(error)
      }
      const onAbort = (): void => {
        cancel(new BridgeToolError('bridge-closed', 'tool call cancelled before the extension answered'))
      }
      timer = setTimeout(() => {
        cancel(new BridgeToolError('timeout', `browser action "${name}" timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      signal.addEventListener('abort', onAbort, { once: true })
      this.pendingTools.set(id, { resolve, reject, timer })
      conn.ws.send(JSON.stringify({
        t: 'tool.call',
        id,
        name,
        args,
        expiresAt,
        ...(sessionId === undefined ? {} : { sessionId }),
      } satisfies BridgeFrame), (error) => {
        /* v8 ignore next -- teardown race: when the write fails, the socket's
        close handler settles the same call with the same code; the callback
        path is a defensive second settle, covered via the close path */
        if (error != null) {
          settle(new BridgeToolError('bridge-closed', `bridge socket failed before delivery: ${error.message}`))
        }
      })
    })
  }

  /**
   * Terminate the server: close the acceptor, drop all sockets, reject all
   * in-flight tool calls.
   * @returns a promise resolving after the acceptor and all pumps stop.
   */
  async close(): Promise<void> {
    // Idempotent: a second close must not touch the acceptor (ws throws
    // "The server is not running" when closing an already-closed server).
    if (this.closed) return
    this.closed = true
    // Capture the live pump BEFORE replaceConnection nulls the connection.
    const pumps = this.current === null ? [] : [this.current.pump]
    this.replaceConnection()
    for (const socket of this.wss.clients) socket.terminate()
    this.current = null
    await new Promise<void>((resolve, reject) => {
      this.wss.close((error) => {
        /* v8 ignore next -- acceptor close cannot fail: close() is idempotent
        and the noServer acceptor only reports teardown of already-terminated clients */
        if (error === undefined) resolve()
        /* v8 ignore next -- same unreachable arm */
        else reject(error)
      })
    })
    await Promise.all(pumps)
  }

  /** @returns whether an authenticated extension is currently connected. */
  hasConnection(): boolean {
    return this.current !== null
  }

  private attach(ws: WebSocket, remoteAddress: string | undefined, origin: string | undefined): void {
    let helloTimer: NodeJS.Timeout | undefined = setTimeout(() => {
      ws.close(4001, 'hello timeout')
    }, this.deps.helloTimeoutMs ?? HELLO_TIMEOUT_MS)

    const onMessage = (data: Buffer | ArrayBuffer | Buffer[]): void => {
      const text = messageToText(data)
      const frame = parseBridgeFrame(text)
      if (frame === undefined) {
        ws.close(1008, 'unparseable frame')
        return
      }
      if (helloTimer !== undefined) {
        // Pending state: only `hello` is legal.
        if (frame.t !== 'hello') {
          ws.close(1008, 'hello first')
          return
        }
        // Zero-config local mode: loopback sockets skip the token (the
        // extension auto-discovers the bridge and connects without setup).
        // WebSockets have no same-origin policy, so a malicious page could
        // open a cross-origin socket to 127.0.0.1 with a loopback remote —
        // the loopback shortcut therefore requires a chrome-extension://
        // Origin (only extension contexts can present one; pages cannot
        // forge the header). Firefox moz-extension:// origins contain a
        // per-install UUID rather than the manifest's stable Gecko ID, so
        // they are not an identity boundary and must present the bearer token.
        // Non-loopback remotes must also present the bearer token.
        const loopbackNoToken = isLoopbackAddress(remoteAddress)
          && typeof origin === 'string'
          && origin.startsWith('chrome-extension://')
        if (!loopbackNoToken && !verifyToken(this.deps.token, frame.token)) {
          ws.close(4002, 'bad token')
          return
        }
        clearTimeout(helloTimer)
        helloTimer = undefined
        this.promote(ws, remoteAddress)
        return
      }
      this.handleReadyFrame(frame)
    }
    const onClose = (): void => {
      if (helloTimer !== undefined) clearTimeout(helloTimer)
      if (this.current !== null && this.current.ws === ws) this.replaceConnection()
    }
    ws.on('message', onMessage)
    ws.once('close', onClose)
    ws.once('error', onClose)
  }

  /** Promote an authenticated socket to the single active slot. */
  private promote(ws: WebSocket, remoteAddress: string | undefined): void {
    this.replaceConnection()
    const abort = new AbortController()
    const ping = setInterval(() => { sendFrame(ws, { t: 'ping' }) }, this.deps.pingIntervalMs ?? PING_INTERVAL_MS)
    const pump = (async () => {
      try {
        for await (const envelope of this.deps.openSessionEvents(abort.signal)) {
          if (ws.readyState !== WebSocket.OPEN) break
          sendFrame(ws, {
            t: 'event',
            frame: { rpcId: envelope.rpcId, method: envelope.method, payload: envelope.payload },
          })
        }
      } catch (error: unknown) {
        if (!abort.signal.aborted && ws.readyState === WebSocket.OPEN) {
          sendFrame(ws, { t: 'error', code: 'stream-failed', message: String(error) })
        }
      }
    })()
    this.current = { ws, remoteAddress, abort, pump, ping }
    sendFrame(ws, { t: 'hello.ok', caps: this.deps.caps })
    ws.once('close', () => {
      clearInterval(ping)
      abort.abort()
    })
  }

  private handleReadyFrame(frame: BridgeFrame): void {
    switch (frame.t) {
      case 'rpc':
        this.routeRpc(frame)
        break
      case 'respond':
        this.handleRespond(frame)
        break
      case 'tool.result':
        this.settleTool(frame.id, frame.ok, frame.ok ? frame.result : frame.error)
        break
      case 'pong':
      case 'hello':
      case 'hello.ok':
      case 'rpc.result':
      case 'respond.result':
      case 'event':
      case 'tool.call':
      case 'tool.cancel':
      case 'ping':
      case 'error':
        // Protocol violations and unsolicited server-side shapes are ignored;
        // the extension is the only sender on this channel.
        break
    }
  }

  /**
   * Preserve prompt/cancel arrival order per session. In particular, the
   * first prompt may still be materializing a provisional session; its cancel
   * must not reach the gateway until that admission has completed.
   */
  private routeRpc(frame: Extract<ClientFrame, { t: 'rpc' }>): void {
    const sessionId = orderedSessionId(frame)
    if (sessionId === undefined) {
      void this.handleRpc(frame)
      return
    }
    const previous = this.orderedSessionRpcs.get(sessionId) ?? Promise.resolve()
    const task = previous.then(
      () => this.handleRpc(frame),
      () => this.handleRpc(frame),
    )
    this.orderedSessionRpcs.set(sessionId, task)
    const clear = (): void => {
      if (this.orderedSessionRpcs.get(sessionId) === task) this.orderedSessionRpcs.delete(sessionId)
    }
    void task.then(clear, clear)
  }

  private async handleRpc(frame: Extract<ClientFrame, { t: 'rpc' }>): Promise<void> {
    const conn = this.current
    /* v8 ignore next -- replacement race: a frame can land between a socket
    replacement and the next promotion; the re-check keeps the handler total */
    if (conn === null) return
    const forbidden = PRIVILEGED_METHODS.has(frame.method) && !isLoopbackAddress(conn.remoteAddress)
    if (forbidden) {
      sendFrame(conn.ws, { t: 'rpc.result', id: frame.id, ok: false, error: { code: 'forbidden', message: 'method is loopback-only' } })
      return
    }
    if (frame.method === BRIDGE_INJECT_BROWSER_SNAPSHOT_METHOD) {
      const payload = browserSnapshotPayload(frame.payload)
      if (payload === undefined) {
        sendFrame(conn.ws, {
          t: 'rpc.result',
          id: frame.id,
          ok: false,
          error: { code: 'bad-request', message: 'sessionId and snapshot must be non-empty strings' },
        })
        return
      }
      try {
        await this.deps.injectBrowserSnapshot(payload.sessionId, payload.snapshot)
        sendFrame(conn.ws, { t: 'rpc.result', id: frame.id, ok: true, result: { accepted: true } })
      } catch (error: unknown) {
        sendFrame(conn.ws, {
          t: 'rpc.result',
          id: frame.id,
          ok: false,
          error: { code: 'internal', message: String(error) },
        })
      }
      return
    }
    if (frame.method === BRIDGE_SESSION_PURGE_METHOD) {
      const sessionId = purgeSessionPayload(frame.payload)
      if (sessionId === undefined) {
        sendFrame(conn.ws, {
          t: 'rpc.result',
          id: frame.id,
          ok: false,
          error: { code: 'bad-request', message: 'sessionId must be a non-empty string' },
        })
        return
      }
      try {
        await this.deps.purgeSession(sessionId)
        sendFrame(conn.ws, { t: 'rpc.result', id: frame.id, ok: true, result: { purged: true } })
      } catch (error: unknown) {
        const code = error instanceof SessionPurgeError ? error.code : 'internal'
        const message = error instanceof Error ? error.message : String(error)
        sendFrame(conn.ws, { t: 'rpc.result', id: frame.id, ok: false, error: { code, message } })
      }
      return
    }
    const dispatch = dispatchRpc(this.deps, frame.method, frame.payload)
    if (dispatch === undefined) {
      sendFrame(conn.ws, {
        t: 'rpc.result',
        id: frame.id,
        ok: false,
        error: { code: 'not-found', message: `unknown method "${frame.method}"` },
      })
      return
    }
    const controller = new AbortController()
    try {
      const result = await dispatch(controller.signal)
      sendFrame(conn.ws, { t: 'rpc.result', id: frame.id, ok: true, result })
    } catch (error: unknown) {
      sendFrame(conn.ws, { t: 'rpc.result', id: frame.id, ok: false, error: remoteFailureOf(error) })
    }
  }

  /**
   * Answer a `respond` frame. There is no in-process equivalent of the old
   * `ApiProxy.respond(message)` call: the replacement mechanism is a scoped
   * Cordis waterfall event (`approval/request` / `user-questions/request`)
   * that a listener answers by returning a value from its own handler, not by
   * holding a request and resolving it later from an unrelated code path.
   * Wiring the bridge as a global listener on those events would risk
   * intercepting approvals meant for the GUI's own listener, so this frame is
   * refused rather than guessed at. See the plugin's migration notes.
   */
  private handleRespond(frame: Extract<ClientFrame, { t: 'respond' }>): void {
    const conn = this.current
    /* v8 ignore next -- replacement race; a closed socket simply drops the receipt */
    if (conn === null) return
    sendFrame(conn.ws, {
      t: 'respond.result',
      id: frame.id,
      ok: false,
      error: { code: 'not-implemented', message: 'pending host-interaction responses are not supported by this bridge version' },
    })
  }

  private settleTool(id: string, ok: boolean, payload: unknown): void {
    const pending = this.pendingTools.get(id)
    if (pending === undefined) return
    clearTimeout(pending.timer)
    this.pendingTools.delete(id)
    if (ok) pending.resolve(payload)
    else pending.reject(new BridgeToolError(payloadCode(payload), payloadMessage(payload)))
  }

  /** Close the current connection (if any) and settle its in-flight calls. */
  private replaceConnection(): void {
    const conn = this.current
    if (conn === null) return
    this.current = null
    clearInterval(conn.ping)
    conn.abort.abort()
    if (conn.ws.readyState === WebSocket.OPEN || conn.ws.readyState === WebSocket.CONNECTING) {
      conn.ws.close(4000, 'replaced')
    }
    for (const [id, pending] of this.pendingTools) {
      clearTimeout(pending.timer)
      this.pendingTools.delete(id)
      pending.reject(new BridgeToolError('bridge-closed', 'the extension connection was replaced'))
    }
  }
}

function browserSnapshotPayload(payload: unknown): { sessionId: string; snapshot: string } | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  const { sessionId, snapshot } = payload as Record<string, unknown>
  if (typeof sessionId !== 'string' || sessionId.trim() === '') return undefined
  if (typeof snapshot !== 'string' || snapshot.trim() === '') return undefined
  return { sessionId, snapshot }
}

function purgeSessionPayload(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  const { sessionId } = payload as Record<string, unknown>
  if (typeof sessionId !== 'string' || sessionId.trim() === '') return undefined
  return sessionId
}

/** One wire RPC method resolved to its typed dispatch, awaiting only a cancellation signal. */
type RpcDispatch = (signal: AbortSignal) => Promise<unknown>

/**
 * Resolve one wire `frame.method` to its typed in-process call, validating
 * `payload` against the shape that method needs.
 * @param deps - the bridge's injected service surfaces.
 * @param method - wire method name (e.g. `session.create`).
 * @param payload - unvalidated wire payload.
 * @returns a callable bound to `payload`, or `undefined` for an unknown method.
 * @throws TypertRemoteFailure with code `bad-request` when `payload` does not match `method`'s shape.
 */
function dispatchRpc(deps: BridgeServerDeps, method: string, payload: unknown): RpcDispatch | undefined {
  switch (method) {
    case 'session.create':
      return () => deps.sessionApi.create(sessionCreateRequest(payload))
    case 'session.prompt':
      return signal => deps.sessionApi.prompt(sessionPromptRequest(payload), signal)
    case 'session.cancel':
      return async () => deps.sessionApi.cancel(sessionCancelRequest(payload))
    case 'session.list':
      return signal => deps.sessionApi.list(sessionListRequest(payload), signal)
    case 'session.rename':
      return () => deps.sessionApi.rename(sessionRenameRequest(payload))
    case 'session.selectModel':
      return () => deps.sessionApi.selectModel(sessionSelectModelRequest(payload))
    case 'session.attachment':
      return () => deps.sessionApi.attachment(sessionAttachmentRequest(payload))
    case 'session.history':
      return signal => sessionHistory(deps.sessionApi, payload, signal)
    case 'workspace.list':
      return signal => deps.workspaceApi.list(signal)
    case 'workspace.archiveSession':
      return () => deps.workspaceApi.archiveSession(workspaceArchiveSessionRequest(payload))
    case 'llm.discoverModels': {
      const request = llmDiscoverModelsRequest(payload)
      return async signal => ({ models: await deps.llmApi.discoverModels(request.settingsNs, { ...request.request, signal }) })
    }
    case 'host.openPath':
      return signal => deps.sessionApi.openWorkspacePath(openWorkspacePathRequest(payload), signal)
    case 'host.pickDirectory':
      return signal => deps.directoryPickerApi.pick(signal)
    case 'settings.describe':
      return async () => deps.settingsApi.describe()
    case 'settings.openDocument':
      return signal => deps.settingsApi.openSettingsDocument(signal)
    case 'settings.update': {
      const request = settingsWriteRequest(payload, 'patch')
      return () => deps.settingsApi.update(request.ns, request.body as Record<string, JsonValue>, request.expectedRevision)
    }
    case 'settings.replace': {
      const request = settingsWriteRequest(payload, 'section')
      return () => deps.settingsApi.replace(request.ns, request.body as Record<string, JsonValue>, request.expectedRevision)
    }
    case 'settings.mutate': {
      const request = settingsWriteRequest(payload, 'ops')
      return () => deps.settingsApi.mutate(request.ns, request.body as SettingsPathOpView[], request.expectedRevision)
    }
    case 'credentials.describe':
      return () => deps.credentialsApi.describe(credentialsDescribeRequest(payload))
    case 'credentials.set': {
      const request = credentialsSetRequest(payload)
      return () => deps.credentialsApi.set(request.ref, request.value)
    }
    case 'credentials.unset': {
      const request = credentialsUnsetRequest(payload)
      return () => deps.credentialsApi.unset(request.ref)
    }
    default:
      return undefined
  }
}

/**
 * A locally-detected wire validation failure. Shaped like the Host's own
 * `TypertRemoteFailure` (`{ failure: { code, message } }`) so `remoteFailureOf`
 * can map both uniformly, without this plugin importing that harness class —
 * see `harness-types.ts` for why.
 */
class BridgeRemoteFailure extends Error {
  constructor(readonly failure: { readonly code: string; readonly message: string }) {
    super(failure.message)
    this.name = 'BridgeRemoteFailure'
  }
}

/** Raise a `bad-request` failure for a wire payload that does not match its method's shape. */
function badRequest(message: string): BridgeRemoteFailure {
  return new BridgeRemoteFailure({ code: 'bad-request', message })
}

/** Structural check for a thrown Host business failure shaped like `{ failure: { code, message, details? } }` (e.g. `TypertRemoteFailure`). */
function isRemoteFailureLike(error: unknown): error is { failure: { code: string; message: string; details?: unknown } } {
  if (typeof error !== 'object' || error === null || !('failure' in error)) return false
  const failure = (error as { failure: unknown }).failure
  return typeof failure === 'object' && failure !== null
    && typeof (failure as { code?: unknown }).code === 'string'
    && typeof (failure as { message?: unknown }).message === 'string'
}

function payloadRecord(payload: unknown, method: string): Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw badRequest(`invalid payload for ${method}`)
  }
  return payload as Record<string, unknown>
}

function sessionCreateRequest(payload: unknown): SessionCreateRequest {
  const record = payload === undefined ? {} : payloadRecord(payload, 'session.create')
  const request: Partial<Record<keyof SessionCreateRequest, unknown>> = {}
  if (typeof record.workspaceId === 'string') request.workspaceId = record.workspaceId
  if (typeof record.cwd === 'string') request.cwd = record.cwd
  if (typeof record.sessionId === 'string') request.sessionId = record.sessionId
  if (typeof record.agentPreset === 'string') request.agentPreset = record.agentPreset
  return request as SessionCreateRequest
}

function sessionPromptRequest(payload: unknown): SessionPromptRequest {
  const record = payloadRecord(payload, 'session.prompt')
  const { sessionId, mode, content, requestId, clientTimeZone } = record
  if (typeof sessionId !== 'string' || sessionId.trim() === '') throw badRequest('session.prompt requires a non-empty sessionId')
  if (mode !== 'queue' && mode !== 'steer') throw badRequest('session.prompt requires mode "queue" or "steer"')
  if (!Array.isArray(content)) throw badRequest('session.prompt requires an array content')
  return {
    // Client-minted upstream of this migration; synthesized here when absent
    // so extension builds that predate the field keep working.
    requestId: (typeof requestId === 'string' && requestId.trim() !== '' ? requestId : randomUUID()) as SessionPromptRequest['requestId'],
    sessionId: sessionId as SessionPromptRequest['sessionId'],
    mode,
    content: content as SessionPromptRequest['content'],
    ...(typeof clientTimeZone === 'string' ? { clientTimeZone } : {}),
  }
}

function sessionCancelRequest(payload: unknown): SessionCancelRequest {
  const { sessionId } = payloadRecord(payload, 'session.cancel')
  if (typeof sessionId !== 'string' || sessionId.trim() === '') throw badRequest('session.cancel requires a non-empty sessionId')
  return { sessionId: sessionId as SessionCancelRequest['sessionId'] }
}

function sessionListRequest(payload: unknown): SessionListRequest {
  const record = payload === undefined ? {} : payloadRecord(payload, 'session.list')
  return typeof record.cursor === 'string' ? { cursor: record.cursor } : {}
}

function sessionRenameRequest(payload: unknown): SessionRenameRequest {
  const { sessionId, title } = payloadRecord(payload, 'session.rename')
  if (typeof sessionId !== 'string' || sessionId.trim() === '') throw badRequest('session.rename requires a non-empty sessionId')
  if (typeof title !== 'string') throw badRequest('session.rename requires a title')
  return { sessionId: sessionId as SessionRenameRequest['sessionId'], title }
}

function openWorkspacePathRequest(payload: unknown): SessionOpenWorkspacePathRequest {
  const { path } = payloadRecord(payload, 'host.openPath')
  if (typeof path !== 'string' || path.trim() === '') throw badRequest('host.openPath requires a non-empty path')
  return { path }
}

function sessionSelectModelRequest(payload: unknown): SessionSelectModelRequest {
  const { sessionId, provider, model, reasoningEffort } = payloadRecord(payload, 'session.selectModel')
  if (typeof sessionId !== 'string' || sessionId.trim() === '') throw badRequest('session.selectModel requires a non-empty sessionId')
  if (typeof provider !== 'string' || provider.trim() === '') throw badRequest('session.selectModel requires a non-empty provider')
  if (typeof model !== 'string' || model.trim() === '') throw badRequest('session.selectModel requires a non-empty model')
  return {
    sessionId: sessionId as SessionSelectModelRequest['sessionId'],
    provider,
    model,
    ...(typeof reasoningEffort === 'string' ? { reasoningEffort } : {}),
  }
}

function sessionAttachmentRequest(payload: unknown): SessionAttachmentRequest {
  const { sessionId, attachmentId } = payloadRecord(payload, 'session.attachment')
  if (typeof sessionId !== 'string' || sessionId.trim() === '') throw badRequest('session.attachment requires a non-empty sessionId')
  if (typeof attachmentId !== 'string' || attachmentId.trim() === '') throw badRequest('session.attachment requires a non-empty attachmentId')
  return { sessionId: sessionId as SessionAttachmentRequest['sessionId'], attachmentId }
}

/**
 * `session.history` has no unary Remote method anymore — it's synthesized
 * from the opening snapshot of `follow`, mapped into the wire shape the
 * extension's `HistoryPage` still expects (`{ events, projections }`).
 * Chunk-packed assistant delta runs are dropped rather than unpacked.
 */
async function sessionHistory(
  sessionApi: BridgeSessionApi,
  payload: unknown,
  signal: AbortSignal,
): Promise<{ events: { event: unknown }[]; projections?: unknown }> {
  const { sessionId } = payloadRecord(payload, 'session.history')
  if (typeof sessionId !== 'string' || sessionId.trim() === '') throw badRequest('session.history requires a non-empty sessionId')
  const iterator = sessionApi.follow(
    { address: { kind: 'session', sessionId: sessionId as SessionAttachmentRequest['sessionId'] } },
    signal,
  )[Symbol.asyncIterator]()
  const first = await iterator.next()
  if (first.done || first.value.type !== 'snapshot') {
    throw badRequest('session.history: follow stream produced no opening snapshot')
  }
  await iterator.return?.()
  const snapshot = first.value
  return {
    events: snapshot.records
      .filter((record): record is Extract<typeof record, { type: 'event' }> => record.type === 'event')
      .map(record => ({ event: record.event })),
    projections: snapshot.projections,
  }
}

function workspaceArchiveSessionRequest(payload: unknown): WorkspaceArchiveSessionRequest {
  const { sessionId } = payloadRecord(payload, 'workspace.archiveSession')
  if (typeof sessionId !== 'string' || sessionId.trim() === '') throw badRequest('workspace.archiveSession requires a non-empty sessionId')
  return { sessionId: sessionId as WorkspaceArchiveSessionRequest['sessionId'] }
}

function llmDiscoverModelsRequest(payload: unknown): { settingsNs: string; request: LlmModelDiscoveryRequest } {
  const { settingsNs, provider, api, baseURL, apiKey } = payloadRecord(payload, 'llm.discoverModels')
  if (typeof settingsNs !== 'string' || settingsNs.trim() === '') throw badRequest('llm.discoverModels requires a non-empty settingsNs')
  const request: LlmModelDiscoveryRequest = {
    ...(typeof provider === 'string' ? { provider } : {}),
    ...(typeof api === 'string' ? { api } : {}),
    ...(typeof baseURL === 'string' ? { baseURL } : {}),
    ...(typeof apiKey === 'string' ? { apiKey } : {}),
  }
  return { settingsNs, request }
}

function settingsWriteRequest(
  payload: unknown,
  bodyKey: 'patch' | 'section' | 'ops',
): { ns: string; body: unknown; expectedRevision: number | undefined } {
  const record = payloadRecord(payload, `settings.${bodyKey === 'patch' ? 'update' : bodyKey === 'section' ? 'replace' : 'mutate'}`)
  const { ns, expectedRevision } = record
  const body = record[bodyKey]
  if (typeof ns !== 'string' || ns.trim() === '') throw badRequest('settings write requires a non-empty ns')
  if (bodyKey === 'ops' ? !Array.isArray(body) : typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw badRequest(`settings write requires ${bodyKey}`)
  }
  if (expectedRevision !== undefined && typeof expectedRevision !== 'number') {
    throw badRequest('settings write expectedRevision must be a number when present')
  }
  return { ns, body, expectedRevision }
}

function credentialsDescribeRequest(payload: unknown): string[] {
  const { refs } = payloadRecord(payload, 'credentials.describe')
  if (!Array.isArray(refs) || !refs.every((ref): ref is string => typeof ref === 'string')) {
    throw badRequest('credentials.describe requires a string array refs')
  }
  return refs
}

function credentialsSetRequest(payload: unknown): { ref: string; value: string } {
  const { ref, value } = payloadRecord(payload, 'credentials.set')
  if (typeof ref !== 'string' || ref.trim() === '') throw badRequest('credentials.set requires a non-empty ref')
  if (typeof value !== 'string') throw badRequest('credentials.set requires a value')
  return { ref, value }
}

function credentialsUnsetRequest(payload: unknown): { ref: string } {
  const { ref } = payloadRecord(payload, 'credentials.unset')
  if (typeof ref !== 'string' || ref.trim() === '') throw badRequest('credentials.unset requires a non-empty ref')
  return { ref }
}

/** Map a thrown dispatch failure to the wire `rpc.result` error shape. */
function remoteFailureOf(error: unknown): { code: string; message: string; details?: unknown } {
  if (isRemoteFailureLike(error)) {
    return {
      code: error.failure.code,
      message: error.failure.message,
      ...(error.failure.details === undefined ? {} : { details: error.failure.details }),
    }
  }
  return { code: 'internal', message: error instanceof Error ? error.message : String(error) }
}

function orderedSessionId(frame: Extract<ClientFrame, { t: 'rpc' }>): string | undefined {
  if (!ORDERED_SESSION_METHODS.has(frame.method)) return undefined
  if (typeof frame.payload !== 'object' || frame.payload === null || Array.isArray(frame.payload)) return undefined
  const sessionId = (frame.payload as Record<string, unknown>).sessionId
  return typeof sessionId === 'string' ? sessionId : undefined
}

/**
 * Tool error payload → stable code. The wire parser enforces string fields,
 * so the fallback branches are parser-gated; exported so the fallback
 * contract is unit-testable directly.
 * @param payload - extension-reported error payload.
 * @returns the stable error code.
 */
export function payloadCode(payload: unknown): ToolErrorCode {
  if (typeof payload === 'object' && payload !== null) {
    const code = (payload as { code?: unknown }).code
    if (typeof code === 'string') return code as ToolErrorCode
    return 'internal'
  }
  return 'internal'
}

/**
 * Tool error payload → message. The wire parser enforces string fields, so
 * the fallback branches are parser-gated; exported so the fallback contract
 * is unit-testable directly.
 * @param payload - extension-reported error payload.
 * @returns the human-readable message.
 */
export function payloadMessage(payload: unknown): string {
  if (typeof payload === 'object' && payload !== null) {
    const message = (payload as { message?: unknown }).message
    if (typeof message === 'string' && message.length > 0) return message
    return 'browser action failed'
  }
  return 'browser action failed'
}
