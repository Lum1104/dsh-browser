/**
 * Wire contract between the dsh bridge plugin and the browser extension.
 *
 * Zero-dependency module (pure types, constants, and a parser): both the
 * plugin (node) and the Chrome extension (browser bundle) import this file, so
 * the frame shapes can never drift between the two halves.
 *
 * Frames are one JSON object per WebSocket message, discriminated by `t`.
 * Correlation ids (`id`) are minted by the requestor and echoed by the
 * responder; they are opaque strings, never parsed.
 *
 * @module
 */

/** WebSocket pathname the bridge plugin registers on the host webserver. */
export const BRIDGE_PATH = '/ext/bridge'

/** Zero-config discovery endpoint: returns `{ wsUrl }` for the extension. */
export const BRIDGE_CONFIG_PATH = '/ext/bridge-config'

/** Internal RPC used after an explicit tab handoff to seed the Agent's next step. */
export const BRIDGE_INJECT_BROWSER_SNAPSHOT_METHOD = 'bridge.injectBrowserSnapshot'

/** Internal RPC used by the panel to permanently delete one session's durable storage. */
export const BRIDGE_SESSION_PURGE_METHOD = 'bridge.session.purge'

/** Seconds a fresh socket may take to present `hello` before it is closed. */
export const HELLO_TIMEOUT_MS = 5_000

/** Server-side ping cadence; the client answers `pong` to prove liveness. */
export const PING_INTERVAL_MS = 30_000

/** Default bytes of the generated bearer token (256-bit). */
export const DEFAULT_TOKEN_BYTES = 32

/**
 * Default rendered-snapshot character budget.
 *
 * Sized for a large-context deployment: a snapshot that cuts the page in half
 * costs a second call and a guess, which is more expensive than the characters
 * it saved. Deployments on a small context lower it in plugin config.
 */
export const DEFAULT_SNAPSHOT_MAX_CHARS = 96_000

/** Smallest snapshot budget that can carry both trust boundaries and page text. */
export const MIN_SNAPSHOT_MAX_CHARS = 500

/** Raster formats a tool result may carry (the attachment service's own set, minus GIF). */
export const TOOL_IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const

/** Media type of one image returned by a browser tool. */
export type ToolImageMediaType = typeof TOOL_IMAGE_MEDIA_TYPES[number]

/** Default long-edge cap the extension downscales captures to before sending. */
export const DEFAULT_IMAGE_MAX_DIMENSION = 1_568

/**
 * Default total-pixel cap for one capture.
 *
 * Sized to DeepSeek's own rescaling target of roughly 800×800 equivalent
 * pixels, with headroom: a little above the target keeps text and fine chart
 * detail legible after the route's own resample, while everything past that is
 * discarded before inference and charged the same flat per-image ceiling. Two
 * megapixels is the point where more bytes stop buying more sight.
 */
export const DEFAULT_IMAGE_MAX_PIXELS = 2_000_000

/** Default encoded-byte cap for one captured image (well under the store's own limit). */
export const DEFAULT_IMAGE_MAX_BYTES = 4 * 1024 * 1024

/**
 * Default number of images one tool call may return.
 *
 * Four rather than one, because the unit of interest is usually a POST, not a
 * picture: a forum reply with four screenshots read one call at a time costs
 * four round trips to learn one thing.
 */
export const DEFAULT_IMAGE_MAX_PER_CALL = 4

/**
 * Pages one `browser_read_pages` call may visit. Shared with the extension so
 * the advertised contract and the enforced bound cannot drift apart.
 */
export const MAX_PAGES_PER_READ = 12

/** Default characters returned per page by `browser_read_pages`. */
export const DEFAULT_PAGE_READ_CHARS = 24_000

/** Hard bound on characters returned per page, per call. */
export const MAX_PAGE_READ_CHARS = 120_000

/** Default characters returned by one `browser_get_text` window. */
export const DEFAULT_TEXT_WINDOW_CHARS = 40_000

/** Hard bound on one `browser_get_text` window. */
export const MAX_TEXT_WINDOW_CHARS = 200_000

/** Downloads one `browser_download` call may start. */
export const MAX_BATCH_DOWNLOADS = 20

/** Error codes a tool call may settle with. Open set: consumers must tolerate unknown codes. */
export type ToolErrorCode =
  | 'no-active-tab'
  | 'content-unavailable'
  | 'action-failed'
  | 'timeout'
  | 'bridge-closed'
  | 'bad-args'
  | 'internal'

