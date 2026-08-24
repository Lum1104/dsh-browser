/**
 * Page actions: click/type/press/scroll/navigate/get_text/wait plus the
 * targeting and batching operations, executed in the content script against
 * the real page (preserving login state), each returning a short text status.
 * Navigations return a fresh full snapshot because the document — and the id
 * registry — reset.
 *
 * Action results are text (the model reads page STATE as text); the capture
 * actions return a resolved pixel source for the background to encode, never
 * pixels assembled here.
 *
 * @module
 */

import { pageText, truncate } from './extract.ts'
import type { ElementIds } from './ids.ts'
import type { SnapshotBudget } from './snapshot.ts'
import { buildSnapshot, renderSnapshot } from './snapshot.ts'
import {
  elementViewportBox,
  findElements,
  FindError,
  imageSourceFor,
  locateImageElement,
  renderFindResult,
  roleOf,
  type ImageSource,
} from './locate.ts'
import { DEFAULT_EXPAND_OPTIONS, expandPage, renderExpandResult } from './expand.ts'
import { harvestLinks, renderLinks } from './harvest.ts'
import { verificationTargets, renderVerificationTargets, type VerificationTarget } from './verify.ts'
import {
  renderWindowFooter,
  resolveLimit,
  resolveOffset,
  windowText,
} from '@yuxianglin/dsh-bridge-browser/src/text-window.ts'
import {
  DEFAULT_TEXT_WINDOW_CHARS,
  MAX_TEXT_WINDOW_CHARS,
} from '@yuxianglin/dsh-bridge-browser/src/protocol.ts'

/** A settled action result. */
export interface ActionResult {
  text: string
  /** Page-authored snapshot delta; the background must wrap it as untrusted. */
  pageContent?: string
  /** A same-frame document navigation was scheduled after this response. */
  navigationPending?: boolean
  /**
   * Where the requested pixels live, for the background to fetch, crop, and
   * encode. The content script never encodes images itself: the byte budget
   * and the re-encode belong to the side that owns the wire.
   */
  imageSources?: ImageSource[]
  /**
   * Verification widgets found on the page, with the point to click in
   * top-level viewport coordinates. The click needs a trusted event, which only
   * the background can produce.
   */
  verificationTargets?: VerificationTarget[]
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
/**
 * Budget for the delta that rides an action's result. Generous on purpose: the
 * delta is how the model learns what its click did, and a delta cut short is a
 * second snapshot call plus a guess about what changed in between.
 */
const ACTION_DELTA_MAX_CHARS = 16_000

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
  if (el === undefined || !el.isConnected) {
    throw new ActionError('action-failed', `Element [${index}] is no longer in the page; it may have re-rendered. Call browser_find (it returns a selector you can pass alongside the index) or browser_snapshot for current indices.`)
  }
  return el
}

/**
 * Resolve the element an action targets, preferring the index and falling back
 * to a selector.
 *
 * Indices are per-document and per-inventory, so any re-render that restructures
 * the page invalidates them — the single most common reason an action fails and
 * has to be re-planned by the model. When the call also carries the selector
 * `browser_find` handed out, a stale index costs nothing: the element is found
 * again and the action proceeds, with the substitution reported so the model
 * learns its indices went stale.
 *
 * `isConnected` is checked, not just registry membership: the registry holds a
 * strong reference, so after a re-render it still resolves the index — to a
 * DETACHED node. Acting on that reports success while doing nothing at all,
 * which is the worst possible outcome for a model that cannot see the page.
 *
 * @param ctx - the action context holding the id registry.
 * @param args - the call arguments (`index` and/or `selector`).
 * @returns the element plus whether the selector had to stand in for the index.
 * @throws ActionError when neither handle resolves.
 */
