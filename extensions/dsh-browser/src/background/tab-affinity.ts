/**
 * Pure state machine for binding browser tools to one user-visible tab.
 *
 * The controller deliberately separates Chrome event handling from the
 * affinity rules so transitions can be tested without a browser runtime.
 * A manual tab switch never silently changes the tool target: it creates a
 * handoff decision, and tool dispatch remains blocked until the user chooses.
 * `keep-always` is the one way out of that per-switch prompt: it pins the
 * controlled tab so later switches resolve straight to `background` instead of
 * asking again, and `ask-again` reverses it without disturbing the binding.
 * Pinning never widens what the tools may touch — the target is still exactly
 * the tab the user already approved — and any change of binding clears it.
 *
 * @module
 */

/** Minimal, panel-safe metadata for one Chrome tab. */
export interface AffinityTab {
  tabId: number
  windowId: number
  title: string
  url: string
}

export type TabAffinityStatus = 'unbound' | 'following' | 'handoff' | 'background' | 'lost'
export type TabAffinityDecision = 'keep' | 'follow' | 'keep-always' | 'ask-again'

/** Narrow an untrusted panel message field to a decision. */
export function isTabAffinityDecision(value: unknown): value is TabAffinityDecision {
  return value === 'keep' || value === 'follow'
    || value === 'keep-always' || value === 'ask-again'
}

/** Serializable state sent from the service worker to every side panel. */
export interface TabAffinityState {
  revision: number
  status: TabAffinityStatus
  controlled: AffinityTab | null
  active: AffinityTab | null
  /** True once the user chose `keep-always`; tab switches stop prompting. */
  pinned: boolean
}

export type TabTargetResolution =
  | { kind: 'initial' }
  | { kind: 'target'; tab: AffinityTab }
  | { kind: 'handoff' }
  | { kind: 'lost' }

function sameTab(left: AffinityTab | null, right: AffinityTab | null): boolean {
  return left?.tabId === right?.tabId
    && left?.windowId === right?.windowId
    && left?.title === right?.title
    && left?.url === right?.url
}

/** Owns the controlled-tab lifecycle for one extension/bridge connection. */
export class TabAffinityController {
  private controlled: AffinityTab | null = null
  private active: AffinityTab | null = null
  private keptActiveTabId: number | null = null
  private pinned = false
  private hasBound = false
  private lost = false
  private revision = 0
  private sessionTabs = new Map<string, AffinityTab>()
  private focusedSessionId: string | null = null

  snapshot(): TabAffinityState {
    return {
      revision: this.revision,
      status: this.status(),
      controlled: this.controlled === null ? null : { ...this.controlled },
      active: this.active === null ? null : { ...this.active },
      pinned: this.pinned,
    }
  }

  /** Associate a session with its controlled tab. */
  bindSession(sessionId: string, tab: AffinityTab): void {
    this.sessionTabs.set(sessionId, { ...tab })
  }

  sessionMap(): Record<string, AffinityTab> {
    const result: Record<string, AffinityTab> = {}
    for (const [sid, tab] of this.sessionTabs.entries()) {
      result[sid] = { ...tab }
    }
    return result
  }

  restoreSessionTabs(sessions: Record<string, AffinityTab>): void {
    for (const [sid, tab] of Object.entries(sessions)) {
      this.sessionTabs.set(sid, { ...tab })
    }
  }

  restoreFocusedSession(sessionId: string | null): void {
    this.focusedSessionId = sessionId
  }

  getSessionTab(sessionId: string): AffinityTab | undefined {
    return this.sessionTabs.get(sessionId)
  }

  focusedSession(): string | null {
    return this.focusedSessionId
  }

