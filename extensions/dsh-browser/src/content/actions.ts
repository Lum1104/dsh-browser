/**
 * Page actions: click/type/press/scroll/navigate/get_text/wait, executed in
 * the content script against the real page (preserving login state), each
 * returning a short text status. Navigations return a fresh full snapshot
 * because the document — and the id registry — reset.
 *
 * All browser action results use structured text, so a
 * status line tells the model what happened and what state remains.
 *
 * @module
 */

import {
  accessibleName,
  hasPointerCursor,
  isClickableTarget,
  isVisible,
  pageText,
  querySelectorAllDeep,
  documentHasOpenOverlay,
  InvalidSelectorError,
  truncate,
} from './extract.ts'
import type { ElementIds } from './ids.ts'
import type { SnapshotBudget } from './snapshot.ts'
import {
  buildSnapshot,
  renderSnapshot,
  SnapshotInvalidSelectorError,
  SnapshotRegionError,
} from './snapshot.ts'

/** A settled action result. */
export interface ActionResult {
  text: string
  /** Page-authored snapshot delta; the background must wrap it as untrusted. */
  pageContent?: string
  /** A same-frame document navigation was scheduled after this response. */
  navigationPending?: boolean
}

/** How long an action should observe a ready document before returning. */
export interface PageSettlePolicy {
  /** Earliest return after the document becomes ready. */
  minimumMs: number
  /** Required DOM-quiet period before returning. */
  quietMs: number
  /** Hard cap after readiness; continuously animated pages cannot stall tools. */
  maxAfterReadyMs: number
  /** Hard cap while waiting for document readiness. */
  timeoutMs: number
}

const TYPE_SETTLE: PageSettlePolicy = { minimumMs: 32, quietMs: 32, maxAfterReadyMs: 100, timeoutMs: 5_000 }
const ACTION_SETTLE: PageSettlePolicy = { minimumMs: 100, quietMs: 50, maxAfterReadyMs: 250, timeoutMs: 5_000 }
const SCROLL_SETTLE: PageSettlePolicy = { minimumMs: 50, quietMs: 50, maxAfterReadyMs: 150, timeoutMs: 5_000 }
const EXPLICIT_WAIT_SETTLE: PageSettlePolicy = { minimumMs: 100, quietMs: 100, maxAfterReadyMs: 1_000, timeoutMs: 5_000 }
/** Keep automatic action context focused while preserving the negotiated full snapshot budget. */
const ACTION_DELTA_MAX_CHARS = 4_000

/**
 * Wait for document readiness and a mutation-free window. The old fixed delay
 * charged every action equally and still returned too early when a late DOM
 * update landed near its boundary. This observer returns early on already
 * stable pages, extends only for real mutations, and stays bounded on pages
 * with continuous animation.
 */