function targetElement(ctx: ActionContext, args: Record<string, unknown>): { element: Element; recovered: boolean; label: string } {
  const hasIndex = args.index !== undefined
  const selector = typeof args.selector === 'string' && args.selector !== '' ? args.selector : undefined

  if (hasIndex) {
    const index = numberArg(args, 'index')
    const byIndex = ctx.ids.elementByIndex(index)
    if (byIndex !== undefined && byIndex.isConnected) return { element: byIndex, recovered: false, label: `[${index}]` }
    if (selector === undefined) {
      throw new ActionError(
        'action-failed',
        byIndex === undefined
          ? `Element [${index}] does not exist; the page may have changed. Call browser_find (it returns a selector you can pass alongside the index) or browser_snapshot for current indices.`
          : `Element [${index}] was removed from the page by a re-render. Call browser_find (it returns a selector you can pass alongside the index) or browser_snapshot for current indices.`,
      )
    }
  }
  if (selector === undefined) {
    throw new ActionError('bad-args', 'Provide index, or selector, to identify the element.')
  }
  let found: Element | null
  try {
    found = document.querySelector(selector)
  } catch {
    throw new ActionError('bad-args', `selector is not a valid CSS selector: ${selector}`)
  }
  if (found === null) {
    throw new ActionError('action-failed', `No element matched selector: ${selector}. Call browser_find to locate it again.`)
  }
  return { element: found, recovered: hasIndex, label: `"${selector}"` }
}

/** Note appended when a selector had to stand in for a stale index. */
function recoveryNote(target: { recovered: boolean }): string {
  return target.recovered
    ? ' (the index was stale, so the selector was used; take a fresh snapshot before relying on indices again)'
    : ''
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
    case 'browser_find':
      return findAction(args, ctx)
    case 'browser_select_option':
      return selectOptionAction(args, ctx)
    case 'browser_hover':
      return hoverAction(args, ctx)
    case 'browser_act':
      return actAction(args, ctx)
    case 'browser_screenshot':
      return screenshotAction(args, ctx)
    case 'browser_read_image':
      return readImageAction(args, ctx)
    case 'browser_expand':
      return expandAction(args, ctx)
    // Internal actions: the background calls these directly while serving a
    // model tool; they are not registered as tools themselves.
    case 'dsh_harvest_links':
      return harvestAction(args, ctx)
    case 'dsh_verification_targets':
      return verificationAction()
    default:
      throw new ActionError('bad-args', `Unknown action: ${action}`)
  }
}

function snapshotAction(args: Record<string, unknown>, ctx: ActionContext): ActionResult {
  const delta = args.delta === true
  const region = typeof args.region === 'string' && args.region !== '' ? args.region : undefined
  const full = args.full === true
  // 基线在每次快照后都更新：delta 调用才能相对上一次（无论是否 delta）比较。
  const view = buildSnapshot(ctx.ids, { delta, region, full, budget: ctx.budget }, lastSnapshot)
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
  const resolved = targetElement(ctx, args)
  const el = resolved.element
  const index = resolved.label
  el.scrollIntoView({ block: 'center', behavior: 'instant' })
  if (el instanceof HTMLAnchorElement) {
    // `target` here is the anchor's own target attribute, not the resolved element.
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
          text: `Clicked link ${index} using native browser activation. Call browser_snapshot to read the resulting state.`,
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
        return withPageDelta(`Clicked link ${index}${recoveryNote(resolved)}.`, ctx)
      }
      const sameDocument = href.origin === location.origin
        && href.pathname === location.pathname
        && href.search === location.search
      if (sameDocument) {
        if (href.hash !== location.hash) location.hash = href.hash
        await waitForPageSettled(ACTION_SETTLE)
        return withPageDelta(`Clicked link ${index}${recoveryNote(resolved)}.`, ctx)
      }
      // A cross-document navigation can unload this content script before an
      // awaited response. Answer first and navigate in the next task.
      setTimeout(() => { location.href = href.href }, 0)
      return {
        text: `Clicked link ${index}. Call browser_snapshot again after navigation settles.`,
        navigationPending: true,
      }
    }
    setTimeout(() => { el.click() }, 0)
    return { text: `Clicked link ${index}. The link may open outside the controlled frame.` }
  }
  if (el instanceof HTMLButtonElement && el.disabled) {
    throw new ActionError('action-failed', `Button ${index} is disabled.`)
  }
  ;(el as HTMLElement).click()
  await waitForPageSettled(ACTION_SETTLE)
  return withPageDelta(`Clicked ${index}${recoveryNote(resolved)}.`, ctx)
}

