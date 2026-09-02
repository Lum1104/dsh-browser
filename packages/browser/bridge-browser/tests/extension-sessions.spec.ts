import { describe, expect, it } from 'vitest'
import { ExtensionSessionRegistry, shouldBridgeOwnQuestion } from '../src/extension-sessions.ts'

describe('ExtensionSessionRegistry', () => {
  it('tracks non-empty session ids only', () => {
    const registry = new ExtensionSessionRegistry()
    registry.note(undefined)
    registry.note('')
    registry.note('session-1')
    expect(registry.has(undefined)).toBe(false)
    expect(registry.has('')).toBe(false)
    expect(registry.has('session-1')).toBe(true)
    expect(registry.has('other')).toBe(false)
  })
})

describe('shouldBridgeOwnQuestion', () => {
  it('leaves Desktop sessions to the native waterfall', () => {
    const extensionSessions = new ExtensionSessionRegistry()
    expect(shouldBridgeOwnQuestion({
      hasExtensionConnection: true,
      sessionId: 'desktop-session',
      extensionSessions,
    })).toBe(false)
  })

  it('owns questions only for extension-driven sessions while connected', () => {
    const extensionSessions = new ExtensionSessionRegistry()
    extensionSessions.note('ext-session')
    expect(shouldBridgeOwnQuestion({
      hasExtensionConnection: true,
      sessionId: 'ext-session',
      extensionSessions,
    })).toBe(true)
    expect(shouldBridgeOwnQuestion({
      hasExtensionConnection: false,
      sessionId: 'ext-session',
      extensionSessions,
    })).toBe(false)
    expect(shouldBridgeOwnQuestion({
      hasExtensionConnection: true,
      sessionId: undefined,
      extensionSessions,
    })).toBe(false)
  })
})
