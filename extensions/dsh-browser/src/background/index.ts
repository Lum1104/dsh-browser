/**
 * Background service worker entry: owns the bridge connection, the gateway
 * RPC client, controlled-tab tool dispatch, and the panel port service.
 *
 * MV3 survival: after the user opens the panel, its port plus a half-minute
 * `alarms` keepalive re-arm the reconnect loop. Merely loading the extension
 * never probes or claims the single-connection bridge.
 *
 * Panel port protocol (chrome.runtime.connect, name "dsh-panel"):
 *   panel → bg: { type: 'rpc', id, method, payload }
 *   panel → bg: { type: 'respond', id, rpcId, result }
 *   panel → bg: { type: 'settings', settings: Partial<Settings> }
 *   panel → bg: { type: 'session.active', sessionId }
 *   panel → bg: { type: 'approval.response', id, decision }
 *   panel → bg: { type: 'tab-affinity.response', revision, decision, sessionId }
 *   panel → bg: { type: 'tab-affinity.rebind', id }
 *   panel → bg: { type: 'request-status' }
 *   bg → panel: { type: 'rpc.result', id, ok, result? | error? }
 *   bg → panel: { type: 'respond.result', id, ok, result? | error? }
 *   bg → panel: { type: 'status', state: BridgeState, caps? }
 *   bg → panel: { type: 'event', frame: ServerFrame }
 *   bg → panel: { type: 'approval.request', request }
 *   bg → panel: { type: 'approval.resolved', id }
 *   bg → panel: { type: 'session.resume-hint', sessionId }
 *   bg → panel: { type: 'tab-affinity', state }
 *   bg → panel: { type: 'tab-affinity.rebind.result', id, ok, error? }
 *
 * @module
 */

import {
  BRIDGE_INJECT_BROWSER_SNAPSHOT_METHOD,
  isRespondResult,
  type BridgeCaps,
  type RespondResult,
} from '@yuxianglin/dsh-bridge-browser/src/protocol.ts'
import type { ServerFrame } from '@yuxianglin/dsh-bridge-browser/src/protocol.ts'
import { BRIDGE_CONFIG_PATH, BRIDGE_PATH } from '@yuxianglin/dsh-bridge-browser/src/protocol.ts'
import { BridgeClient, type BridgeState } from './bridge.ts'
import { createRpc } from './rpc.ts'
import { dispatchToolCall, resetTabSnapshot, type ToolAnswer, type ToolCall } from './tools.ts'
import {
  isApprovalDecision,
  type ApprovalAuthorization,
  type ApprovalPrompt,
  type ApprovalRequest,
} from '../security/approval.ts'
import { getUiLocale } from '../i18n.ts'
import { InteractionResponseRouter } from './responses.ts'
import {
  actionCoveredByTrustedOrigins,
  normalizeTrustedOrigin,
} from '../security/trusted-origins.ts'
import { TransientEventCache } from './transient-events.ts'
import {
  TabAffinityController,
  type AffinityTab,
  type TabAffinityDecision,
} from './tab-affinity.ts'
import { FocusedWindowTracker } from './focused-window.ts'
import {
  forgetPanelWindow,
  hasPanelWindow,
  isPanelDocument,
  isPanelWindow,
  openAssistantPanel,
  panelWindowSettled,
  preferPanelOnActionClick,
} from './panel-host.ts'
import { ApprovalCoordinator, type ApprovalRequestResult } from './approval-coordinator.ts'
import {
  RECENT_SESSION_STORAGE_KEY,
  RecentSessionTracker,
  sessionIdFromFrame,
} from './session-continuity.ts'

/** User settings persisted in chrome.storage.local. */
export interface Settings {
  bridgeUrl: string
  token: string
  sharePageContent: 'ask' | 'auto' | 'off'
  /** Origins whose state-changing actions may run without another prompt. */
  trustedActionOrigins: string[]
  /** Show an OS notification when no side panel can display an approval. */
  approvalNotifications: boolean
  /** Restore the last active browser conversation when the panel reopens. */
  autoResumeSession: boolean
}

const SETTINGS_DEFAULTS: Settings = {
  // 空地址 = 自动探测本机 dsh（零配置）；手动填地址时优先手动。
  bridgeUrl: '',
  token: '',
  sharePageContent: 'auto',
  trustedActionOrigins: [],
  approvalNotifications: true,
  autoResumeSession: true,
}

/** 自动探测的候选端口（dsh web 默认 3080；桌面应用常用 14389；--port 覆盖的常见值）。 */
const DISCOVERY_PORTS = [3080, 3081, 3090, 14389]
const LEGACY_LOCAL_URL = 'ws://127.0.0.1:3080'

/** 探测本机 dsh 的桥地址：fetch /ext/bridge-config 直到成功。 */
async function discoverBridge(shouldContinue: () => boolean = () => true): Promise<string | undefined> {
  for (const port of DISCOVERY_PORTS) {
    if (!shouldContinue()) return undefined
    try {
      const response = await fetch(`http://127.0.0.1:${port}/ext/bridge-config`, {
        signal: AbortSignal.timeout(1_500),
      })
      if (!shouldContinue()) return undefined
      if (!response.ok) continue
      const body = await response.json() as { wsUrl?: unknown }
      if (typeof body.wsUrl === 'string' && body.wsUrl.startsWith('ws://')) return body.wsUrl
    } catch {
      // 该端口没有 dsh 或未挂桥：试下一个。
    }
  }
  return undefined
}

/** Avoid opening a noisy loopback WebSocket until the local bridge responds. */
async function probeBridge(url: string): Promise<boolean> {
  try {
    const target = new URL(url)
    if (target.hostname !== '127.0.0.1') return true
    target.protocol = target.protocol === 'wss:' ? 'https:' : 'http:'
    target.pathname = BRIDGE_CONFIG_PATH
    target.search = ''
    target.hash = ''
    const response = await fetch(target, { signal: AbortSignal.timeout(1_500) })
    if (!response.ok) return false
    const body = await response.json() as { wsUrl?: unknown }
    return typeof body.wsUrl === 'string' && body.wsUrl.startsWith('ws://')
  } catch {
    return false
  }
}