async function typeAction(args: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  const text = typeof args.text === 'string' ? args.text : ''
  if (text === '') throw new ActionError('bad-args', 'text must not be empty.')
  const replace = args.replace === true
  const target = targetElement(ctx, args)
  const el = target.element
  const index = target.label
  const contentEditable = el instanceof HTMLElement && el.isContentEditable
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || contentEditable)) {
    throw new ActionError('action-failed', `Element ${index} is not editable (${el.tagName.toLowerCase()}).`)
  }
  if (contentEditable) {
    if (replace) el.textContent = ''
    el.textContent = `${el.textContent ?? ''}${text}`
    el.dispatchEvent(new Event('input', { bubbles: true }))
  } else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    if (replace) setNativeValue(el, '')
    setNativeValue(el, `${el.value}${text}`)
  }
  await waitForPageSettled(TYPE_SETTLE)
  return withPageDelta(`Entered ${text.length} characters into ${index}${recoveryNote(target)}.`, ctx)
}

async function pressAction(args: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  const key = typeof args.key === 'string' && args.key !== '' ? args.key : ''
  if (key === '') throw new ActionError('bad-args', 'key must not be empty.')
  const modifiers = modifierArg(args)
  if (args.index !== undefined || typeof args.selector === 'string') {
    const el = targetElement(ctx, args).element
    if (el instanceof HTMLElement) {
      el.scrollIntoView({ block: 'center', behavior: 'instant' })
      el.focus()
    }
  }
  const target = document.activeElement instanceof HTMLElement ? document.activeElement : document.body
  const init: KeyboardEventInit = {
    key,
    bubbles: true,
    cancelable: true,
    ctrlKey: modifiers.has('Control'),
    shiftKey: modifiers.has('Shift'),
    altKey: modifiers.has('Alt'),
    metaKey: modifiers.has('Meta'),
  }
  target.dispatchEvent(new KeyboardEvent('keydown', init))
  target.dispatchEvent(new KeyboardEvent('keyup', init))
  if (key === 'Enter' && modifiers.size === 0 && target instanceof HTMLInputElement && target.form !== null) {
    target.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  }
  await waitForPageSettled(ACTION_SETTLE)
  const combination = modifiers.size === 0 ? `"${key}"` : `"${[...modifiers].join('+')}+${key}"`
  return withPageDelta(`Sent key ${combination}.`, ctx)
}

/** Modifier names the page keyboard events accept, ignoring anything unknown. */
function modifierArg(args: Record<string, unknown>): Set<string> {
  const allowed = new Set(['Control', 'Shift', 'Alt', 'Meta'])
  const raw = Array.isArray(args.modifiers) ? args.modifiers : []
  const named = raw.filter((value): value is string => typeof value === 'string')
  const unknown = named.filter((value) => !allowed.has(value))
  if (unknown.length > 0) {
    throw new ActionError('bad-args', `modifiers must be Control, Shift, Alt, or Meta; received ${unknown.join(', ')}.`)
  }
  return new Set(named)
}

