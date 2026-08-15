/**
 * Tool dispatch: executes `tool.call` frames in the user's active tab via the
 * content script and answers with the text-only result.
 *
 * Only the active, last-focused window's tab is ever targeted — the bridge
 * never switches tabs or acts in the background.
 *
 * @module
 */

import type { ToolError } from '@deepseek-ai/dsh-bridge-browser/src/protocol.ts'
import {
  allocateFrameBudgets,
  frameDocumentKey,
  frameOrigin,
  listTabFrames,
  type TabFrame,
} from './frames.ts'
import { wrapUntrustedContent } from './untrusted.ts'
import { approvalPromptForCall } from './authorization.ts'
import type { ApprovalPrompt } from '../security/approval.ts'

/** A tool call from the bridge. */
export interface ToolCall {
  id: string
  name: string
  args: Record<string, unknown>
  /** Server-authored wall-clock deadline; absent only in direct unit tests. */
  expiresAt?: number
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
const pendingInjections = new Map<number, Promise<void>>()
const snapshotDocumentsByTab = new Map<number, Map<number, string>>()

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

async function sendAction(tabId: number, call: ToolCall, frame: TabFrame, budget?: ContentBudget): Promise<unknown> {
  return chrome.tabs.sendMessage(tabId, {
    type: 'DSH_ACTION',
    action: call.name,
    args: withoutFrame(call.args),
    ...budget === undefined ? {} : { budget },
  }, frame.documentId === undefined ? { frameId: frame.frameId } : { documentId: frame.documentId })
}

function unavailable(message: string): ToolAnswer {
  return { ok: false, error: { code: 'content-unavailable', message } }
}

function cancelled(): ToolAnswer {
  return { ok: false, error: { code: 'bridge-closed', message: '浏览器工具调用已取消' } }
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
      sections.push(frameHeader(frame), '(该 iframe 无法访问或已在加载期间销毁)')
      continue
    }
    const answer = outcome.value.response
    if (!isToolAnswer(answer)) {
      if (frame.frameId === 0) return unavailable('页面内容脚本返回了无效响应')
      sections.push(frameHeader(frame), '(该 iframe 返回了无效响应)')
      continue
    }
    const text = answerText(answer)
    if (text === undefined) {
      if (frame.frameId === 0) return answer
      sections.push(frameHeader(frame), `(该 iframe 读取失败：${answer.error?.message ?? '未知错误'})`)
      continue
    }
    capturedDocuments.set(frame.frameId, frameDocumentKey(frame))
    if (frame.frameId === 0) sections.push(text)
    else sections.push(frameHeader(frame), text)
  }

  if (deltaRequested) {
    const liveIds = new Set(frames.map((frame) => frame.frameId))
    const removed = [...previous.keys()].filter((frameId) => frameId !== 0 && !liveIds.has(frameId))
    if (removed.length > 0) sections.push(`\n消失的 iframe: ${removed.join(', ')}`)
  }

  snapshotDocumentsByTab.set(tabId, capturedDocuments)
  return { ok: true, result: { text: wrapUntrustedContent(sections.join('\n'), budget.maxChars) } }
}

function frameHeader(frame: TabFrame): string {
  return `\n--- iframe frame=${frame.frameId} parent=${frame.parentFrameId} origin=${frameOrigin(frame)} ---`
}

async function dispatchOnce(
  tabId: number,
  frames: TabFrame[],
  call: ToolCall,
  budget: ContentBudget,
  signal?: AbortSignal,
): Promise<ToolAnswer> {
  if (isCancelled(call, signal)) return cancelled()
  if (call.name === 'browser_snapshot') return snapshotAllFrames(tabId, frames, call, budget)

  const frameId = requestedFrame(call.args)
  if (frameId < 0) return { ok: false, error: { code: 'action-failed', message: 'frame 必须是非负整数' } }
  const frame = frames.find((candidate) => candidate.frameId === frameId)
  if (frame === undefined) {
    return unavailable(`frame ${frameId} 不存在或已经导航，请重新 browser_snapshot`)
  }
  // No await occurs between this guard and tabs.sendMessage, so an expired
  // approval cannot cross the final state-changing dispatch boundary.
  if (isCancelled(call, signal)) return cancelled()
  const response = await sendAction(tabId, call, frame, budget)
  if (isCancelled(call, signal)) return cancelled()
  if (!isToolAnswer(response)) return unavailable('页面内容脚本返回了无效响应')
  if (call.name !== 'browser_get_text') return response
  const text = answerText(response)
  return text === undefined
    ? response
    : { ok: true, result: { text: wrapUntrustedContent(text, budget.maxChars) } }
}