const STORAGE_KEY = 'dshSettings'
const TAB_AFFINITY_STORAGE_KEY = 'dshTabAffinity'

type StoredTabAffinity =
  | { controlledTabId: number; keptActiveTabId?: number }
  | { lost: true }

let settings: Settings = { ...SETTINGS_DEFAULTS }
let caps: BridgeCaps | null = null
let bridge: BridgeClient | null = null
let rpc: ReturnType<typeof createRpc> | null = null
const panelPorts = new Set<chrome.runtime.Port>()
const BRIDGE_KEEPALIVE_ALARM = 'bridge-keepalive'
/** Invalidates an asynchronous discovery attempt when its panel lease ends. */
let bridgeStartRevision = 0
const interactionResponses = new InteractionResponseRouter()
const transientEvents = new TransientEventCache()
const tabAffinity = new TabAffinityController()
const focusedWindow = new FocusedWindowTracker()
const recentSession = new RecentSessionTracker({
  read: async () => (await chrome.storage.session.get(RECENT_SESSION_STORAGE_KEY))[RECENT_SESSION_STORAGE_KEY],
  write: async (sessionId) => {
    await chrome.storage.session.set({ [RECENT_SESSION_STORAGE_KEY]: sessionId })
  },
})
/** Ephemeral allowlist: cleared when the last side panel closes or this worker restarts. */
const sessionTrustedActionOrigins = new Set<string>()
/** Tool calls that can still be withdrawn by a bridge `tool.cancel` frame. */
const activeToolCalls = new Map<string, AbortController>()
let lastPersistedAffinity: string | undefined
let affinityPersistence = Promise.resolve()
/** The next prompt waits until an accepted follow has refreshed dsh context. */
let followedPageRefresh: Promise<void> = Promise.resolve()
let activeFollowRefresh: AbortController | null = null
const TAB_AFFINITY_REBIND_TIMEOUT_MS = 10_000

class TabAffinityRebindError extends Error {
  constructor(readonly code: 'no-active-tab' | 'timeout' | 'cancelled', message: string) {
    super(message)
    this.name = 'TabAffinityRebindError'
  }
}

function rebindAbortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new TabAffinityRebindError('cancelled', getUiLocale() === 'zh' ? '标签页绑定已取消' : 'Tab binding was cancelled')
}

function throwIfRebindAborted(signal: AbortSignal): void {
  if (signal.aborted) throw rebindAbortReason(signal)
}

/** Reject promptly on cancellation while safely consuming a late Chrome promise. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(rebindAbortReason(signal))
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => { reject(rebindAbortReason(signal)) }
    signal.addEventListener('abort', onAbort, { once: true })
    void promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        if (signal.aborted) reject(rebindAbortReason(signal))
        else resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(STORAGE_KEY)
  const loaded = normalizeSettings({ ...SETTINGS_DEFAULTS, ...(stored[STORAGE_KEY] as Partial<Settings> | undefined) })
  if (loaded.bridgeUrl === LEGACY_LOCAL_URL || loaded.bridgeUrl === `${LEGACY_LOCAL_URL}/`) {
    loaded.bridgeUrl = ''
    await chrome.storage.local.set({ [STORAGE_KEY]: loaded })
  }
  return loaded
}

async function persistSettings(next: Partial<Settings>): Promise<void> {
  settings = normalizeSettings({ ...settings, ...next })
  await chrome.storage.local.set({ [STORAGE_KEY]: settings })
}

function normalizeSettings(candidate: Settings): Settings {
  const trusted = Array.isArray(candidate.trustedActionOrigins)
    ? [...new Set(candidate.trustedActionOrigins.map(normalizeTrustedOrigin).filter((entry): entry is string => entry !== undefined))].sort()
    : []
  const sharePageContent = candidate.sharePageContent === 'auto' || candidate.sharePageContent === 'off'
    ? candidate.sharePageContent
    : candidate.sharePageContent === 'ask' ? 'ask' : 'auto'
  return {
    ...candidate,
    sharePageContent,
    trustedActionOrigins: trusted,
    approvalNotifications: candidate.approvalNotifications !== false,
    autoResumeSession: candidate.autoResumeSession !== false,
  }
}

/** Settings load is shared by every lazy connection trigger. */
const settingsReady = loadSettings().then((loaded) => {
  settings = loaded
})

function armBridgeKeepalive(): void {
  chrome.alarms.create(BRIDGE_KEEPALIVE_ALARM, { periodInMinutes: 0.5 })
}

function disarmBridgeKeepalive(): void {
  void Promise.resolve(chrome.alarms.clear(BRIDGE_KEEPALIVE_ALARM)).catch(() => {})
}

function broadcastStatus(): void {
  const payload = { type: 'status', state: bridge?.state ?? ('stopped' as BridgeState), caps }
  for (const port of panelPorts) {
    try { port.postMessage(payload) } catch { /* port already closed */ }
  }
}

function broadcastTabAffinity(): void {
  const payload = { type: 'tab-affinity', state: tabAffinity.snapshot() }
  for (const port of panelPorts) {
    try { port.postMessage(payload) } catch { /* port already closed */ }
  }
}

function broadcastEvent(frame: ServerFrame): void {
  for (const port of panelPorts) {
    try { port.postMessage({ type: 'event', frame }) } catch { /* port already closed */ }
  }
}

function broadcastApprovalResolved(id: string): void {
  for (const port of panelPorts) {
    try { port.postMessage({ type: 'approval.resolved', id }) } catch { /* port already closed */ }
  }
}