async function scrollAction(args: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  const target = scrollTarget(args, ctx)
  if (target !== undefined) {
    target.element.scrollIntoView({ block: 'center', behavior: 'instant' })
    await waitForPageSettled(SCROLL_SETTLE)
    return withPageDelta(`Scrolled ${target.label} into view.`, ctx)
  }
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

/** An explicit scroll destination, when the call named one instead of a direction. */
function scrollTarget(args: Record<string, unknown>, ctx: ActionContext): { element: Element; label: string } | undefined {
  if (args.index !== undefined) {
    const index = numberArg(args, 'index')
    return { element: elementOrThrow(ctx.ids, index), label: `[${index}]` }
  }
  if (typeof args.selector === 'string' && args.selector !== '') {
    let element: Element | null
    try {
      element = document.querySelector(args.selector)
    } catch {
      throw new ActionError('bad-args', `selector is not a valid CSS selector: ${args.selector}`)
    }
    if (element === null) throw new ActionError('action-failed', `No element matched selector: ${args.selector}`)
    return { element, label: `"${args.selector}"` }
  }
  return undefined
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

/**
 * Read page text as a window over the whole source.
 *
 * A fixed cut that only announces "truncated" loses information for good: the
 * model cannot ask for the rest, so it guesses or re-reads the same prefix.
 * Every read now reports the total and the exact call that continues from where
 * it stopped.
 */
async function getTextAction(args: Record<string, unknown>): Promise<ActionResult> {
  const selector = typeof args.selector === 'string' && args.selector !== '' ? args.selector : undefined
  if (selector === undefined) {
    return textWindowResult(pageText(), args, 'browser_get_text({ offset: NEXT })')
  }
  let source: Element | null
  try {
    source = document.querySelector(selector)
  } catch {
    throw new ActionError('bad-args', `selector is not a valid CSS selector: ${selector}`)
  }
  if (source === null) {
    throw new ActionError(
      'action-failed',
      `No element matched selector: ${selector}. Use browser_find or browser_snapshot to see what the page actually offers.`,
    )
  }
  return textWindowResult(pageText(source), args, `browser_get_text({ selector: "${selector}", offset: NEXT })`)
}

/** Project a source text into the requested window plus its continuation footer. */
function textWindowResult(source: string, args: Record<string, unknown>, continuation: string): ActionResult {
  const view = windowText(source, resolveOffset(args.offset), resolveLimit(args.limit, DEFAULT_TEXT_WINDOW_CHARS, MAX_TEXT_WINDOW_CHARS))
  if (view.total === 0) return { text: '(The page or element contains no text.)' }
  if (view.returned === 0) {
    return { text: `[offset ${view.offset} is past the end of this text, which is ${view.total} characters long]` }
  }
  const footer = renderWindowFooter(view, continuation.replace('NEXT', String(view.offset + view.returned)))
  return { text: `${view.text}${footer}` }
}

async function waitAction(args: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  const ms = typeof args.ms === 'number' && args.ms > 0 ? args.ms : 0
  const condition = waitCondition(args)
  if (condition === undefined) {
    await waitForPageSettled(EXPLICIT_WAIT_SETTLE)
    if (ms > 0) await sleep(ms)
    return withPageDelta(`The page is stable${ms > 0 ? ` after an additional ${ms}ms wait` : ''}.`, ctx)
  }
  const timeoutMs = typeof args.timeoutMs === 'number' && args.timeoutMs > 0
    ? Math.min(args.timeoutMs, MAX_CONDITION_WAIT_MS)
    : DEFAULT_CONDITION_WAIT_MS
  const held = await waitForCondition(condition.test, timeoutMs)
  if (!held) {
    throw new ActionError(
      'action-failed',
      `Timed out after ${timeoutMs}ms waiting for ${condition.label}. The page may not have loaded it, or the wording may differ — take a browser_snapshot to see the current state.`,
    )
  }
  await waitForPageSettled(EXPLICIT_WAIT_SETTLE)
  if (ms > 0) await sleep(ms)
  return withPageDelta(`Condition met: ${condition.label}.`, ctx)
}

/** Default and maximum budget for a condition wait, in milliseconds. */
const DEFAULT_CONDITION_WAIT_MS = 10_000
const MAX_CONDITION_WAIT_MS = 60_000
/** How often a pending condition is re-evaluated. */
const CONDITION_POLL_MS = 100

/** The condition a `browser_wait` call is blocking on, if any. */
function waitCondition(args: Record<string, unknown>): { test: () => boolean; label: string } | undefined {
  const gone = args.gone === true
  const selector = typeof args.selector === 'string' && args.selector !== '' ? args.selector : undefined
  const text = typeof args.text === 'string' && args.text !== '' ? args.text : undefined
  if (selector === undefined && text === undefined) return undefined
  if (selector !== undefined) {
    try {
      document.querySelector(selector)
    } catch {
      throw new ActionError('bad-args', `selector is not a valid CSS selector: ${selector}`)
    }
  }
  const wanted = text?.replace(/\s+/g, ' ').trim().toLowerCase()
  const present = (): boolean => {
    if (selector !== undefined && document.querySelector(selector) === null) return false
    if (wanted !== undefined) {
      const scope = selector === undefined ? document.body : document.querySelector(selector)
      if (scope === null) return false
      const source = scope instanceof HTMLElement && typeof scope.innerText === 'string' ? scope.innerText : scope.textContent ?? ''
      if (!source.replace(/\s+/g, ' ').toLowerCase().includes(wanted)) return false
    }
    return true
  }
  const description = [
    selector === undefined ? undefined : `selector "${selector}"`,
    text === undefined ? undefined : `text "${text}"`,
  ].filter((value) => value !== undefined).join(' with ')
  return {
    test: gone ? () => !present() : present,
    label: `${description} to ${gone ? 'disappear' : 'appear'}`,
  }
}

/** Poll a predicate until it holds or the budget runs out. */
function waitForCondition(test: () => boolean, timeoutMs: number): Promise<boolean> {
  if (test()) return Promise.resolve(true)
  const startedAt = performance.now()
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      let held = false
      try {
        held = test()
      } catch {
        // A predicate that throws on a mid-teardown DOM is not a failed wait.
      }
      if (held || performance.now() - startedAt >= timeoutMs) {
        clearInterval(timer)
        resolve(held)
      }
    }, CONDITION_POLL_MS)
  })
}

