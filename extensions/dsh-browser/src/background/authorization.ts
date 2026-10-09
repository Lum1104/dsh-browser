/** Pure authorization policy for model-requested browser tools. */

import type { ToolCall } from './tools.ts'
import type { TabFrame } from './frames.ts'
import type { ApprovalAuthorization, ApprovalPrompt } from '../security/approval.ts'
import { getUiLocale, type UiLocale } from '../i18n.ts'

const PAGE_READS = new Set(['browser_snapshot', 'browser_get_text'])
const STATE_CHANGING_ACTIONS = new Set([
  'browser_click',
  'browser_type',
  'browser_press',
  'browser_navigate',
  'browser_open_tab',
  'browser_back',
  'browser_forward',
  'browser_reload',
])

/**
 * The developer-tools group. These calls drive the page through the debugger
 * (CDP) instead of the content script, so they never consult the ordinary
 * origin allowlist: only the explicit developer-tools setting, a session grant
 * the user made in this browser, or a fresh per-call approval can pass.
 */
export const DEVTOOLS_TOOLS = new Set([
  'browser_devtools_elements',
  'browser_devtools_set_element_style',
  'browser_devtools_set_element_attribute',
  'browser_console_eval',
  'browser_console_logs',
  'browser_devtools_network',
  'browser_devtools_list_requests',
  'browser_devtools_get_request',
  'browser_devtools_request_body',
])

/** Whether a tool belongs to the developer-tools group. */
export function isDevToolsTool(name: string): boolean {
  return DEVTOOLS_TOOLS.has(name)
}

/**
 * The approval prompt for one developer-tools call.
 *
 * Every devtools call is high privilege, so the prompt always renders and can
 * never be satisfied by the origin allowlist or unrestricted access. Only the
 * model-facing presentation differs between read-shaped and action-shaped calls.
 * @param call - the tool call awaiting a decision.
 * @param frames - the controlled tab's frames, for the origin list.
 * @param locale - UI locale for the summary text.
 * @returns the prompt handed to the side panel.
 */
export function devToolsApprovalForCall(
  call: ToolCall,
  frames: TabFrame[],
  locale: UiLocale = getUiLocale(),
): ApprovalPrompt {
  const destructive = call.name === 'browser_devtools_set_element_style'
    || call.name === 'browser_devtools_set_element_attribute'
    || call.name === 'browser_console_eval'
  return {
    kind: destructive ? 'action' : 'read',
    action: call.name,
    summary: summarizeDevToolsAction(call, locale),
    origins: uniqueOrigins(frames.filter((frame) => frame.frameId === 0), frames),
    // Session trust for devtools is granted through the dedicated prompt path,
    // never as a blanket "trust this origin for every browser action".
    canTrust: false,
    devTools: true,
  }
}

function summarizeDevToolsAction(call: ToolCall, locale: UiLocale): string {
  const detail = inlineArg(call)
  switch (call.name) {
    case 'browser_devtools_elements':
      return localized(locale, `Inspect page element (${detail})`, `查看页面元素（${detail}）`)
    case 'browser_devtools_set_element_style':
      return localized(locale, `Modify live CSS on page element (${detail})`, `修改页面元素 CSS（${detail}）`)
    case 'browser_devtools_set_element_attribute':
      return localized(locale, `Change page element attribute (${detail})`, `修改页面元素属性（${detail}）`)
    case 'browser_console_eval':
      return localized(
        locale,
        `Run JavaScript in the page (${typeof call.args.expression === 'string' ? `${call.args.expression.length} characters, not shown here}` : 'expression not shown'})`,
        `在页面中执行 JavaScript（${typeof call.args.expression === 'string' ? `${call.args.expression.length} 个字符，此处不显示内容` : '表达式内容不显示'}）`,
      )
    case 'browser_console_logs':
      return localized(locale, 'Read the page console output', '读取页面控制台输出')
    case 'browser_devtools_network':
      return localized(locale, `Control network capture (${safeInline(typeof call.args.action === 'string' ? call.args.action : 'status')})`, `控制网络抓包（${safeInline(typeof call.args.action === 'string' ? call.args.action : 'status')}）`)
    case 'browser_devtools_list_requests':
      return localized(locale, 'List captured network requests', '列出已捕获的网络请求')
    case 'browser_devtools_get_request':
      return localized(locale, `Read one captured request in full, including headers (index ${safeInline(String(call.args.index ?? '?'))})`, `查看单条网络请求的完整内容，含请求头（序号 ${safeInline(String(call.args.index ?? '?'))}）`)
    case 'browser_devtools_request_body':
      return localized(locale, `Read a captured request or response body (index ${safeInline(String(call.args.index ?? '?'))})`, `读取已捕获的请求或响应正文（序号 ${safeInline(String(call.args.index ?? '?'))}）`)
    default:
      return call.name
  }
}