const APPROVAL_NOTIFICATION_PREFIX = 'dsh-browser-approval:'

function approvalNotificationId(id: string): string {
  return `${APPROVAL_NOTIFICATION_PREFIX}${id}`
}

function deliverApproval(request: ApprovalRequest): boolean {
  let delivered = false
  for (const port of panelPorts) {
    try {
      port.postMessage({ type: 'approval.request', request })
      delivered = true
    } catch { /* port already closed */ }
  }
  return delivered
}

function notifyApproval(request: ApprovalRequest, _windowId: number): void {
  if (!settings.approvalNotifications) return
  const copy = getUiLocale() === 'zh'
    ? {
        title: '浏览器操作等待确认',
        message: '点击通知打开 dsh 浏览器助手，并在 60 秒内确认或拒绝。',
      }
    : {
        title: 'Browser action awaiting approval',
        message: 'Click to open dsh Browser Assistant, then allow or deny within 60 seconds.',
      }
  void Promise.resolve(chrome.notifications.create(approvalNotificationId(request.id), {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('assets/icons/icon128.png'),
    title: copy.title,
    message: copy.message,
    requireInteraction: true,
  })).catch(() => {})
}

function clearApprovalNotification(id: string): void {
  void Promise.resolve(chrome.notifications.clear(approvalNotificationId(id))).catch(() => {})
}

const approvals = new ApprovalCoordinator({
  deliver: deliverApproval,
  notify: notifyApproval,
  clearNotification: clearApprovalNotification,
  resolved: broadcastApprovalResolved,
})

function responseMessages(): { unavailable: string; timeout: string; duplicate: string; disconnected: string } {
  return getUiLocale() === 'zh'
    ? {
        unavailable: '未连接 dsh，无法提交回答',
        timeout: '提交回答超时，请重试',
        duplicate: '回答请求编号重复，请重试',
        disconnected: 'dsh 连接已断开，请重新连接后再试',
      }
    : {
        unavailable: 'dsh is not connected, so the answer could not be sent',
        timeout: 'Sending the answer timed out. Try again.',
        duplicate: 'The answer request ID was duplicated. Try again.',
        disconnected: 'The dsh connection was lost. Reconnect and try again.',
      }
}

function cancelPendingApprovals(): void {
  approvals.cancelAll()
}

function summarizeTab(tab: chrome.tabs.Tab): AffinityTab | null {
  if (tab.id === undefined) return null
  return {
    tabId: tab.id,
    windowId: tab.windowId,
    title: tab.title ?? '',
    url: tab.url ?? '',
  }
}

function storedAffinity(): StoredTabAffinity | null {
  const state = tabAffinity.snapshot()
  if (state.controlled !== null) {
    return {
      controlledTabId: state.controlled.tabId,
      ...(state.status === 'background' && state.active !== null
        ? { keptActiveTabId: state.active.tabId }
        : {}),
    }
  }
  return state.status === 'lost' ? { lost: true } : null
}

function persistTabAffinity(): void {
  const record = storedAffinity()
  const serialized = JSON.stringify(record)
  if (serialized === lastPersistedAffinity) return
  lastPersistedAffinity = serialized
  affinityPersistence = affinityPersistence.catch(() => {}).then(async () => {
    if (record === null) await chrome.storage.session.remove(TAB_AFFINITY_STORAGE_KEY)
    else await chrome.storage.session.set({ [TAB_AFFINITY_STORAGE_KEY]: record })
  }).catch(() => {
    if (lastPersistedAffinity === serialized) lastPersistedAffinity = undefined
  })
}

function observeActiveSummary(summary: AffinityTab): void {
  const previousStatus = tabAffinity.snapshot().status
  if (!tabAffinity.observeActive(summary)) return
  if (previousStatus !== 'handoff' && tabAffinity.snapshot().status === 'handoff') {
    activeFollowRefresh?.abort()
    cancelPendingApprovals()
  }
  persistTabAffinity()
  broadcastTabAffinity()
}

function observeActiveTab(tab: chrome.tabs.Tab): void {
  const summary = summarizeTab(tab)
  if (summary !== null) observeActiveSummary(summary)
}

/**
 * The last window that held a real page. Only consulted where the panel lives
 * in a window of its own: there Chrome's last-focused window is the panel
 * itself while the user types in it, which must never become the tool target.
 *
 * Persisted for the same reason the panel window is: an MV3 restart while the
 * popup is open would otherwise forget which window the user came from, and
 * the popup still answers as the last-focused one.
 */
const BROWSER_WINDOW_STORAGE_KEY = 'dshBrowserWindow'

let lastBrowserWindowId: number | undefined

function rememberBrowserWindow(windowId: number | undefined): void {
  if (lastBrowserWindowId === windowId) return
  lastBrowserWindowId = windowId
  try {
    void (windowId === undefined
      ? chrome.storage.session.remove(BROWSER_WINDOW_STORAGE_KEY)
      : chrome.storage.session.set({ [BROWSER_WINDOW_STORAGE_KEY]: windowId })
    ).catch(() => {})
  } catch {
    // Persistence is a convenience; losing it costs a widened query, not correctness.
  }
}

async function restoreBrowserWindow(): Promise<void> {
  try {
    const stored = await chrome.storage.session.get(BROWSER_WINDOW_STORAGE_KEY)
    const id: unknown = stored[BROWSER_WINDOW_STORAGE_KEY]
    if (typeof id === 'number' && Number.isInteger(id) && id >= 0) lastBrowserWindowId = id
  } catch {
    // Same as above.
  }
}

function activeTabQuery(windowId?: number): chrome.tabs.QueryInfo {
  if (windowId !== undefined) return { active: true, windowId }
  if (hasPanelWindow() && lastBrowserWindowId !== undefined) {
    return { active: true, windowId: lastBrowserWindowId }
  }
  return { active: true, lastFocusedWindow: true }
}