function findAction(args: Record<string, unknown>, ctx: ActionContext): ActionResult {
  const query = {
    ...(typeof args.text === 'string' ? { text: args.text } : {}),
    ...(typeof args.selector === 'string' ? { selector: args.selector } : {}),
    ...(typeof args.role === 'string' ? { role: args.role } : {}),
    ...(typeof args.interactiveOnly === 'boolean' ? { interactiveOnly: args.interactiveOnly } : {}),
    ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
  }
  try {
    const result = findElements(ctx.ids, query)
    return { text: truncate(renderFindResult(result, query), ctx.budget.maxChars).text }
  } catch (error: unknown) {
    if (error instanceof FindError) throw new ActionError('bad-args', error.message)
    throw error
  }
}

async function selectOptionAction(args: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  const wanted = (Array.isArray(args.values) ? args.values : []).filter((value): value is string => typeof value === 'string')
  if (wanted.length === 0) throw new ActionError('bad-args', 'values must contain at least one option label or value.')
  const target = targetElement(ctx, args)
  const el = target.element
  const index = target.label
  if (!(el instanceof HTMLSelectElement)) {
    throw new ActionError('action-failed', `Element ${index} is a ${el.tagName.toLowerCase()}, not a select.`)
  }
  if (el.disabled) throw new ActionError('action-failed', `Select ${index} is disabled.`)
  if (!el.multiple && wanted.length > 1) {
    throw new ActionError('bad-args', `Select ${index} accepts one option, but ${wanted.length} were given.`)
  }
  const options = [...el.options]
  const chosen: HTMLOptionElement[] = []
  for (const value of wanted) {
    const option = matchOption(options, value)
    if (option === undefined) {
      const available = options.slice(0, 20).map((candidate) => `"${optionLabel(candidate)}"`).join(', ')
      throw new ActionError('action-failed', `Select ${index} has no option matching "${value}". Available: ${available}${options.length > 20 ? ', …' : ''}`)
    }
    chosen.push(option)
  }
  if (!el.multiple) el.selectedIndex = -1
  else for (const option of options) option.selected = false
  for (const option of chosen) option.selected = true
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  await waitForPageSettled(ACTION_SETTLE)
  return withPageDelta(`Selected ${chosen.map((option) => `"${optionLabel(option)}"`).join(', ')} in ${index}${recoveryNote(target)}.`, ctx)
}

function optionLabel(option: HTMLOptionElement): string {
  const label = option.label !== '' ? option.label : option.textContent ?? ''
  return label.replace(/\s+/g, ' ').trim()
}

/** Match an option by exact value, exact label, then a label substring. */
function matchOption(options: HTMLOptionElement[], wanted: string): HTMLOptionElement | undefined {
  const needle = wanted.replace(/\s+/g, ' ').trim().toLowerCase()
  return options.find((option) => option.value === wanted)
    ?? options.find((option) => optionLabel(option).toLowerCase() === needle)
    ?? options.find((option) => option.value.toLowerCase() === needle)
    ?? options.find((option) => optionLabel(option).toLowerCase().includes(needle))
}

async function hoverAction(args: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  const target = targetElement(ctx, args)
  const el = target.element
  const index = target.label
  el.scrollIntoView({ block: 'center', behavior: 'instant' })
  const rect = el.getBoundingClientRect()
  const point = { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }
  // Menus open on pointer events, tooltips on mouse events, and some widgets
  // only react to the move that follows the enter — so all three are sent.
  dispatchPointerLike(el, 'pointerover', point, true)
  dispatchPointerLike(el, 'pointerenter', point, false)
  dispatchPointerLike(el, 'mouseover', point, true)
  dispatchPointerLike(el, 'mouseenter', point, false)
  dispatchPointerLike(el, 'pointermove', point, true)
  dispatchPointerLike(el, 'mousemove', point, true)
  await waitForPageSettled(ACTION_SETTLE)
  return withPageDelta(`Hovered ${index}${recoveryNote(target)}.`, ctx)
}