  /** Focus or select a session to align the visible controlled tab in the panel. */
  focusSession(sessionId: string): boolean {
    const previousFocusedSessionId = this.focusedSessionId
    const previousControlled = this.controlled
    const previousKept = this.keptActiveTabId
    const previousLost = this.lost
    const previousPinned = this.pinned
    this.focusedSessionId = sessionId
    const tab = this.sessionTabs.get(sessionId)
    if (tab === undefined) {
      this.controlled = null
      this.keptActiveTabId = null
      this.pinned = false
      this.hasBound = true
      this.lost = true
    } else {
      this.controlled = { ...tab }
      this.hasBound = true
      this.lost = false
      this.keptActiveTabId = this.active !== null && this.active.tabId !== tab.tabId
        ? this.active.tabId
        : null
      // A pin belongs to the tab it was made for, so it survives re-focusing the
      // same binding (session resume replays the focused session) and is dropped
      // only when focus actually moves the controlled tab. Identity here is the
      // tab id alone, not sameTab(): that compares title and url for change
      // detection, and a restored session snapshot routinely disagrees with the
      // live tab on both after the page has navigated.
      if (previousControlled?.tabId !== this.controlled.tabId) this.pinned = false
    }
    const changed = previousFocusedSessionId !== sessionId
      || !sameTab(previousControlled, this.controlled)
      || previousKept !== this.keptActiveTabId
      || previousLost !== this.lost
      || previousPinned !== this.pinned
    if (changed) this.revision += 1
    return changed
  }

  /** Observe the active tab after a user tab/window focus change. */
  observeActive(tab: AffinityTab): boolean {
    const previousActive = this.active
    const previousControlled = this.controlled
    const previousKept = this.keptActiveTabId
    this.active = { ...tab }
    if (this.controlled?.tabId === tab.tabId) {
      this.controlled = { ...tab }
      this.keptActiveTabId = null
    } else if (previousActive?.tabId !== tab.tabId) {
      this.keptActiveTabId = null
    }
    return this.bumpIfChanged(previousActive, previousControlled, previousKept)
  }

  /** Refresh title/URL metadata without interpreting it as a tab switch. */
  observeTab(tab: AffinityTab): boolean {
    const previousActive = this.active
    const previousControlled = this.controlled
    const previousKept = this.keptActiveTabId
    if (this.active?.tabId === tab.tabId) this.active = { ...tab }
    if (this.controlled?.tabId === tab.tabId) this.controlled = { ...tab }
    for (const [sid, sTab] of this.sessionTabs.entries()) {
      if (sTab.tabId === tab.tabId) this.sessionTabs.set(sid, { ...tab })
    }
    return this.bumpIfChanged(previousActive, previousControlled, previousKept)
  }

  /** Bind the first prompt/direct browser call to the then-active tab. */
  bindInitial(tab: AffinityTab, sessionId?: string): boolean {
    const sid = sessionId?.trim()
    if (sid !== undefined && sid !== '') {
      if (this.sessionTabs.has(sid)) return false
      this.sessionTabs.set(sid, { ...tab })
      if (this.focusedSessionId === null) this.focusedSessionId = sid
      if (this.focusedSessionId === sid) {
        this.active = { ...tab }
        this.controlled = { ...tab }
        this.hasBound = true
        this.lost = false
        this.keptActiveTabId = null
        this.pinned = false
      }
      this.revision += 1
      return true
    }
    if (this.controlled !== null || this.hasBound || this.lost) return false
    this.active = { ...tab }
    this.controlled = { ...tab }
    this.hasBound = true
    this.keptActiveTabId = null
    this.pinned = false
    this.revision += 1
    return true
  }

  /** Bind an unmapped session only after an explicit new-session activation. */
  bindNewSession(sessionId: string, tab: AffinityTab): boolean {
    const sid = sessionId.trim()
    if (sid === '') return false
    const previous = this.sessionTabs.get(sid)
    this.sessionTabs.set(sid, { ...tab })
    this.focusedSessionId = sid
    this.active = { ...tab }
    this.controlled = { ...tab }
    this.keptActiveTabId = null
    this.pinned = false
    this.hasBound = true
    this.lost = false
    if (!sameTab(previous ?? null, tab)) this.revision += 1
    return true
  }