export function waitForPageSettled(policy: PageSettlePolicy = ACTION_SETTLE): Promise<boolean> {
  const startedAt = performance.now()
  let readyAt = document.readyState === 'complete' ? startedAt : undefined
  let lastMutationAt = startedAt
  let timer: ReturnType<typeof setTimeout> | undefined
  let finished = false
  let observer: MutationObserver | undefined

  return new Promise((resolve) => {
    const finish = (settled: boolean): void => {
      if (finished) return
      finished = true
      if (timer !== undefined) clearTimeout(timer)
      observer?.disconnect()
      document.removeEventListener('readystatechange', schedule)
      window.removeEventListener('load', schedule)
      resolve(settled)
    }
    const check = (): void => {
      timer = undefined
      const now = performance.now()
      if (readyAt === undefined && document.readyState === 'complete') {
        readyAt = now
        lastMutationAt = now
      }
      if (readyAt !== undefined) {
        const afterReady = now - readyAt
        const quietFor = now - lastMutationAt
        if ((afterReady >= policy.minimumMs && quietFor >= policy.quietMs)
          || afterReady >= policy.maxAfterReadyMs) {
          finish(true)
          return
        }
        const untilMinimum = Math.max(0, policy.minimumMs - afterReady)
        const untilQuiet = Math.max(0, policy.quietMs - quietFor)
        timer = setTimeout(check, Math.max(1, Math.min(policy.maxAfterReadyMs - afterReady, Math.max(untilMinimum, untilQuiet))))
        return
      }
      const elapsed = now - startedAt
      if (elapsed >= policy.timeoutMs) {
        finish(false)
        return
      }
      timer = setTimeout(check, Math.max(1, Math.min(100, policy.timeoutMs - elapsed)))
    }
    function schedule(): void {
      if (finished) return
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(check, 0)
    }

    if (document.documentElement !== null) {
      observer = new MutationObserver(() => {
        lastMutationAt = performance.now()
        schedule()
      })
      observer.observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      })
    }
    document.addEventListener('readystatechange', schedule)
    window.addEventListener('load', schedule)
    schedule()
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

function elementOrThrow(ids: ElementIds, index: number): Element {
  const el = ids.elementByIndex(index)
  if (el === undefined) {
    throw new ActionError('action-failed', `Element [${index}] does not exist; the page may have changed. Call browser_snapshot again to get current indices.`)
  }
  return el
}

/** Error carrying a stable wire code. */
export class ActionError extends Error {
  constructor(
    readonly code: 'action-failed' | 'bad-args' | 'no-match' | 'ambiguous-match',
    message: string,
  ) {
    super(message)
    this.name = 'ActionError'
  }
}

/** React-compatible value write: native setter + beforeinput/input/change events. */
function setNativeValue(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const previous = input.value
  const prototype = input instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  dispatchBeforeInput(input, value, previous === '' ? 'insertText' : 'insertReplacementText')
  if (setter === undefined) {
    input.value = value
  } else {
    setter.call(input, value)
  }
  input.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

function dispatchBeforeInput(target: EventTarget, data: string, inputType: string): void {
  try {
    target.dispatchEvent(new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      data,
      inputType,
    }))
  } catch {
    // jsdom / older engines may lack InputEvent; skip without failing the write.
  }
}

/** How an action addressed its target. */
interface ResolvedTarget {
  element: Element
  label: string
  /** Skip scrollIntoView for visually hidden form controls. */
  skipScroll: boolean
}

/**
 * Resolve `index` | `selector` | `text` (mutually exclusive) to one element.
 * @param mode - `click` allows text targeting; `type`/`focus`/`upload` do not.
 */