/** Dispatch a pointer/mouse event, falling back where PointerEvent is unavailable. */
function dispatchPointerLike(
  el: Element,
  type: string,
  point: { clientX: number; clientY: number },
  bubbles: boolean,
): void {
  // `view` is deliberately omitted: nothing reading a hover needs it, and
  // passing a window across realms is what breaks in non-browser hosts.
  const init = { ...point, bubbles, cancelable: true, composed: true }
  const pointer = type.startsWith('pointer')
  if (pointer && typeof PointerEvent === 'function') {
    el.dispatchEvent(new PointerEvent(type, { ...init, pointerType: 'mouse', isPrimary: true }))
    return
  }
  if (pointer) return
  el.dispatchEvent(new MouseEvent(type, init))
}

function numberArg(args: Record<string, unknown>, name: string): number {
  const value = args[name]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ActionError('bad-args', `${name} must be a non-negative integer; received ${String(value)}.`)
  }
  return value
}

/**
 * Hard cap on one batch, independent of the plugin's advertised limit: the
 * batch holds the page for its whole duration, so its cost must be bounded
 * here rather than by whatever the caller claims.
 */
const MAX_BATCH_STEPS = 12

/** Steps a batch may contain, mapped to the single-action implementations. */
const BATCH_ACTIONS: Record<string, string> = {
  click: 'browser_click',
  type: 'browser_type',
  press: 'browser_press',
  hover: 'browser_hover',
  select: 'browser_select_option',
  scroll: 'browser_scroll',
  wait: 'browser_wait',
}

/**
 * Run a sequence of steps in one round trip.
 *
 * The whole point is latency: each step alone costs a message hop plus a
 * settle, and a three-step form fill spends most of its time in transit. The
 * sequence stops at a navigating step because the document that the remaining
 * steps' indices refer to is being replaced.
 */
