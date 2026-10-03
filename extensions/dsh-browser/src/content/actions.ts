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

import { pageText, truncate } from './extract.ts'
import type { ElementIds } from './ids.ts'
import type { SnapshotBudget } from './snapshot.ts'
import { buildSnapshot, renderSnapshot } from './snapshot.ts'

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
    readonly code: 'action-failed' | 'bad-args',
    message: string,
  ) {
    super(message)
    this.name = 'ActionError'
  }
}

/** React-compatible value write: native setter + input/change events. */
function setNativeValue(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = input instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  if (setter === undefined) {
    input.value = value
  } else {
    setter.call(input, value)
  }
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
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
  // 基线在每次快照后都更新：delta 调用才能相对上一次（无论是否 delta）比较。
  const view = buildSnapshot(ctx.ids, { delta, region, budget: ctx.budget }, lastSnapshot)
  lastSnapshot = view
  return { text: renderSnapshot(view, delta) }
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
  const index = numberArg(args, 'index')
  const el = elementOrThrow(ctx.ids, index)
  el.scrollIntoView({ block: 'center', behavior: 'instant' })
  if (el instanceof HTMLAnchorElement) {
    const target = el.target.trim().toLowerCase()
    const sameFrameTarget = target === '' || target === '_self'
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
          text: `Clicked link [${index}] using native browser activation. Call browser_snapshot to read the resulting state.`,
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
        return withPageDelta(`Clicked link [${index}].`, ctx)
      }
      const sameDocument = href.origin === location.origin
        && href.pathname === location.pathname
        && href.search === location.search
      if (sameDocument) {
        if (href.hash !== location.hash) location.hash = href.hash
        await waitForPageSettled(ACTION_SETTLE)
        return withPageDelta(`Clicked link [${index}].`, ctx)
      }
      // A cross-document navigation can unload this content script before an
      // awaited response. Answer first and navigate in the next task.
      setTimeout(() => { location.href = href.href }, 0)
      return {
        text: `Clicked link [${index}]. Call browser_snapshot again after navigation settles.`,
        navigationPending: true,
      }
    }
    setTimeout(() => { el.click() }, 0)
    return { text: `Clicked link [${index}]. The link may open outside the controlled frame.` }
  }
  if (el instanceof HTMLButtonElement && el.disabled) {
    throw new ActionError('action-failed', `Button [${index}] is disabled.`)
  }
  ;(el as HTMLElement).click()
  await waitForPageSettled(ACTION_SETTLE)
  return withPageDelta(`Clicked [${index}].`, ctx)
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
  if (replace) host.textContent = ''
  host.textContent = `${host.textContent ?? ''}${text}`
  host.dispatchEvent(new Event('input', { bubbles: true }))
}

async function typeAction(args: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  const index = numberArg(args, 'index')
  const text = typeof args.text === 'string' ? args.text : ''
  if (text === '') throw new ActionError('bad-args', 'text must not be empty.')
  const replace = args.replace === true
  const el = elementOrThrow(ctx.ids, index)
  if (isEditable(el)) {
    typeIntoContentEditable(el, text, replace)
  } else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    if (replace) setNativeValue(el, '')
    setNativeValue(el, `${el.value}${text}`)
  } else {
    throw new ActionError('action-failed', `Element [${index}] is not editable (${el.tagName.toLowerCase()}).`)
  }
  await waitForPageSettled(TYPE_SETTLE)
  return withPageDelta(`Entered ${text.length} characters into [${index}].`, ctx)
}

async function pressAction(args: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  const key = typeof args.key === 'string' && args.key !== '' ? args.key : ''
  if (key === '') throw new ActionError('bad-args', 'key must not be empty.')
  const target = document.activeElement instanceof HTMLElement ? document.activeElement : document.body
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  target.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }))
  if (key === 'Enter' && target instanceof HTMLInputElement && target.form !== null) {
    target.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  }
  await waitForPageSettled(ACTION_SETTLE)
  return withPageDelta(`Sent key "${key}".`, ctx)
}

/** Directions `browser_scroll` accepts. */
type ScrollDirection = 'up' | 'down' | 'top' | 'bottom'