/**
 * The active tab, never the panel's own document. A remembered browser window
 * can have closed since it was recorded, so a guess that finds nothing widens
 * to any normal window rather than reporting no active tab while one is open.
 * An explicit `windowId` is the caller's choice and is never widened.
 */
async function queryActiveBrowserTab(
  windowId: number | undefined,
  signal?: AbortSignal,
): Promise<chrome.tabs.Tab | undefined> {
  const run = async (query: chrome.tabs.QueryInfo): Promise<chrome.tabs.Tab | undefined> => {
    const tabs = chrome.tabs.query(query)
    const resolved = signal === undefined ? await tabs : await abortable(tabs, signal)
    // Fail closed rather than bind browser tools to the panel's own document.
    return resolved.find((candidate) => !isPanelDocument(candidate.url))
  }

  const found = await run(activeTabQuery(windowId))
  if (found !== undefined || windowId !== undefined) return found

  // Last resort. windowType excludes the panel popup, so this can only answer
  // with a page, but it answers for every normal window at once. Binding to an
  // arbitrary one would move browser control silently, which this codebase
  // never does on an ambiguous signal, so only an unambiguous answer counts.
  const tabs = chrome.tabs.query({ active: true, windowType: 'normal' })
  const resolved = signal === undefined ? await tabs : await abortable(tabs, signal)
  const pages = resolved.filter((candidate) => !isPanelDocument(candidate.url))
  return pages.length === 1 ? pages[0] : undefined
}

async function syncActiveTab(windowId?: number, signal?: AbortSignal): Promise<chrome.tabs.Tab | undefined> {
  const queryRevision = focusedWindow.beginQuery()
  try {
    const tab = await queryActiveBrowserTab(windowId, signal)
    if (signal !== undefined) throwIfRebindAborted(signal)
    if (tab === undefined) return undefined
    if (!focusedWindow.commitQuery(tab.windowId, queryRevision)) return undefined
    if (signal !== undefined) throwIfRebindAborted(signal)
    rememberBrowserWindow(tab.windowId)
    observeActiveTab(tab)
    return tab
  } catch {
    if (signal !== undefined && signal.aborted) throw rebindAbortReason(signal)
    return undefined
  }
}

async function restoreTabAffinity(): Promise<void> {
  // Before any sync: the first one runs inside this function.
  await restoreBrowserWindow()
  let record: StoredTabAffinity | null = null
  try {
    const stored = await chrome.storage.session.get(TAB_AFFINITY_STORAGE_KEY)
    const candidate = stored[TAB_AFFINITY_STORAGE_KEY] as Partial<StoredTabAffinity> | undefined
    const controlledTabId = (candidate as { controlledTabId?: unknown } | undefined)?.controlledTabId
    if (typeof controlledTabId === 'number' && Number.isInteger(controlledTabId) && controlledTabId >= 0) {
      const keptActiveTabId = (candidate as { keptActiveTabId?: unknown }).keptActiveTabId
      record = {
        controlledTabId,
        ...(typeof keptActiveTabId === 'number' && Number.isInteger(keptActiveTabId) && keptActiveTabId >= 0
          ? { keptActiveTabId }
          : {}),
      }
    } else if ((candidate as { lost?: unknown } | undefined)?.lost === true) {
      record = { lost: true }
    }
    lastPersistedAffinity = candidate === undefined || record !== null
      ? JSON.stringify(record)
      : undefined
  } catch {
    // Session storage is a survival aid, not a reason to disable the bridge.
  }

  if (record !== null && 'controlledTabId' in record) {
    try {
      const controlled = summarizeTab(await chrome.tabs.get(record.controlledTabId))
      if (controlled === null) tabAffinity.restoreLost()
      else tabAffinity.restoreControlled(controlled)
    } catch {
      tabAffinity.restoreLost()
    }
  } else if (record?.lost === true) {
    tabAffinity.restoreLost()
  }

  await syncActiveTab()
  if (record !== null && 'keptActiveTabId' in record) {
    const state = tabAffinity.snapshot()
    if (state.status === 'handoff' && state.active?.tabId === record.keptActiveTabId) {
      tabAffinity.decide('keep', state.revision)
    }
  }
  persistTabAffinity()
  broadcastTabAffinity()
}

const affinityReady = restoreTabAffinity()

/** Bind at prompt submission so a switch while the model is thinking is visible. */
async function ensureInitialTabBinding(): Promise<boolean> {
  await affinityReady
  if (tabAffinity.resolveTarget().kind !== 'initial') return true
  try {
    const tab = await syncActiveTab()
    const summary = tab === undefined ? null : summarizeTab(tab)
    if (summary === null) return false
    if (tabAffinity.bindInitial(summary)) {
      persistTabAffinity()
      broadcastTabAffinity()
    }
    return true
  } catch {
    return false
  }
}

function affinityFailure(kind: 'handoff' | 'lost' | 'missing'): ToolAnswer {
  if (kind === 'handoff') {
    return {
      ok: false,
      error: { code: 'action-failed', message: 'The user switched tabs, so browser operations are paused. In the side panel, choose whether to keep the previous page or follow the current page.' },
    }
  }
  if (kind === 'lost') {
    return {
      ok: false,
      error: { code: 'content-unavailable', message: 'The controlled tab was closed. Select the current page in the side panel before retrying.' },
    }
  }
  return { ok: false, error: { code: 'no-active-tab', message: 'No active tab is available for browser operations.' } }
}

