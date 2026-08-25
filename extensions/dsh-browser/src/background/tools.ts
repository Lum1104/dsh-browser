/**
 * Tool dispatch: executes `tool.call` frames in an explicitly selected tab via
 * the content script and answers with the text-only result.
 *
 * The background service owns tab-affinity policy. Direct callers may omit a
 * target for backward-compatible active-tab dispatch in isolated tests.
 *
 * @module
 */

import { DEFAULT_SNAPSHOT_MAX_CHARS } from '@yuxianglin/dsh-bridge-browser/src/protocol.ts'
import type { ImageResultCaps, ToolImagePayload, ToolError } from '@yuxianglin/dsh-bridge-browser/src/protocol.ts'
import {
  allocateFrameBudgets,
  frameDocumentKey,
  frameOrigin,
  listTabFrames,
  type TabFrame,
} from './frames.ts'
import { wrapUntrustedContent } from '../security/untrusted.ts'
import { approvalPromptForCall } from './authorization.ts'
import { waitForNextDocumentReady } from './navigation.ts'
import {
  blobFromDataUrl,
  clampBoxToImage,
  CaptureError,
  encodeBitmap,
  fetchImageBitmap,
  type CaptureBox,
} from './capture.ts'
import {
  captureElementShot,
  chromeElementShotDeps,
  shotScale,
  type ElementShotDeps,
} from './element-shot.ts'
import type { ApprovalAuthorization, ApprovalPrompt } from '../security/approval.ts'

/** A tool call from the bridge. */
export interface ToolCall {
  id: string
  name: string
  args: Record<string, unknown>
  /** Server-authored wall-clock deadline; absent only in direct unit tests. */
  expiresAt?: number
  /** Owning Agent session, when supplied by a current bridge. */
  sessionId?: string
}

/** The wire answer for one tool call. */
export interface ToolAnswer {
  ok: boolean
  result?: unknown
  error?: ToolError
}

/** Snapshot limits negotiated with the bridge and forwarded after lazy injection. */
export interface ContentBudget {
  maxItems: number
  maxChars: number
}

const CONTENT_SCRIPT_FILE = 'content.js'
const ACTION_DELTA_TOOLS = new Set([
  'browser_click',
  'browser_type',
  'browser_press',
  'browser_scroll',
  'browser_wait',
  'browser_hover',
  'browser_select_option',
  'browser_act',
])
const ACTION_DELTA_GUIDANCE = 'The page settled and its current changes are included below. Continue from this state; take another snapshot only when broader page context is needed.'
const NAVIGATION_CANDIDATE_TOOLS = new Set([
  'browser_click',
  'browser_navigate',
  'browser_back',
  'browser_forward',
  'browser_reload',
  'browser_act',
])
const NAVIGATION_SNAPSHOT_GUIDANCE = 'Navigation completed and the current page snapshot is included below. Use it directly instead of taking an immediate duplicate snapshot.'
/** Tools that hand back a valid element index, so they also refresh the baseline. */
const BASELINE_TOOLS = new Set(['browser_snapshot', 'browser_find'])
/** Tools addressing an element by index, which must belong to the snapshotted document. */
const ELEMENT_TARGET_TOOLS = new Set([
  'browser_click',
  'browser_type',
  'browser_select_option',
  'browser_hover',
  'browser_press',
  'browser_scroll',
  'browser_screenshot',
  'browser_read_image',
  'browser_act',
])
/** Tools whose result carries pixels. */
const CAPTURE_TOOLS = new Set(['browser_screenshot', 'browser_read_image'])
/** Everything that moves page content out of the page, text or pixels. */
const PAGE_CONTENT_TOOLS = new Set([
  'browser_snapshot',
  'browser_get_text',
  'browser_find',
  'browser_screenshot',
  'browser_read_image',
  // An evaluation's return value is page content in arbitrary form, so the
  // sharing-off boundary blocks it like any read.
  'browser_evaluate',
])
const pendingInjections = new Map<number, Promise<void>>()
const snapshotDocumentsByTab = new Map<number, Map<number, string>>()

/** Room the secure wrapper + a content-script continuation footer need before
 * a get_text window may fill the whole snapshot budget. */
const TEXT_WINDOW_WRAP_RESERVE = 1024

/** Forget delta/element state whenever the user explicitly follows a new tab. */
export function resetTabSnapshot(tabId: number): void {
  snapshotDocumentsByTab.delete(tabId)
}

