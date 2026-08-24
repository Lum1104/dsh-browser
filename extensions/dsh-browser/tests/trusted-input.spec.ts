// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { trustedClick, TrustedInputError, type TrustedInputDeps } from '../src/background/trusted-input.ts'

function makeDeps(overrides: Partial<TrustedInputDeps> = {}) {
  const events: string[] = []
  const sent: { method: string; params?: object }[] = []
  const deps: TrustedInputDeps = {
    hasPermission: async () => true,
    attach: async () => { events.push('attach') },
    detach: async () => { events.push('detach') },
    send: async (_target, method, params) => {
      events.push(method)
      sent.push({ method, ...(params === undefined ? {} : { params }) })
      return undefined
    },
    delay: async () => {},
    ...overrides,
  }
  return { deps, events, sent }
}

describe('trustedClick', () => {
  it('sends a move, press, and release, then detaches', async () => {
    const { deps, events, sent } = makeDeps()
    await trustedClick(7, { x: 120.4, y: 40.6 }, deps)

    expect(events).toEqual([
      'attach',
      'Input.dispatchMouseEvent',
      'Input.dispatchMouseEvent',
      'Input.dispatchMouseEvent',
      'detach',
    ])
    expect(sent.map((entry) => (entry.params as { type: string }).type)).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased'])
    // Coordinates are rounded: the protocol takes integers.
    expect(sent[0]?.params).toMatchObject({ x: 120, y: 41, button: 'left' })
    expect(sent[1]?.params).toMatchObject({ buttons: 1, clickCount: 1 })
    expect(sent[2]?.params).toMatchObject({ buttons: 0 })
  })

  it('refuses without the optional permission, and never attaches', async () => {
    const { deps, events } = makeDeps({ hasPermission: async () => false })
    await expect(trustedClick(7, { x: 1, y: 1 }, deps)).rejects.toThrow(TrustedInputError)
    await expect(trustedClick(7, { x: 1, y: 1 }, deps)).rejects.toThrow(/side panel settings/)
    expect(events).toEqual([])
  })

  it('explains an attach conflict with DevTools rather than repeating Chrome\'s wording', async () => {
    const { deps } = makeDeps({ attach: async () => { throw new Error('Another debugger is already attached to the tab with id: 7.') } })
    await expect(trustedClick(7, { x: 1, y: 1 }, deps)).rejects.toThrow(/DevTools may be open/)
  })

  it('reports any other attach failure as itself', async () => {
    const { deps } = makeDeps({ attach: async () => { throw new Error('Cannot access a chrome:// URL') } })
    await expect(trustedClick(7, { x: 1, y: 1 }, deps)).rejects.toThrow(/could not attach.*chrome:\/\//)
  })

  it('detaches even when a dispatch fails, so no banner is left behind', async () => {
    const { deps, events } = makeDeps({ send: async () => { throw new Error('target closed') } })
    await expect(trustedClick(7, { x: 1, y: 1 }, deps)).rejects.toThrow(/could not be delivered: target closed/)
    expect(events).toEqual(['attach', 'detach'])
  })

  it('does not fail the click when only the detach fails', async () => {
    const detach = vi.fn(async () => { throw new Error('tab already closed') })
    const { deps } = makeDeps({ detach })
    await expect(trustedClick(7, { x: 5, y: 5 }, deps)).resolves.toBeUndefined()
    expect(detach).toHaveBeenCalled()
  })

  it('attaches with a pinned protocol version', async () => {
    const attach = vi.fn(async () => {})
    const { deps } = makeDeps({ attach })
    await trustedClick(7, { x: 5, y: 5 }, deps)
    expect(attach).toHaveBeenCalledWith({ tabId: 7 }, '1.3')
  })
})