/** One tool-call failure: stable machine code plus human text for the model. */
export interface ToolError {
  code: ToolErrorCode
  message: string
}

/** Result sent for a pending host interaction such as ask_user_question. */
export type RespondResult =
  | { ok: true; value?: unknown }
  | { ok: false; error: { code: string; message: string; details: Record<string, unknown> } }

/** Capabilities negotiated in `hello`/`hello.ok`. The extension performs its own actions; these bounds shape page snapshots. */
export interface BridgeCaps {
  /** Page STATE is rendered as text only; images arrive solely as explicit capture results. */
  textOnly: true
  /** Upper bound on one rendered snapshot's characters (plugin config, minimum 500). */
  snapshotMaxChars: number
  /** Upper bound on interactive inventory items per snapshot (plugin config). */
  maxInteractiveItems: number
  /**
   * Image budget the HOST accepts on a tool result, sent in `hello.ok` only and
   * absent when the deployment stores no attachments (then the extension must
   * never send image payloads, and the image tools are not registered). The
   * extension downscales and re-encodes captures to fit these bounds before
   * they cross the wire.
   */
  images?: ImageResultCaps
}

/** Host-declared bounds for images returned by a browser tool. */
export interface ImageResultCaps {
  /** Encoded-byte cap for one image. */
  maxBytes: number
  /** Long-edge pixel cap for one image. */
  maxDimension: number
  /**
   * Total-pixel cap for one image (width × height), when the model route scales
   * by AREA rather than by long edge.
   *
   * DeepSeek's vision models rescale every image to roughly 800×800 EQUIVALENT
   * PIXELS before inference and charge a flat per-image token ceiling, so a
   * 2000×2000 capture and a 5000×5000 one are billed and seen identically. A
   * long-edge cap alone cannot express that: a 1568×200 strip is well under the
   * edge cap while a 1200×1200 square is over the area budget at the same edge.
   * Sending more than this spends transport and encode time on pixels the route
   * discards. Absent when the host declares no area preference.
   */
  maxPixels?: number
  /** Images one tool call may return. */
  maxPerCall: number
  /** Accepted media types, in host preference order. */
  mediaTypes: readonly ToolImageMediaType[]
}

/**
 * One image a browser tool captured, as it crosses the wire. Bytes are base64
 * (no `data:` prefix); the plugin decodes and commits them to the attachment
 * store before the model ever sees a reference.
 */
export interface ToolImagePayload {
  data: string
  mediaType: ToolImageMediaType
  width: number
  height: number
  /** Display name for the transcript (never a filesystem path). */
  name?: string
}

/** Frames sent by the extension to the bridge plugin. */
export type ClientFrame =
  /** First frame, within HELLO_TIMEOUT_MS of socket open. */
  | { t: 'hello'; token: string; caps: BridgeCaps }
  /** Unary gateway RPC passthrough (method names from the apiproxy RpcMethodMap). */
  | { t: 'rpc'; id: string; method: string; payload: unknown }
  /** Answer or cancel a pending host interaction through /api/respond. */
  | { t: 'respond'; id: string; rpcId: string; result: RespondResult }
  /** Result of a previously dispatched tool call. */
  | { t: 'tool.result'; id: string; ok: true; result: unknown }
  | { t: 'tool.result'; id: string; ok: false; error: ToolError }
  /** Liveness reply. */
  | { t: 'pong' }

/** Frames sent by the bridge plugin to the extension. */
export type ServerFrame =
  /** Accepted after a valid `hello`. */
  | { t: 'hello.ok'; caps: BridgeCaps }
  /** Reply to an `rpc` frame; `result` is the apiproxy ServerResponse envelope. */
  | { t: 'rpc.result'; id: string; ok: true; result: unknown }
  | { t: 'rpc.result'; id: string; ok: false; error: { code: string; message: string } }
  /** Receipt for a `respond` frame (normally `{ accepted: boolean }`). */
  | { t: 'respond.result'; id: string; ok: true; result: unknown }
  | { t: 'respond.result'; id: string; ok: false; error: { code: string; message: string } }
  /** One gateway event envelope (the same server-request shape the GUI's /api/events.mux carries). */
  | { t: 'event'; frame: { rpcId: string; method: string; payload: unknown } }
  /** A model-requested browser action to execute in the user-controlled tab. */
  | { t: 'tool.call'; id: string; name: string; args: Record<string, unknown>; expiresAt: number; sessionId?: string }
  /** Withdraw a tool call that timed out or whose caller was cancelled. */
  | { t: 'tool.cancel'; id: string }
  /** Liveness probe. */
  | { t: 'ping' }
  /** Fatal connection error; the client should re-authenticate. */
  | { t: 'error'; code: string; message: string }

