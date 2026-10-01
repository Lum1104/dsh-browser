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
 * Provisional sessions also answer `session.models` from the host-wide
 * `session.modelCatalog` (via the Host API adapter, plus a pending switch)
 * and remember `session.selectModel` until materialization, so the composer can
 * show a model switcher before the first message.
 *
 * @module @yuxianglin/dsh-bridge-browser/src/session-deferral
 */

import type { ImageAttachmentLimits } from '@deepseek-ai/dsh-attachment'
import type { BrowserHostApi, HostRpcCall, HostRpcResult } from './host-api.ts'
import { isRecord } from './host-api.ts'

/** Provisional entries older than this are dropped on the next create. */
const PROVISIONAL_TTL_MS = 30 * 60_000

interface ModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

interface ProvisionalEntry {
  /** The original create payload, replayed at materialization (keeps cwd/workspaceId). */
  payload: Record<string, unknown>
  createdAt: number
  /** Composer switch chosen before the session exists on the Host. */
  selection?: ModelSelection
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
  api: BrowserHostApi,
  enabled: boolean,
  imageLimits?: ImageAttachmentLimits,
): BrowserHostApi {
  if (!enabled) return api

  const provisional = new Map<string, ProvisionalEntry>()
  const materializing = new Map<string, Promise<HostRpcResult>>()

  const prune = (): void => {
    const cutoff = Date.now() - PROVISIONAL_TTL_MS
    for (const [id, entry] of provisional) {
      if (entry.createdAt < cutoff) provisional.delete(id)
    }
  }

  const mintedId = (payload: Record<string, unknown>): string =>
    typeof payload.sessionId === 'string' ? payload.sessionId : `session-${crypto.randomUUID()}`

  return {
    async call(call: HostRpcCall): Promise<HostRpcResult> {
      if (call.method === 'session.create') {
        if (!isRecord(call.payload)) {
          return { ok: false, error: { code: 'bad-request', message: 'session.create payload must be an object', details: {} } }
        }
        prune()
        const sessionId = mintedId(call.payload)
        provisional.set(sessionId, { payload: { ...call.payload }, createdAt: Date.now() })
        return { ok: true, value: { sessionId } }
      }
      if (call.method === 'session.history') {
        const sessionId = sessionIdOf(call.payload)
        if (sessionId === undefined || !provisional.has(sessionId)) return api.call(call)
        return {
          ok: true,
          value: {
            events: [],
            hasMore: false,
            ...(imageLimits === undefined
              ? {}
              : { projections: { asOfSeq: -1, values: { imageLimits } } }),
          },
        }
      }
      if (call.method === 'session.models') {
        const sessionId = sessionIdOf(call.payload)
        if (sessionId === undefined || !provisional.has(sessionId)) return api.call(call)
        return provisionalModels(api, provisional.get(sessionId)!, call.signal)
      }
      if (call.method === 'session.selectModel') {
        const sessionId = sessionIdOf(call.payload)
        if (sessionId === undefined || !provisional.has(sessionId)) return api.call(call)
        const entry = provisional.get(sessionId)!
        const selected = selectionOf(call.payload)
        if (selected === undefined) {
          return {
            ok: false,
            error: {
              code: 'bad-request',
              message: 'session.selectModel requires provider and model',
              details: {},
            },
          }
        }
        entry.selection = selected
        return { ok: true, value: { selected: { ...selected } } }
      }
      if (call.method !== 'session.prompt') return api.call(call)
      const sessionId = sessionIdOf(call.payload)
      if (sessionId === undefined) return api.call(call)
      const entry = provisional.get(sessionId)
      if (entry === undefined) return api.call(call)
      const existing = materializing.get(sessionId)
      const pending = existing ?? api.call({
        rpcId: crypto.randomUUID(),
        method: 'session.create',
        payload: { ...entry.payload, sessionId },
        signal: call.signal,
      })
      if (existing === undefined) {
        materializing.set(sessionId, pending)
        void pending.then(
          () => { materializing.delete(sessionId) },
          () => { materializing.delete(sessionId) },
        )
      }
      const created = await pending
      if (!created.ok) return created
      const selection = entry.selection
      provisional.delete(sessionId)
      if (selection !== undefined) {
        try {
          await api.call({
            rpcId: crypto.randomUUID(),
            method: 'session.selectModel',
            payload: { sessionId, ...selection },
            signal: call.signal,
          })
        } catch {
          // The prompt still proceeds; the Host keeps its deployment default.
        }
      }
      return api.call(call)
    },
    events: signal => api.events(signal),
    respond: (rpcId, result, signal) => api.respond(rpcId, result, signal),
  }
}

