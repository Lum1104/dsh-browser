/** Pure authorization policy for model-requested browser tools. */

import type { ToolCall } from './tools.ts'
import type { TabFrame } from './frames.ts'
import type { ApprovalPrompt } from '../security/approval.ts'
import { getUiLocale, type UiLocale } from '../i18n.ts'

const PAGE_READS = new Set([
  'browser_snapshot',
  'browser_get_text',
  'browser_find',
  'browser_screenshot',
  'browser_read_image',
])
const STATE_CHANGING_ACTIONS = new Set([
  'browser_click',
  'browser_type',
  'browser_press',
  'browser_navigate',
  'browser_back',
  'browser_forward',
  'browser_reload',
  'browser_select_option',
  'browser_hover',
  'browser_act',
  'browser_expand',
])
/** Whole-page reads: a snapshot spans every frame, and so does a tab capture. */
const WHOLE_PAGE_READS = new Set(['browser_snapshot', 'browser_screenshot'])

/**
 * Tab management is authorized on its own terms: `list` reveals the user's open
 * tabs (a read), while opening, switching, and closing change the browser
 * itself (actions). Its origins come from the request, not from a frame.
 */
export function tabsApprovalPrompt(
  call: ToolCall,
  sharePageContent: 'ask' | 'auto' | 'off',
  locale: UiLocale = getUiLocale(),
): ApprovalPrompt | undefined {
  const action = typeof call.args.action === 'string' ? call.args.action : ''
  if (action === 'list') {
    if (sharePageContent !== 'ask') return undefined
    return {
      kind: 'read',
      action: call.name,
      summary: localized(locale, 'List the titles and addresses of your open browser tabs', '列出你打开的所有标签页标题与地址'),
      origins: [],
      canTrust: false,
    }
  }
  const destination = action === 'open'
    ? originFromUrl(typeof call.args.url === 'string' ? call.args.url : '')
    : undefined
  return {
    kind: 'action',
    action: call.name,
    summary: summarizeTabsAction(action, call, locale),
    origins: destination === undefined ? [] : [destination],
    // Trust is per-origin permission to act on a PAGE; rearranging tabs is not
    // that, so it never becomes an allowlist entry.
    canTrust: false,
  }
}

function summarizeTabsAction(action: string, call: ToolCall, locale: UiLocale): string {
  const tabId = typeof call.args.tabId === 'number' ? call.args.tabId : '?'
  switch (action) {
    case 'open': {
      const url = displayUrl(typeof call.args.url === 'string' ? call.args.url : '', locale)
      const control = call.args.control === false
        ? localized(locale, ' in the background', '（后台打开，不接管控制）')
        : localized(locale, ' and control it', '并接管浏览器控制权')
      return localized(locale, `Open ${url} in a new tab${control}`, `在新标签页打开 ${url}${control}`)
    }
    case 'switch':
      return localized(locale, `Move browser control to tab ${tabId}`, `将浏览器控制权切换到标签页 ${tabId}`)
    case 'close':
      return localized(locale, `Close tab ${tabId}`, `关闭标签页 ${tabId}`)
    default:
      return localized(locale, `Manage browser tabs (${action})`, `管理浏览器标签页（${action}）`)
  }
}

