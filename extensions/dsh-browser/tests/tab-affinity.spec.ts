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

  it('stops prompting on later tab switches after keep-always', () => {
    const affinity = new TabAffinityController()
    affinity.observeActive(tab(1))
    affinity.bindInitial(tab(1))
    affinity.observeActive(tab(2))

    expect(affinity.decide('keep-always', affinity.snapshot().revision)).toBe(true)
    expect(affinity.snapshot()).toMatchObject({ status: 'background', pinned: true, controlled: { tabId: 1 } })

    affinity.observeActive(tab(3))
    expect(affinity.snapshot()).toMatchObject({ status: 'background', pinned: true, controlled: { tabId: 1 } })
    expect(affinity.resolveTarget()).toMatchObject({ kind: 'target', tab: { tabId: 1 } })

    // Returning to the controlled tab and leaving again must still not prompt.
    affinity.observeActive(tab(1))
    expect(affinity.snapshot()).toMatchObject({ status: 'following', pinned: true })
    affinity.observeActive(tab(4))
    expect(affinity.snapshot().status).toBe('background')
  })

  it('drops the keep-always pin whenever the binding changes', () => {
    const followed = new TabAffinityController()
    followed.observeActive(tab(1))
    followed.bindInitial(tab(1))
    followed.observeActive(tab(2))
    followed.decide('keep-always', followed.snapshot().revision)
    followed.observeActive(tab(3))
    expect(followed.decide('follow', followed.snapshot().revision)).toBe(true)
    expect(followed.snapshot()).toMatchObject({ status: 'following', pinned: false, controlled: { tabId: 3 } })
    followed.observeActive(tab(5))
    expect(followed.snapshot().status).toBe('handoff')

    const rebound = new TabAffinityController()
    rebound.observeActive(tab(1))
    rebound.bindInitial(tab(1))
    rebound.observeActive(tab(2))
    rebound.decide('keep-always', rebound.snapshot().revision)
    rebound.rebindActive(tab(2))
    expect(rebound.snapshot().pinned).toBe(false)

    const closed = new TabAffinityController()
    closed.observeActive(tab(1))
    closed.bindInitial(tab(1))
    closed.observeActive(tab(2))
    closed.decide('keep-always', closed.snapshot().revision)
    closed.removeTab(1)
    expect(closed.snapshot()).toMatchObject({ status: 'lost', pinned: false })
  })

  it('re-raises the prompt when the pin is undone, without rebinding', () => {
    const affinity = new TabAffinityController()
    affinity.observeActive(tab(1))
    affinity.bindInitial(tab(1))
    affinity.observeActive(tab(2))
    affinity.decide('keep-always', affinity.snapshot().revision)
    affinity.observeActive(tab(3))

    const pinned = affinity.snapshot()
    expect(affinity.decide('ask-again', pinned.revision - 1)).toBe(false)
    expect(affinity.decide('ask-again', pinned.revision)).toBe(true)
    expect(affinity.snapshot()).toMatchObject({
      status: 'handoff',
      pinned: false,
      controlled: { tabId: 1 },
      active: { tabId: 3 },
    })
    expect(affinity.resolveTarget()).toEqual({ kind: 'handoff' })

    // Undoing a pin that is not set is a no-op rather than a state change.
    expect(affinity.decide('ask-again', affinity.snapshot().revision)).toBe(false)
  })

  it('keeps a pin when focus replays the same session, drops it when the tab moves', () => {
    const affinity = new TabAffinityController()
    affinity.observeActive(tab(1))
    affinity.bindNewSession('s1', tab(1))
    affinity.bindNewSession('s2', tab(2))
    affinity.focusSession('s1')
    affinity.observeActive(tab(3))
    affinity.decide('keep-always', affinity.snapshot().revision)
    expect(affinity.snapshot()).toMatchObject({ status: 'background', pinned: true, controlled: { tabId: 1 } })

    // Session resume replays the focused session: the binding is unchanged, so
    // the pin must survive and no revision is burned.
    const before = affinity.snapshot()
    expect(affinity.focusSession('s1')).toBe(false)
    expect(affinity.snapshot()).toMatchObject({ revision: before.revision, pinned: true, status: 'background' })

    // Moving focus to a session on a different tab drops the pin, and the
    // change is reported so the panel and the persisted record follow.
    expect(affinity.focusSession('s2')).toBe(true)
    expect(affinity.snapshot()).toMatchObject({ pinned: false, controlled: { tabId: 2 } })
    expect(affinity.snapshot().revision).toBeGreaterThan(before.revision)
  })

  it('keeps a restored pin when the tab navigated while the worker was down', () => {
    // Restart shape: the stored session snapshot carries the metadata from when
    // the session was bound, while the live tab has since navigated.
    const affinity = new TabAffinityController()
    affinity.restoreSessionTabs({ s1: tab(1, 'Title at bind time') })
    affinity.restoreControlled(tab(1, 'Title after navigating'))
    affinity.restoreFocusedSession('s1')
    expect(affinity.restorePinned()).toBe(true)
    affinity.observeActive(tab(2))
    expect(affinity.snapshot()).toMatchObject({ status: 'background', pinned: true })

    // Same tab id, different title/url: still the binding the user pinned.
    affinity.focusSession('s1')
    expect(affinity.snapshot()).toMatchObject({ pinned: true, controlled: { tabId: 1 } })
    expect(affinity.resolveTarget()).toMatchObject({ kind: 'target', tab: { tabId: 1 } })
  })

  it('rejects a keep-always pin that has no controlled tab behind it', () => {
    const unbound = new TabAffinityController()
    unbound.observeActive(tab(1))
    expect(unbound.restorePinned()).toBe(false)
    expect(unbound.snapshot().pinned).toBe(false)

    const restored = new TabAffinityController()
    restored.restoreControlled(tab(1))
    expect(restored.restorePinned()).toBe(true)
    restored.observeActive(tab(2))
    expect(restored.snapshot()).toMatchObject({ status: 'background', pinned: true })
    expect(restored.restorePinned()).toBe(false)
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

  it('rebinds control to a listed background tab without changing the active tab', () => {
    const affinity = new TabAffinityController()
    affinity.observeActive(tab(1))
    affinity.bindInitial(tab(1), 'session-1')

    expect(affinity.rebindControlled(tab(2), 'session-1')).toBe(true)
    expect(affinity.snapshot()).toMatchObject({
      status: 'background',
      controlled: { tabId: 2 },
      active: { tabId: 1 },
    })
    expect(affinity.resolveTarget('session-1')).toMatchObject({ kind: 'target', tab: { tabId: 2 } })

    affinity.observeActive(tab(3))
    expect(affinity.snapshot().status).toBe('handoff')
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
