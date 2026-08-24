// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  TabAffinityController,
  type AffinityTab,
} from '../src/background/tab-affinity.ts'

function tab(tabId: number, title = `Tab ${tabId}`): AffinityTab {
  return { tabId, windowId: 1, title, url: `https://example.com/${tabId}` }
}

describe('TabAffinityController', () => {
  it('binds the first tool target and follows metadata updates in place', () => {
    const affinity = new TabAffinityController()
    affinity.observeActive(tab(1))
    expect(affinity.resolveTarget()).toEqual({ kind: 'initial' })

    expect(affinity.bindInitial(tab(1))).toBe(true)
    expect(affinity.snapshot()).toMatchObject({ status: 'following', controlled: { tabId: 1 } })

    affinity.observeTab(tab(1, 'Updated title'))
    expect(affinity.resolveTarget()).toMatchObject({ kind: 'target', tab: { tabId: 1, title: 'Updated title' } })
  })

  it('fails closed on a manual switch until the matching handoff is decided', () => {
    const affinity = new TabAffinityController()
    affinity.observeActive(tab(1))
    affinity.bindInitial(tab(1))
    affinity.observeActive(tab(2))
    const handoff = affinity.snapshot()

    expect(handoff).toMatchObject({ status: 'handoff', controlled: { tabId: 1 }, active: { tabId: 2 } })
    expect(affinity.resolveTarget()).toEqual({ kind: 'handoff' })
    expect(affinity.decide('follow', handoff.revision - 1)).toBe(false)
    expect(affinity.resolveTarget()).toEqual({ kind: 'handoff' })

    expect(affinity.decide('follow', handoff.revision)).toBe(true)
    expect(affinity.snapshot()).toMatchObject({ status: 'following', controlled: { tabId: 2 } })
  })

  it('keeps operating the bound tab in the background after an explicit keep choice', () => {
    const affinity = new TabAffinityController()
    affinity.observeActive(tab(1))
    affinity.bindInitial(tab(1))
    affinity.observeActive(tab(2))
    const handoff = affinity.snapshot()

    expect(affinity.decide('keep', handoff.revision)).toBe(true)
    expect(affinity.snapshot()).toMatchObject({ status: 'background', controlled: { tabId: 1 }, active: { tabId: 2 } })
    expect(affinity.resolveTarget()).toMatchObject({ kind: 'target', tab: { tabId: 1 } })

    affinity.observeActive(tab(3))
    expect(affinity.snapshot().status).toBe('handoff')
  })

  it('supports explicit rebindActive when starting new chat', () => {
    const affinity = new TabAffinityController()
    affinity.observeActive(tab(1))
    affinity.bindInitial(tab(1))
    affinity.observeActive(tab(2))
    affinity.decide('keep', affinity.snapshot().revision)

    expect(affinity.rebindActive(tab(2))).toBe(true)
    expect(affinity.snapshot()).toMatchObject({ status: 'following', controlled: { tabId: 2 }, active: { tabId: 2 } })
    expect(affinity.resolveTarget()).toMatchObject({ kind: 'target', tab: { tabId: 2 } })
  })

  it('does not silently rebind after the controlled tab closes', () => {
    const affinity = new TabAffinityController()
    affinity.observeActive(tab(1))
    affinity.bindInitial(tab(1))
    affinity.observeActive(tab(2))
    affinity.decide('keep', affinity.snapshot().revision)

    expect(affinity.removeTab(1)).toBe(true)
    expect(affinity.snapshot()).toMatchObject({ status: 'lost', controlled: null, active: { tabId: 2 } })
    expect(affinity.resolveTarget()).toEqual({ kind: 'lost' })
    expect(affinity.bindInitial(tab(2))).toBe(false)

    const lost = affinity.snapshot()
    expect(affinity.decide('follow', lost.revision)).toBe(true)
    expect(affinity.snapshot()).toMatchObject({ status: 'following', controlled: { tabId: 2 } })
  })

  it('preserves a following tab when Chrome replaces its identity', () => {
    const affinity = new TabAffinityController()
    affinity.observeActive(tab(1))
    affinity.bindInitial(tab(1))
    const before = affinity.snapshot()

    expect(affinity.replaceTab(1, 9)).toBe(true)
    expect(affinity.snapshot()).toMatchObject({
      revision: before.revision + 1,
      status: 'following',
      controlled: { tabId: 9 },
      active: { tabId: 9 },
    })
    expect(affinity.tracks(1)).toBe(false)
    expect(affinity.allowsTarget(9)).toBe(true)

    affinity.observeTab(tab(9, 'Replacement metadata'))
    expect(affinity.snapshot()).toMatchObject({
      controlled: { tabId: 9, title: 'Replacement metadata' },
      active: { tabId: 9, title: 'Replacement metadata' },
    })
  })

  it('preserves background affinity when either tracked tab is replaced', () => {
    const affinity = new TabAffinityController()
    affinity.observeActive(tab(1))
    affinity.bindInitial(tab(1))
    affinity.observeActive(tab(2))
    affinity.decide('keep', affinity.snapshot().revision)

    expect(affinity.replaceTab(1, 10)).toBe(true)
    expect(affinity.snapshot()).toMatchObject({
      status: 'background',
      controlled: { tabId: 10 },
      active: { tabId: 2 },
    })

    expect(affinity.replaceTab(2, 20)).toBe(true)
    expect(affinity.snapshot()).toMatchObject({
      status: 'background',
      controlled: { tabId: 10 },
      active: { tabId: 20 },
    })
    expect(affinity.allowsTarget(10)).toBe(true)
    expect(affinity.replaceTab(999, 30)).toBe(false)
  })

  it('clears the handoff if the user returns to the controlled tab', () => {
    const affinity = new TabAffinityController()
    affinity.observeActive(tab(1))
    affinity.bindInitial(tab(1))
    affinity.observeActive(tab(2))
    affinity.observeActive(tab(1, 'Tab 1 again'))

    expect(affinity.snapshot()).toMatchObject({ status: 'following', controlled: { title: 'Tab 1 again' } })
  })

  it('rehydrates controlled and lost states without allowing a fresh automatic bind', () => {
    const restored = new TabAffinityController()
    expect(restored.restoreControlled(tab(4))).toBe(true)
    restored.observeActive(tab(5))
    expect(restored.snapshot()).toMatchObject({ status: 'handoff', controlled: { tabId: 4 }, active: { tabId: 5 } })

    const lost = new TabAffinityController()
    expect(lost.restoreLost()).toBe(true)
    lost.observeActive(tab(5))
    expect(lost.resolveTarget()).toEqual({ kind: 'lost' })
    expect(lost.bindInitial(tab(5))).toBe(false)
  })

  it('supports independent per-session tab affinity for concurrent sessions', () => {
    const affinity = new TabAffinityController()
    affinity.observeActive(tab(1))
    expect(affinity.bindInitial(tab(1), 'session-1')).toBe(true)

    affinity.observeActive(tab(2))
    expect(affinity.rebindActive(tab(2), 'session-2')).toBe(true)

    expect(affinity.resolveTarget('session-1')).toEqual({ kind: 'target', tab: tab(1) })
    expect(affinity.resolveTarget('session-2')).toEqual({ kind: 'target', tab: tab(2) })

    expect(affinity.allowsTarget(1, 'session-1')).toBe(true)
    expect(affinity.allowsTarget(2, 'session-1')).toBe(false)
    expect(affinity.allowsTarget(2, 'session-2')).toBe(true)
    expect(affinity.allowsTarget(1, 'session-2')).toBe(false)

    expect(affinity.focusSession('session-1')).toBe(true)
    expect(affinity.snapshot()).toMatchObject({ controlled: { tabId: 1 } })
    expect(affinity.focusSession('session-2')).toBe(true)
    expect(affinity.snapshot()).toMatchObject({ controlled: { tabId: 2 } })

    const sessionMap = affinity.sessionMap()
    expect(sessionMap['session-1']).toEqual(tab(1))
    expect(sessionMap['session-2']).toEqual(tab(2))

    const restoredAffinity = new TabAffinityController()
    restoredAffinity.restoreSessionTabs(sessionMap)
    expect(restoredAffinity.resolveTarget('session-1')).toEqual({ kind: 'target', tab: tab(1) })
    expect(restoredAffinity.resolveTarget('session-2')).toEqual({ kind: 'target', tab: tab(2) })
    expect(restoredAffinity.resolveTarget('session-missing')).toEqual({ kind: 'lost' })
    expect(restoredAffinity.allowsTarget(2, 'session-missing')).toBe(false)
  })
})