function isToolAnswer(value: unknown): value is ToolAnswer {
  return typeof value === 'object'
    && value !== null
    && typeof (value as { ok?: unknown }).ok === 'boolean'
}

function isInjectablePage(url: string | undefined): boolean {
  return url !== undefined && /^https?:\/\//i.test(url)
}

/** Inject the packaged content script once per tab, coalescing concurrent recovery attempts. */
async function injectContentScript(tabId: number): Promise<void> {
  let pending = pendingInjections.get(tabId)
  if (pending === undefined) {
    pending = chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: [CONTENT_SCRIPT_FILE],
    }).then(() => undefined)
    pendingInjections.set(tabId, pending)
  }
  try {
    await pending
  } finally {
    if (pendingInjections.get(tabId) === pending) pendingInjections.delete(tabId)
  }
}

async function sendAction(
  tabId: number,
  call: ToolCall,
  frame: TabFrame,
  budget?: ContentBudget,
  includePageDelta: boolean = false,
): Promise<unknown> {
  return chrome.tabs.sendMessage(tabId, {
    type: 'DSH_ACTION',
    action: call.name,
    args: withoutFrame(call.args),
    ...budget === undefined ? {} : { budget },
    ...includePageDelta ? { includePageDelta: true } : {},
  }, frame.documentId === undefined ? { frameId: frame.frameId } : { documentId: frame.documentId })
}

function unavailable(message: string): ToolAnswer {
  return { ok: false, error: { code: 'content-unavailable', message } }
}

function cancelled(): ToolAnswer {
  return { ok: false, error: { code: 'bridge-closed', message: 'The browser tool call was cancelled.' } }
}

/** Preserve the factual approval outcome for the model without prescribing a response. */
export function approvalFailure(approval: ApprovalPrompt, authorization: Exclude<ApprovalAuthorization, 'approved'>): ToolAnswer {
  switch (authorization) {
    case 'denied':
      return {
        ok: false,
        error: { code: 'action-failed', message: `The user denied the browser approval request for "${approval.action}".` },
      }
    case 'unavailable':
      return {
        ok: false,
        error: {
          code: 'action-failed',
          message: `No browser side panel was available to receive or complete the approval request for "${approval.action}".`,
        },
      }
    case 'timed-out':
      return {
        ok: false,
        error: { code: 'timeout', message: `The browser approval request for "${approval.action}" timed out before the user responded.` },
      }
    case 'cancelled':
      return {
        ok: false,
        error: { code: 'bridge-closed', message: `The browser approval request for "${approval.action}" was cancelled.` },
      }
  }
}

function targetChanged(): ToolAnswer {
  return unavailable('The controlled tab changed during the operation. Confirm the page in the side panel before retrying.')
}

function isCancelled(call: ToolCall, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
    || (call.expiresAt !== undefined && Date.now() >= call.expiresAt)
}

function withoutFrame(args: Record<string, unknown>): Record<string, unknown> {
  const { frame: _frame, ...rest } = args
  return rest
}

function requestedFrame(args: Record<string, unknown>): number {
  const value = args.frame
  if (value === undefined) return 0
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return -1
  return value
}

function answerText(answer: ToolAnswer): string | undefined {
  if (!answer.ok || typeof answer.result !== 'object' || answer.result === null) return undefined
  const text = (answer.result as { text?: unknown }).text
  return typeof text === 'string' ? text : undefined
}

function answerPageContent(answer: ToolAnswer): string | undefined {
  if (!answer.ok || typeof answer.result !== 'object' || answer.result === null) return undefined
  const pageContent = (answer.result as { pageContent?: unknown }).pageContent
  return typeof pageContent === 'string' ? pageContent : undefined
}

function answerNavigationPending(answer: ToolAnswer): boolean {
  return answer.ok
    && typeof answer.result === 'object'
    && answer.result !== null
    && (answer.result as { navigationPending?: unknown }).navigationPending === true
}

/** The pixel sources the content script resolved, when the call asked for any. */
function answerImageSources(answer: ToolAnswer): ContentImageSource[] {
  if (!answer.ok || typeof answer.result !== 'object' || answer.result === null) return []
  const sources = (answer.result as { imageSources?: unknown }).imageSources
  if (!Array.isArray(sources)) return []
  return sources.filter((source): source is ContentImageSource => {
    if (typeof source !== 'object' || source === null) return false
    const kind = (source as { kind?: unknown }).kind
    return kind === 'url' || kind === 'data' || kind === 'box'
  })
}