/** Resolve one stable tab target without allowing a manual switch to drift it. */
async function resolveToolTab(): Promise<Pick<chrome.tabs.Tab, 'id' | 'url' | 'windowId'> | ToolAnswer> {
  await affinityReady
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const resolution = tabAffinity.resolveTarget()
    if (resolution.kind === 'handoff') return affinityFailure('handoff')
    if (resolution.kind === 'lost') return affinityFailure('lost')
    if (resolution.kind === 'initial') {
      if (!await ensureInitialTabBinding()) return affinityFailure('missing')
      continue
    }
    try {
      const tab = await chrome.tabs.get(resolution.tab.tabId)
      const summary = summarizeTab(tab)
      if (summary === null) return affinityFailure('missing')
      if (tabAffinity.observeTab(summary)) broadcastTabAffinity()
      const current = tabAffinity.resolveTarget()
      if (current.kind === 'handoff') return affinityFailure('handoff')
      if (current.kind === 'lost') return affinityFailure('lost')
      if (current.kind === 'target' && current.tab.tabId === summary.tabId) return tab
    } catch {
      if (tabAffinity.removeTab(resolution.tab.tabId)) {
        cancelPendingApprovals()
        persistTabAffinity()
        broadcastTabAffinity()
      }
      return affinityFailure('lost')
    }
  }
  return affinityFailure('handoff')
}

async function authorizeToolCall(
  prompt: ApprovalPrompt,
  signal: AbortSignal,
  windowId: number,
  sessionId?: string,
): Promise<ApprovalAuthorization> {
  if (signal.aborted) return 'cancelled'
  if (actionCoveredByTrustedOrigins(
    prompt,
    sessionTrustedActionOrigins,
    settings.trustedActionOrigins,
  )) {
    return 'approved'
  }
  const result: ApprovalRequestResult = await approvals.request(prompt, signal, windowId, sessionId)
  if (signal.aborted) return 'cancelled'
  if (result.status !== 'decision') return result.status
  const { decision } = result
  if (decision === 'always-allow-reads' && prompt.kind === 'read') {
    await persistSettings({ sharePageContent: 'auto' })
    return 'approved'
  }
  if (decision === 'trust-session' && prompt.kind === 'action' && prompt.canTrust && prompt.origins.length === 1) {
    sessionTrustedActionOrigins.add(prompt.origins[0]!)
    return 'approved'
  }
  // Retain wire compatibility with panels from the previous build. The new UI
  // manages permanent trust explicitly in Settings instead of offering it in
  // the action dialog.
  if (decision === 'trust-origin' && prompt.kind === 'action' && prompt.canTrust && prompt.origins.length === 1) {
    await persistSettings({ trustedActionOrigins: [...settings.trustedActionOrigins, prompt.origins[0]!] })
    return 'approved'
  }
  return decision === 'allow-once' ? 'approved' : 'denied'
}

/** Capture the newly controlled tab and seed it into this session's next Agent step. */
async function refreshFollowedPage(sessionId: string, tabId: number): Promise<void> {
  activeFollowRefresh?.abort()
  const controller = new AbortController()
  activeFollowRefresh = controller
  try {
    const target = await resolveToolTab()
    if ('ok' in target || target.id !== tabId || controller.signal.aborted) return
    const budget = caps === null
      ? undefined
      : { maxItems: caps.maxInteractiveItems, maxChars: caps.snapshotMaxChars }
    const answer = await dispatchToolCall(
      { id: crypto.randomUUID(), name: 'browser_snapshot', args: {} },
      settings.sharePageContent,
      budget,
      (prompt) => authorizeToolCall(prompt, controller.signal, target.windowId, sessionId),
      controller.signal,
      target,
      () => target.id !== undefined && tabAffinity.allowsTarget(target.id),
    )
    if (!answer.ok || controller.signal.aborted || !tabAffinity.allowsTarget(tabId)) return
    if (typeof answer.result !== 'object' || answer.result === null) return
    const snapshot = (answer.result as { text?: unknown }).text
    if (typeof snapshot !== 'string' || snapshot.trim() === '') return
    await gatewayRpc(BRIDGE_INJECT_BROWSER_SNAPSHOT_METHOD, { sessionId, snapshot })
  } finally {
    if (activeFollowRefresh === controller) activeFollowRefresh = null
  }
}

async function resolveTabAffinityResponse(response: {
  revision: number
  decision: TabAffinityDecision
  sessionId: unknown
}): Promise<void> {
  await affinityReady
  await syncActiveTab()
  const accepted = tabAffinity.decide(response.decision, response.revision)
  const controlled = accepted && response.decision === 'follow'
    ? tabAffinity.snapshot().controlled
    : null
  if (controlled !== null) resetTabSnapshot(controlled.tabId)
  if (accepted) persistTabAffinity()
  broadcastTabAffinity()
  if (controlled !== null && typeof response.sessionId === 'string' && response.sessionId.trim() !== '') {
    await refreshFollowedPage(response.sessionId, controlled.tabId)
  }
}

/** Move browser control to the current tab only after a fresh, valid query. */
async function rebindTabAffinityToActive(signal: AbortSignal): Promise<void> {
  await abortable(affinityReady, signal)
  const tab = await syncActiveTab(undefined, signal)
  throwIfRebindAborted(signal)
  const summary = tab === undefined ? null : summarizeTab(tab)
  if (summary === null) {
    throw new TabAffinityRebindError('no-active-tab', getUiLocale() === 'zh'
      ? '无法确定当前标签页，原会话和标签页绑定保持不变'
      : 'The current tab could not be determined; the existing session and tab binding were left unchanged')
  }

  const previousControlledTabId = tabAffinity.snapshot().controlled?.tabId
  activeFollowRefresh?.abort()
  cancelAllToolCalls()
  cancelPendingApprovals()
  tabAffinity.rebindActive(summary)
  if (previousControlledTabId !== undefined && previousControlledTabId !== summary.tabId) {
    resetTabSnapshot(previousControlledTabId)
  }
  resetTabSnapshot(summary.tabId)
  persistTabAffinity()
  broadcastTabAffinity()
}