function sessionIdOf(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined
  return typeof payload.sessionId === 'string' ? payload.sessionId : undefined
}

function selectionOf(payload: unknown): ModelSelection | undefined {
  if (!isRecord(payload)) return undefined
  const provider = typeof payload.provider === 'string' ? payload.provider.trim() : ''
  const model = typeof payload.model === 'string' ? payload.model.trim() : ''
  if (provider === '' || model === '') return undefined
  const reasoningEffort = typeof payload.reasoningEffort === 'string' && payload.reasoningEffort.trim() !== ''
    ? payload.reasoningEffort.trim()
    : undefined
  return {
    provider,
    model,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  }
}

/** Build a session.models-shaped answer from the host catalog for a provisional id. */
async function provisionalModels(
  api: BrowserHostApi,
  entry: ProvisionalEntry,
  signal: AbortSignal,
): Promise<HostRpcResult> {
  // Inner API (not the deferral wrapper): session.models → session/modelCatalog.
  const catalog = await api.call({
    rpcId: crypto.randomUUID(),
    method: 'session.models',
    payload: {},
    signal,
  })
  if (!catalog.ok) return catalog
  const groups = isRecord(catalog.value) && Array.isArray(catalog.value.groups)
    ? catalog.value.groups
    : []
  const failures = isRecord(catalog.value) && Array.isArray(catalog.value.failures)
    ? catalog.value.failures
    : []
  const catalogCurrent = isRecord(catalog.value) ? modelSelectionOf(catalog.value.current) : undefined
  const current = entry.selection
    ?? catalogCurrent
    ?? await defaultSelection(api, signal)
    ?? firstCatalogSelection(groups)
  if (current === undefined) {
    return {
      ok: true,
      value: {
        current: { provider: 'none', model: 'none' },
        routable: false,
        groups,
        failures,
      },
    }
  }
  return {
    ok: true,
    value: {
      current: { ...current },
      routable: true,
      groups,
      failures,
    },
  }
}

function modelSelectionOf(value: unknown): ModelSelection | undefined {
  if (!isRecord(value)) return undefined
  const provider = typeof value.provider === 'string' ? value.provider.trim() : ''
  const model = typeof value.model === 'string' ? value.model.trim() : ''
  if (provider === '' || model === '') return undefined
  const reasoningEffort = typeof value.reasoningEffort === 'string' && value.reasoningEffort.trim() !== ''
    ? value.reasoningEffort.trim()
    : undefined
  return {
    provider,
    model,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  }
}

async function defaultSelection(
  api: BrowserHostApi,
  signal: AbortSignal,
): Promise<ModelSelection | undefined> {
  const described = await api.call({
    rpcId: crypto.randomUUID(),
    method: 'settings.describe',
    payload: {},
    signal,
  })
  if (!described.ok || !isRecord(described.value) || !Array.isArray(described.value.namespaces)) {
    return undefined
  }
  const defaults = described.value.namespaces.find((candidate) => (
    isRecord(candidate) && candidate.ns === 'agent-default-model'
  ))
  const value = isRecord(defaults) && isRecord(defaults.value) ? defaults.value : undefined
  if (value === undefined) return undefined
  const provider = typeof value.provider === 'string' ? value.provider.trim() : ''
  const model = typeof value.model === 'string' ? value.model.trim() : ''
  if (provider === '' || model === '') return undefined
  const reasoningEffort = typeof value.reasoningEffort === 'string' && value.reasoningEffort.trim() !== ''
    ? value.reasoningEffort.trim()
    : undefined
  return {
    provider,
    model,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  }
}

function firstCatalogSelection(groups: unknown[]): ModelSelection | undefined {
  for (const group of groups) {
    if (!isRecord(group) || typeof group.id !== 'string' || !Array.isArray(group.models)) continue
    for (const model of group.models) {
      if (!isRecord(model) || typeof model.id !== 'string' || model.id.trim() === '') continue
      return { provider: group.id, model: model.id }
    }
  }
  return undefined
}
