/**
 * Defer real session creation until the first prompt.
 *
 * The panel calls `session.create` as soon as it connects, but a session that
 * is opened and never used should leave zero trace in the store/GUI. This
 * wrapper answers `session.create` with a provisional id (minted locally,
 * nothing persisted), serves `session.history` for provisional ids as empty,
 * and materializes the real session — same id, original create payload — on
 * the first `session.prompt` for that id. Abandoned provisional ids are
 * pruned after {@link PROVISIONAL_TTL_MS}.
 *
 * @module @yuxianglin/dsh-bridge-browser/src/session-deferral
 */

import { randomUUID } from 'node:crypto'
import type { ImageAttachmentLimits } from '@deepseek-ai/dsh-attachment'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { LegacyRpc } from './legacy-rpc.ts'

/** Provisional entries older than this are dropped on the next create. */
const PROVISIONAL_TTL_MS = 30 * 60_000

type CreatePayload = Record<string, unknown> & { sessionId?: SessionId }

interface ProvisionalEntry {
  /** The original create payload, replayed at materialization (keeps cwd/workspaceId). */
  payload: CreatePayload
  createdAt: number
}

/**
 * Wrap the gateway sessions API so `session.create` returns a provisional id
 * without creating anything; the real session materializes on the first
 * `session.prompt` for that id.
 *
 * @param api - Gateway API implementation.
 * @param enabled - Whether deferral is active; false returns the API untouched.
 * @param imageLimits - actual host image capability, used for the synthetic
 * empty history before the deferred Session exists.
 * @returns the original API when disabled, otherwise the wrapped API.
 */
export function withSessionDeferral(
  api: LegacyRpc,
  enabled: boolean,
  imageLimits?: ImageAttachmentLimits,
): LegacyRpc {
  if (!enabled) return api

  const provisional = new Map<SessionId, ProvisionalEntry>()
  const materializing = new Map<SessionId, Promise<unknown>>()

  const prune = (): void => {
    const cutoff = Date.now() - PROVISIONAL_TTL_MS
    for (const [id, entry] of provisional) {
      if (entry.createdAt < cutoff) provisional.delete(id)
    }
  }

  const mintedId = (payload: CreatePayload): SessionId =>
    payload.sessionId ?? `session-${randomUUID()}` as SessionId

  return async (method, payload, signal) => {
    const request = asPayload(payload)
    switch (method) {
      case 'session.create': {
        prune()
        const sessionId = mintedId(request)
        provisional.set(sessionId, { payload: { ...request }, createdAt: Date.now() })
        return { sessionId }
      }
      case 'session.history': {
        if (!provisional.has(request.sessionId as SessionId)) return api(method, payload, signal)
        return {
          events: [],
          hasMore: false,
          ...(imageLimits === undefined
            ? {}
            : { projections: { asOfSeq: -1, values: { imageLimits } } }),
        }
      }
      case 'session.prompt': {
        const sessionId = request.sessionId as SessionId
        const entry = provisional.get(sessionId)
        if (entry === undefined) return api(method, payload, signal)
        const existing = materializing.get(sessionId)
        const pending = existing ?? api('session.create', { ...entry.payload, sessionId }, signal)
        if (existing === undefined) {
          materializing.set(sessionId, pending)
          void pending.then(
            () => { materializing.delete(sessionId) },
            () => { materializing.delete(sessionId) },
          )
        }
        await pending
        provisional.delete(sessionId)
        return api(method, payload, signal)
      }
      default:
        return api(method, payload, signal)
    }
  }
}

function asPayload(payload: unknown): CreatePayload {
  return typeof payload === 'object' && payload !== null && !Array.isArray(payload)
    ? payload as CreatePayload
    : {}
}