/** 把协商的快照预算下发到受控页（尚未绑定时使用活动页）。 */
async function pushBudgetToControlledTab(negotiated: BridgeCaps): Promise<void> {
  await affinityReady
  const resolution = tabAffinity.resolveTarget()
  const tabId = resolution.kind === 'target'
    ? resolution.tab.tabId
    : resolution.kind === 'initial'
      ? (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id
      : undefined
  if (tabId === undefined) return
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: 'DSH_BUDGET',
      budget: { maxItems: negotiated.maxInteractiveItems, maxChars: negotiated.snapshotMaxChars },
    })
  } catch {
    // 页面尚未注入 content script：下一次快照仍用默认预算，可接受。
  }
}

/** Route one tool.call frame to the user-approved controlled tab. */
function routeToolCall(call: ToolCall): void {
  if (bridge === null) return
  recentSession.remember(call.sessionId)
  activeToolCalls.get(call.id)?.abort()
  const controller = new AbortController()
  activeToolCalls.set(call.id, controller)
  const expiryTimer = call.expiresAt === undefined
    ? undefined
    : setTimeout(() => { controller.abort() }, Math.max(0, call.expiresAt - Date.now()))
  const budget = caps === null
    ? undefined
    : { maxItems: caps.maxInteractiveItems, maxChars: caps.snapshotMaxChars }
  void resolveToolTab().then((target) => 'ok' in target
    ? target
    : dispatchToolCall(
        call,
        settings.sharePageContent,
        budget,
        (prompt) => authorizeToolCall(prompt, controller.signal, target.windowId, call.sessionId),
        controller.signal,
        target,
        () => target.id !== undefined && tabAffinity.allowsTarget(target.id),
      )).then(
    (answer) => {
      if (controller.signal.aborted) return
      const socket = bridge
      if (socket === null) return
      if (answer.ok) {
        socket.send({ t: 'tool.result', id: call.id, ok: true, result: answer.result })
      } else {
        socket.send({ t: 'tool.result', id: call.id, ok: false, error: answer.error! })
      }
    },
    (error: unknown) => {
      if (controller.signal.aborted) return
      bridge?.send({
        t: 'tool.result',
        id: call.id,
        ok: false,
        error: { code: 'internal', message: error instanceof Error ? error.message : String(error) },
      })
    },
  ).finally(() => {
    if (expiryTimer !== undefined) clearTimeout(expiryTimer)
    if (activeToolCalls.get(call.id) === controller) activeToolCalls.delete(call.id)
  })
}

function cancelToolCall(id: string): void {
  activeToolCalls.get(id)?.abort()
}

function cancelAllToolCalls(): void {
  for (const controller of activeToolCalls.values()) controller.abort()
  activeToolCalls.clear()
}

/** (Re)start the bridge with the current settings. 零配置：地址留空时自动探测；回环连接无需 token。 */
async function startBridge(): Promise<void> {
  const revision = ++bridgeStartRevision
  if (panelPorts.size === 0) return
  let url = settings.bridgeUrl
  if (url === '') {
    url = await discoverBridge(() => revision === bridgeStartRevision && panelPorts.size > 0) ?? ''
  }
  // Discovery is asynchronous. A panel may have closed or a newer settings
  // update may have started while its fetches were in flight.
  if (revision !== bridgeStartRevision || panelPorts.size === 0) return
  if (url === '') {
    bridge?.stop()
    bridge = null
    rpc = null
    broadcastStatus()
    return
  }
  // 手动填的地址常只有主机部分（如 ws://127.0.0.1:3080）；桥路径是协议
  // 常量，缺省时自动补全，避免连到根路径失败。
  try {
    const parsed = new URL(url)
    if (parsed.pathname === '' || parsed.pathname === '/') parsed.pathname = BRIDGE_PATH
    url = parsed.toString()
  } catch {
    // 非法 URL 原样交给 WebSocket 构造函数报错。
  }
  if (bridge === null) {
    const client = new BridgeClient({
      onStateChange: (state) => {
        if (state !== 'connected') {
          cancelAllToolCalls()
          interactionResponses.failAll(responseMessages().disconnected)
          transientEvents.clear()
        }
        broadcastStatus()
        if (state === 'stopped' && panelPorts.size === 0) disarmBridgeKeepalive()
      },
      onFrame: (frame) => {
        if (frame.t === 'event') {
          recentSession.noteActivity(sessionIdFromFrame(frame))
          transientEvents.ingest(frame)
          broadcastEvent(frame)
        }
        else if (frame.t === 'tool.call') routeToolCall(frame)
        else if (frame.t === 'tool.cancel') cancelToolCall(frame.id)
        else if (frame.t === 'respond.result') interactionResponses.route(frame)
        // rpc.result is settled by the rpc facade (wrapped below).
      },
      onHelloOk: (negotiated) => {
        caps = negotiated
        broadcastStatus()
        void pushBudgetToControlledTab(negotiated)
      },
    }, probeBridge, () => panelPorts.size > 0)
    bridge = client
    rpc = createRpc(client)
  }
  bridge.start(url, settings.token)
}

/** Gateway RPC with a helpful error when the bridge is down. */
async function gatewayRpc(method: string, payload: unknown): Promise<unknown> {
  if (rpc === null || bridge === null || !bridge.connected) {
    throw new Error(getUiLocale() === 'zh'
      ? '未连接 dsh（请检查设置中的地址与 token）'
      : 'dsh is not connected (check the bridge address and token in Settings)')
  }
  return rpc.request(method, payload)
}

