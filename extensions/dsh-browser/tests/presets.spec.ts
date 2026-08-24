// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { PanelRpcError } from '../src/panel/api.ts'
import {
  defaultPresetId,
  isPresetLocked,
  isPresetMissing,
  isSessionMissing,
  needsFreshSession,
  parsePresetRoster,
  presetLabel,
  presetLabelFor,
} from '../src/panel/presets.ts'

const REPLY = {
  authorable: true,
  hasDocument: false,
  presets: [
    { id: 'router-flash', trust: 'user', isDefault: true, name: '路由 Flash', description: '默认' },
    { id: 'standard', trust: 'system', isDefault: false, name: '标准模式' },
    { id: 'broken-one', trust: 'user', isDefault: false, broken: 'cordis.yml is unparsable' },
    { id: '', trust: 'system', isDefault: false },
    'not an entry',
  ],
}

describe('parsePresetRoster', () => {
  it('keeps well-formed entries and drops unusable ones', () => {
    const roster = parsePresetRoster(REPLY)
    expect(roster?.authorable).toBe(true)
    expect(roster?.presets.map((entry) => entry.id)).toEqual(['router-flash', 'standard', 'broken-one'])
    expect(roster?.presets[2]?.broken).toBe('cordis.yml is unparsable')
  })

  it('accepts a deployment that composes no presets', () => {
    expect(parsePresetRoster({ presets: [], authorable: false })).toEqual({ presets: [], authorable: false })
  })

  it('rejects a reply that is not a roster', () => {
    expect(parsePresetRoster(null)).toBeNull()
    expect(parsePresetRoster({})).toBeNull()
    expect(parsePresetRoster({ presets: 'nope' })).toBeNull()
  })

  it('defaults an unknown trust to system rather than claiming user authorship', () => {
    const roster = parsePresetRoster({ presets: [{ id: 'x', trust: 'weird', isDefault: false }] })
    expect(roster?.presets[0]?.trust).toBe('system')
  })
})

describe('preset labels', () => {
  const presets = parsePresetRoster(REPLY)!.presets

  it('prefers the published name and falls back to the id', () => {
    expect(presetLabel(presets[0]!)).toBe('路由 Flash')
    expect(presetLabel(presets[2]!)).toBe('broken-one')
  })

  it('shows the deployment default until a session names one', () => {
    expect(presetLabelFor(presets, null, 'fallback')).toBe('路由 Flash')
    expect(presetLabelFor([], null, 'fallback')).toBe('fallback')
  })

  it('shows a preset the roster no longer offers by its raw id', () => {
    expect(presetLabelFor(presets, 'deleted-preset', 'fallback')).toBe('deleted-preset')
  })

  it('reports the default preset id', () => {
    expect(defaultPresetId(presets)).toBe('router-flash')
    expect(defaultPresetId(presets.slice(1))).toBeNull()
  })
})

describe('select failure classification', () => {
  it('recognizes the blank-session lock, however the host words it', () => {
    expect(isPresetLocked(new PanelRpcError('agent-preset-locked', 'nope'))).toBe(true)
    expect(isPresetLocked(new PanelRpcError('rpc-failed', 'http 400: agent-preset-locked'))).toBe(true)
    expect(isPresetLocked(new Error('agent-preset-locked'))).toBe(true)
  })

  it('does not mistake other failures for the lock', () => {
    expect(isPresetLocked(new PanelRpcError('bridge-unavailable', 'dsh is not connected'))).toBe(false)
    expect(isPresetLocked('agent-preset-locked')).toBe(false)
  })

  it('recognizes a preset that no longer exists', () => {
    expect(isPresetMissing(new PanelRpcError('agent-preset-not-found', 'gone'))).toBe(true)
    expect(isPresetMissing(new PanelRpcError('agent-preset-locked', 'nope'))).toBe(false)
  })
})

describe('a switch that needs a fresh session', () => {
  it('recognizes the provisional session the side panel starts with', () => {
    // deferSessionCreate means nothing is persisted until the first message, so
    // anything addressing the session by id answers session-not-found.
    expect(isSessionMissing(new PanelRpcError('session-not-found', 'session "session-abc" not found'))).toBe(true)
    expect(isSessionMissing(new PanelRpcError('rpc-failed', 'session "session-abc" not found'))).toBe(true)
    expect(isSessionMissing(new PanelRpcError('agent-preset-locked', 'nope'))).toBe(false)
    expect(isSessionMissing(new PanelRpcError('bridge-unavailable', 'dsh is not connected'))).toBe(false)
  })

  it('treats both refusals as the same recovery', () => {
    // Locked (has history) and missing (not yet persisted) differ in cause but
    // not in cure: the choice has to ride a new session.
    expect(needsFreshSession(new PanelRpcError('agent-preset-locked', 'nope'))).toBe(true)
    expect(needsFreshSession(new PanelRpcError('session-not-found', 'gone'))).toBe(true)
    expect(needsFreshSession(new PanelRpcError('agent-preset-not-found', 'gone'))).toBe(false)
    expect(needsFreshSession(new PanelRpcError('bridge-unavailable', 'dsh is not connected'))).toBe(false)
  })

  it('keeps a deleted preset distinct, because that one is not fixed by a new session', () => {
    const missingPreset = new PanelRpcError('agent-preset-not-found', 'gone')
    expect(isPresetMissing(missingPreset)).toBe(true)
    expect(needsFreshSession(missingPreset)).toBe(false)
  })
})