/**
 * Open a navigation URL in a new tab or a new window instead of steering the
 * user's active tab. The active page is left untouched; the freshly created
 * tab becomes the focused target for subsequent snapshot/click tools.
 */
async function openNavigationTarget(
  call: ToolCall,
  target: 'new-tab' | 'new-window',
  authorize?: (prompt: ApprovalPrompt) => Promise<boolean>,
  signal?: AbortSignal,
): Promise<ToolAnswer> {
  const url = typeof call.args.url === 'string' ? call.args.url : ''
  if (!/^https?:\/\//i.test(url)) {
    return { ok: false, error: { code: 'action-failed', message: 'browser_navigate 需要完整的 http/https URL' } }
  }
  const approval = approvalPromptForCall({ ...call, name: 'browser_navigate' }, 'auto', [])
  if (approval !== undefined) {
    const allowed = authorize === undefined ? false : await authorize(approval)
    if (isCancelled(call, signal)) return cancelled()
    if (!allowed) return { ok: false, error: { code: 'action-failed', message: '用户未批准读取或页面操作' } }
  }
  if (isCancelled(call, signal)) return cancelled()
  try {
    if (target === 'new-window') {
      const created = await chrome.windows.create({ url, focused: true })
      const tabId = created.tabs?.[0]?.id
      return {
        ok: true,
        result: { text: `已在新窗口打开: ${url}`, url, tabId: tabId ?? undefined },
      }
    }
    const created = await chrome.tabs.create({ url, active: true })
    return { ok: true, result: { text: `已在新标签页打开: ${url}`, url, tabId: created.id } }
  } catch {
    return { ok: false, error: { code: 'action-failed', message: target === 'new-window' ? '无法新开窗口' : '无法新开标签页' } }
  }
}

/**
 * Dispatch one tool call to the active tab's content script.
 * @param call - the tool call to execute.
 * @param sharePageContent - the user's page-sharing preference ('off' blocks
 *   every page-content read).
 * @param budget - snapshot limits to restore after on-demand content-script injection.
 * @param signal - bridge lifetime; cancellation prevents any not-yet-sent page action.
 * @param navigationTarget - where `browser_navigate` opens URLs: the active tab
 *   (default), a new tab, or a new window. The user's active page is never
 *   disturbed when a new tab or window is chosen.
 * @returns the content script's answer, or a stable error when no tab or
 *   content script is available.
 */