async function actAction(args: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  const steps = Array.isArray(args.steps) ? args.steps : undefined
  if (steps === undefined || steps.length === 0) {
    throw new ActionError('bad-args', 'steps must be a non-empty array of actions.')
  }
  if (steps.length > MAX_BATCH_STEPS) {
    throw new ActionError('bad-args', `steps may contain at most ${MAX_BATCH_STEPS} entries; received ${steps.length}. Split the flow into several browser_act calls.`)
  }
  const continueOnError = args.continueOnError === true
  // Inner steps skip their own delta: one delta for the whole batch is both
  // cheaper and easier to read than one per step.
  const stepCtx: ActionContext = { ...ctx, includePageDelta: false }
  const lines: string[] = []
  let navigationPending = false

  for (const [position, raw] of steps.entries()) {
    const step = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {}
    const name = typeof step.action === 'string' ? step.action : ''
    const mapped = BATCH_ACTIONS[name]
    if (mapped === undefined) {
      const failure = `step ${position + 1} (${name === '' ? 'missing action' : name}): action must be one of ${Object.keys(BATCH_ACTIONS).join(', ')}.`
      if (!continueOnError) throw new ActionError('bad-args', failure)
      lines.push(`${position + 1}. ${failure}`)
      continue
    }
    try {
      const result = await runAction(mapped, stepArgs(step), stepCtx)
      lines.push(`${position + 1}. ${name}: ${result.text}`)
      if (result.navigationPending === true) {
        navigationPending = true
        const skipped = steps.length - position - 1
        if (skipped > 0) lines.push(`(Navigation started, so the remaining ${skipped} step(s) were skipped.)`)
        break
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      lines.push(`${position + 1}. ${name}: FAILED — ${message}`)
      if (!continueOnError) {
        const skipped = steps.length - position - 1
        if (skipped > 0) lines.push(`(Stopped after the failure; ${skipped} later step(s) were skipped.)`)
        break
      }
    }
  }

  const summary = lines.join('\n')
  if (navigationPending) return { text: summary, navigationPending: true }
  return withPageDelta(summary, ctx)
}

/** Project one batch step onto the argument shape its single action expects. */
function stepArgs(step: Record<string, unknown>): Record<string, unknown> {
  const { action: _action, ...rest } = step
  return rest
}

function screenshotAction(args: Record<string, unknown>, ctx: ActionContext): ActionResult {
  const target = scrollTarget(args, ctx)
  const viewport = `${Math.round(window.innerWidth)}x${Math.round(window.innerHeight)}`
  if (target === undefined) {
    return { text: `Capturing the visible viewport (${viewport}) of ${location.href}.` }
  }
  target.element.scrollIntoView({ block: 'center', behavior: 'instant' })
  const box = elementViewportBox(target.element)
  if (box === undefined) {
    return {
      text: `Element ${target.label} has no visible box, or sits inside a cross-origin iframe whose position cannot be resolved. Capturing the visible viewport (${viewport}) instead.`,
    }
  }
  return {
    text: `Capturing ${target.label} (${Math.round(box.width)}x${Math.round(box.height)}) on ${location.href}.`,
    imageSources: [{ kind: 'box', box }],
  }
}

/**
 * Resolve one or more images on the page to their pixel sources.
 *
 * `indices` exists because a forum post is rarely one picture: reading five
 * images one call at a time costs five round trips to learn one thing.
 */
function readImageAction(args: Record<string, unknown>, ctx: ActionContext): ActionResult {
  const requested = Array.isArray(args.indices)
    ? args.indices.filter((value): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0)
    : []
  const queries: { index?: number; selector?: string; alt?: string }[] = requested.length > 0
    ? requested.map((index) => ({ index }))
    : [{
        ...(args.index === undefined ? {} : { index: numberArg(args, 'index') }),
        ...(typeof args.selector === 'string' ? { selector: args.selector } : {}),
        ...(typeof args.alt === 'string' ? { alt: args.alt } : {}),
      }]
  if (queries.length === 1 && queries[0]!.index === undefined
    && queries[0]!.selector === undefined && queries[0]!.alt === undefined) {
    throw new ActionError('bad-args', 'Provide index, indices, selector, or alt to identify the image(s).')
  }

  const sources: ImageSource[] = []
  const lines: string[] = []
  for (const query of queries) {
    let el: Element | undefined
    try {
      el = locateImageElement(ctx.ids, query)
    } catch (error: unknown) {
      if (error instanceof FindError) throw new ActionError('bad-args', error.message)
      throw error
    }
    const label = query.index !== undefined ? `[${query.index}]` : query.selector ?? query.alt ?? 'the image'
    if (el === undefined) {
      lines.push(`${label}: no image matched.`)
      continue
    }
    el.scrollIntoView({ block: 'center', behavior: 'instant' })
    const source = imageSourceFor(el)
    if (source === undefined) {
      lines.push(`${label}: no readable pixels (hidden or empty).`)
      continue
    }
    sources.push(source)
    const describe = source.kind === 'box'
      ? 'as rendered on the page (its own bytes were not reachable)'
      : `at ${source.width}x${source.height}`
    const extra = source.kind === 'url' && source.fallbacks !== undefined
      ? ` (using the full-size source; ${source.fallbacks.length} fallback(s) available)`
      : ''
    lines.push(`${label}: ${roleOf(el)}${source.name === undefined ? '' : ` "${source.name}"`} ${describe}${extra}.`)
  }
  if (sources.length === 0) {
    throw new ActionError(
      'action-failed',
      `${lines.join(' ')} Use browser_snapshot to list the page's images with their indices.`,
    )
  }
  return {
    text: [`Reading ${sources.length} image(s) from ${location.href}.`, ...lines].join('\n'),
    imageSources: sources,
  }
}

async function expandAction(args: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  const maxRounds = typeof args.maxRounds === 'number' && args.maxRounds > 0
    ? Math.min(Math.floor(args.maxRounds), 6)
    : DEFAULT_EXPAND_OPTIONS.maxRounds
  const result = await expandPage(
    { ...DEFAULT_EXPAND_OPTIONS, maxRounds, scroll: args.scroll !== false },
    () => waitForPageSettled(ACTION_SETTLE),
  )
  const text = renderExpandResult(result)
  if (result.navigated) return { text, navigationPending: true }
  return withPageDelta(text, ctx)
}

function harvestAction(args: Record<string, unknown>, ctx: ActionContext): ActionResult {
  const excludeHosts = Array.isArray(args.excludeHosts)
    ? args.excludeHosts.filter((value): value is string => typeof value === 'string')
    : []
  const links = harvestLinks({
    excludeHosts,
    ...(typeof args.selector === 'string' ? { selector: args.selector } : {}),
    ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
  })
  const heading = typeof args.heading === 'string' && args.heading !== ''
    ? args.heading
    : `${links.length} link(s) on ${location.href}:`
  return { text: truncate(renderLinks(links, heading), ctx.budget.maxChars).text }
}

function verificationAction(): ActionResult {
  const targets: VerificationTarget[] = verificationTargets()
  return {
    text: renderVerificationTargets(targets),
    verificationTargets: targets,
  }
}
