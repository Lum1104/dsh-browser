/**
 * Tab operations for `browser_tabs`.
 *
 * Multi-tab work is the one browser capability that cannot live in the content
 * script, and it touches the consent model directly: browser tools are bound
 * to ONE user-visible tab, so moving that binding is a user-visible act. The
 * rule here is that the model may move the binding only through an approved
 * call, and moving it never hides the change — the affinity state is
 * rebroadcast so the side panel shows which page is now controlled.
 *
 * Chrome APIs are injected so the whole surface is testable without a browser.
 *
 * @module
 */

import type { AffinityTab } from './tab-affinity.ts'
import { wrapDerivedReport } from '../security/untrusted.ts'

/** The parsed `browser_tabs` request. */
export interface TabsRequest {
  action: 'list' | 'open' | 'switch' | 'close'
  url?: string
  tabId?: number
  control?: boolean
  activate?: boolean
}

/** One listed tab, as the model sees it. */
export interface TabSummary {
  tabId: number
  title: string
  url: string
  active: boolean
  controlled: boolean
}

/** Chrome and affinity seams this module drives. */
export interface TabsDeps {
  listTabs(): Promise<chrome.tabs.Tab[]>
  getTab(tabId: number): Promise<chrome.tabs.Tab>
  createTab(url: string, active: boolean): Promise<chrome.tabs.Tab>
  closeTab(tabId: number): Promise<void>
  activateTab(tabId: number, windowId: number): Promise<void>
  /** Move browser control to this tab and broadcast the new affinity state. */
  bindControl(tab: AffinityTab, sessionId?: string): void
  /** The tab browser tools currently operate on. */
  controlledTabId(): number | undefined
}

/** A refusal the model should read and act on. */
export class TabsError extends Error {
  constructor(readonly code: 'bad-args' | 'action-failed', message: string) {
    super(message)
    this.name = 'TabsError'
  }
}

/** Cap on listed tabs: a tab list is orientation, not a data dump. */
const MAX_LISTED_TABS = 40

/**
 * Parse the model's arguments into a request.
 * @param args - raw tool arguments.
 * @returns the validated request.
 * @throws TabsError for an unusable shape.
 */
export function parseTabsRequest(args: Record<string, unknown>): TabsRequest {
  const action = args.action
  if (action !== 'list' && action !== 'open' && action !== 'switch' && action !== 'close') {
    throw new TabsError('bad-args', 'action must be list, open, switch, or close.')
  }
  const request: TabsRequest = { action }
  if (action === 'open') {
    if (typeof args.url !== 'string' || args.url === '') throw new TabsError('bad-args', 'open requires a url.')
    let parsed: URL
    try {
      parsed = new URL(args.url)
    } catch {
      throw new TabsError('bad-args', `url is not valid: ${args.url}`)
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new TabsError('bad-args', `Only http and https URLs can be opened; received ${parsed.protocol}.`)
    }
    request.url = parsed.href
  }
  if (action === 'switch' || action === 'close') {
    if (typeof args.tabId !== 'number' || !Number.isInteger(args.tabId) || args.tabId < 0) {
      throw new TabsError('bad-args', `${action} requires the numeric tabId reported by the list action.`)
    }
    request.tabId = args.tabId
  }
  if (typeof args.control === 'boolean') request.control = args.control
  if (typeof args.activate === 'boolean') request.activate = args.activate
  return request
}

/** Chrome tab → the affinity controller's minimal shape. */
function affinityTab(tab: chrome.tabs.Tab): AffinityTab | null {
  if (tab.id === undefined) return null
  return { tabId: tab.id, windowId: tab.windowId, title: tab.title ?? '', url: tab.url ?? '' }
}

/**
 * Execute one tab request.
 *
 * Every answer names pages by their own title and URL, which the pages control,
 * so the report is enclosed in the untrusted-content boundary exactly as a
 * snapshot or an inspection report is.
 *
 * With page sharing `off` no page-authored text may leave the page at all, so
 * `list` is refused outright — it is a pure read of what the user has open — and
 * the remaining answers identify tabs by id rather than by title.
 *
 * @param request - the parsed request.
 * @param deps - Chrome and affinity seams.
 * @param sharePageContent - the user's page-sharing preference.
 * @returns model-facing text, inside the trust boundary.
 * @throws TabsError when the request cannot be carried out.
 */
export async function runTabsAction(
  request: TabsRequest,
  deps: TabsDeps,
  sharePageContent: 'ask' | 'auto' | 'off' = 'auto',
  sessionId?: string,
): Promise<string> {
  return wrapDerivedReport(await renderTabsAction(request, deps, sharePageContent !== 'off', sessionId))
}