export async function dispatchToolCall(
  call: ToolCall,
  sharePageContent: 'ask' | 'auto' | 'off',
  budget?: ContentBudget,
  authorize?: (prompt: ApprovalPrompt) => Promise<boolean>,
  signal?: AbortSignal,
  navigationTarget: 'current' | 'new-tab' | 'new-window' = 'current',
): Promise<ToolAnswer> {
  if (isCancelled(call, signal)) return cancelled()
  // Privacy boundary: with sharing off, no page content may leave the page.
  if (sharePageContent === 'off' && (call.name === 'browser_snapshot' || call.name === 'browser_get_text')) {
    return { ok: false, error: { code: 'action-failed', message: '页面内容共享已关闭（设置 → 页面内容共享）' } }
  }
  if (call.name === 'browser_navigate' && navigationTarget !== 'current') {
    return openNavigationTarget(call, navigationTarget, authorize, signal)
  }
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  if (isCancelled(call, signal)) return cancelled()
  if (tab?.id === undefined) {
    return { ok: false, error: { code: 'no-active-tab', message: '没有活动的标签页可操作' } }
  }
  const effectiveBudget = budget ?? { maxItems: 60, maxChars: 12_000 }
  const frames = await listTabFrames(tab.id, tab.url)
  if (isCancelled(call, signal)) return cancelled()
  const frameError = validateFrameTarget(call, frames)
  if (frameError !== undefined) return frameError
  const targetError = validateElementTarget(call, tab.id, frames)
  if (targetError !== undefined) return targetError
  const approval = approvalPromptForCall(call, sharePageContent, frames)
  if (approval !== undefined) {
    const allowed = authorize === undefined ? false : await authorize(approval)
    if (isCancelled(call, signal)) return cancelled()
    if (!allowed) {
      return { ok: false, error: { code: 'action-failed', message: '用户未批准读取或页面操作' } }
    }
  }
  let executionFrames = frames
  if (approval !== undefined) {
    executionFrames = await listTabFrames(tab.id, tab.url)
    if (isCancelled(call, signal)) return cancelled()
    const refreshedApproval = approvalPromptForCall(call, sharePageContent, executionFrames)
    if (refreshedApproval === undefined
      || !sameApprovalBoundary(approval, refreshedApproval)
      || (approval.kind === 'action' && !sameTargetDocument(call, frames, executionFrames))) {
      return unavailable('页面在确认期间发生变化；为避免操作错误页面，请重新 browser_snapshot 后再试')
    }
    const refreshedTargetError = validateElementTarget(call, tab.id, executionFrames)
    if (refreshedTargetError !== undefined) return refreshedTargetError
  }
  try {
    return await dispatchOnce(tab.id, executionFrames, call, effectiveBudget, signal)
  } catch {
    if (isCancelled(call, signal)) return cancelled()
    // Manifest content scripts do not run retroactively in tabs that were
    // already open when an unpacked extension was installed or reloaded.
    // Recover in place so the user never has to refresh and lose page state.
    if (!isInjectablePage(tab.url)) {
      return unavailable('当前页面不支持浏览器操作；请切换到普通的 http/https 页面')
    }
    try {
      await injectContentScript(tab.id)
      if (isCancelled(call, signal)) return cancelled()
      const refreshedFrames = await listTabFrames(tab.id, tab.url)
      if (isCancelled(call, signal)) return cancelled()
      const refreshedTargetError = validateElementTarget(call, tab.id, refreshedFrames)
      if (refreshedTargetError !== undefined) return refreshedTargetError
      if (approval !== undefined) {
        const refreshedApproval = approvalPromptForCall(call, sharePageContent, refreshedFrames)
        if (refreshedApproval === undefined
          || !sameApprovalBoundary(approval, refreshedApproval)
          || (approval.kind === 'action' && !sameTargetDocument(call, executionFrames, refreshedFrames))) {
          return unavailable('页面在加载内容脚本期间发生变化；请重新 browser_snapshot 后再试')
        }
      }
      return await dispatchOnce(tab.id, refreshedFrames, call, effectiveBudget, signal)
    } catch {
      return unavailable('无法在当前页面加载内容脚本；Chrome 内置页和受保护页面不支持操作')
    }
  }
}

function validateFrameTarget(call: ToolCall, frames: TabFrame[]): ToolAnswer | undefined {
  if (call.name === 'browser_snapshot') return undefined
  const frameId = requestedFrame(call.args)
  if (frameId < 0) return { ok: false, error: { code: 'action-failed', message: 'frame 必须是非负整数' } }
  if (!frames.some((frame) => frame.frameId === frameId)) {
    return unavailable(`frame ${frameId} 不存在或已经导航，请重新 browser_snapshot`)
  }
  return undefined
}

function validateElementTarget(call: ToolCall, tabId: number, frames: TabFrame[]): ToolAnswer | undefined {
  if (call.name !== 'browser_click' && call.name !== 'browser_type') return undefined
  const frameId = requestedFrame(call.args)
  const frame = frames.find((candidate) => candidate.frameId === frameId)
  const snapshotted = snapshotDocumentsByTab.get(tabId)?.get(frameId)
  if (frame === undefined || snapshotted === undefined || snapshotted !== frameDocumentKey(frame)) {
    return unavailable('元素引用不属于当前文档；请重新 browser_snapshot 获取最新的 frame 与 index')
  }
  return undefined
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