function resolveTarget(
  ids: ElementIds,
  args: Record<string, unknown>,
  mode: 'click' | 'type' | 'focus' | 'upload',
): ResolvedTarget {
  const hasIndex = args.index !== undefined
  const hasSelector = typeof args.selector === 'string' && args.selector !== ''
  // For type/upload, `text` is the payload / unused; only click uses text targeting.
  const hasTextTarget = mode === 'click' && typeof args.text === 'string' && args.text !== ''
  const modes = [hasIndex, hasSelector, hasTextTarget].filter(Boolean).length
  if (modes === 0) {
    throw new ActionError(
      'bad-args',
      mode === 'click'
        ? 'Provide exactly one of index, selector, or text to address the element.'
        : 'Provide exactly one of index or selector to address the element.',
    )
  }
  if (modes > 1) {
    throw new ActionError('bad-args', 'index, selector, and text addressing are mutually exclusive; provide only one.')
  }

  if (hasIndex) {
    const index = numberArg(args, 'index')
    const el = elementOrThrow(ids, index)
    return {
      element: el,
      label: `[${index}]`,
      skipScroll: !isVisible(el),
    }
  }

  if (hasSelector) {
    const selector = args.selector as string
    const allowHidden = args.allowHidden === true
    const nth = optionalNth(args)
    let matches: Element[]
    try {
      matches = querySelectorAllDeep(document, selector)
    } catch (error) {
      if (error instanceof InvalidSelectorError) {
        throw new ActionError('bad-args', error.message)
      }
      throw error
    }
    const candidates = allowHidden ? matches : matches.filter((el) => isVisible(el))
    if (candidates.length === 0) {
      throw new ActionError(
        'no-match',
        allowHidden
          ? `No element matched selector: ${selector}`
          : `No visible element matched selector: ${selector}. Pass allowHidden=true to target hidden matches.`,
      )
    }
    if (nth !== undefined) {
      if (nth < 0 || nth >= candidates.length) {
        throw new ActionError(
          'no-match',
          `selector "${selector}" matched ${candidates.length} element(s); nth=${nth} is out of range (0..${candidates.length - 1}).`,
        )
      }
      const el = candidates[nth]!
      return { element: el, label: `selector "${selector}" nth=${nth}`, skipScroll: !isVisible(el) }
    }
    if (candidates.length > 1) {
      throw new ActionError('ambiguous-match', formatAmbiguous(selector, candidates))
    }
    const el = candidates[0]!
    return { element: el, label: `selector "${selector}"`, skipScroll: !isVisible(el) }
  }

  const needle = (args.text as string).trim()
  const exact = args.exact !== false
  const nth = optionalNth(args)
  const textMatches = findByVisibleText(needle, exact)
  if (textMatches.length === 0) {
    throw new ActionError('no-match', `No visible element matched text: "${needle}"`)
  }
  const chosen = nth !== undefined
    ? (() => {
      if (nth < 0 || nth >= textMatches.length) {
        throw new ActionError(
          'no-match',
          `text "${needle}" matched ${textMatches.length} element(s); nth=${nth} is out of range (0..${textMatches.length - 1}).`,
        )
      }
      return textMatches[nth]!
    })()
    : textMatches.length === 1
    ? textMatches[0]!
    : pickDeepestSmallest(textMatches)
  if (nth === undefined && textMatches.length > 1 && !sameClickableLift(textMatches, chosen)) {
    // Multiple distinct clickable lifts — require nth.
    const lifts = textMatches.map((el) => liftClickable(el))
    const unique = uniqueElements(lifts)
    if (unique.length > 1) {
      throw new ActionError('ambiguous-match', formatAmbiguous(`text "${needle}"`, unique))
    }
  }
  const target = liftClickable(chosen)
  return {
    element: target,
    label: `text "${needle}"`,
    skipScroll: false,
  }
}

function optionalNth(args: Record<string, unknown>): number | undefined {
  if (args.nth === undefined) return undefined
  if (typeof args.nth !== 'number' || !Number.isInteger(args.nth) || args.nth < 0) {
    throw new ActionError('bad-args', `nth must be a non-negative integer; received ${String(args.nth)}.`)
  }
  return args.nth
}

function formatAmbiguous(query: string, candidates: Element[]): string {
  const preview = candidates.slice(0, 5).map((el, i) => {
    const name = accessibleName(el)
    return `  #${i}: ${el.tagName.toLowerCase()} "${name}"`
  }).join('\n')
  const more = candidates.length > 5 ? `\n  …and ${candidates.length - 5} more` : ''
  return `Ambiguous match for ${query}: ${candidates.length} candidates. Pass nth to disambiguate.\n${preview}${more}`
}

function findByVisibleText(needle: string, exact: boolean): Element[] {
  const matches: Element[] = []
  const walk = (root: Document | Element | ShadowRoot): void => {
    const nodes = root.querySelectorAll('*')
    for (const el of nodes) {
      if (!isVisible(el)) continue
      const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
      const hit = exact ? text === needle : text.includes(needle)
      if (hit) matches.push(el)
      if (el.shadowRoot !== null) walk(el.shadowRoot)
    }
  }
  walk(document)
  // Keep leaf matches only: ancestors share the same textContent and would
  // otherwise explode into ambiguous clickable lifts (html/body/…).
  return matches.filter((el) => !matches.some((other) => other !== el && el.contains(other)))
}

function pickDeepestSmallest(elements: Element[]): Element {
  return elements.reduce((best, el) => {
    const bestDepth = depthOf(best)
    const depth = depthOf(el)
    if (depth > bestDepth) return el
    if (depth < bestDepth) return best
    const bestArea = areaOf(best)
    const area = areaOf(el)
    return area < bestArea ? el : best
  })
}