/** Any frame on the wire. */
export type BridgeFrame = ClientFrame | ServerFrame

/**
 * Type guard: is this frame one the SERVER may send? Client-only shapes
 * (hello/tool.result/pong) narrow out, so server-side consumers never
 * dispatch on their own request vocabulary.
 * @param frame - parsed frame.
 * @returns true for server-sendable frames.
 */
export function isServerFrame(frame: BridgeFrame): frame is ServerFrame {
  return frame.t === 'hello.ok'
    || frame.t === 'rpc.result'
    || frame.t === 'respond.result'
    || frame.t === 'event'
    || frame.t === 'tool.call'
    || frame.t === 'tool.cancel'
    || frame.t === 'ping'
    || frame.t === 'error'
}

/**
 * Type guard: is this frame one the CLIENT may send? Server-only shapes
 * narrow out, so client-side consumers never dispatch on server vocabulary.
 * @param frame - parsed frame.
 * @returns true for client-sendable frames.
 */
export function isClientFrame(frame: BridgeFrame): frame is ClientFrame {
  return frame.t === 'hello' || frame.t === 'rpc' || frame.t === 'respond' || frame.t === 'tool.result' || frame.t === 'pong'
}

/**
 * Parse one WebSocket message into a frame.
 * @param text - raw message text.
 * @returns the frame, or `undefined` when the message is not a valid frame.
 */
export function parseBridgeFrame(text: string): BridgeFrame | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const frame = value as Record<string, unknown>
  if (typeof frame.t !== 'string') return undefined
  switch (frame.t) {
    case 'hello':
      return typeof frame.token === 'string'
        && isCaps(frame.caps)
        ? { t: 'hello', token: frame.token, caps: frame.caps }
        : undefined
    case 'rpc':
      return typeof frame.id === 'string' && typeof frame.method === 'string'
        ? { t: 'rpc', id: frame.id, method: frame.method, payload: frame.payload }
        : undefined
    case 'respond':
      return typeof frame.id === 'string' && typeof frame.rpcId === 'string' && isRespondResult(frame.result)
        ? { t: 'respond', id: frame.id, rpcId: frame.rpcId, result: frame.result }
        : undefined
    case 'tool.result':
      if (typeof frame.id !== 'string') return undefined
      if (frame.ok === true && 'result' in frame) {
        return { t: 'tool.result', id: frame.id, ok: true, result: frame.result }
      }
      return isToolError(frame.error)
        ? { t: 'tool.result', id: frame.id, ok: false, error: frame.error }
        : undefined
    case 'pong':
      return { t: 'pong' }
    case 'hello.ok':
      return isCaps(frame.caps)
        ? { t: 'hello.ok', caps: frame.caps }
        : undefined
    case 'rpc.result':
      if (typeof frame.id !== 'string') return undefined
      if (frame.ok === true && 'result' in frame) {
        return { t: 'rpc.result', id: frame.id, ok: true, result: frame.result }
      }
      return typeof frame.error === 'object' && frame.error !== null
        ? { t: 'rpc.result', id: frame.id, ok: false, error: frame.error as { code: string; message: string } }
        : undefined
    case 'respond.result':
      if (typeof frame.id !== 'string') return undefined
      if (frame.ok === true && 'result' in frame) {
        return { t: 'respond.result', id: frame.id, ok: true, result: frame.result }
      }
      return isWireError(frame.error)
        ? { t: 'respond.result', id: frame.id, ok: false, error: frame.error }
        : undefined
    case 'event':
      return typeof frame.frame === 'object' && frame.frame !== null
        ? { t: 'event', frame: frame.frame as ServerFrame extends { t: 'event' } ? ServerFrame['frame'] : never }
        : undefined
    case 'tool.call':
      if (frame.sessionId !== undefined
        && (typeof frame.sessionId !== 'string' || frame.sessionId.trim() === '')) return undefined
      return typeof frame.id === 'string' && typeof frame.name === 'string'
        && typeof frame.args === 'object' && frame.args !== null && !Array.isArray(frame.args)
        && typeof frame.expiresAt === 'number' && Number.isFinite(frame.expiresAt) && frame.expiresAt > 0
        ? {
            t: 'tool.call',
            id: frame.id,
            name: frame.name,
            args: frame.args as Record<string, unknown>,
            expiresAt: frame.expiresAt,
            ...(typeof frame.sessionId === 'string' ? { sessionId: frame.sessionId } : {}),
          }
        : undefined
    case 'tool.cancel':
      return typeof frame.id === 'string' ? { t: 'tool.cancel', id: frame.id } : undefined
    case 'ping':
      return { t: 'ping' }
    case 'error':
      return typeof frame.code === 'string' && typeof frame.message === 'string'
        ? { t: 'error', code: frame.code, message: frame.message }
        : undefined
    default:
      return undefined
  }
}