/** Mirror of the content script's resolved pixel source. */
type ContentImageSource =
  | { kind: 'url'; url: string; width: number; height: number; name?: string; fallbacks?: string[]; box?: CaptureBox }
  | { kind: 'data'; dataUrl: string; width: number; height: number; name?: string }
  | { kind: 'box'; box: CaptureBox; name?: string }

/**
 * The tab a call runs against. Window and visibility are optional so a direct
 * caller (and the existing tests) can still name a tab by id and url alone;
 * only a capture needs the rest.
 */
export type ToolTargetTab = Pick<chrome.tabs.Tab, 'id' | 'url'> & Partial<Pick<chrome.tabs.Tab, 'windowId' | 'active'>>

/** The tab facts a capture needs beyond its id. */
export interface CaptureTarget {
  windowId?: number
  active?: boolean
}

/**
 * Turn resolved pixel sources into image payloads on the answer.
 *
 * A capture that cannot be produced degrades to its text status plus the
 * reason: the model asked to see something and must learn that it cannot,
 * without losing the turn to a tool failure it can do nothing about. With
 * several sources, the ones that worked are returned and the rest are explained
 * — a forum post with one dead image should still show the other four.
 *
 * @param target - window and visibility facts of the controlled tab.
 * @param text - the content script's status text.
 * @param sources - resolved sources; empty means capture the viewport.
 * @param caps - the host's negotiated image budget.
 * @param tabId - the controlled tab, enabling the full-resolution protocol capture.
 * @returns the answer, with `images` when pixels were obtained.
 */
export async function captureAnswer(
  target: CaptureTarget,
  text: string,
  sources: readonly ContentImageSource[],
  caps: ImageResultCaps,
  tabId?: number,
): Promise<ToolAnswer> {
  const requested = sources.length === 0 ? [undefined] : sources.slice(0, caps.maxPerCall)
  const images: ToolImagePayload[] = []
  const notes: string[] = []
  if (sources.length > requested.length) {
    notes.push(`Only the first ${requested.length} of ${sources.length} images were read; this deployment accepts ${caps.maxPerCall} per call.`)
  }
  for (const source of requested) {
    try {
      images.push(await captureImage(target, source, caps, tabId))
    } catch (error: unknown) {
      const reason = error instanceof CaptureError
        ? error.message
        : error instanceof Error ? error.message : String(error)
      notes.push(`${source?.name ?? 'One image'} could not be produced: ${reason}`)
    }
  }
  const suffix = notes.length === 0 ? '' : `\n${notes.join('\n')}`
  if (images.length === 0) return { ok: true, result: { text: `${text}${suffix}` } }
  return { ok: true, result: { text: `${text}${suffix}`, images } }
}

/**
 * Fetch a URL source, walking its fallbacks.
 *
 * For each candidate, cache first, then the network. An image host with hotlink
 * protection answers 404 to a service-worker fetch (no `Referer`), but the page
 * already loaded the same URL with the right headers — `force-cache` reads those
 * bytes without touching the network. Only when the cache has nothing do we try
 * a live fetch, which still helps for a full-size original the page never
 * requested. Cache-then-network is per URL so a cached thumbnail cannot beat a
 * still-untried original.
 *
 * The content script offers the full-size original first and the thumbnail
 * last, so a 403 or an oversized original still yields the picture instead of
 * an error the model can do nothing with.
 */
async function fetchWithFallbacks(source: { url: string; fallbacks?: string[] }, caps: ImageResultCaps): Promise<ImageBitmap> {
  const candidates = [source.url, ...(source.fallbacks ?? [])]
  let last: unknown
  for (const url of candidates) {
    for (const cache of ['force-cache', 'default'] as const) {
      try {
        return await fetchImageBitmap(url, caps.maxBytes, cache)
      } catch (error: unknown) {
        last = error
      }
    }
  }
  throw last instanceof Error ? last : new CaptureError('no candidate URL for this image could be read')
}