function depthOf(el: Element): number {
  let depth = 0
  let node: Element | null = el
  while (node !== null) {
    depth += 1
    node = node.parentElement
  }
  return depth
}

function areaOf(el: Element): number {
  const rect = el.getBoundingClientRect()
  return Math.max(0, rect.width) * Math.max(0, rect.height)
}

/** Walk up at most 3 ancestors looking for a clickable host. */
function liftClickable(el: Element): Element {
  let current: Element | null = el
  for (let i = 0; i < 4 && current !== null; i += 1) {
    if (isClickableTarget(current, hasPointerCursor)) return current
    current = current.parentElement
  }
  return el
}

function sameClickableLift(elements: Element[], chosen: Element): boolean {
  const lift = liftClickable(chosen)
  return elements.every((el) => liftClickable(el) === lift)
}

function uniqueElements(elements: Element[]): Element[] {
  const seen = new Set<Element>()
  const out: Element[] = []
  for (const el of elements) {
    if (seen.has(el)) continue
    seen.add(el)
    out.push(el)
  }
  return out
}

function describeTarget(target: ResolvedTarget): string {
  return target.label
}

/** Action implementations; each returns a text result. */
export interface ActionContext {
  ids: ElementIds
  budget: SnapshotBudget
  /** Enabled only when the background may share page content without another approval. */
  includePageDelta?: boolean
}

/** Run one named action with its args. */
export async function runAction(action: string, args: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  switch (action) {
    case 'browser_snapshot':
      return snapshotAction(args, ctx)
    case 'browser_click':
      return clickAction(args, ctx)
    case 'browser_type':
      return typeAction(args, ctx)
    case 'browser_focus':
      return focusAction(args, ctx)
    case 'browser_upload':
      return uploadAction(args, ctx)
    case 'browser_press':
      return pressAction(args, ctx)
    case 'browser_scroll':
      return scrollAction(args, ctx)
    case 'browser_navigate':
      return navigateAction(args)
    case 'browser_back':
      return historyAction(-1)
    case 'browser_forward':
      return historyAction(1)
    case 'browser_reload':
      return reloadAction()
    case 'browser_get_text':
      return getTextAction(args)
    case 'browser_wait':
      return waitAction(args, ctx)
    default:
      throw new ActionError('bad-args', `Unknown action: ${action}`)
  }
}

function snapshotAction(args: Record<string, unknown>, ctx: ActionContext): ActionResult {
  const delta = args.delta === true
  const region = typeof args.region === 'string' && args.region !== '' ? args.region : undefined
  try {
    // 基线在每次快照后都更新：delta 调用才能相对上一次（无论是否 delta）比较。
    const view = buildSnapshot(ctx.ids, { delta, region, budget: ctx.budget }, lastSnapshot)
    lastSnapshot = view
    return { text: renderSnapshot(view, delta) }
  } catch (error) {
    if (error instanceof SnapshotRegionError) {
      throw new ActionError('no-match', error.message)
    }
    if (error instanceof SnapshotInvalidSelectorError) {
      throw new ActionError('bad-args', error.message)
    }
    throw error
  }
}

/** Module-level last snapshot state for delta mode (content-script lifetime). */
let lastSnapshot: ReturnType<typeof buildSnapshot> | null = null

/** Invalidate delta state after navigation (new document). */
function resetDeltaState(): void {
  lastSnapshot = null
}

/** Attach the settled page change while retaining the full view as the next delta baseline. */
function withPageDelta(text: string, ctx: ActionContext): ActionResult {
  if (ctx.includePageDelta !== true || lastSnapshot === null) return { text }
  const view = buildSnapshot(ctx.ids, { delta: true, budget: ctx.budget }, lastSnapshot)
  lastSnapshot = view
  return {
    text,
    pageContent: renderSnapshot(view, true, Math.min(ctx.budget.maxChars, ACTION_DELTA_MAX_CHARS)),
  }
}

