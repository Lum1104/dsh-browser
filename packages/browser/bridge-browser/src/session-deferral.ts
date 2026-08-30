/**
 * Defer real session creation until the first prompt.
 *
 * The panel calls `session.create` as soon as it connects, but a session that
 * is opened and never used should leave zero trace in the store/GUI. This
 * wrapper answers `session.create` with a provisional id (minted locally,
 * nothing persisted), serves `session.page` for provisional ids as empty,
 * and materializes the real session — same id, original create payload — on
 * the first `session.prompt` for that id. Abandoned provisional ids are
 * pruned after {@link PROVISIONAL_TTL_MS}.
 *
 * @module @yuxianglin/dsh-bridge-browser/src/session-deferral
 */

import { randomUUID } from 'node:crypto'
import type {
  SessionAddress,
  SessionCreateRequest,
  SessionFollowFrame,
  SessionFollowRequest,
  SessionPage,
  SessionPageRequest,
  SessionPromptRequest,
} from './harness-types.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { BridgeSessionApi } from './session-api.ts'

/** A single-frame async iterable yielding one empty opening snapshot, for a provisional session's `follow`. */
async function* emptyFollow(): AsyncGenerator<SessionFollowFrame> {
  yield {
    type: 'snapshot',
    header: {},
    cursor: 0,
    records: [],
    hasMore: false,
    projections: { asOfSeq: -1, values: {} },
  }
}

/** Provisional entries older than this are dropped on the next create. */
const PROVISIONAL_TTL_MS = 30 * 60_000

interface ProvisionalEntry {
  /** The original create payload, replayed at materialization (keeps cwd/workspaceId). */
  readonly payload: SessionCreateRequest
  readonly createdAt: number
}

/** The provisional session id a page request addresses, or undefined for a non-session address. */
function addressedSessionId(address: SessionAddress): SessionId | undefined {
  return address.kind === 'session' ? address.sessionId : undefined
}

/**
 * Wrap the session-call surface so `create` returns a provisional id without
 * creating anything; the real session materializes on the first `prompt` for
 * that id.
 *
 * @param api - Injected session-call surface.
 * @param enabled - Whether deferral is active; false returns the API untouched.
 * @returns the original API when disabled, otherwise the wrapped API.
 */
export function withSessionDeferral(
  api: BridgeSessionApi,
  enabled: boolean,
): BridgeSessionApi {
  if (!enabled) return api

  const provisional = new Map<SessionId, ProvisionalEntry>()
  const materializing = new Map<SessionId, ReturnType<BridgeSessionApi['create']>>()

  const prune = (): void => {
    const cutoff = Date.now() - PROVISIONAL_TTL_MS
    for (const [id, entry] of provisional) {
      if (entry.createdAt < cutoff) provisional.delete(id)
    }
  }

  const mintedId = (payload: SessionCreateRequest): SessionId =>
    payload.sessionId ?? `session-${randomUUID()}` as SessionId

  return {
    ...api,
    async create(request) {
      prune()
      const sessionId = mintedId(request)
      provisional.set(sessionId, { payload: { ...request }, createdAt: Date.now() })
      return { sessionId }
    },
    async page(request: SessionPageRequest, signal) {
      const sessionId = addressedSessionId(request.address)
      if (sessionId === undefined || !provisional.has(sessionId)) return api.page(request, signal)
      const empty: SessionPage = { records: [], hasMore: false }
      return empty
    },
    follow(request: SessionFollowRequest, signal) {
      const sessionId = addressedSessionId(request.address)
      if (sessionId === undefined || !provisional.has(sessionId)) return api.follow(request, signal)
      return emptyFollow()
    },
    async prompt(request: SessionPromptRequest, signal) {
      const entry = provisional.get(request.sessionId)
      if (entry === undefined) return api.prompt(request, signal)
      const existing = materializing.get(request.sessionId)
      const pending = existing ?? api.create({ ...entry.payload, sessionId: request.sessionId })
      if (existing === undefined) {
        materializing.set(request.sessionId, pending)
        void pending.then(
          () => { materializing.delete(request.sessionId) },
          () => { materializing.delete(request.sessionId) },
        )
      }
      await pending
      provisional.delete(request.sessionId)
      return api.prompt(request, signal)
    },
  }
}