/**
 * Photograph one element region, preferring the protocol screenshot.
 *
 * `Page.captureScreenshot` re-rasterizes the clip at its own scale, so an image
 * displayed smaller than its natural size comes back near full resolution — the
 * answer for a host that refuses a service-worker fetch. It also reaches a
 * region scrolled out of view. Both properties are unavailable to
 * `captureVisibleTab`, which only ever returns the screen.
 *
 * It needs the optional debugger permission, which is never requested here: an
 * image read must not become a permission prompt. Without it (or on any protocol
 * failure) this falls back to cropping the viewport capture, which is what the
 * user can see and therefore always defensible.
 *
 * @param tabId - the controlled tab, when known; absent forces the viewport path.
 * @param natural - the source's own pixel size, used to choose the scale.
 */
async function captureFromBox(
  target: CaptureTarget,
  box: CaptureBox,
  name: string | undefined,
  caps: ImageResultCaps,
  tabId?: number,
  natural?: { width: number; height: number },
  deps: ElementShotDeps = chromeElementShotDeps(),
): Promise<ToolImagePayload> {
  if (tabId !== undefined && box.pageX !== undefined && box.pageY !== undefined) {
    try {
      const dataUrl = await captureElementShot(tabId, {
        x: box.pageX,
        y: box.pageY,
        width: box.width,
        height: box.height,
        scale: shotScale(box, natural, caps),
      }, deps)
      return encodeBitmap(await createImageBitmap(await blobFromDataUrl(dataUrl)), caps, undefined, name)
    } catch {
      // Fall through to the viewport crop: no permission, DevTools open, or a
      // protocol refusal all mean the same thing here.
    }
  }
  const viewport = await captureViewport(target)
  const crop = clampBoxToImage(box, viewport.width, viewport.height)
  if (crop === undefined) {
    throw new CaptureError('the element is scrolled outside the visible viewport; scroll to it and capture again')
  }
  return encodeBitmap(viewport, caps, crop, name)
}

async function captureImage(
  target: CaptureTarget,
  source: ContentImageSource | undefined,
  caps: ImageResultCaps,
  tabId?: number,
): Promise<ToolImagePayload> {
  if (source?.kind === 'url') {
    const natural = source.width > 0 && source.height > 0
      ? { width: source.width, height: source.height }
      : undefined
    try {
      return encodeBitmap(await fetchWithFallbacks(source, caps), caps, undefined, source.name)
    } catch (error: unknown) {
      if (source.box === undefined) throw error
      // The picture is already on screen. Re-rasterizing it needs no Referer,
      // cookies, or CORS — which is exactly what the host just refused.
      return captureFromBox(target, source.box, source.name, caps, tabId, natural)
    }
  }
  if (source?.kind === 'data') {
    let bitmap: ImageBitmap
    try {
      bitmap = await createImageBitmap(await blobFromDataUrl(source.dataUrl))
    } catch {
      throw new CaptureError('the rendered image data could not be decoded')
    }
    return encodeBitmap(bitmap, caps, undefined, source.name)
  }
  if (source === undefined) return encodeBitmap(await captureViewport(target), caps)
  return captureFromBox(target, source.box, source.name, caps, tabId)
}