describe('TabAffinityController.bindTool', () => {
  const userTab = { tabId: 1, windowId: 1, title: 'User page', url: 'https://a.example' }
  const modelTab = { tabId: 2, windowId: 1, title: 'Opened page', url: 'https://b.example' }

  it('keeps tools running when control moves to a tab the user is not looking at', () => {
    const controller = new TabAffinityController()
    controller.bindInitial(userTab)
    controller.bindTool(modelTab)

    const state = controller.snapshot()
    expect(state.controlled?.tabId).toBe(2)
    // 'background' is the state that means "assistant works there, you look
    // here"; a 'handoff' would block the very calls the switch was made for.
    expect(state.status).toBe('background')
    expect(controller.resolveTarget()).toEqual({ kind: 'target', tab: expect.objectContaining({ tabId: 2 }) })
  })

  it('still asks when the user then moves somewhere else themselves', () => {
    const controller = new TabAffinityController()
    controller.bindInitial(userTab)
    controller.bindTool(modelTab)
    controller.observeActive({ tabId: 3, windowId: 1, title: 'Third', url: 'https://c.example' })

    expect(controller.snapshot().status).toBe('handoff')
    expect(controller.resolveTarget()).toEqual({ kind: 'handoff' })
  })

  it('follows normally when control moves to the tab already in front', () => {
    const controller = new TabAffinityController()
    controller.bindInitial(userTab)
    controller.bindTool(userTab)
    expect(controller.snapshot().status).toBe('following')
  })

  it('recovers a lost binding and bumps the revision panels watch', () => {
    const controller = new TabAffinityController()
    controller.bindInitial(userTab)
    controller.removeTab(1)
    expect(controller.snapshot().status).toBe('lost')

    const before = controller.snapshot().revision
    controller.bindTool(modelTab)
    const after = controller.snapshot()
    // With no known active tab the state is 'background' rather than
    // 'following'; what matters is that tools may run again, and the next
    // activation event resolves the visible pairing.
    expect(after.controlled?.tabId).toBe(2)
    expect(controller.resolveTarget().kind).toBe('target')
    expect(after.revision).toBeGreaterThan(before)
  })
})