/** A short, non-secret hint about which element a call targets. */
function inlineArg(call: ToolCall): string {
  if (typeof call.args.selector === 'string' && call.args.selector !== '') return safeInline(call.args.selector)
  if (typeof call.args.index === 'number') {
    const frame = typeof call.args.frame === 'number' && call.args.frame !== 0 ? `, frame ${call.args.frame}` : ''
    return `snapshot index ${call.args.index}${frame}`
  }
  return 'no selector given'
}

/** Return an approval prompt, or undefined when this call needs no prompt. */
export function approvalPromptForCall(
  call: ToolCall,
  sharePageContent: 'ask' | 'auto' | 'off',
  frames: TabFrame[],
  locale: UiLocale = getUiLocale(),
): ApprovalPrompt | undefined {
  if (PAGE_READS.has(call.name)) {
    if (sharePageContent !== 'ask') return undefined
    const targetFrames = call.name === 'browser_snapshot'
      ? frames
      : frames.filter((frame) => frame.frameId === requestedFrame(call.args))
    return {
      kind: 'read',
      action: call.name,
      summary: call.name === 'browser_snapshot'
        ? localized(locale, 'Read the current page and accessible iframes', '读取当前页面及可访问 iframe')
        : localized(locale, 'Read text from the specified area of the current page', '读取当前页面的指定文本区域'),
      origins: uniqueOrigins(targetFrames, frames),
      canTrust: false,
    }
  }

  if (!STATE_CHANGING_ACTIONS.has(call.name)) return undefined
  if (call.name === 'browser_open_tab') {
    const destination = originFromUrl(typeof call.args.url === 'string' ? call.args.url : '')
    return {
      kind: 'action',
      action: call.name,
      summary: summarizeAction(call, locale),
      // A new tab does not mutate the current page; only the destination matters.
      origins: destination === undefined ? [] : [destination],
      canTrust: destination !== undefined,
    }
  }
  const frameId = requestedFrame(call.args)
  const target = frames.find((frame) => frame.frameId === frameId) ?? frames.find((frame) => frame.frameId === 0)
  const origins = uniqueOrigins(target === undefined ? [] : [target], frames)
  let canTrust = origins.length === 1 && call.name !== 'browser_back' && call.name !== 'browser_forward'
  if (call.name === 'browser_navigate') {
    const destination = originFromUrl(typeof call.args.url === 'string' ? call.args.url : '')
    if (destination !== undefined && !origins.includes(destination)) origins.push(destination)
    // Do not let an invalid, opaque, or cross-origin navigation become a
    // back door for adding the current page to the persistent allowlist.
    canTrust = destination !== undefined && origins.length === 1 && origins[0] === destination
  }
  return {
    kind: 'action',
    action: call.name,
    summary: summarizeAction(call, locale),
    origins,
    // Cross-origin/invalid navigation and unknown history destinations always
    // require a fresh decision; they must never expand trust implicitly.
    canTrust,
  }
}

function requestedFrame(args: Record<string, unknown>): number {
  return typeof args.frame === 'number' && Number.isInteger(args.frame) && args.frame >= 0 ? args.frame : 0
}

function uniqueOrigins(targets: TabFrame[], allFrames: TabFrame[]): string[] {
  const origins = new Set<string>()
  for (const frame of targets) {
    const origin = effectiveFrameOrigin(frame, allFrames)
    if (origin !== undefined) origins.add(origin)
  }
  return [...origins].sort()
}

function effectiveFrameOrigin(frame: TabFrame, frames: TabFrame[], visited = new Set<number>()): string | undefined {
  if (visited.has(frame.frameId)) return undefined
  visited.add(frame.frameId)
  const direct = originFromUrl(frame.url)
  if (direct !== undefined) return direct
  const parent = frames.find((candidate) => candidate.frameId === frame.parentFrameId)
  return parent === undefined ? undefined : effectiveFrameOrigin(parent, frames, visited)
}