/** Capture the visible tab of the controlled window and decode it. */
async function captureViewport(target: CaptureTarget): Promise<ImageBitmap> {
  if (target.active === false) {
    throw new CaptureError(
      'the controlled page is a background tab, and only a visible tab can be captured; bring it forward with browser_tabs (action "switch", activate true) or ask the user to focus it',
    )
  }
  let dataUrl: string
  try {
    dataUrl = target.windowId === undefined
      ? await chrome.tabs.captureVisibleTab({ format: 'png' })
      : await chrome.tabs.captureVisibleTab(target.windowId, { format: 'png' })
  } catch (error: unknown) {
    throw new CaptureError(`the tab could not be captured: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
    throw new CaptureError('the tab capture returned no image data')
  }
  try {
    return await createImageBitmap(await blobFromDataUrl(dataUrl))
  } catch {
    throw new CaptureError('the tab capture could not be decoded')
  }
}

/** Keep extension-authored action status outside the nonce-bound page-data boundary. */
function wrapActionDelta(status: string, pageContent: string, frame: TabFrame, maxChars: number): string {
  const prefix = `${status}\n${ACTION_DELTA_GUIDANCE}`
  const separator = '\n\n'
  const boundaryBudget = maxChars - prefix.length - separator.length
  if (boundaryBudget < 500) return prefix.slice(0, maxChars)
  const framedContent = frame.frameId === 0 ? pageContent : `${frameHeader(frame)}\n${pageContent}`
  return `${prefix}${separator}${wrapUntrustedContent(framedContent, boundaryBudget)}`
}

async function snapshotAllFrames(
  tabId: number,
  frames: TabFrame[],
  call: ToolCall,
  budget: ContentBudget,
): Promise<ToolAnswer> {
  const budgets = allocateFrameBudgets(frames, budget)
  const previous = snapshotDocumentsByTab.get(tabId) ?? new Map<number, string>()
  const deltaRequested = call.args.delta === true

  const settled = await Promise.allSettled(frames.map(async (frame) => {
    const sameDocument = previous.get(frame.frameId) === frameDocumentKey(frame)
    const frameCall: ToolCall = {
      ...call,
      args: deltaRequested && sameDocument ? call.args : { ...call.args, delta: false },
    }
    const response = await sendAction(tabId, frameCall, frame, budgets.get(frame.frameId))
    return { frame, response }
  }))

  const sections: string[] = []
  const capturedDocuments = new Map<number, string>()
  for (let index = 0; index < settled.length; index += 1) {
    const outcome = settled[index]!
    const frame = frames[index]!
    if (outcome.status === 'rejected') {
      if (frame.frameId === 0) throw outcome.reason
      sections.push(frameHeader(frame), '(This iframe was inaccessible or destroyed while loading.)')
      continue
    }
    const answer = outcome.value.response
    if (!isToolAnswer(answer)) {
      if (frame.frameId === 0) return unavailable('The page content script returned an invalid response.')
      sections.push(frameHeader(frame), '(This iframe returned an invalid response.)')
      continue
    }
    const text = answerText(answer)
    if (text === undefined) {
      if (frame.frameId === 0) return answer
      sections.push(frameHeader(frame), `(This iframe could not be read: ${answer.error?.message ?? 'unknown error'})`)
      continue
    }
    capturedDocuments.set(frame.frameId, frameDocumentKey(frame))
    if (frame.frameId === 0) sections.push(text)
    else sections.push(frameHeader(frame), text)
  }

  if (deltaRequested) {
    const liveIds = new Set(frames.map((frame) => frame.frameId))
    const removed = [...previous.keys()].filter((frameId) => frameId !== 0 && !liveIds.has(frameId))
    if (removed.length > 0) sections.push(`\nRemoved iframes: ${removed.join(', ')}`)
  }

  snapshotDocumentsByTab.set(tabId, capturedDocuments)
  return { ok: true, result: { text: wrapUntrustedContent(sections.join('\n'), budget.maxChars) } }
}

function frameHeader(frame: TabFrame): string {
  return `\n--- iframe frame=${frame.frameId} parent=${frame.parentFrameId} origin=${frameOrigin(frame)} ---`
}

function stripDuplicateSnapshotPrompt(status: string): string {
  return status.replace(/ Call browser_snapshot again after (?:navigation settles|the page loads|it loads)\.$/, '')
}

async function snapshotAfterNavigation(
  tabId: number,
  call: ToolCall,
  status: string,
  budget: ContentBudget,
  targetStillAllowed?: () => boolean,
): Promise<ToolAnswer | undefined> {
  const prefix = `${stripDuplicateSnapshotPrompt(status)}\n${NAVIGATION_SNAPSHOT_GUIDANCE}`
  const snapshotMaxChars = budget.maxChars - prefix.length - 2
  if (snapshotMaxChars < 500) return undefined
  const frames = await listTabFrames(tabId, undefined)
  if (targetStillAllowed?.() === false) return targetChanged()
  const answer = await snapshotAllFrames(
    tabId,
    frames,
    { ...call, name: 'browser_snapshot', args: {} },
    { ...budget, maxChars: snapshotMaxChars },
  )
  const snapshot = answerText(answer)
  if (snapshot === undefined) return undefined
  return { ok: true, result: { text: `${prefix}\n\n${snapshot}` } }
}

async function dispatchOnce(
  tabId: number,
  frames: TabFrame[],
  call: ToolCall,
  budget: ContentBudget,
  signal?: AbortSignal,
  targetStillAllowed?: () => boolean,
  includeActionDelta: boolean = false,
  capture?: { target: CaptureTarget; caps: ImageResultCaps },
): Promise<ToolAnswer> {
  if (isCancelled(call, signal)) return cancelled()
  if (targetStillAllowed?.() === false) return targetChanged()
  if (call.name === 'browser_snapshot') return snapshotAllFrames(tabId, frames, call, budget)

  const frameId = requestedFrame(call.args)
  if (frameId < 0) return { ok: false, error: { code: 'action-failed', message: 'frame must be a non-negative integer.' } }
  const frame = frames.find((candidate) => candidate.frameId === frameId)
  if (frame === undefined) {
    return unavailable(`Frame ${frameId} does not exist or has navigated. Call browser_snapshot again.`)
  }
  // No await occurs between this guard and tabs.sendMessage, so an expired
  // approval cannot cross the final state-changing dispatch boundary.
  if (isCancelled(call, signal)) return cancelled()
  if (targetStillAllowed?.() === false) return targetChanged()
  const hasSnapshotBaseline = snapshotDocumentsByTab.get(tabId)?.get(frameId) === frameDocumentKey(frame)
  const requestPageDelta = includeActionDelta && hasSnapshotBaseline && ACTION_DELTA_TOOLS.has(call.name)
  const navigationWait = includeActionDelta && NAVIGATION_CANDIDATE_TOOLS.has(call.name)
    ? waitForNextDocumentReady(tabId, frameId, frame.documentId, signal)
    : undefined
  let response: unknown
  try {
    response = await sendAction(
      tabId,
      call,
      frame,
      requestPageDelta ? budget : undefined,
      requestPageDelta,
    )
  } catch (error: unknown) {
    navigationWait?.cancel()
    throw error
  }
  if (isCancelled(call, signal)) {
    navigationWait?.cancel()
    return cancelled()
  }
  if (!isToolAnswer(response)) {
    navigationWait?.cancel()
    return unavailable('The page content script returned an invalid response.')
  }
  const text = answerText(response)
  if (text === undefined) {
    navigationWait?.cancel()
    return response
  }
  // A lookup hands back element indices, so it also establishes the baseline
  // that authorizes a later click or type against this document.
  if (BASELINE_TOOLS.has(call.name)) {
    const documents = snapshotDocumentsByTab.get(tabId) ?? new Map<number, string>()
    documents.set(frameId, frameDocumentKey(frame))
    snapshotDocumentsByTab.set(tabId, documents)
  }
  if (CAPTURE_TOOLS.has(call.name)) {
    navigationWait?.cancel()
    if (capture === undefined) {
      return { ok: true, result: { text: `${text}\nThe image could not be produced: this dsh deployment does not accept image results.` } }
    }
    if (isCancelled(call, signal)) return cancelled()
    if (targetStillAllowed?.() === false) return targetChanged()
    return captureAnswer(capture.target, text, answerImageSources(response), capture.caps, tabId)
  }
  if (answerNavigationPending(response) && navigationWait !== undefined) {
    const ready = await navigationWait.ready
    if (isCancelled(call, signal)) return cancelled()
    if (targetStillAllowed?.() === false) return targetChanged()
    if (ready) {
      try {
        const snapshot = await snapshotAfterNavigation(tabId, call, text, budget, targetStillAllowed)
        if (snapshot !== undefined) return snapshot
      } catch {
        // Preserve the successful navigation status when the replacement page
        // becomes unavailable before its opportunistic snapshot completes.
      }
    }
  } else {
    navigationWait?.cancel()
  }
  if (call.name === 'browser_get_text') {
    return { ok: true, result: { text: wrapUntrustedContent(text, budget.maxChars) } }
  }
  if (call.name === 'browser_find') {
    // Find results carry page-controlled accessible names, context and URLs —
    // the same untrusted-data boundary as snapshots and get_text.
    return { ok: true, result: { text: wrapUntrustedContent(text, budget.maxChars) } }
  }
  const pageContent = requestPageDelta ? answerPageContent(response) : undefined
  return {
    ok: true,
    result: {
      text: pageContent === undefined ? text : wrapActionDelta(text, pageContent, frame, budget.maxChars),
    },
  }
}

/**
 * Dispatch one tool call to the selected tab's content script.
 * @param call - the tool call to execute.
 * @param sharePageContent - the user's page-sharing preference ('off' blocks
 *   every page-content read).
 * @param budget - snapshot limits to restore after on-demand content-script injection.
 * @param signal - bridge lifetime; cancellation prevents any not-yet-sent page action.
 * @param targetTab - tab selected by the background affinity controller.
 * @param targetStillAllowed - final fail-closed guard after asynchronous approval/navigation checks.
 * @returns the content script's answer, or a stable error when no tab or
 *   content script is available.
 */
export async function dispatchToolCall(
  call: ToolCall,
  sharePageContent: 'ask' | 'auto' | 'off',
  budget?: ContentBudget,
  authorize?: (prompt: ApprovalPrompt) => Promise<ApprovalAuthorization>,
  signal?: AbortSignal,
  targetTab?: ToolTargetTab,
  targetStillAllowed?: () => boolean,
  imageCaps?: ImageResultCaps,
): Promise<ToolAnswer> {
  if (isCancelled(call, signal)) return cancelled()
  // Privacy boundary: with sharing off, no page content may leave the page —
  // and a capture is page content in its most complete form.
  if (sharePageContent === 'off' && PAGE_CONTENT_TOOLS.has(call.name)) {
    return { ok: false, error: { code: 'action-failed', message: 'Page content sharing is disabled in Settings > Page content sharing.' } }
  }
  const tab = targetTab ?? (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]
  if (isCancelled(call, signal)) return cancelled()
  if (tab?.id === undefined) {
    return { ok: false, error: { code: 'no-active-tab', message: 'No active tab is available for browser operations.' } }
  }
  if (targetStillAllowed?.() === false) return targetChanged()
  const effectiveBudget = budget ?? { maxItems: 60, maxChars: DEFAULT_SNAPSHOT_MAX_CHARS }
  // The trust wrapper truncates get_text results to the snapshot budget and
  // would cut the content script's own window footer off (losing the exact
  // continuation offset). A request for a larger window is clamped with room
  // reserved for the wrapper's nonce/notice overhead and the footer itself, so
  // the footer's total and paging stay intact.
  if (call.name === 'browser_get_text') {
    const requested = (call.args as { limit?: unknown }).limit
    const wrapped = Math.max(0, effectiveBudget.maxChars - TEXT_WINDOW_WRAP_RESERVE)
    if (typeof requested === 'number' && requested > wrapped) {
      call = { ...call, args: { ...(call.args ?? {}), limit: wrapped } }
    }
  }
  const capture = CAPTURE_TOOLS.has(call.name) && imageCaps !== undefined
    ? {
        caps: imageCaps,
        target: {
          ...(tab.windowId === undefined ? {} : { windowId: tab.windowId }),
          ...(tab.active === undefined ? {} : { active: tab.active }),
        },
      }
    : undefined
  const frames = await listTabFrames(tab.id, tab.url)
  if (isCancelled(call, signal)) return cancelled()
  if (targetStillAllowed?.() === false) return targetChanged()
  const frameError = validateFrameTarget(call, frames)
  if (frameError !== undefined) return frameError
  const targetError = validateElementTarget(call, tab.id, frames)
  if (targetError !== undefined) return targetError
  const approval = approvalPromptForCall(call, sharePageContent, frames)
  if (approval !== undefined) {
    const authorization = authorize === undefined ? 'unavailable' : await authorize(approval)
    if (isCancelled(call, signal)) return cancelled()
    if (targetStillAllowed?.() === false) return targetChanged()
    if (authorization !== 'approved') {
      return approvalFailure(approval, authorization)
    }
  }
  let executionFrames = frames
  if (approval !== undefined) {
    executionFrames = await listTabFrames(tab.id, tab.url)
    if (isCancelled(call, signal)) return cancelled()
    if (targetStillAllowed?.() === false) return targetChanged()
    const refreshedApproval = approvalPromptForCall(call, sharePageContent, executionFrames)
    if (refreshedApproval === undefined
      || !sameApprovalBoundary(approval, refreshedApproval)
      || (approval.kind === 'action' && !sameTargetDocument(call, frames, executionFrames))) {
      return unavailable('The page changed while approval was pending. Call browser_snapshot again before retrying.')
    }
    const refreshedTargetError = validateElementTarget(call, tab.id, executionFrames)
    if (refreshedTargetError !== undefined) return refreshedTargetError
  }
  try {
    return await dispatchOnce(
      tab.id,
      executionFrames,
      call,
      effectiveBudget,
      signal,
      targetStillAllowed,
      sharePageContent === 'auto',
      capture,
    )
  } catch {
    if (isCancelled(call, signal)) return cancelled()
    // Manifest content scripts do not run retroactively in tabs that were
    // already open when an unpacked extension was installed or reloaded.
    // Recover in place so the user never has to refresh and lose page state.
    if (!isInjectablePage(tab.url)) {
      return unavailable('The current page does not support browser operations. Switch to a standard http or https page.')
    }
    try {
      await injectContentScript(tab.id)
      if (isCancelled(call, signal)) return cancelled()
      if (targetStillAllowed?.() === false) return targetChanged()
      const refreshedFrames = await listTabFrames(tab.id, tab.url)
      if (isCancelled(call, signal)) return cancelled()
      if (targetStillAllowed?.() === false) return targetChanged()
      const refreshedTargetError = validateElementTarget(call, tab.id, refreshedFrames)
      if (refreshedTargetError !== undefined) return refreshedTargetError
      if (approval !== undefined) {
        const refreshedApproval = approvalPromptForCall(call, sharePageContent, refreshedFrames)
        if (refreshedApproval === undefined
          || !sameApprovalBoundary(approval, refreshedApproval)
          || (approval.kind === 'action' && !sameTargetDocument(call, executionFrames, refreshedFrames))) {
          return unavailable('The page changed while the content script was loading. Call browser_snapshot again before retrying.')
        }
      }
      return await dispatchOnce(
        tab.id,
        refreshedFrames,
        call,
        effectiveBudget,
        signal,
        targetStillAllowed,
        sharePageContent === 'auto',
        capture,
      )
    } catch {
      return unavailable('The content script could not be loaded on this page. Chrome internal and protected pages do not support browser operations.')
    }
  }
}

function validateFrameTarget(call: ToolCall, frames: TabFrame[]): ToolAnswer | undefined {
  if (call.name === 'browser_snapshot') return undefined
  const frameId = requestedFrame(call.args)
  if (frameId < 0) return { ok: false, error: { code: 'action-failed', message: 'frame must be a non-negative integer.' } }
  if (!frames.some((frame) => frame.frameId === frameId)) {
    return unavailable(`Frame ${frameId} does not exist or has navigated. Call browser_snapshot again.`)
  }
  return undefined
}

function validateElementTarget(call: ToolCall, tabId: number, frames: TabFrame[]): ToolAnswer | undefined {
  if (!ELEMENT_TARGET_TOOLS.has(call.name)) return undefined
  // Only a call that actually names an index depends on the baseline: a
  // viewport screenshot or a selector-addressed capture does not.
  if (!callTargetsIndex(call)) return undefined
  const frameId = requestedFrame(call.args)
  const frame = frames.find((candidate) => candidate.frameId === frameId)
  const snapshotted = snapshotDocumentsByTab.get(tabId)?.get(frameId)
  if (frame === undefined || snapshotted === undefined || snapshotted !== frameDocumentKey(frame)) {
    return unavailable('The element reference does not belong to the current document. Call browser_snapshot or browser_find again for current frame and index values.')
  }
  return undefined
}

/**
 * Whether this call depends on the inventory numbering being current.
 *
 * A call that also carries a selector does not: the selector is evaluated
 * against the live document, so a stale index costs it nothing and blocking it
 * on a missing baseline would defeat the fallback. Only a bare index needs the
 * document to be the one that was inventoried.
 */
function callTargetsIndex(call: ToolCall): boolean {
  const hasSelector = typeof call.args.selector === 'string' && call.args.selector !== ''
  if (typeof call.args.index === 'number') return !hasSelector
  if (call.name !== 'browser_act') return false
  const steps = call.args.steps
  return Array.isArray(steps) && steps.some((step) => {
    if (typeof step !== 'object' || step === null) return false
    const entry = step as { index?: unknown; selector?: unknown }
    if (typeof entry.index !== 'number') return false
    return !(typeof entry.selector === 'string' && entry.selector !== '')
  })
}

function sameApprovalBoundary(before: ApprovalPrompt, after: ApprovalPrompt): boolean {
  return before.kind === after.kind
    && before.action === after.action
    && before.origins.length === after.origins.length
    && before.origins.every((origin, index) => origin === after.origins[index])
}

function sameTargetDocument(call: ToolCall, before: TabFrame[], after: TabFrame[]): boolean {
  const frameId = requestedFrame(call.args)
  const beforeFrame = before.find((frame) => frame.frameId === frameId)
  const afterFrame = after.find((frame) => frame.frameId === frameId)
  return beforeFrame !== undefined
    && afterFrame !== undefined
    && frameDocumentKey(beforeFrame) === frameDocumentKey(afterFrame)
}