  /** Explicitly rebind to the active tab for the named session. */
  rebindActive(tab: AffinityTab, sessionId?: string): boolean {
    const sid = sessionId?.trim()
    this.active = { ...tab }
    this.controlled = { ...tab }
    this.keptActiveTabId = null
    this.pinned = false
    this.hasBound = true
    this.lost = false
    if (sid !== undefined && sid !== '') {
      this.sessionTabs.set(sid, { ...tab })
      this.focusedSessionId = sid
    }
    this.revision += 1
    return true
  }

  /** Explicitly control an existing tab without changing the browser's active tab. */
  rebindControlled(tab: AffinityTab, sessionId?: string): boolean {
    const sid = sessionId?.trim()
    this.controlled = { ...tab }
    this.keptActiveTabId = this.active !== null && this.active.tabId !== tab.tabId
      ? this.active.tabId
      : null
    this.pinned = false
    this.hasBound = true
    this.lost = false
    if (sid !== undefined && sid !== '') {
      this.sessionTabs.set(sid, { ...tab })
      this.focusedSessionId = sid
    }
    this.revision += 1
    return true
  }

  /** Rehydrate a still-live controlled tab after an MV3 worker restart. */
  restoreControlled(tab: AffinityTab): boolean {
    if (this.controlled !== null || this.hasBound || this.lost) return false
    this.controlled = { ...tab }
    this.hasBound = true
    this.revision += 1
    return true
  }

  /**
   * Rehydrate a `keep-always` choice after an MV3 worker restart.
   *
   * Only valid once a controlled tab exists, so a stale pin can never suppress
   * the handoff prompt for a binding the user has not approved.
   */
  restorePinned(): boolean {
    if (this.controlled === null || this.pinned) return false
    this.pinned = true
    this.revision += 1
    return true
  }

  /** Rehydrate the fail-closed state when the prior controlled tab was lost. */
  restoreLost(): boolean {
    if (this.controlled !== null || this.hasBound || this.lost) return false
    this.hasBound = true
    this.lost = true
    this.revision += 1
    return true
  }

  sessionIdsForTab(tabId: number): string[] {
    const result: string[] = []
    for (const [sid, tab] of this.sessionTabs.entries()) {
      if (tab.tabId === tabId) result.push(sid)
    }
    return result
  }

  /** Remove stale state when Chrome closes a tracked tab. */
  removeTab(tabId: number): boolean {
    let sessionRemoved = false
    for (const [sid, sTab] of this.sessionTabs.entries()) {
      if (sTab.tabId === tabId) {
        this.sessionTabs.delete(sid)
        if (this.focusedSessionId === sid) this.focusedSessionId = null
        sessionRemoved = true
      }
    }
    if (this.controlled?.tabId !== tabId && this.active?.tabId !== tabId) {
      if (sessionRemoved) this.revision += 1
      return sessionRemoved
    }
    const previousActive = this.active
    const previousControlled = this.controlled
    const previousKept = this.keptActiveTabId
    if (this.controlled?.tabId === tabId) {
      this.controlled = null
      this.keptActiveTabId = null
      this.pinned = false
      this.hasBound = true
      this.lost = true
    }
    if (this.active?.tabId === tabId) this.active = null
    return this.bumpIfChanged(previousActive, previousControlled, previousKept) || sessionRemoved
  }