function isScrollDirection(value: unknown): value is ScrollDirection {
  return value === 'up' || value === 'down' || value === 'top' || value === 'bottom'
}

/**
 * Nearest ancestor — the element itself included — that actually scrolls
 * vertically. Nested app shells (chat transcripts, side panes, modal bodies)
 * keep their own overflow container, so a `window` scroll never reaches them
 * and the app never receives the scroll event its lazy loading waits for.
 */
function nearestScrollable(el: Element | null): HTMLElement | null {
  for (let node: Element | null = el; node !== null && node !== document.body; node = node.parentElement) {
    if (!(node instanceof HTMLElement)) continue
    const overflowY = getComputedStyle(node).overflowY
    if (overflowY !== 'auto' && overflowY !== 'scroll' && overflowY !== 'overlay') continue
    if (node.scrollHeight > node.clientHeight + 1) return node
  }
  return null
}

/** Short, stable container description for the status line. */
function describeContainer(box: HTMLElement): string {
  const id = box.id === '' ? '' : `#${box.id}`
  const role = box.getAttribute('role')
  return `${box.tagName.toLowerCase()}${id}${role === null ? '' : `[role="${role}"]`}`
}

/** Scroll the document itself: the only behavior this action had before targeting. */
function scrollDocument(direction: ScrollDirection, amount: number): void {
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
  }
}

async function scrollAction(args: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  const direction = args.direction
  if (!isScrollDirection(direction)) {
    throw new ActionError('bad-args', `direction must be up, down, top, or bottom; received "${String(direction)}".`)
  }
  const amount = typeof args.amount === 'number' ? args.amount : Math.floor(window.innerHeight * 0.8)
  const selector = typeof args.selector === 'string' && args.selector !== '' ? args.selector : undefined
  const hasIndex = args.index !== undefined
  if (hasIndex && selector !== undefined) {
    throw new ActionError('bad-args', 'Provide either index or selector, not both.')
  }

  // No target: keep the original page-level behavior exactly as it was.
  if (!hasIndex && selector === undefined) {
    scrollDocument(direction, amount)
    await waitForPageSettled(SCROLL_SETTLE)
    return withPageDelta(`Scrolled ${direction}.`, ctx)
  }

  const index = hasIndex ? numberArg(args, 'index') : undefined
  let anchor: Element
  if (index !== undefined) {
    anchor = elementOrThrow(ctx.ids, index)
  } else {
    let found: Element | null
    try {
      found = document.querySelector(selector as string)
    } catch {
      throw new ActionError('bad-args', `selector is not a valid CSS selector: ${String(selector)}`)
    }
    if (found === null) throw new ActionError('action-failed', `No element matched selector: ${String(selector)}`)
    anchor = found
  }
  const label = index !== undefined ? `element [${index}]` : `selector ${String(selector)}`

  const box = nearestScrollable(anchor)
  if (box === null) {
    scrollDocument(direction, amount)
    await waitForPageSettled(SCROLL_SETTLE)
    return withPageDelta(
      `Scrolled ${direction}; ${label} has no scrollable container, so the page scrolled instead.`,
      ctx,
    )
  }

  const before = box.scrollTop
  if (direction === 'top') box.scrollTop = 0
  else if (direction === 'bottom') box.scrollTop = box.scrollHeight
  else box.scrollTop += direction === 'up' ? -amount : amount
  // Moving scrollTop relocates the container but tells listeners nothing, and a
  // synthetic wheel event does not scroll by itself. Replay the gesture after
  // the move so apps that gate lazy loading on `wheel` still fire.
  const wheelDelta = direction === 'up' || direction === 'top' ? -amount : amount
  if (typeof WheelEvent === 'function') {
    box.dispatchEvent(new WheelEvent('wheel', { deltaY: wheelDelta, bubbles: true, cancelable: true }))
  }

  await waitForPageSettled(SCROLL_SETTLE)
  return withPageDelta(
    `Scrolled ${direction} inside ${describeContainer(box)} (${before} to ${box.scrollTop}).`,
    ctx,
  )
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