// ---- Panel ports ----

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'dsh-panel') return
  const wasIdle = panelPorts.size === 0
  const tabAffinityRebinds = new Map<string, {
    controller: AbortController
    timer: ReturnType<typeof setTimeout>
  }>()
  panelPorts.add(port)
  if (wasIdle) armBridgeKeepalive()
  void settingsReady.then(() => {
    if (!panelPorts.has(port)) return
    if (bridge === null || bridge.state === 'stopped') return startBridge()
  })
  try { port.postMessage({ type: 'status', state: bridge?.state ?? ('stopped' as BridgeState), caps }) } catch { /* port closed */ }
  void affinityReady.then(async () => {
    await syncActiveTab()
    try { port.postMessage({ type: 'tab-affinity', state: tabAffinity.snapshot() }) } catch { /* port closed */ }
  })
  port.onMessage.addListener((message: unknown) => {
    if (typeof message !== 'object' || message === null) return
    const msg = message as { type?: string }
    switch (msg.type) {
      case 'rpc': {
        const rpcMsg = message as { id: string; method: string; payload?: unknown }
        const refresh = followedPageRefresh
        const prepare = rpcMsg.method === 'session.prompt'
          ? ensureInitialTabBinding().then(async (bound) => {
              await refresh
              return bound
            })
          : Promise.resolve(true)
        void prepare.then(() => gatewayRpc(rpcMsg.method, rpcMsg.payload)).then(
          (result) => {
            try { port.postMessage({ type: 'rpc.result', id: rpcMsg.id, ok: true, result }) } catch { /* port closed */ }
          },
          (error: unknown) => {
            try {
              port.postMessage({
                type: 'rpc.result',
                id: rpcMsg.id,
                ok: false,
                error: { code: 'bridge-unavailable', message: error instanceof Error ? error.message : String(error) },
              })
            } catch { /* port closed */ }
          },
        )
        break
      }
      case 'respond': {
        const response = message as { id?: unknown; rpcId?: unknown; result?: unknown }
        if (typeof response.id !== 'string' || typeof response.rpcId !== 'string' || !isRespondResult(response.result)) break
        const messages = responseMessages()
        interactionResponses.begin(
          port,
          response.id,
          () => bridge?.send({
            t: 'respond',
            id: response.id as string,
            rpcId: response.rpcId as string,
            result: response.result as RespondResult,
          }) === true,
          messages,
        )
        break
      }
      case 'settings': {
        const settingsMsg = message as { settings: Partial<Settings> }
        void settingsReady.then(async () => {
          const previousConnection = { bridgeUrl: settings.bridgeUrl, token: settings.token }
          await persistSettings(settingsMsg.settings)
          if (panelPorts.size > 0) {
            await startBridge()
            broadcastStatus()
            return
          }
          const connectionChanged = settings.bridgeUrl !== previousConnection.bridgeUrl
            || settings.token !== previousConnection.token
          if (!connectionChanged) return
          // The settings write outlived its originating panel. Do not keep a
          // healthy socket authenticated with stale connection settings: make
          // the next explicit panel lease start from the persisted values.
          bridgeStartRevision += 1
          bridge?.stop()
          bridge = null
          rpc = null
          caps = null
          broadcastStatus()
          disarmBridgeKeepalive()
        })
        break
      }
      case 'session.active': {
        const session = message as { sessionId?: unknown }
        recentSession.remember(session.sessionId)
        break
      }
      case 'approval.response': {
        const approval = message as { id?: unknown; decision?: unknown }
        if (typeof approval.id === 'string' && isApprovalDecision(approval.decision)) {
          approvals.respond(approval.id, approval.decision)
        }
        break
      }
      case 'tab-affinity.response': {
        const response = message as { revision?: unknown; decision?: unknown; sessionId?: unknown }
        if (typeof response.revision !== 'number'
          || (response.decision !== 'keep' && response.decision !== 'follow')) break
        const decision = resolveTabAffinityResponse({
          revision: response.revision,
          decision: response.decision,
          sessionId: response.sessionId,
        })
        if (response.decision === 'follow') followedPageRefresh = decision.catch(() => {})
        void decision.catch(() => {})
        break
      }
      case 'tab-affinity.rebind': {
        const request = message as { id?: unknown }
        if (typeof request.id !== 'string') break
        const requestId = request.id
        if (tabAffinityRebinds.has(requestId)) break
        const controller = new AbortController()
        const timer = setTimeout(() => {
          controller.abort(new TabAffinityRebindError('timeout', getUiLocale() === 'zh'
            ? '绑定当前标签页超时，请重试'
            : 'Binding the current tab timed out. Try again.'))
        }, TAB_AFFINITY_REBIND_TIMEOUT_MS)
        tabAffinityRebinds.set(requestId, { controller, timer })
        void rebindTabAffinityToActive(controller.signal).then(
          () => {
            try { port.postMessage({ type: 'tab-affinity.rebind.result', id: requestId, ok: true }) } catch { /* port closed */ }
          },
          (error: unknown) => {
            try {
              port.postMessage({
                type: 'tab-affinity.rebind.result',
                id: requestId,
                ok: false,
                error: {
                  code: error instanceof TabAffinityRebindError ? error.code : 'no-active-tab',
                  message: error instanceof Error ? error.message : String(error),
                },
              })
            } catch { /* port closed */ }
          },
        ).finally(() => {
          const current = tabAffinityRebinds.get(requestId)
          if (current?.controller !== controller) return
          clearTimeout(current.timer)
          tabAffinityRebinds.delete(requestId)
        })
        break
      }
      case 'request-status':
        try {
          port.postMessage({ type: 'status', state: bridge?.state ?? ('stopped' as BridgeState), caps })
          port.postMessage({ type: 'tab-affinity', state: tabAffinity.snapshot() })
          for (const frame of transientEvents.replay()) port.postMessage({ type: 'event', frame })
          approvals.replay((request) => {
            port.postMessage({ type: 'approval.request', request })
            return true
          })
          void recentSession.ready.then(() => {
            try {
              port.postMessage({ type: 'session.resume-hint', sessionId: recentSession.current() })
            } catch { /* port closed */ }
          })
        } catch { /* port closed */ }
        break
    }
  })
  port.onDisconnect.addListener(() => {
    for (const operation of tabAffinityRebinds.values()) {
      clearTimeout(operation.timer)
      operation.controller.abort(new TabAffinityRebindError('cancelled', getUiLocale() === 'zh'
        ? '后台连接已断开，标签页绑定已取消'
        : 'The background connection was lost, so tab binding was cancelled'))
    }
    tabAffinityRebinds.clear()
    panelPorts.delete(port)
    interactionResponses.removePort(port)
    if (panelPorts.size === 0) {
      bridgeStartRevision += 1
      bridge?.suspendReconnect()
      sessionTrustedActionOrigins.clear()
      approvals.notifyPending()
      if (bridge?.state !== 'connected') disarmBridgeKeepalive()
    }
  })
})

