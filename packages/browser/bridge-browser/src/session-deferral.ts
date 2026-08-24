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
 * Agent-preset selection is deferred with it. A preset may only be chosen
 * while a session is blank, which for this surface is exactly the provisional
 * window: the gateway has no session to recompose yet, so `agentPreset.select`
 * is recorded into the pending create payload and applied at materialization.
 *
 * @module @yuxianglin/dsh-bridge-browser/src/session-deferral
 */

import { randomUUID } from 'node:crypto'
import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy/api'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { ImageAttachmentLimits } from '@deepseek-ai/dsh-attachment'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Provisional entries older than this are dropped on the next create. */
const PROVISIONAL_TTL_MS = 30 * 60_000

type CreateRequest = Parameters<ApiProxy['sessions']['create']>[0]
type HistoryRequest = Parameters<ApiProxy['sessions']['history']>[0]
type PromptRequest = Parameters<ApiProxy['sessions']['prompt']>[0]
type PresetSelectRequest = Parameters<ApiProxy['agentPresets']['select']>[0]

interface ProvisionalEntry {
  /** The original create payload, replayed at materialization (keeps cwd/workspaceId/agentPreset). */
  payload: CreateRequest['payload']
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
  api: ApiProxy,
  enabled: boolean,
  imageLimits?: ImageAttachmentLimits,
): ApiProxy {
  if (!enabled) return api

  const provisional = new Map<SessionId, ProvisionalEntry>()
  const materializing = new Map<SessionId, ReturnType<ApiProxy['sessions']['create']>>()

  const prune = (): void => {
    const cutoff = Date.now() - PROVISIONAL_TTL_MS
    for (const [id, entry] of provisional) {
      if (entry.createdAt < cutoff) provisional.delete(id)
    }
  }

  const mintedId = (payload: CreateRequest['payload']): SessionId =>
    payload.sessionId ?? `session-${randomUUID()}` as SessionId

  return {
    ...api,
    agentPresets: {
      ...api.agentPresets,
      async select(request: PresetSelectRequest) {
        const entry = provisional.get(request.payload.sessionId)
        if (entry === undefined) return api.agentPresets.select(request)
        // The gateway has nothing to recompose yet. Record the choice on the
        // pending create payload so materialization composes the agent from
        // it — the same outcome `select` would produce on a blank session.
        entry.payload = { ...entry.payload, agentPreset: request.payload.agentPreset }
        return {
          rpcId: request.rpcId,
          result: { ok: true, value: { agentPreset: request.payload.agentPreset } },
        }
      },
    },
    sessions: {
      ...api.sessions,
      async create(request: CreateRequest) {
        prune()
        const sessionId = mintedId(request.payload)
        provisional.set(sessionId, { payload: { ...request.payload }, createdAt: Date.now() })
        return {
          rpcId: request.rpcId,
          result: {
            ok: true,
            value: {
              sessionId,
              ...(request.payload.agentPreset === undefined ? {} : { agentPreset: request.payload.agentPreset }),
            },
          },
        }
      },
      async history(request: HistoryRequest) {
        if (!provisional.has(request.payload.sessionId)) return api.sessions.history(request)
        return {
          rpcId: request.rpcId,
          result: {
            ok: true,
            value: {
              events: [],
              hasMore: false,
              ...(imageLimits === undefined
                ? {}
                : { projections: { asOfSeq: -1, values: { imageLimits } } }),
            },
          },
        }
      },
      async prompt(request: PromptRequest) {
        const entry = provisional.get(request.payload.sessionId)
        if (entry === undefined) return api.sessions.prompt(request)
        const existing = materializing.get(request.payload.sessionId)
        const pending = existing ?? api.sessions.create({
          rpcId: RpcId(randomUUID()),
          payload: { ...entry.payload, sessionId: request.payload.sessionId },
        })
        if (existing === undefined) {
          materializing.set(request.payload.sessionId, pending)
          void pending.then(
            () => { materializing.delete(request.payload.sessionId) },
            () => { materializing.delete(request.payload.sessionId) },
          )
        }
        const created = await pending
        if (!created.result.ok) {
          // The create failure value shape differs from prompt's success
          // shape; the carrier relays only result.ok/error, so the value
          // side is irrelevant here.
          return created as unknown as Awaited<ReturnType<ApiProxy['sessions']['prompt']>>
        }
        provisional.delete(request.payload.sessionId)
        return api.sessions.prompt(request)
      },
    },
  }
}