async function clickAction(args: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  const target = resolveTarget(ctx.ids, args, 'click')
  const el = target.element
  const label = describeTarget(target)
  if (!target.skipScroll) {
    el.scrollIntoView({ block: 'center', behavior: 'instant' })
  }
  if (el instanceof HTMLAnchorElement) {
    const targetAttr = el.target.trim().toLowerCase()
    const sameFrameTarget = targetAttr === '' || targetAttr === '_self'
    let href: URL | undefined
    try { href = new URL(el.href) } catch { /* let the native click handle unusual links */ }
    const controlledNavigation = sameFrameTarget
      && !el.hasAttribute('download')
      && (href?.protocol === 'http:' || href?.protocol === 'https:')
    if (controlledNavigation && href !== undefined) {
      // Manual location assignment cannot preserve browser-managed link
      // semantics such as referrer suppression, hyperlink auditing, or
      // attribution registration. Keep native activation for those links,
      // but do not claim a replacement document is guaranteed: an SPA may
      // still cancel the click and remain in this document.
      const hasReferrerPolicy = typeof el.referrerPolicy === 'string' && el.referrerPolicy !== ''
      const requiresNativeActivation = el.relList.contains('noreferrer')
        || hasReferrerPolicy
        || el.hasAttribute('ping')
        || el.hasAttribute('attributionsrc')
      if (requiresNativeActivation) {
        setTimeout(() => { el.click() }, 0)
        return {
          text: `Clicked link ${label} using native browser activation. Call browser_snapshot to read the resulting state.`,
        }
      }
      // Dispatch the click handlers without its default navigation so a
      // client-side router can cancel synchronously and keep this document.
      const shouldNavigate = el.dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        composed: true,
      }))
      if (!shouldNavigate) {
        await waitForPageSettled(ACTION_SETTLE)
        return withPageDelta(`Clicked link ${label}.`, ctx)
      }
      const sameDocument = href.origin === location.origin
        && href.pathname === location.pathname
        && href.search === location.search
      if (sameDocument) {
        if (href.hash !== location.hash) location.hash = href.hash
        await waitForPageSettled(ACTION_SETTLE)
        return withPageDelta(`Clicked link ${label}.`, ctx)
      }
      // A cross-document navigation can unload this content script before an
      // awaited response. Answer first and navigate in the next task.
      setTimeout(() => { location.href = href.href }, 0)
      return {
        text: `Clicked link ${label}. Call browser_snapshot again after navigation settles.`,
        navigationPending: true,
      }
    }
    setTimeout(() => { el.click() }, 0)
    return { text: `Clicked link ${label}. The link may open outside the controlled frame.` }
  }
  if (el instanceof HTMLButtonElement && el.disabled) {
    throw new ActionError('action-failed', `Button ${label} is disabled.`)
  }
  synthesizePointerClick(el as HTMLElement)
  await waitForPageSettled(ACTION_SETTLE)
  return withPageDelta(`Clicked ${label}.`, ctx)
}

/**
 * Dispatch a pointer/mouse sequence that matches a real user press.
 *
 * Many design-system pickers open on `pointerdown`/`mousedown`/`focus`, not
 * on the synthetic `HTMLElement.click()` event alone.
 */
function synthesizePointerClick(target: HTMLElement): void {
  // Omit `view`: jsdom rejects `view: window` on MouseEvent/PointerEvent.
  const downInit: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    button: 0,
    buttons: 1,
  }
  dispatchPointer(target, 'pointerdown', downInit)
  target.dispatchEvent(new MouseEvent('mousedown', downInit))
  const focusTarget = focusableWithin(target)
  if (focusTarget !== null) {
    try {
      focusTarget.focus({ preventScroll: true })
    } catch {
      focusTarget.focus()
    }
  }
  const upInit: MouseEventInit = { ...downInit, buttons: 0 }
  dispatchPointer(target, 'pointerup', upInit)
  target.dispatchEvent(new MouseEvent('mouseup', upInit))
  target.dispatchEvent(new MouseEvent('click', { ...upInit, detail: 1 }))
}