function isCaps(value: unknown): value is BridgeCaps {
  if (typeof value !== 'object' || value === null) return false
  const caps = value as Record<string, unknown>
  return caps.textOnly === true
    && typeof caps.snapshotMaxChars === 'number'
    && Number.isInteger(caps.snapshotMaxChars)
    && caps.snapshotMaxChars >= MIN_SNAPSHOT_MAX_CHARS
    && typeof caps.maxInteractiveItems === 'number' && caps.maxInteractiveItems > 0
    && (caps.images === undefined || isImageResultCaps(caps.images))
}

/**
 * Validate the optional host image budget. Unknown or malformed budgets are
 * refused rather than defaulted: an extension that misreads them would send
 * payloads the host then rejects, after the capture cost was already paid.
 * @param value - candidate `caps.images` value.
 * @returns true when the budget is a complete, positive, non-empty declaration.
 */
export function isImageResultCaps(value: unknown): value is ImageResultCaps {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const caps = value as Record<string, unknown>
  return isPositiveInteger(caps.maxBytes)
    && isPositiveInteger(caps.maxDimension)
    && isPositiveInteger(caps.maxPerCall)
    // Optional: an older extension that never heard of area budgets still
    // speaks this protocol fine.
    && (caps.maxPixels === undefined || isPositiveInteger(caps.maxPixels))
    && Array.isArray(caps.mediaTypes)
    && caps.mediaTypes.length > 0
    && caps.mediaTypes.every(isToolImageMediaType)
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

/**
 * Type guard for a media type a tool result may carry.
 * @param value - candidate media type.
 * @returns true for one of {@link TOOL_IMAGE_MEDIA_TYPES}.
 */
export function isToolImageMediaType(value: unknown): value is ToolImageMediaType {
  return typeof value === 'string' && (TOOL_IMAGE_MEDIA_TYPES as readonly string[]).includes(value)
}

/**
 * Parse one image payload from an extension tool result. The extension is
 * trusted only as far as this guard: bad shapes are dropped, so a malformed
 * capture degrades to a text-only result instead of failing the tool call.
 * @param value - candidate payload from `tool.result`.
 * @returns the payload, or `undefined` when it is not a valid image.
 */
export function parseToolImagePayload(value: unknown): ToolImagePayload | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const image = value as Record<string, unknown>
  if (typeof image.data !== 'string' || image.data === '') return undefined
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)) return undefined
  if (!isToolImageMediaType(image.mediaType)) return undefined
  if (!isPositiveInteger(image.width) || !isPositiveInteger(image.height)) return undefined
  if (image.name !== undefined && typeof image.name !== 'string') return undefined
  return {
    data: image.data,
    mediaType: image.mediaType,
    width: image.width,
    height: image.height,
    ...(typeof image.name === 'string' && image.name !== '' ? { name: image.name } : {}),
  }
}

function isToolError(value: unknown): value is ToolError {
  return typeof value === 'object' && value !== null
    && typeof (value as Record<string, unknown>).code === 'string'
    && typeof (value as Record<string, unknown>).message === 'string'
}

function isWireError(value: unknown): value is { code: string; message: string } {
  return typeof value === 'object' && value !== null
    && typeof (value as Record<string, unknown>).code === 'string'
    && typeof (value as Record<string, unknown>).message === 'string'
}

export function isRespondResult(value: unknown): value is RespondResult {
  if (typeof value !== 'object' || value === null) return false
  const result = value as Record<string, unknown>
  if (result.ok === true) return result.error === undefined
  return result.ok === false && isRespondError(result.error)
}

function isRespondError(value: unknown): value is Extract<RespondResult, { ok: false }>['error'] {
  return isWireError(value)
    && typeof (value as Record<string, unknown>).details === 'object'
    && (value as Record<string, unknown>).details !== null
    && !Array.isArray((value as Record<string, unknown>).details)
}