async function renderTabsAction(request: TabsRequest, deps: TabsDeps, mayNamePages: boolean, sessionId?: string): Promise<string> {
  switch (request.action) {
    case 'list':
      if (!mayNamePages) {
        throw new TabsError(
          'action-failed',
          'Listing tabs would report the titles and addresses of pages you have open. Page content sharing is disabled in Settings > Page content sharing.',
        )
      }
      return renderTabList(await summarizeTabs(deps))
    case 'open':
      return openTab(request, deps, sessionId)
    case 'switch':
      return switchTab(request.tabId!, request.activate === true, mayNamePages, deps, sessionId)
    case 'close':
      return closeTab(request.tabId!, deps)
  }
}

async function summarizeTabs(deps: TabsDeps): Promise<TabSummary[]> {
  const controlled = deps.controlledTabId()
  const tabs = await deps.listTabs()
  return tabs
    .filter((tab): tab is chrome.tabs.Tab & { id: number } => tab.id !== undefined)
    .map((tab) => ({
      tabId: tab.id,
      title: (tab.title ?? '').replace(/\s+/g, ' ').trim(),
      url: tab.url ?? '',
      active: tab.active === true,
      controlled: tab.id === controlled,
    }))
}

function renderTabList(tabs: TabSummary[]): string {
  if (tabs.length === 0) return 'No browser tabs are open.'
  const shown = tabs.slice(0, MAX_LISTED_TABS)
  const lines = [`${tabs.length} open tab(s):`]
  for (const tab of shown) {
    const flags = [tab.controlled ? 'controlled' : undefined, tab.active ? 'active' : undefined]
      .filter((flag) => flag !== undefined)
      .join('/')
    lines.push(`  [tabId ${tab.tabId}]${flags === '' ? '' : ` (${flags})`} "${tab.title}" — ${tab.url}`)
  }
  if (tabs.length > shown.length) lines.push(`  (${tabs.length - shown.length} more omitted.)`)
  lines.push('Only the controlled tab can be read or acted on; use action "switch" with a tabId to move control.')
  return lines.join('\n')
}

async function openTab(request: TabsRequest, deps: TabsDeps, sessionId?: string): Promise<string> {
  const takeControl = request.control !== false
  const tab = await deps.createTab(request.url!, request.activate === true)
  const summary = affinityTab(tab)
  if (summary === null) throw new TabsError('action-failed', 'The new tab could not be identified after opening.')
  if (!takeControl) {
    return `Opened ${request.url!} in a new background tab (tabId ${summary.tabId}). Browser control stayed on the previous page; switch to it to operate there.`
  }
  deps.bindControl(summary, sessionId)
  return `Opened ${request.url!} in a new tab (tabId ${summary.tabId}) and moved browser control to it. Call browser_snapshot once it has loaded.`
}

async function switchTab(tabId: number, activate: boolean, mayNamePages: boolean, deps: TabsDeps, sessionId?: string): Promise<string> {
  let tab: chrome.tabs.Tab
  try {
    tab = await deps.getTab(tabId)
  } catch {
    throw new TabsError('action-failed', `No tab with id ${tabId} exists. Call browser_tabs with action "list" for current ids.`)
  }
  const summary = affinityTab(tab)
  if (summary === null) throw new TabsError('action-failed', `Tab ${tabId} could not be identified.`)
  if (!/^https?:\/\//i.test(summary.url)) {
    throw new TabsError('action-failed', `Tab ${tabId} is not a standard http or https page, so browser tools cannot operate on it.`)
  }
  if (activate) await deps.activateTab(tabId, tab.windowId)
  deps.bindControl(summary, sessionId)
  const named = mayNamePages ? ` ("${summary.title}" — ${summary.url})` : ''
  return `Browser control moved to tabId ${tabId}${named}. Call browser_snapshot to read it.`
}

async function closeTab(tabId: number, deps: TabsDeps): Promise<string> {
  const controlled = deps.controlledTabId()
  const tabs = await deps.listTabs()
  if (!tabs.some((tab) => tab.id === tabId)) {
    throw new TabsError('action-failed', `No tab with id ${tabId} exists.`)
  }
  if (tabs.length <= 1) {
    throw new TabsError('action-failed', 'This is the last open tab; closing it would close the browser window.')
  }
  await deps.closeTab(tabId)
  return tabId === controlled
    ? `Closed tabId ${tabId}, which was the controlled tab. Use browser_tabs "switch" to bind another page before reading or acting.`
    : `Closed tabId ${tabId}. The controlled tab is unchanged.`
}