function dispatchPointer(target: HTMLElement, type: string, mouseInit: MouseEventInit): void {
  try {
    if (typeof PointerEvent === 'function') {
      target.dispatchEvent(new PointerEvent(type, {
        ...mouseInit,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
      }))
      return
    }
  } catch {
    // Fall through to a MouseEvent stand-in.
  }
  // Avoid double-firing mousedown/mouseup when PointerEvent is unavailable —
  // the caller already dispatches those MouseEvents.
  if (type === 'pointerdown' || type === 'pointerup') return
  target.dispatchEvent(new MouseEvent(type, mouseInit))
}

/** Prefer the addressed element, else a nested focusable control (picker input). */
function focusableWithin(el: HTMLElement): HTMLElement | null {
  if (el.tabIndex >= 0) return el
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    return el
  }
  if (el.isContentEditable) return el
  const nested = el.querySelector<HTMLElement>(
    'input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"], [contenteditable=""]',
  )
  return nested ?? el
}

/**
 * The nearest editable host, or null when a `contenteditable="false"` island
 * blocks editing.
 *
 * The walk must stop at the nearest `[contenteditable]` boundary instead of
 * skipping disabled ones: an element inside a non-editable island nested in an
 * editable composer belongs to the island, and resolving past it would type
 * into the surrounding composer rather than refusing the target.
 *
 * @param el - element addressed by the action.
 * @returns the owning editable host, or null when editing is blocked.
 */
function editingHost(el: HTMLElement): HTMLElement | null {
  const boundary = el.closest('[contenteditable]')
  if (!(boundary instanceof HTMLElement)) return null
  return boundary.getAttribute('contenteditable') === 'false' ? null : boundary
}

/**
 * Whether the element can receive rich-text input.
 *
 * `isContentEditable` is the browser's own answer; the boundary walk covers the
 * attribute case, which is unimplemented in jsdom, where these tests run.
 *
 * @param el - element addressed by the action.
 * @returns true when the element can receive rich-text input.
 */
function isEditable(el: Element): el is HTMLElement {
  return el instanceof HTMLElement && (el.isContentEditable || editingHost(el) !== null)
}

/**
 * Insert text into a rich-text host through the browser's editing pipeline.
 *
 * Editors such as Lexical, Draft.js and ProseMirror keep their own document
 * model and reconcile away foreign DOM writes, so assigning `textContent`
 * silently reverts and the caller's success report becomes a lie.
 * `execCommand('insertText')` is deprecated but remains the only path that
 * produces the `beforeinput`/`input` sequence those editors listen for. Hosts
 * without it keep the direct-write fallback.
 *
 * @param el - element addressed by the action.
 * @param text - text to insert.
 * @param replace - whether to replace the host's current contents.
 */
function typeIntoContentEditable(el: HTMLElement, text: string, replace: boolean): void {
  // `isEditable` already refused a disabled island, so a null host here means
  // the element is editable without the attribute; address it directly.
  const host = editingHost(el) ?? el
  host.focus()
  const selection = host.ownerDocument.getSelection()
  if (selection !== null) {
    const range = host.ownerDocument.createRange()
    range.selectNodeContents(host)
    // A caret collapsed to the end appends; a full selection is replaced by insertText.
    if (!replace) range.collapse(false)
    selection.removeAllRanges()
    selection.addRange(range)
  }
  const doc = host.ownerDocument
  if (typeof doc.execCommand === 'function') {
    try {
      if (doc.execCommand('insertText', false, text)) return
    } catch {
      // Fall through to the direct-write path below.
    }
  }
  // Direct writes do not synthesize beforeinput; emit it for controlled editors.
  dispatchBeforeInput(host, text, replace ? 'insertReplacementText' : 'insertText')
  if (replace) host.textContent = ''
  host.textContent = `${host.textContent ?? ''}${text}`
  host.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }))
}

