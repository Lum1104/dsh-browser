/**
 * Capture of the text the user highlights in a page.
 *
 * The watcher stays disarmed until the service worker says a side panel is
 * open and page sharing is allowed: `selectionchange` fires on every drag in
 * every tab, and an always-on watcher would wake the MV3 service worker for
 * highlights nobody can see.
 *
 * Two page-authored risks shape the rest of this module. A page can move the
 * selection itself (`getSelection().selectAllChildren(…)`), so an event-driven
 * capture requires transient user activation — the user's own drag or keyboard
 * selection — before it is reported. And a selection can sit inside a password
 * or payment field, so the whole selected range is checked against the same
 * privacy boundary the snapshot uses, including contenteditable widgets and
 * fields inside shadow roots.
 *
 * @module
 */

import { normalizeSelectionText, type SelectionCapture } from '../selection.ts'
import { isSensitiveField } from './privacy.ts'

/** Quiet period after the last selection change before a capture is emitted. */
const SELECTION_SETTLE_MS = 250

/** Field-like ancestors whose contents must never be echoed unchecked. */
const FIELD_SELECTOR = 'input, textarea, select, [contenteditable]'

/** The deepest focused element, following shadow roots the page may use. */
function deepActiveElement(): Element | null {
  if (typeof document === 'undefined') return null
  let active: Element | null = document.activeElement
  while (active?.shadowRoot?.activeElement != null) active = active.shadowRoot.activeElement
  return active
}

/** Whether an element sits inside — or is — a field that must not be read. */
function withinSensitiveField(node: Node | null): boolean {
  const start = node instanceof Element ? node : node?.parentElement ?? null
  for (let el = start?.closest(FIELD_SELECTOR) ?? null; el !== null;) {
    if (isSensitiveField(el)) return true
    el = el.parentElement?.closest(FIELD_SELECTOR) ?? null
  }
  return false
}

/** Whether the live range touches any field the privacy boundary protects. */
function selectionTouchesSensitiveField(selection: Selection | null): boolean {
  if (selection === null) return false
  if (withinSensitiveField(selection.anchorNode) || withinSensitiveField(selection.focusNode)) return true
  // A range spanning several fields anchors outside them; check what it covers.
  try {
    const range = selection.rangeCount > 0 ? selection.getRangeAt(0) : null
    const container = range?.commonAncestorContainer ?? null
    const scope = container instanceof Element ? container : container?.parentElement ?? null
    if (scope === null) return false
    for (const field of scope.querySelectorAll(FIELD_SELECTOR)) {
      if (isSensitiveField(field) && range?.intersectsNode(field) === true) return true
    }
  } catch {
    // If a live range cannot be inspected, fail closed rather than risk
    // returning a protected field that changed during this read.
    return true
  }
  return false
}

/** Read the current highlight, preferring a focused field's own selection. */
function selectedText(): string {
  const active = deepActiveElement()
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
    // A field's own selection is invisible to window.getSelection() in Chrome.
    if (isSensitiveField(active)) return ''
    try {
      const { selectionStart, selectionEnd } = active
      if (selectionStart !== null && selectionEnd !== null && selectionEnd > selectionStart) {
        return active.value.slice(selectionStart, selectionEnd)
      }
    } catch {
      // selectionStart throws on input types that do not support selection.
    }
  }
  try {
    const selection = window.getSelection()
    if (selectionTouchesSensitiveField(selection)) return ''
    return selection?.toString() ?? ''
  } catch {
    return ''
  }
}

/**
 * Whether the page currently holds transient user activation.
 *
 * `selectionchange` is not a UIEvent, so it carries no `isTrusted` signal that
 * would separate the user's drag from a page moving the selection itself.
 * Activation is the closest available proxy. Where the API is missing the
 * check cannot run, so it does not block the capture.
 */
function hasUserGesture(): boolean {
  const activation = navigator.userActivation
  return activation === undefined || activation.isActive
}

/**
 * Read the frame's current selection as a capture.
 * @returns the capture, or null when nothing quotable is selected.
 */
export function readSelectionCapture(): SelectionCapture | null {
  if (typeof document === 'undefined') return null
  const raw = selectedText()
  if (raw === '') return null
  const { text, truncated } = normalizeSelectionText(raw)
  if (text === '') return null
  return { text, truncated, title: document.title, url: location.href }
}

/**
 * Debounced `selectionchange` watcher for one frame.
 *
 * Emits only settled, changed, non-empty selections: a drag fires the event
 * per character, and re-emitting an unchanged highlight would replace the
 * panel's capture with an identical one.
 */
export class SelectionWatcher {
  private enabled = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private lastEmitted: SelectionCapture | null = null
  /** Worker lifetime that issued the current ordering revision. */
  private epoch = 'legacy'
  /** Ordering guard: a stale arm/disarm reply must not undo a newer command. */
  private revision = -1

  constructor(
    private readonly emit: (capture: SelectionCapture) => void,
    private readonly settleMs: number = SELECTION_SETTLE_MS,
  ) {}

  /**
   * Arm or disarm the watcher.
   * @param revision - the service worker's command sequence.
   * @param epoch - the issuing worker's lifetime; revisions restart after an
   *   MV3 worker restart while this content script may remain alive.
   */
  setEnabled(next: boolean, revision = 0, epoch = 'legacy'): boolean {
    if (epoch === this.epoch && revision < this.revision) return false
    this.epoch = epoch
    this.revision = revision
    if (next === this.enabled) return false
    this.enabled = next
    if (next) {
      if (typeof document !== 'undefined') {
        document.addEventListener('selectionchange', this.onSelectionChange)
      }
      // Opening the panel arms the watcher, and the text the user highlighted
      // just before opening it fires no further selectionchange. Reading it
      // needs no page gesture: the user acted on the extension to get here.
      this.flushNow(false)
      return true
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('selectionchange', this.onSelectionChange)
    }
    this.cancel()
    this.lastEmitted = null
    return true
  }

  /**
   * Forget the last reported text after the panel dropped it, so re-selecting
   * the same passage reports it again instead of being deduplicated away.
   */
  resetDedupe(): void {
    this.lastEmitted = null
  }

  /** Release page listeners left behind by a replaced content script. */
  dispose(): void {
    // Bypass the revision gate: a replaced script must drop its timer even
    // when the last arm used a higher sequence than the default disarm.
    this.enabled = false
    if (typeof document !== 'undefined') {
      document.removeEventListener('selectionchange', this.onSelectionChange)
    }
    this.cancel()
    this.lastEmitted = null
  }

  private cancel(): void {
    if (this.timer === undefined) return
    clearTimeout(this.timer)
    this.timer = undefined
  }

  private readonly onSelectionChange = (): void => {
    this.cancel()
    this.timer = setTimeout(() => { this.flushNow(true) }, this.settleMs)
  }

  private flushNow(requireGesture: boolean): void {
    this.timer = undefined
    if (!this.enabled) return
    if (requireGesture && !hasUserGesture()) return
    const capture = readSelectionCapture()
    // A cleared highlight keeps the panel's capture: the user may have clicked
    // into the page while composing the request about what they selected. It
    // still resets deduplication so the same passage can be selected again.
    if (capture === null) {
      this.lastEmitted = null
      return
    }
    if (this.lastEmitted !== null
      && capture.text === this.lastEmitted.text
      && capture.truncated === this.lastEmitted.truncated
      && capture.title === this.lastEmitted.title
      && capture.url === this.lastEmitted.url) return
    this.lastEmitted = { ...capture }
    this.emit(capture)
  }
}