  /** Transfer tracked identity when Chrome replaces a tab without a user switch. */
  replaceTab(removedTabId: number, addedTabId: number): boolean {
    if (removedTabId === addedTabId) return false
    let sessionReplaced = false
    for (const [sid, sTab] of this.sessionTabs.entries()) {
      if (sTab.tabId === removedTabId) {
        this.sessionTabs.set(sid, { ...sTab, tabId: addedTabId })
        sessionReplaced = true
      }
    }
    if (this.controlled?.tabId !== removedTabId
      && this.active?.tabId !== removedTabId
      && this.keptActiveTabId !== removedTabId) {
      if (sessionReplaced) this.revision += 1
      return sessionReplaced
    }
    const previousActive = this.active
    const previousControlled = this.controlled
    const previousKept = this.keptActiveTabId
    if (this.controlled?.tabId === removedTabId) {
      this.controlled = { ...this.controlled, tabId: addedTabId }
    }
    if (this.active?.tabId === removedTabId) {
      this.active = { ...this.active, tabId: addedTabId }
    }
    if (this.keptActiveTabId === removedTabId) this.keptActiveTabId = addedTabId
    return this.bumpIfChanged(previousActive, previousControlled, previousKept) || sessionReplaced
  }

  /** Apply a panel choice only if it still describes the visible revision. */
  decide(decision: TabAffinityDecision, revision: number, sessionId?: string): boolean {
    if (revision !== this.revision) return false
    const currentStatus = this.status()
    if (decision === 'ask-again') {
      // Undo a pin in place. Dropping keptActiveTabId re-raises the prompt for
      // the switch the pin was suppressing, so control stays user-confirmed.
      if (!this.pinned) return false
      this.pinned = false
      this.keptActiveTabId = null
      this.revision += 1
      return true
    }
    if (decision === 'keep' || decision === 'keep-always') {
      if (currentStatus !== 'handoff' || this.active === null) return false
      this.keptActiveTabId = this.active.tabId
      if (decision === 'keep-always') this.pinned = true
      this.revision += 1
      return true
    }
    if (this.active === null || (currentStatus !== 'background' && currentStatus !== 'lost' && currentStatus !== 'handoff')) {
      return false
    }
    this.controlled = { ...this.active }
    this.keptActiveTabId = null
    this.pinned = false
    this.hasBound = true
    this.lost = false
    if (sessionId !== undefined && sessionId.trim() !== '') {
      this.sessionTabs.set(sessionId, { ...this.active })
    }
    this.revision += 1
    return true
  }

  /** Resolve whether a tool may run and, if so, which tab owns it. */
  resolveTarget(sessionId?: string): TabTargetResolution {
    if (sessionId !== undefined) {
      const tab = this.sessionTabs.get(sessionId)
      return tab === undefined ? { kind: 'lost' } : { kind: 'target', tab: { ...tab } }
    }
    switch (this.status()) {
      case 'unbound': return { kind: 'initial' }
      case 'lost': return { kind: 'lost' }
      case 'handoff': return { kind: 'handoff' }
      case 'following':
      case 'background':
        return { kind: 'target', tab: { ...this.controlled! } }
    }
  }

  tracks(tabId: number): boolean {
    if (this.controlled?.tabId === tabId || this.active?.tabId === tabId) return true
    for (const tab of this.sessionTabs.values()) {
      if (tab.tabId === tabId) return true
    }
    return false
  }

  /** Final dispatch guard for async calls that began before a tab switch. */
  allowsTarget(tabId: number, sessionId?: string): boolean {
    if (sessionId !== undefined) {
      return this.sessionTabs.get(sessionId)?.tabId === tabId
    }
    const resolution = this.resolveTarget()
    return resolution.kind === 'target' && resolution.tab.tabId === tabId
  }

  private status(): TabAffinityStatus {
    if (this.controlled === null) return this.lost ? 'lost' : 'unbound'
    if (this.active?.tabId === this.controlled.tabId) return 'following'
    if (this.active !== null && !this.pinned && this.keptActiveTabId !== this.active.tabId) return 'handoff'
    return 'background'
  }

  private bumpIfChanged(
    previousActive: AffinityTab | null,
    previousControlled: AffinityTab | null,
    previousKept: number | null,
  ): boolean {
    const changed = !sameTab(previousActive, this.active)
      || !sameTab(previousControlled, this.controlled)
      || previousKept !== this.keptActiveTabId
    if (changed) this.revision += 1
    return changed
  }
}