async function typeAction(args: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  // Input payload lives in `text`; addressing uses index|selector only.
  const addressing = { ...args }
  const text = typeof addressing.text === 'string' ? addressing.text : ''
  if (text === '') throw new ActionError('bad-args', 'text must not be empty.')
  // When addressing by selector, `text` is the value to type — strip it from
  // the mutual-exclusion check by resolving with a type-mode copy that keeps
  // selector/index only.
  const resolveArgs: Record<string, unknown> = { ...addressing }
  if (typeof resolveArgs.selector === 'string' && resolveArgs.selector !== '') {
    delete resolveArgs.text
  }
  const replace = args.replace === true
  const target = resolveTarget(ctx.ids, resolveArgs, 'type')
  const el = target.element
  const label = describeTarget(target)
  if (!target.skipScroll) {
    el.scrollIntoView({ block: 'center', behavior: 'instant' })
  }
  if (isEditable(el)) {
    typeIntoContentEditable(el, text, replace)
  } else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    if (el instanceof HTMLInputElement && el.type === 'file') {
      throw new ActionError('action-failed', `Element ${label} is a file input; use browser_upload instead of browser_type.`)
    }
    ;(el as HTMLElement).focus()
    if (replace) setNativeValue(el, '')
    setNativeValue(el, `${el.value}${text}`)
  } else if (el instanceof HTMLSelectElement) {
    el.focus()
    el.value = text
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  } else {
    throw new ActionError('action-failed', `Element ${label} is not editable (${el.tagName.toLowerCase()}).`)
  }
  await waitForPageSettled(TYPE_SETTLE)
  return withPageDelta(`Entered ${text.length} characters into ${label}.`, ctx)
}

async function focusAction(args: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  const target = resolveTarget(ctx.ids, args, 'focus')
  const el = target.element
  if (!(el instanceof HTMLElement)) {
    throw new ActionError('action-failed', `Element ${describeTarget(target)} cannot receive focus.`)
  }
  if (!target.skipScroll) el.scrollIntoView({ block: 'center', behavior: 'instant' })
  el.focus()
  await waitForPageSettled(TYPE_SETTLE)
  return withPageDelta(`Focused ${describeTarget(target)}.`, ctx)
}

async function uploadAction(args: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  const name = typeof args.name === 'string' && args.name !== '' ? args.name : 'upload.bin'
  const mimeType = typeof args.mimeType === 'string' && args.mimeType !== '' ? args.mimeType : 'application/octet-stream'
  const dataBase64 = typeof args.dataBase64 === 'string' ? args.dataBase64 : ''
  if (dataBase64 === '') throw new ActionError('bad-args', 'dataBase64 must not be empty.')
  const target = resolveTarget(ctx.ids, args, 'upload')
  const el = target.element
  if (!(el instanceof HTMLInputElement) || el.type !== 'file') {
    throw new ActionError('action-failed', `Element ${describeTarget(target)} is not an input[type=file].`)
  }
  let bytes: Uint8Array
  try {
    const binary = atob(dataBase64)
    bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0))
  } catch {
    throw new ActionError('bad-args', 'dataBase64 is not valid base64.')
  }
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  const file = new File([copy], name, { type: mimeType })
  assignInputFiles(el, file)
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  await waitForPageSettled(ACTION_SETTLE)
  return withPageDelta(`Uploaded "${name}" (${bytes.length} bytes) to ${describeTarget(target)}.`, ctx)
}

/** Assign a FileList onto an input, with a jsdom-friendly fallback. */
function assignInputFiles(input: HTMLInputElement, file: File): void {
  if (typeof DataTransfer !== 'undefined') {
    const transfer = new DataTransfer()
    transfer.items.add(file)
    try {
      input.files = transfer.files
      if (input.files === transfer.files) return
    } catch {
      // Fall through to defineProperty.
    }
  }
  const list = {
    0: file,
    length: 1,
    item: (index: number) => (index === 0 ? file : null),
    *[Symbol.iterator]() { yield file },
  } as unknown as FileList
  Object.defineProperty(input, 'files', { configurable: true, value: list })
}