export function originFromUrl(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'blob:') return undefined
    return url.origin === 'null' ? undefined : url.origin
  } catch {
    return undefined
  }
}

function summarizeAction(call: ToolCall, locale: UiLocale): string {
  const frame = typeof call.args.frame === 'number' && call.args.frame !== 0
    ? localized(locale, `, iframe ${call.args.frame}`, `，iframe ${call.args.frame}`)
    : ''
  const index = typeof call.args.index === 'number' ? call.args.index : '?'
  switch (call.name) {
    case 'browser_click': return localized(locale, `Click element [${index}]${frame}`, `点击元素 [${index}]${frame}`)
    case 'browser_type': {
      const length = typeof call.args.text === 'string' ? call.args.text.length : 0
      return localized(
        locale,
        `Enter ${length} characters in element [${index}]${frame} (the text is not shown in this dialog)`,
        `向元素 [${index}] 输入 ${length} 个字符${frame}（文本内容不会显示在确认框）`,
      )
    }
    case 'browser_press': return localized(
      locale,
      `Press “${safeInline(typeof call.args.key === 'string' ? call.args.key : '')}”${frame}`,
      `发送按键「${safeInline(typeof call.args.key === 'string' ? call.args.key : '')}」${frame}`,
    )
    case 'browser_navigate': return localized(
      locale,
      `Navigate to ${displayUrl(typeof call.args.url === 'string' ? call.args.url : '', locale)}`,
      `导航到 ${displayUrl(typeof call.args.url === 'string' ? call.args.url : '', locale)}`,
    )
    case 'browser_open_tab': {
      const destination = displayUrl(typeof call.args.url === 'string' ? call.args.url : '', locale)
      return call.args.active === false
        ? localized(
          locale,
          `Open a background tab at ${destination}`,
          `在后台新标签页打开 ${destination}`,
        )
        : localized(
          locale,
          `Open a new tab at ${destination}`,
          `在新标签页打开 ${destination}`,
        )
    }
    case 'browser_back': return localized(locale, 'Go back in browser history (destination domain unknown)', '返回浏览历史上一页（目标域名未知）')
    case 'browser_forward': return localized(locale, 'Go forward in browser history (destination domain unknown)', '前进到浏览历史下一页（目标域名未知）')
    case 'browser_reload': return localized(locale, 'Reload the current page', '重新加载当前页面')
    default: return call.name
  }
}

function displayUrl(value: string, locale: UiLocale): string {
  try {
    const url = new URL(value)
    return safeInline(`${url.origin}${url.pathname}`, 160)
  } catch {
    return localized(locale, '(invalid URL)', '(无效 URL)')
  }
}

function localized(locale: UiLocale, english: string, chinese: string): string {
  return locale === 'zh' ? chinese : english
}

function safeInline(value: string, maxLength = 40): string {
  const inline = value.replace(/\s+/g, ' ').trim()
  return inline.length <= maxLength ? inline : `${inline.slice(0, maxLength - 1)}…`
}

/** Inputs the approval gate evaluates before a prompt is even sent. */
export interface ApprovalGateInput {
  prompt: ApprovalPrompt
  /** Persisted "allow developer tools" setting. */
  devToolsAllowed: boolean
  /** Ephemeral devtools grant the user made in this side-panel session. */
  devToolsSessionGrant: boolean
  /** The user's blanket browser-control switch. */
  unrestrictedAccess: boolean
  /** Result of the persistent + session origin allowlist for ordinary actions. */
  coveredByTrustedOrigins: boolean
}

/**
 * Decide whether an approval prompt can be skipped.
 *
 * Developer tools are their own consent surface: unrestricted access and the
 * persistent origin allowlist deliberately do not cover them, so enabling
 * either can never hand the model the debugger. Ordinary actions keep the
 * existing shortcut semantics.
 *
 * @param input - the prompt plus the policy state it is evaluated against.
 * @returns the authorization to apply, or `'prompt'` when the user must decide.
 */
export function resolveApprovalGate(input: ApprovalGateInput): ApprovalAuthorization | 'prompt' {
  if (input.prompt.devTools === true) {
    if (input.devToolsSessionGrant || input.devToolsAllowed) return 'approved'
    return 'prompt'
  }
  if (input.unrestrictedAccess || input.coveredByTrustedOrigins) return 'approved'
  return 'prompt'
}