/** Return an approval prompt, or undefined when this call needs no prompt. */
export function approvalPromptForCall(
  call: ToolCall,
  sharePageContent: 'ask' | 'auto' | 'off',
  frames: TabFrame[],
  locale: UiLocale = getUiLocale(),
): ApprovalPrompt | undefined {
  if (call.name === 'browser_tabs') return tabsApprovalPrompt(call, sharePageContent, locale)
  if (PAGE_READS.has(call.name)) {
    if (sharePageContent !== 'ask') return undefined
    const targetFrames = WHOLE_PAGE_READS.has(call.name) && call.args.index === undefined && call.args.selector === undefined
      ? frames
      : frames.filter((frame) => frame.frameId === requestedFrame(call.args))
    return {
      kind: 'read',
      action: call.name,
      summary: summarizeRead(call, locale),
      origins: uniqueOrigins(targetFrames, frames),
      canTrust: false,
    }
  }

  if (!STATE_CHANGING_ACTIONS.has(call.name)) return undefined
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

/** What a read call is about to take out of the page, in the user's words. */
function summarizeRead(call: ToolCall, locale: UiLocale): string {
  switch (call.name) {
    case 'browser_snapshot':
      return localized(locale, 'Read the current page and accessible iframes', '读取当前页面及可访问 iframe')
    case 'browser_find':
      return localized(
        locale,
        `Search the current page for matching elements${call.args.text === undefined ? '' : ` ("${safeInline(String(call.args.text))}")`}`,
        `在当前页面中查找匹配元素${call.args.text === undefined ? '' : `（「${safeInline(String(call.args.text))}」）`}`,
      )
    case 'browser_screenshot':
      return call.args.index === undefined && call.args.selector === undefined
        ? localized(locale, 'Capture a picture of the visible page', '截取当前可见页面的图像')
        : localized(locale, 'Capture a picture of one element on the page', '截取页面中某个元素的图像')
    case 'browser_read_image':
      return localized(locale, 'Read one image on the page at full resolution', '以原始分辨率读取页面中的一张图片')
    default:
      return localized(locale, 'Read text from the specified area of the current page', '读取当前页面的指定文本区域')
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
    case 'browser_back': return localized(locale, 'Go back in browser history (destination domain unknown)', '返回浏览历史上一页（目标域名未知）')
    case 'browser_forward': return localized(locale, 'Go forward in browser history (destination domain unknown)', '前进到浏览历史下一页（目标域名未知）')
    case 'browser_reload': return localized(locale, 'Reload the current page', '重新加载当前页面')
    case 'browser_hover': return localized(locale, `Hover over element [${index}]${frame}`, `将鼠标悬停在元素 [${index}] 上${frame}`)
    case 'browser_select_option': {
      const values = Array.isArray(call.args.values)
        ? call.args.values.filter((value): value is string => typeof value === 'string')
        : []
      const shown = values.map((value) => safeInline(value, 24)).join(', ')
      return localized(
        locale,
        `Choose ${shown === '' ? 'an option' : `“${shown}”`} in dropdown [${index}]${frame}`,
        `在下拉框 [${index}] 中选择${shown === '' ? '选项' : `「${shown}」`}${frame}`,
      )
    }
    case 'browser_act': return summarizeBatch(call, frame, locale)
    default: return call.name
  }
}

/**
 * Describe a batch as the sequence the user is actually approving. One dialog
 * covers the whole batch, so it must name every step — approving "run 4 steps"
 * would be consent without content.
 */
function summarizeBatch(call: ToolCall, frame: string, locale: UiLocale): string {
  const steps = Array.isArray(call.args.steps) ? call.args.steps : []
  const described = steps.slice(0, 8).map((raw, position) => {
    const step = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {}
    const name = typeof step.action === 'string' ? step.action : '?'
    const index = typeof step.index === 'number' ? `[${step.index}]` : ''
    const detail = name === 'type' && typeof step.text === 'string'
      ? localized(locale, ` (${step.text.length} characters)`, `（${step.text.length} 个字符）`)
      : name === 'press' && typeof step.key === 'string'
        ? ` “${safeInline(step.key, 16)}”`
        : ''
    return `${position + 1}. ${name} ${index}${detail}`.trim()
  })
  const overflow = steps.length > described.length
    ? localized(locale, ` and ${steps.length - described.length} more`, ` 等 ${steps.length - described.length} 个步骤`)
    : ''
  return localized(
    locale,
    `Run ${steps.length} page action(s)${frame}: ${described.join('; ')}${overflow}`,
    `连续执行 ${steps.length} 个页面操作${frame}：${described.join('；')}${overflow}`,
  )
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

/**
 * Authorize proactive work: a web search or a multi-page read.
 *
 * These open pages the USER did not choose, in the user's own browser and
 * therefore with the user's cookies, so they are treated as state-changing
 * even though they leave the controlled page untouched. One prompt covers the
 * whole call and names every destination origin — a research step that asked
 * once per URL would only teach the user to click through.
 *
 * Page sharing is not consulted here: 'off' rejects these calls before they are
 * ever dispatched, so a prompt is only ever built for a call that may run.
 *
 * @param call - the tool call.
 * @param origins - every origin the call will visit.
 * @param locale - UI locale for the summary.
 * @returns the prompt covering the whole call.
 */
export function researchApprovalPrompt(
  call: ToolCall,
  origins: readonly string[],
  locale: UiLocale = getUiLocale(),
): ApprovalPrompt {
  const shown = origins.slice(0, 6)
  const overflow = origins.length - shown.length
  const hosts = shown.join(', ') + (overflow > 0
    ? localized(locale, ` and ${overflow} more`, ` 等 ${overflow} 个站点`)
    : '')
  const summary = call.name === 'browser_search'
    ? localized(
        locale,
        `Search the web for “${safeInline(typeof call.args.query === 'string' ? call.args.query : '', 80)}” in a background tab`,
        `在后台标签页搜索「${safeInline(typeof call.args.query === 'string' ? call.args.query : '', 80)}」`,
      )
    : localized(
        locale,
        `Open and read ${origins.length === 0 ? 'pages' : hosts} in background tabs, using your browser session`,
        `用你的浏览器会话在后台标签页打开并读取 ${origins.length === 0 ? '这些页面' : hosts}`,
      )
  return {
    kind: 'action',
    action: call.name,
    summary,
    origins: [...origins],
    // Trusting one origin here would silently authorize every future fetch of
    // it, including authenticated pages, so proactive reads never offer trust.
    canTrust: false,
  }
}

/**
 * Authorize a download. Saving a file is a change outside the browser, so it
 * always prompts, and the prompt names where the bytes come from.
 *
 * @param call - the tool call.
 * @param origins - origins the bytes are fetched from (empty when managing).
 * @param locale - UI locale for the summary.
 * @returns the prompt.
 */
export function downloadApprovalPrompt(
  call: ToolCall,
  origins: readonly string[],
  locale: UiLocale = getUiLocale(),
): ApprovalPrompt {
  if (call.name === 'browser_downloads') {
    const action = typeof call.args.action === 'string' ? call.args.action : ''
    return {
      kind: 'action',
      action: call.name,
      summary: action === 'list'
        ? localized(locale, 'List this browser profile\'s recent downloads', '列出当前浏览器配置的最近下载')
        : localized(locale, `Manage a download (${action})`, `管理下载任务（${action}）`),
      origins: [],
      canTrust: false,
    }
  }
  const count = Array.isArray(call.args.urls)
    ? call.args.urls.length + (typeof call.args.url === 'string' ? 1 : 0)
    : typeof call.args.url === 'string' ? 1 : 0
  const target = typeof call.args.subdirectory === 'string' && call.args.subdirectory !== ''
    ? localized(locale, ` into the "${safeInline(call.args.subdirectory, 40)}" folder`, `，保存到「${safeInline(call.args.subdirectory, 40)}」子目录`)
    : ''
  return {
    kind: 'action',
    action: call.name,
    summary: localized(
      locale,
      `Download ${count} file(s) from ${origins.join(', ')}${target}`,
      `从 ${origins.join('、')} 下载 ${count} 个文件${target}`,
    ),
    origins: [...origins],
    canTrust: origins.length === 1,
  }
}

/**
 * Authorize a trusted verification click.
 *
 * This one is always prompted, whatever the sharing preference: it attaches the
 * browser debugger for the duration of a real mouse event, which is the most
 * privileged thing this extension can do, and the user should see it every time.
 *
 * @param call - the tool call.
 * @param pageUrl - URL of the controlled page.
 * @param locale - UI locale for the summary.
 * @returns the prompt.
 */
export function verifyApprovalPrompt(
  call: ToolCall,
  pageUrl: string,
  locale: UiLocale = getUiLocale(),
): ApprovalPrompt {
  const origin = originFromUrl(pageUrl)
  return {
    kind: 'action',
    action: call.name,
    summary: localized(
      locale,
      'Click the human-verification widget with a real mouse event (attaches the browser debugger for that click)',
      '用真实鼠标事件点击人机验证控件（该次点击期间会挂载浏览器调试器）',
    ),
    origins: origin === undefined ? [] : [origin],
    // A standing allowance for debugger-backed input is not something an
    // origin should be able to earn once and keep.
    canTrust: false,
  }
}

/**
 * Names in model-authored code that would send page data somewhere else.
 *
 * This is a WARNING aid, not a sandbox: it is trivially evadable and is not
 * relied on for safety. Its purpose is to keep an approval dialog from looking
 * routine when the code would exfiltrate — the user is the only gate on
 * arbitrary evaluation, and a page can talk the model into writing this.
 */
const EXFILTRATION_HINTS = [
  'fetch(',
  'XMLHttpRequest',
  'sendBeacon',
  'WebSocket',
  'EventSource',
  'import(',
  'document.cookie',
  'localStorage',
  'sessionStorage',
  'indexedDB',
]

/** Which outbound/storage names appear in this code, for the dialog to flag. */
export function outboundCodeHints(code: string): string[] {
  return EXFILTRATION_HINTS.filter((hint) => code.includes(hint))
}

/**
 * Authorize model-authored JavaScript in the page's MAIN world.
 *
 * This is always prompted and never trustable: arbitrary code is the most
 * privileged thing the page can be asked to run, so a standing allowance would
 * let one early approval silently cover every later script. The summary shows
 * a snippet of the actual code — approving "run script" without seeing it
 * would be consent without content — and flags outbound calls, because a page
 * that talks the model into exfiltrating data is defeated only by the user
 * noticing that this particular dialog is not routine.
 *
 * @param call - the tool call.
 * @param pageUrl - URL of the controlled page.
 * @param locale - UI locale for the summary.
 * @returns the prompt.
 */
export function evaluateApprovalPrompt(
  call: ToolCall,
  pageUrl: string,
  locale: UiLocale = getUiLocale(),
): ApprovalPrompt {
  const origin = originFromUrl(pageUrl)
  const code = typeof call.args.function === 'string' ? call.args.function : ''
  const snippet = safeInline(code, 120)
  const hints = outboundCodeHints(code)
  const warning = hints.length === 0
    ? ''
    : localized(
        locale,
        ` — WARNING: this code uses ${hints.join(', ')}, which can send page data off this site. Approve only if you asked for that.`,
        ` —— 警告：这段代码使用了 ${hints.join('、')}，可能把页面数据发送到站外。除非这是你要求的，否则请拒绝。`,
      )
  return {
    kind: 'action',
    action: call.name,
    summary: localized(
      locale,
      `Run JavaScript on this page${snippet === '' ? '' : `: ${snippet}`}${warning}`,
      `在该页面上运行 JavaScript${snippet === '' ? '' : `：${snippet}`}${warning}`,
    ),
    origins: origin === undefined ? [] : [origin],
    // A standing allowance for arbitrary code is exactly what an injected
    // prompt on a compromised page would want; every run gets its own consent.
    canTrust: false,
  }
}

/**
 * Authorize a console/network inspection.
 *
 * Recording attaches the browser debugger and can return response bodies —
 * page content in its most complete form — so it is authorized as a page read,
 * except that a `reload` also throws away unsaved page state and is therefore
 * an action.
 *
 * @param call - the tool call.
 * @param pageUrl - URL of the controlled page.
 * @param sharePageContent - the user's page-sharing preference.
 * @param locale - UI locale for the summary.
 * @returns the prompt, or undefined when a plain read needs none.
 */
export function inspectApprovalPrompt(
  call: ToolCall,
  pageUrl: string,
  sharePageContent: 'ask' | 'auto' | 'off',
  locale: UiLocale = getUiLocale(),
): ApprovalPrompt | undefined {
  const origin = originFromUrl(pageUrl)
  const origins = origin === undefined ? [] : [origin]
  if (call.args.reload === true) {
    return {
      kind: 'action',
      action: call.name,
      summary: localized(
        locale,
        'Reload the page and record its console messages and network requests',
        '重新加载页面并记录其控制台消息与网络请求',
      ),
      origins,
      canTrust: false,
    }
  }
  if (sharePageContent !== 'ask') return undefined
  return {
    kind: 'read',
    action: call.name,
    summary: localized(
      locale,
      'Record this page’s console messages and network requests, including response bodies',
      '记录该页面的控制台消息与网络请求（含响应内容）',
    ),
    origins,
    canTrust: false,
  }
}