chrome.notifications.onClicked.addListener((notificationId) => {
  if (!notificationId.startsWith(APPROVAL_NOTIFICATION_PREFIX)) return
  const id = notificationId.slice(APPROVAL_NOTIFICATION_PREFIX.length)
  const windowId = approvals.windowId(id)
  if (windowId === undefined) return
  clearApprovalNotification(id)
  // Notification clicks are extension user gestures; every panel API requires
  // the call to remain inside this handler.
  void openAssistantPanel(windowId)
})

// ---- Tab affinity ----

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  // The panel window's own tab is never a page to control. acceptActivation
  // already rejects it while the tracker points elsewhere; this states it.
  if (isPanelWindow(windowId)) return
  void affinityReady.then(() => {
    const activationRevision = focusedWindow.acceptActivation(windowId)
    if (activationRevision === null) return
    // Mark the switch before awaiting metadata so an already-running trusted
    // action cannot slip through the handoff boundary.
    observeActiveSummary({ tabId, windowId, title: '', url: '' })
    return chrome.tabs.get(tabId).then((tab) => {
      if (focusedWindow.isCurrent(activationRevision)) observeActiveTab(tab)
    }).catch(() => {})
  })
})

chrome.tabs.onUpdated.addListener((tabId, _changeInfo, tab) => {
  void affinityReady.then(() => {
    if (!tabAffinity.tracks(tabId)) return
    const summary = summarizeTab(tab)
    if (summary !== null && tabAffinity.observeTab(summary)) broadcastTabAffinity()
  })
})

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  void affinityReady.then(() => {
    // onReplaced is an identity swap (for example prerender activation), not
    // a close or user-visible switch. Transfer IDs synchronously before any
    // metadata lookup so tool resolution never observes the removed target.
    const controlledReplaced = tabAffinity.snapshot().controlled?.tabId === removedTabId
    if (!tabAffinity.replaceTab(removedTabId, addedTabId)) return
    // Only work targeting the replaced controlled page is stale. Replacing a
    // merely visible background-affinity tab must not cancel work on the
    // separately controlled page.
    if (controlledReplaced) {
      activeFollowRefresh?.abort()
      cancelPendingApprovals()
    }
    resetTabSnapshot(removedTabId)
    resetTabSnapshot(addedTabId)
    persistTabAffinity()
    broadcastTabAffinity()
    return chrome.tabs.get(addedTabId).then((tab) => {
      const summary = summarizeTab(tab)
      if (summary !== null && tabAffinity.observeTab(summary)) broadcastTabAffinity()
    }).catch(() => {})
  })
})

chrome.tabs.onRemoved.addListener((tabId) => {
  void affinityReady.then(() => {
    if (!tabAffinity.removeTab(tabId)) return
    activeFollowRefresh?.abort()
    cancelPendingApprovals()
    persistTabAffinity()
    broadcastTabAffinity()
  })
})

function trackFocusedWindow(windowId: number): void {
  // Marking the panel's own window focused is what would let its activation
  // through: tabs.onActivated marks a switch before it has any URL to reject,
  // so the guard has to be here, where the window is still identifiable.
  if (isPanelWindow(windowId)) return
  focusedWindow.markFocused(windowId)
  void affinityReady.then(() => syncActiveTab(windowId))
}

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return
  // The browser focuses a new panel window before windows.create resolves, so
  // mid-open this window has no id to compare against yet. Wait for it.
  if (hasPanelWindow() && !isPanelWindow(windowId)) {
    void panelWindowSettled().then(() => { trackFocusedWindow(windowId) })
    return
  }
  trackFocusedWindow(windowId)
})

// ---- Keepalive ----

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== BRIDGE_KEEPALIVE_ALARM) return
  if (panelPorts.size === 0) {
    if (bridge === null || bridge.state !== 'connected') disarmBridgeKeepalive()
    return
  }
  // `stopped` is intentionally terminal until an explicit panel reopen or
  // settings save. In particular, code 4000 means another browser owns the
  // single bridge slot and the keepalive must not reclaim it.
  if (bridge === null || bridge.state === 'reconnecting') {
    void settingsReady.then(() => startBridge())
  }
})

// ---- Boot ----

// Open the panel when the toolbar icon is clicked. Chrome opens its side panel
// itself; Firefox and Opera deliver action.onClicked instead, so the listener is
// registered for every build and openAssistantPanel picks the host at runtime.
preferPanelOnActionClick()
chrome.action.onClicked.addListener((tab) => {
  // Record the window the click came from before any panel window can steal focus.
  if (tab.windowId !== undefined) rememberBrowserWindow(tab.windowId)
  void openAssistantPanel(tab.windowId)
})
chrome.windows.onRemoved.addListener((windowId) => {
  forgetPanelWindow(windowId)
  // A closed window cannot answer an active-tab query; drop it so the next
  // sync widens instead of targeting a window that is gone.
  if (lastBrowserWindowId === windowId) rememberBrowserWindow(undefined)
})

// Alarms survive some extension/service-worker restarts. Remove any stale
// schedule left by an older eager-connection build; onConnect re-arms it.
disarmBridgeKeepalive()

// `settingsReady` intentionally has no bridge-start continuation: opening a
// side panel is the first action allowed to claim the bridge connection.
