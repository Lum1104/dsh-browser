/**
 * Agent-preset roster for the side panel.
 *
 * A preset decides which plugins — and therefore which tools and prompt
 * sections — a session's agent is composed from, so switching one is only
 * legal while the session is blank. The gateway enforces that and answers
 * `agent-preset-locked` otherwise; this module keeps the panel's reading of
 * that contract in one testable place, because the recovery ("start a fresh
 * session on the preset you picked") depends on telling that refusal apart
 * from a real failure.
 *
 * @module
 */

import { PanelRpcError } from './api.ts'

/** One preset the deployment offers, as `agentPreset.list` reports it. */
export interface AgentPresetEntry {
  id: string
  trust: 'system' | 'user'
  isDefault: boolean
  name?: string
  description?: string
  /** Why the preset cannot compose a session; present means unusable. */
  broken?: string
}

/** The roster plus the deployment facts that came with it. */
export interface PresetRoster {
  presets: AgentPresetEntry[]
  authorable: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseEntry(value: unknown): AgentPresetEntry | null {
  if (!isRecord(value) || typeof value.id !== 'string' || value.id === '') return null
  const trust = value.trust === 'user' ? 'user' : 'system'
  return {
    id: value.id,
    trust,
    isDefault: value.isDefault === true,
    ...(typeof value.name === 'string' && value.name !== '' ? { name: value.name } : {}),
    ...(typeof value.description === 'string' && value.description !== '' ? { description: value.description } : {}),
    ...(typeof value.broken === 'string' && value.broken !== '' ? { broken: value.broken } : {}),
  }
}

/**
 * Parse an `agentPreset.list` reply, tolerating a deployment that composes no
 * roster at all (an empty list, which means every session shares the host
 * composition and there is nothing to switch).
 *
 * @param value - the RPC value.
 * @returns the roster, or `null` when the reply is not one.
 */
export function parsePresetRoster(value: unknown): PresetRoster | null {
  if (!isRecord(value) || !Array.isArray(value.presets)) return null
  const presets = value.presets.map(parseEntry).filter((entry): entry is AgentPresetEntry => entry !== null)
  return { presets, authorable: value.authorable === true }
}

/** The label a picker shows: the published name, else the id. */
export function presetLabel(entry: AgentPresetEntry): string {
  return entry.name ?? entry.id
}

/**
 * The label for an id that may not be in the roster (a session created under a
 * preset that has since been deleted still names it).
 * @param presets - the roster.
 * @param presetId - the session's preset id, when known.
 * @param fallback - text for "no preset selected yet".
 * @returns display text.
 */
export function presetLabelFor(presets: readonly AgentPresetEntry[], presetId: string | null, fallback: string): string {
  if (presetId === null) {
    const preferred = presets.find((entry) => entry.isDefault)
    return preferred === undefined ? fallback : presetLabel(preferred)
  }
  const entry = presets.find((candidate) => candidate.id === presetId)
  return entry === undefined ? presetId : presetLabel(entry)
}

/**
 * The preset a fresh session will actually run, so the panel can show it
 * before any switch happens.
 * @param presets - the roster.
 * @returns the default preset's id, or `null` when the roster declares none.
 */
export function defaultPresetId(presets: readonly AgentPresetEntry[]): string | null {
  return presets.find((entry) => entry.isDefault)?.id ?? null
}

/**
 * Whether a failed `agentPreset.select` was refused because the session has
 * already produced history, which is recoverable by starting a new session on
 * that preset rather than by retrying.
 *
 * @param cause - the rejection from the RPC.
 * @returns true for the locked refusal.
 */
export function isPresetLocked(cause: unknown): boolean {
  if (cause instanceof PanelRpcError) {
    if (cause.code === 'agent-preset-locked') return true
    return cause.code === 'rpc-failed' && /agent-preset-locked/.test(cause.message)
  }
  return cause instanceof Error && /agent-preset-locked/.test(cause.message)
}

/**
 * Whether the host does not know this session at all.
 *
 * The side panel's session is provisional until its first message — nothing is
 * persisted, so the gateway answers `session-not-found` for anything that
 * addresses it by id. A deployment whose bridge records the choice on the
 * pending create never gets here; an older one always does. Either way the
 * recovery is the same as the locked case: compose a NEW session from the
 * chosen preset, which `session.create({ agentPreset })` supports directly.
 *
 * @param cause - the rejection from the RPC.
 * @returns true when the session is unknown to the host.
 */
export function isSessionMissing(cause: unknown): boolean {
  const code = cause instanceof PanelRpcError ? cause.code : ''
  const message = cause instanceof Error ? cause.message : ''
  return code === 'session-not-found' || /session-not-found|not found/i.test(message)
}

/**
 * Whether a preset change can only be applied by starting a new conversation.
 * @param cause - the rejection from the RPC.
 * @returns true when a fresh session is the way through.
 */
export function needsFreshSession(cause: unknown): boolean {
  return isPresetLocked(cause) || isSessionMissing(cause)
}

/**
 * Whether a failed `agentPreset.select` means the roster the panel is showing
 * is stale (the preset was deleted underneath it).
 * @param cause - the rejection from the RPC.
 * @returns true when the preset no longer exists.
 */
export function isPresetMissing(cause: unknown): boolean {
  const code = cause instanceof PanelRpcError ? cause.code : ''
  const message = cause instanceof Error ? cause.message : ''
  return code === 'agent-preset-not-found' || /agent-preset-not-found/.test(message)
}