async function pressAction(args: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  const key = typeof args.key === 'string' && args.key !== '' ? args.key : ''
  if (key === '') throw new ActionError('bad-args', 'key must not be empty.')
  const target = document.activeElement instanceof HTMLElement ? document.activeElement : document.body
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  target.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }))
  // Never synthesize form submit while a picker/dropdown is open — Enter is often
  // used to confirm a cell, and a synthetic submit can submit a job/checkout form.
  if (
    key === 'Enter'
    && target instanceof HTMLInputElement
    && target.form !== null
    && !documentHasOpenOverlay()
  ) {
    target.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  }
  await waitForPageSettled(ACTION_SETTLE)
  return withPageDelta(`Sent key "${key}".`, ctx)
}

async function scrollAction(args: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  const direction = typeof args.direction === 'string' ? args.direction : ''
  const amount = typeof args.amount === 'number' ? args.amount : Math.floor(window.innerHeight * 0.8)
  switch (direction) {
    case 'top':
      window.scrollTo({ top: 0, behavior: 'instant' })
      break
    case 'bottom':
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' })
      break
    case 'up':
      window.scrollBy({ top: -amount, behavior: 'instant' })
      break
    case 'down':
      window.scrollBy({ top: amount, behavior: 'instant' })
      break
    default:
      throw new ActionError('bad-args', `direction must be up, down, top, or bottom; received "${direction}".`)
  }
  await waitForPageSettled(SCROLL_SETTLE)
  return withPageDelta(`Scrolled ${direction}.`, ctx)
}

async function navigateAction(args: Record<string, unknown>): Promise<ActionResult> {
  const url = typeof args.url === 'string' && args.url !== '' ? args.url : ''
  if (url === '') throw new ActionError('bad-args', 'url must not be empty.')
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new ActionError('bad-args', `url is not valid: ${url}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ActionError('bad-args', `Only http and https URLs are supported; received ${parsed.protocol}.`)
  }
  resetDeltaState()
  // Cross-document navigation unloads this content script and destroys the
  // tabs.sendMessage response port before any await settles — so answer
  // FIRST, then navigate in a fresh task. The model re-snapshots after load.
  setTimeout(() => { location.href = parsed.href }, 0)
  return {
    text: `Navigating to ${parsed.href}. Call browser_snapshot again after the page loads.`,
    navigationPending: true,
  }
}

async function historyAction(delta: 1 | -1): Promise<ActionResult> {
  resetDeltaState()
  // 同 navigate：先响应再导航（文档卸载会销毁响应端口）。
  setTimeout(() => { if (delta === -1) history.back(); else history.forward() }, 0)
  return {
    text: 'Navigating through browser history. Call browser_snapshot again after the page loads.',
    navigationPending: true,
  }
}

function reloadAction(): ActionResult {
  resetDeltaState()
  setTimeout(() => { location.reload() }, 0)
  return {
    text: 'The page is reloading. Call browser_snapshot again after it loads.',
    navigationPending: true,
  }
}

async function getTextAction(args: Record<string, unknown>): Promise<ActionResult> {
  const selector = typeof args.selector === 'string' && args.selector !== '' ? args.selector : undefined
  const source = selector !== undefined ? document.querySelector(selector) : null
  const text = source !== null ? pageText(source) : selector !== undefined ? `No element matched selector: ${selector}` : pageText()
  const truncated = truncate(text, 8_000)
  return { text: truncated.text + (truncated.truncated > 0 ? `\n(Truncated ${truncated.truncated} characters.)` : '') }
}

async function waitAction(args: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  const ms = typeof args.ms === 'number' && args.ms > 0 ? args.ms : 0
  await waitForPageSettled(EXPLICIT_WAIT_SETTLE)
  if (ms > 0) await sleep(ms)
  return withPageDelta(`The page is stable${ms > 0 ? ` after an additional ${ms}ms wait` : ''}.`, ctx)
}

function numberArg(args: Record<string, unknown>, name: string): number {
  const value = args[name]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ActionError('bad-args', `${name} must be a non-negative integer; received ${String(value)}.`)
  }
  return value
}
