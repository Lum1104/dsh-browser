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
 *   panel → bg: { type: 'panel.window', windowId }
 *   panel → bg: { type: 'selection.clear', selection? }
 *   panel → bg: { type: 'request-status' }
 *   bg → panel: { type: 'rpc.result', id, ok, result? | error? }
 *   bg → panel: { type: 'respond.result', id, ok, result? | error? }
 *   bg → panel: { type: 'status', state: BridgeState, caps? }
 *   bg → panel: { type: 'event', frame: ServerFrame }
 *   bg → panel: { type: 'approval.request', request }
 *   bg → panel: { type: 'approval.resolved', id }
 *   bg → panel: { type: 'session.resume-hint', sessionId }
 *   bg → panel: { type: 'selection', selection }
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
import {
  approvalFailure,
  dispatchToolCall,
  resetTabSnapshot,
  type ContentBudget,
  type ToolAnswer,
  type ToolCall,
} from './tools.ts'
import { parseTabsRequest, runTabsAction, TabsError, type TabsDeps } from './tabs.ts'
import {
  parseDownloadRequest,
  parseDownloadsRequest,
  runDownload,
  runDownloadsAction,
  DownloadError,
  type DownloadsDeps,
} from './downloads.ts'
import {
  parseReadPagesRequest,
  parseSearchRequest,
  requestOrigins,
  runReadPages,
  runSearch,
  ResearchError,
  searchUrl,
  type ResearchDeps,
} from './research.ts'
import { chromeTrustedInputDeps, trustedClick, TrustedInputError } from './trusted-input.ts'
import {
  chromeInspectDeps,
  renderInspection,
  startInspection,
  InspectError,
  type InspectionSession,
} from './inspect.ts'
import {
  downloadApprovalPrompt,
  evaluateApprovalPrompt,
  inspectApprovalPrompt,
  researchApprovalPrompt,
  tabsApprovalPrompt,
  verifyApprovalPrompt,
} from './authorization.ts'
import { chromeEvaluateDeps, EvaluateError, evaluateOnTab } from './evaluate.ts'
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
import { SelectionTracker, type SelectionSource } from './selection.ts'
import { parsePageSelection, parseSelectionCapture } from '../selection.ts'
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
  /**
   * Approve state-changing browser actions without asking.
   *
   * Default ON, matching the posture of a local single-user deployment: the
   * assistant already drives this browser on the user's behalf, and a dialog
   * per click trains the user to click through rather than to read. Turning it
   * off restores the per-action prompt and the trusted-origin allowlist, which
   * remain fully implemented.
   */
  autoApproveActions: boolean
}

const SETTINGS_DEFAULTS: Settings = {
  // 空地址 = 自动探测本机 dsh（零配置）；手动填地址时优先手动。
  bridgeUrl: '',
  token: '',
  sharePageContent: 'auto',
  trustedActionOrigins: [],
  approvalNotifications: true,
  autoResumeSession: true,
  autoApproveActions: true,
}

/**
 * 自动探测的候选端口：
 * - dsh web（CLI）默认 3080，端口被占时依次回退 3081 / 3090；
 * - DSH Desktop 默认由系统随机分配本地 Web 端口（`dsh-desktop.port: 0`），
 *   用户指南推荐固定为 43189（见 deepseek-harness-desktop docs/user-guide）；
 * - 14389 为历史桌面应用端口，保留兼容旧版。
 */
const DISCOVERY_PORTS = [3080, 3081, 3090, 14389, 43189]
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
  | { controlledTabId: number; keptActiveTabId?: number; sessionTabs?: Record<string, AffinityTab>; focusedSessionId?: string }
  | { lost: true; sessionTabs?: Record<string, AffinityTab>; focusedSessionId?: string }

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
const selections = new SelectionTracker()
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
/** Per-session snapshot refreshes preserve prompt ordering without cross-session cancellation. */
const sessionSnapshotRefreshes = new Map<string, Promise<void>>()
const activeFollowRefreshes = new Map<string, AbortController>()
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
    autoApproveActions: candidate.autoApproveActions !== false,
  }
}

/** Settings load is shared by every lazy connection trigger. */
let settingsLoaded = false
const settingsReady = loadSettings().then((loaded) => {
  settings = loaded
  settingsLoaded = true
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

/** Which window each panel port belongs to, so a quote stays in its window. */
const panelWindows = new WeakMap<chrome.runtime.Port, number>()

/**
 * Send one window's selection to that window's panels only.
 *
 * A panel must never be offered a quote from a page its own window is not
 * looking at, which also keeps an incognito window's highlight out of a
 * normal window's composer.
 */
function broadcastSelection(windowId: number): void {
  const payload = { type: 'selection', selection: selections.current(windowId) }
  for (const port of panelPorts) {
    if (panelWindows.get(port) !== windowId) continue
    try { port.postMessage(payload) } catch { /* port already closed */ }
  }
}

function broadcastSelections(windowIds: readonly number[]): void {
  for (const windowId of windowIds) broadcastSelection(windowId)
}

/** Whether a window currently has a panel that can display its selection. */
function hasPanelInWindow(windowId: number): boolean {
  for (const port of panelPorts) {
    if (panelWindows.get(port) === windowId) return true
  }
  return false
}

/**
 * Tell a frame its quote is gone so re-selecting the same passage reports it
 * again; the content script deduplicates against the last text it sent.
 */
function resetSelectionDedupe(sources: readonly SelectionSource[]): void {
  for (const { tabId, frameId } of sources) {
    void Promise.resolve(chrome.tabs.sendMessage(
      tabId,
      { type: 'DSH_SELECTION_RESET' },
      { frameId },
    ))
      .catch(() => { /* no content script in this tab */ })
  }
}

/** Whether saved privacy settings currently allow page-selection capture. */
function selectionSharingEnabled(): boolean {
  // Until storage answers, `settings` still holds the defaults. Reporting the
  // default here would arm watchers for a user whose saved choice is `off`.
  return settingsLoaded && settings.sharePageContent !== 'off'
}

/** Page selections are captured only in a window with an open panel. */
function selectionWatchEnabled(windowId: number): boolean {
  return selectionSharingEnabled() && hasPanelInWindow(windowId)
}

let selectionWatchArmed = false
/** Distinguishes revisions issued by different MV3 worker lifetimes. */
const selectionWatchEpoch = crypto.randomUUID()
/** Orders arm/disarm commands so a slow delivery cannot undo a newer one. */
let selectionWatchRevision = 0

/**
 * Arm or disarm every content script. `selectionchange` fires on each drag in
 * each tab, so the watcher stays off until a panel can actually show a quote.
 *
 * Delivery is asynchronous, so each command carries a revision: a panel that
 * closes and reopens quickly must not leave watchers in the state of whichever
 * `tabs.query` happened to resolve last.
 */
function syncSelectionWatch(): void {
  const anyEnabled = selectionSharingEnabled()
    && [...panelPorts].some((port) => panelWindows.get(port) !== undefined)
  const wasArmed = selectionWatchArmed
  selectionWatchArmed = anyEnabled
  const revision = ++selectionWatchRevision
  if (wasArmed && !anyEnabled) {
    resetSelectionDedupe(selections.sourcesWithSelection())
    broadcastSelections(selections.clearAll())
  }
  void Promise.resolve(chrome.tabs.query({})).then((tabs) => {
    if (revision !== selectionWatchRevision) return
    for (const tab of tabs) {
      if (tab.id === undefined) continue
      const enabled = selectionWatchEnabled(tab.windowId)
      void Promise.resolve(chrome.tabs.sendMessage(tab.id, {
        type: 'DSH_SELECTION_WATCH',
        enabled,
        epoch: selectionWatchEpoch,
        revision,
      }))
        .catch(() => { /* no content script in this tab */ })
    }
  }).catch(() => {})
}

/**
 * Accept a capture from the page the user is actually looking at.
 *
 * `sender.tab` already carries the tab's window, active state, and incognito
 * flag, so admission needs no `chrome.tabs` call: a background page cannot
 * make the worker query Chrome by moving its own selection in a loop.
 */
function recordSelection(tab: chrome.tabs.Tab, frameId: number, value: unknown): void {
  if (!selectionWatchEnabled(tab.windowId)) return
  // Only the tab the user is looking at, in its own window, may set a quote.
  if (tab.id === undefined || tab.active !== true) return
  const capture = parseSelectionCapture(value)
  if (capture === null) return
  if (selections.capture({ windowId: tab.windowId, tabId: tab.id, frameId }, capture)) {
    broadcastSelection(tab.windowId)
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

function cancelPendingApprovals(sessionId?: string): void {
  approvals.cancelAll(sessionId)
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
  const sessionTabs = tabAffinity.sessionMap()
  const hasSessionTabs = Object.keys(sessionTabs).length > 0
  const focusedSessionId = tabAffinity.focusedSession()
  const focus = focusedSessionId === null ? {} : { focusedSessionId }
  if (state.controlled !== null) {
    return {
      controlledTabId: state.controlled.tabId,
      ...(state.status === 'background' && state.active !== null
        ? { keptActiveTabId: state.active.tabId }
        : {}),
      ...(hasSessionTabs ? { sessionTabs } : {}),
      ...focus,
    }
  }
  return state.status === 'lost'
    ? { lost: true, ...(hasSessionTabs ? { sessionTabs } : {}), ...focus }
    : (hasSessionTabs ? { lost: true, sessionTabs, ...focus } : null)
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
    const focused = tabAffinity.focusedSession()
    if (focused !== null) {
      activeFollowRefreshes.get(focused)?.abort()
      cancelPendingApprovals(focused)
    } else {
      cancelPendingApprovals()
    }
  }
  persistTabAffinity()
  broadcastTabAffinity()
}

function observeActiveTab(tab: chrome.tabs.Tab): void {
  const summary = summarizeTab(tab)
  if (summary !== null) observeActiveSummary(summary)
}

async function syncActiveTab(windowId?: number, signal?: AbortSignal): Promise<chrome.tabs.Tab | undefined> {
  const queryRevision = focusedWindow.beginQuery()
  const query = windowId === undefined
    ? { active: true, lastFocusedWindow: true }
    : { active: true, windowId }
  try {
    const tabs = chrome.tabs.query(query)
    const [tab] = signal === undefined ? await tabs : await abortable(tabs, signal)
    if (signal !== undefined) throwIfRebindAborted(signal)
    if (tab === undefined) return undefined
    if (!focusedWindow.commitQuery(tab.windowId, queryRevision)) return undefined
    if (signal !== undefined) throwIfRebindAborted(signal)
    observeActiveTab(tab)
    return tab
  } catch {
    if (signal !== undefined && signal.aborted) throw rebindAbortReason(signal)
    return undefined
  }
}

async function restoreTabAffinity(): Promise<void> {
  let record: StoredTabAffinity | null = null
  try {
    const stored = await chrome.storage.session.get(TAB_AFFINITY_STORAGE_KEY)
    const candidate = stored[TAB_AFFINITY_STORAGE_KEY] as Partial<StoredTabAffinity> | undefined
    const controlledTabId = (candidate as { controlledTabId?: unknown } | undefined)?.controlledTabId
    const focusedSessionId = (candidate as { focusedSessionId?: unknown } | undefined)?.focusedSessionId
    const focus = typeof focusedSessionId === 'string' && focusedSessionId.trim() !== '' ? { focusedSessionId } : {}
    if (typeof controlledTabId === 'number' && Number.isInteger(controlledTabId) && controlledTabId >= 0) {
      const keptActiveTabId = (candidate as { keptActiveTabId?: unknown }).keptActiveTabId
      const sessionTabs = (candidate as { sessionTabs?: Record<string, AffinityTab> }).sessionTabs
      record = {
        controlledTabId,
        ...(typeof keptActiveTabId === 'number' && Number.isInteger(keptActiveTabId) && keptActiveTabId >= 0
          ? { keptActiveTabId }
          : {}),
        ...(typeof sessionTabs === 'object' && sessionTabs !== null ? { sessionTabs } : {}),
        ...focus,
      }
    } else if ((candidate as { lost?: unknown } | undefined)?.lost === true) {
      const sessionTabs = (candidate as { sessionTabs?: Record<string, AffinityTab> }).sessionTabs
      record = {
        lost: true,
        ...(typeof sessionTabs === 'object' && sessionTabs !== null ? { sessionTabs } : {}),
        ...focus,
      }
    }
    lastPersistedAffinity = candidate === undefined || record !== null
      ? JSON.stringify(record)
      : undefined
  } catch {
    // Session storage is a survival aid, not a reason to disable the bridge.
  }

  if (record?.sessionTabs !== undefined) {
    const restoredSessions: Record<string, AffinityTab> = {}
    for (const [sid, storedTab] of Object.entries(record.sessionTabs)) {
      if (typeof storedTab?.tabId !== 'number' || !Number.isInteger(storedTab.tabId) || storedTab.tabId < 0) continue
      try {
        const live = summarizeTab(await chrome.tabs.get(storedTab.tabId))
        if (live !== null) restoredSessions[sid] = live
      } catch {
        // Closed tabs are deliberately pruned so the session fails closed.
      }
    }
    tabAffinity.restoreSessionTabs(restoredSessions)
  }
  tabAffinity.restoreFocusedSession(record?.focusedSessionId ?? null)

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
async function ensureInitialTabBinding(sessionId?: string): Promise<boolean> {
  await affinityReady
  if (tabAffinity.resolveTarget(sessionId).kind !== 'initial') return true
  try {
    const tab = await syncActiveTab()
    const summary = tab === undefined ? null : summarizeTab(tab)
    if (summary === null) return false
    if (tabAffinity.bindInitial(summary, sessionId)) {
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
async function resolveToolTab(sessionId?: string): Promise<Pick<chrome.tabs.Tab, 'id' | 'url' | 'windowId' | 'active'> | ToolAnswer> {
  await affinityReady
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const resolution = tabAffinity.resolveTarget(sessionId)
    if (resolution.kind === 'handoff') return affinityFailure('handoff')
    if (resolution.kind === 'lost') return affinityFailure('lost')
    if (resolution.kind === 'initial') {
      if (!await ensureInitialTabBinding(sessionId)) return affinityFailure('missing')
      continue
    }
    try {
      const tab = await chrome.tabs.get(resolution.tab.tabId)
      const summary = summarizeTab(tab)
      if (summary === null) return affinityFailure('missing')
      if (tabAffinity.observeTab(summary)) broadcastTabAffinity()
      const current = tabAffinity.resolveTarget(sessionId)
      if (current.kind === 'handoff') return affinityFailure('handoff')
      if (current.kind === 'lost') return affinityFailure('lost')
      if (current.kind === 'target' && current.tab.tabId === summary.tabId) return tab
    } catch {
      const affectedSessions = tabAffinity.sessionIdsForTab(resolution.tab.tabId)
      if (tabAffinity.removeTab(resolution.tab.tabId)) {
        for (const sid of affectedSessions) {
          activeFollowRefreshes.get(sid)?.abort()
          cancelPendingApprovals(sid)
        }
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
  // The frictionless path: no dialog, no allowlist lookup, no round trip to a
  // panel that may not even be open.
  if (settings.autoApproveActions) return 'approved'
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
  activeFollowRefreshes.get(sessionId)?.abort()
  const controller = new AbortController()
  activeFollowRefreshes.set(sessionId, controller)
  try {
    const target = await resolveToolTab(sessionId)
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
      () => target.id !== undefined && tabAffinity.allowsTarget(target.id, sessionId),
    )
    if (!answer.ok || controller.signal.aborted || !tabAffinity.allowsTarget(tabId, sessionId)) return
    if (typeof answer.result !== 'object' || answer.result === null) return
    const snapshot = (answer.result as { text?: unknown }).text
    if (typeof snapshot !== 'string' || snapshot.trim() === '') return
    await gatewayRpc(BRIDGE_INJECT_BROWSER_SNAPSHOT_METHOD, { sessionId, snapshot })
  } finally {
    if (activeFollowRefreshes.get(sessionId) === controller) activeFollowRefreshes.delete(sessionId)
  }
}

async function refreshSessionSnapshot(sessionId: string): Promise<void> {
  await affinityReady
  const target = await resolveToolTab(sessionId)
  if (!('ok' in target) && target.id !== undefined) {
    await refreshFollowedPage(sessionId, target.id)
  }
}

async function resolveTabAffinityResponse(response: {
  revision: number
  decision: TabAffinityDecision
  sessionId: unknown
}): Promise<void> {
  await affinityReady
  await syncActiveTab()
  const sid = typeof response.sessionId === 'string' ? response.sessionId : undefined
  const accepted = tabAffinity.decide(response.decision, response.revision, sid)
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
async function rebindTabAffinityToActive(signal: AbortSignal, sessionId?: string): Promise<void> {
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
  if (sessionId !== undefined) {
    activeFollowRefreshes.get(sessionId)?.abort()
    cancelPendingApprovals(sessionId)
  }
  tabAffinity.rebindActive(summary, sessionId)
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

/** Chrome and affinity seams for `browser_tabs`. */
const tabsDeps: TabsDeps = {
  listTabs: () => chrome.tabs.query({}),
  getTab: (tabId) => chrome.tabs.get(tabId),
  createTab: (url, active) => chrome.tabs.create({ url, active }),
  closeTab: async (tabId) => { await chrome.tabs.remove(tabId) },
  activateTab: async (tabId, windowId) => {
    await chrome.tabs.update(tabId, { active: true })
    await chrome.windows.update(windowId, { focused: true })
  },
  bindControl: (tab) => {
    // The previous page's pending approvals describe work on a page that is no
    // longer the target, so they are withdrawn. In-flight tool calls are NOT
    // cancelled: this runs inside one of them.
    const previous = tabAffinity.snapshot().controlled?.tabId
    activeFollowRefresh?.abort()
    cancelPendingApprovals()
    tabAffinity.bindTool(tab)
    if (previous !== undefined && previous !== tab.tabId) resetTabSnapshot(previous)
    resetTabSnapshot(tab.tabId)
    persistTabAffinity()
    broadcastTabAffinity()
  },
  controlledTabId: () => tabAffinity.snapshot().controlled?.tabId,
}

/** The window an approval dialog for a non-page call should surface in. */
async function approvalWindowId(): Promise<number> {
  const state = tabAffinity.snapshot()
  const known = state.controlled?.windowId ?? state.active?.windowId
  if (known !== undefined) return known
  try {
    return (await chrome.windows.getLastFocused()).id ?? chrome.windows.WINDOW_ID_CURRENT
  } catch {
    return chrome.windows.WINDOW_ID_CURRENT
  }
}

/**
 * Run one `browser_tabs` call. Tab management lives outside the content-script
 * path — it is about the browser, not one page — so it carries its own
 * approval and never resolves a controlled tab first.
 */
async function dispatchTabsCall(call: ToolCall, signal: AbortSignal): Promise<ToolAnswer> {
  await affinityReady
  if (signal.aborted) return cancelledAnswer()
  const prompt = tabsApprovalPrompt(call, settings.sharePageContent)
  if (prompt !== undefined) {
    const authorization = await authorizeToolCall(prompt, signal, await approvalWindowId(), call.sessionId)
    if (authorization !== 'approved') return approvalFailure(prompt, authorization)
  }
  if (signal.aborted) return cancelledAnswer()
  try {
    const text = await runTabsAction(parseTabsRequest(call.args), tabsDeps)
    return { ok: true, result: { text } }
  } catch (error: unknown) {
    if (error instanceof TabsError) return { ok: false, error: { code: error.code, message: error.message } }
    return { ok: false, error: { code: 'action-failed', message: error instanceof Error ? error.message : String(error) } }
  }
}

function cancelledAnswer(): ToolAnswer {
  return { ok: false, error: { code: 'bridge-closed', message: 'The browser tool call was cancelled.' } }
}

/** Chrome seams for `chrome.downloads`. */
const downloadsDeps: DownloadsDeps = {
  start: (options) => chrome.downloads.download(options),
  search: (query) => chrome.downloads.search(query),
  cancel: (id) => chrome.downloads.cancel(id),
  pause: (id) => chrome.downloads.pause(id),
  resume: (id) => chrome.downloads.resume(id),
  show: (id) => { chrome.downloads.show(id) },
}

/** Wait for one tab to finish loading, without polling it. */
function waitForTabLoad(tabId: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (loaded: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      chrome.tabs.onUpdated.removeListener(onUpdated)
      chrome.tabs.onRemoved.removeListener(onRemoved)
      resolve(loaded)
    }
    const onUpdated = (updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo): void => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') finish(true)
    }
    const onRemoved = (removedTabId: number): void => {
      if (removedTabId === tabId) finish(false)
    }
    const timer = setTimeout(() => { finish(false) }, timeoutMs)
    chrome.tabs.onUpdated.addListener(onUpdated)
    chrome.tabs.onRemoved.addListener(onRemoved)
    // The tab may already be complete before the listener was installed.
    void chrome.tabs.get(tabId).then(
      (tab) => { if (tab.status === 'complete') finish(true) },
      () => { finish(false) },
    )
  })
}

/**
 * Ask one tab's content script for an action, injecting the script when the
 * tab predates this build, and unwrapping the answer envelope.
 */
async function askTab(tabId: number, action: string, args: Record<string, unknown>): Promise<{ text?: string } | undefined> {
  const message = { type: 'DSH_ACTION', action, args }
  type Envelope = { ok?: boolean; result?: { text?: string }; error?: { message?: string } } | undefined
  let answer: Envelope
  try {
    answer = await chrome.tabs.sendMessage(tabId, message, { frameId: 0 }) as Envelope
  } catch {
    // A tab opened before this build was loaded has no content script yet.
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] })
    answer = await chrome.tabs.sendMessage(tabId, message, { frameId: 0 }) as Envelope
  }
  if (answer?.ok === false) throw new Error(answer.error?.message ?? 'the page could not be read')
  return answer?.result
}

/** Chrome seams for scratch-tab research. */
const researchDeps: ResearchDeps = {
  openScratchTab: async (url) => {
    const tab = await chrome.tabs.create({ url, active: false })
    if (tab.id === undefined) throw new Error('the background tab could not be opened')
    return tab.id
  },
  closeTab: async (tabId) => { await chrome.tabs.remove(tabId) },
  waitForLoad: waitForTabLoad,
  ask: askTab,
  describeTab: async (tabId) => {
    const tab = await chrome.tabs.get(tabId)
    return { title: (tab.title ?? '').replace(/\s+/g, ' ').trim(), url: tab.url ?? '' }
  },
}

/**
 * Run one call that never touches the controlled page: web search, multi-page
 * reading, and download management. Each carries its own approval, with the
 * destination origins of the WHOLE call in one prompt — a research step that
 * asked five times would just train the user to click through.
 */
async function dispatchProactiveCall(call: ToolCall, signal: AbortSignal): Promise<ToolAnswer> {
  if (signal.aborted) return cancelledAnswer()
  try {
    switch (call.name) {
      case 'browser_search': {
        const request = parseSearchRequest(call.args)
        const prompt = researchApprovalPrompt(call, requestOrigins([searchUrl(request)]), settings.sharePageContent)
        const refusal = await authorizeOrRefuse(prompt, signal, call.sessionId)
        if (refusal !== undefined) return refusal
        return { ok: true, result: { text: await runSearch(request, researchDeps) } }
      }
      case 'browser_read_pages': {
        const request = parseReadPagesRequest(call.args)
        const prompt = researchApprovalPrompt(call, requestOrigins(request.urls), settings.sharePageContent)
        const refusal = await authorizeOrRefuse(prompt, signal, call.sessionId)
        if (refusal !== undefined) return refusal
        return { ok: true, result: { text: await runReadPages(request, researchDeps) } }
      }
      case 'browser_download': {
        const request = parseDownloadRequest(call.args)
        const prompt = downloadApprovalPrompt(call, requestOrigins(request.urls))
        const refusal = await authorizeOrRefuse(prompt, signal, call.sessionId)
        if (refusal !== undefined) return refusal
        return { ok: true, result: { text: await runDownload(request, downloadsDeps) } }
      }
      case 'browser_downloads': {
        const request = parseDownloadsRequest(call.args)
        const prompt = downloadApprovalPrompt(call, [])
        const refusal = await authorizeOrRefuse(prompt, signal, call.sessionId)
        if (refusal !== undefined) return refusal
        return { ok: true, result: { text: await runDownloadsAction(request, downloadsDeps) } }
      }
      default:
        return { ok: false, error: { code: 'bad-args', message: `Unknown browser tool: ${call.name}` } }
    }
  } catch (error: unknown) {
    if (error instanceof DownloadError || error instanceof ResearchError) {
      return { ok: false, error: { code: error.code, message: error.message } }
    }
    return { ok: false, error: { code: 'action-failed', message: error instanceof Error ? error.message : String(error) } }
  }
}

/** Resolve an approval, returning the refusal answer when it was not granted. */
async function authorizeOrRefuse(
  prompt: ApprovalPrompt | undefined,
  signal: AbortSignal,
  sessionId?: string,
): Promise<ToolAnswer | undefined> {
  if (prompt === undefined) return undefined
  const authorization = await authorizeToolCall(prompt, signal, await approvalWindowId(), sessionId)
  if (authorization !== 'approved') return approvalFailure(prompt, authorization)
  return signal.aborted ? cancelledAnswer() : undefined
}

/**
 * Click a human-verification widget with a trusted event.
 *
 * The geometry comes from the page (the widget's iframe rectangle) and the
 * click comes from the debugger, because the whole point of such a widget is
 * that a synthetic `click()` is ignored. The debugging permission is optional,
 * so a first use asks the side panel to request it — that click is the user
 * gesture Chrome requires.
 */
async function dispatchVerifyCall(call: ToolCall, signal: AbortSignal): Promise<ToolAnswer> {
  await affinityReady
  if (signal.aborted) return cancelledAnswer()
  const target = await resolveToolTab()
  if ('ok' in target) return target
  const tabId = target.id
  if (tabId === undefined) return { ok: false, error: { code: 'no-active-tab', message: 'No active tab is available for browser operations.' } }

  const prompt = verifyApprovalPrompt(call, target.url ?? '')
  const refusal = await authorizeOrRefuse(prompt, signal, call.sessionId)
  if (refusal !== undefined) return refusal

  let located: { text: string; targets: unknown[] }
  try {
    located = await locateVerification(tabId)
  } catch (error: unknown) {
    return { ok: false, error: { code: 'content-unavailable', message: `The page could not be inspected for a verification widget: ${error instanceof Error ? error.message : String(error)}` } }
  }
  const point = firstVerificationPoint(located.targets)
  if (point === undefined) return { ok: true, result: { text: located.text } }
  if (!tabAffinity.allowsTarget(tabId)) {
    return { ok: false, error: { code: 'content-unavailable', message: 'The controlled tab changed before the verification click.' } }
  }

  const deps = chromeTrustedInputDeps()
  try {
    if (!await deps.hasPermission()) {
      const granted = await requestDebuggerPermission(signal)
      if (!granted) {
        return {
          ok: false,
          error: {
            code: 'action-failed',
            message: 'The user did not grant the browser debugging permission, so a trusted click cannot be delivered. Ask them to click the widget themselves, or to enable it in the side panel settings.',
          },
        }
      }
    }
    await trustedClick(tabId, point, deps)
  } catch (error: unknown) {
    if (error instanceof TrustedInputError) return { ok: false, error: { code: 'action-failed', message: error.message } }
    return { ok: false, error: { code: 'action-failed', message: error instanceof Error ? error.message : String(error) } }
  }
  // The widget resolves asynchronously; give it a moment, then let the model
  // read the outcome itself rather than claiming success here.
  await new Promise((resolve) => { setTimeout(resolve, 1_200) })
  return {
    ok: true,
    result: {
      text: `${located.text}\nDelivered a trusted click to the widget. Verification resolves asynchronously — call browser_snapshot (or browser_wait for the page's own content) to see whether it passed.`,
    },
  }
}

/** Ask the top frame which verification widgets it can see. */
async function locateVerification(tabId: number): Promise<{ text: string; targets: unknown[] }> {
  const answer = await chrome.tabs.sendMessage(tabId, {
    type: 'DSH_ACTION',
    action: 'dsh_verification_targets',
    args: {},
  }, { frameId: 0 }) as { ok?: boolean; result?: { text?: string; verificationTargets?: unknown[] }; error?: { message?: string } } | undefined
  if (answer?.ok !== true) throw new Error(answer?.error?.message ?? 'the content script returned no answer')
  return {
    text: typeof answer.result?.text === 'string' ? answer.result.text : '',
    targets: Array.isArray(answer.result?.verificationTargets) ? answer.result.verificationTargets : [],
  }
}

/** The first usable click point among the located widgets. */
function firstVerificationPoint(targets: readonly unknown[]): { x: number; y: number } | undefined {
  for (const entry of targets) {
    if (typeof entry !== 'object' || entry === null) continue
    const { x, y } = entry as { x?: unknown; y?: unknown }
    if (typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0) {
      return { x, y }
    }
  }
  return undefined
}

/** Tools handled entirely in the background, with no controlled page involved. */
const PROACTIVE_TOOLS = new Set(['browser_search', 'browser_read_pages', 'browser_download', 'browser_downloads'])

/** Default and maximum recording window for a standalone inspection, in ms. */
const DEFAULT_INSPECT_MS = 2_500
const MAX_INSPECT_MS = 20_000

/** Attach a recorder for a call that asked for one, tolerating a refusal. */
async function beginCapture(tabId: number): Promise<{ session?: InspectionSession; note?: string }> {
  try {
    return { session: await startInspection(tabId, chromeInspectDeps()) }
  } catch (error: unknown) {
    // A capture that cannot start must not fail the action it was decorating:
    // the action is what the model asked for, the evidence is a bonus.
    return { note: error instanceof InspectError ? error.message : String(error) }
  }
}

/** Append a recorded report to an otherwise successful answer. */
function withInspection(answer: ToolAnswer, section: string): ToolAnswer {
  if (!answer.ok || typeof answer.result !== 'object' || answer.result === null) return answer
  const result = answer.result as { text?: unknown }
  if (typeof result.text !== 'string') return answer
  return { ...answer, result: { ...result, text: `${result.text}\n\n${section}` } }
}

/**
 * Run one page-directed call, optionally recording console and network activity
 * around it.
 *
 * `capture: true` is what turns "I clicked and nothing happened" into a fact.
 * The recorder wraps the dispatch so it sees the events the action causes, and
 * is released on every path — a leaked attachment would leave Chrome's
 * debugging banner up on the user's tab.
 */
async function dispatchPageCall(call: ToolCall, signal: AbortSignal, budget?: ContentBudget): Promise<ToolAnswer> {
  const target = await resolveToolTab()
  if ('ok' in target) return target
  const wantsCapture = call.args.capture === true && target.id !== undefined
  const capture = wantsCapture ? await beginCapture(target.id!) : {}
  try {
    const answer = await dispatchToolCall(
      call,
      settings.sharePageContent,
      budget,
      (prompt) => authorizeToolCall(prompt, signal, target.windowId, call.sessionId),
      signal,
      target,
      () => target.id !== undefined && tabAffinity.allowsTarget(target.id),
      caps?.images,
    )
    if (capture.session === undefined) {
      return capture.note === undefined
        ? answer
        : withInspection(answer, `(Console and network were not captured: ${capture.note})`)
    }
    const report = await capture.session.finish({ bodies: call.args.bodies === true })
    return withInspection(answer, renderInspection(report, 'Recorded while this action ran:'))
  } catch (error: unknown) {
    await capture.session?.abort()
    throw error
  }
}

/**
 * Record console and network activity on the controlled tab for a window of
 * time, optionally reloading first so a page's own requests are observed.
 *
 * The protocol only reports events from `enable` onward, which is why the
 * reload option exists: without it a page that already loaded has nothing left
 * to observe.
 */
async function dispatchInspectCall(call: ToolCall, signal: AbortSignal): Promise<ToolAnswer> {
  await affinityReady
  if (signal.aborted) return cancelledAnswer()
  const target = await resolveToolTab()
  if ('ok' in target) return target
  const tabId = target.id
  if (tabId === undefined) {
    return { ok: false, error: { code: 'no-active-tab', message: 'No active tab is available for browser operations.' } }
  }
  const reload = call.args.reload === true
  const prompt = inspectApprovalPrompt(call, target.url ?? '', settings.sharePageContent)
  const refusal = await authorizeOrRefuse(prompt, signal, call.sessionId)
  if (refusal !== undefined) return refusal

  const ms = typeof call.args.ms === 'number' && call.args.ms > 0
    ? Math.min(Math.floor(call.args.ms), MAX_INSPECT_MS)
    : DEFAULT_INSPECT_MS
  let session: InspectionSession
  try {
    session = await startInspection(tabId, chromeInspectDeps())
  } catch (error: unknown) {
    return {
      ok: false,
      error: {
        code: 'action-failed',
        message: error instanceof InspectError ? error.message : String(error),
      },
    }
  }
  try {
    if (reload) await chrome.tabs.reload(tabId)
    await new Promise((resolve) => { setTimeout(resolve, ms) })
    if (signal.aborted) {
      await session.abort()
      return cancelledAnswer()
    }
    const report = await session.finish({
      bodies: call.args.bodies !== false,
      ...(typeof call.args.filter === 'string' && call.args.filter !== '' ? { filter: call.args.filter } : {}),
    })
    const heading = reload
      ? `Reloaded ${target.url ?? 'the page'} and recorded ${ms}ms of activity:`
      : `Recorded ${ms}ms of activity on ${target.url ?? 'the page'} (nothing that happened BEFORE this call is visible — pass reload: true to observe the page load):`
    return { ok: true, result: { text: renderInspection(report, heading) } }
  } catch (error: unknown) {
    await session.abort()
    return { ok: false, error: { code: 'action-failed', message: error instanceof Error ? error.message : String(error) } }
  }
}

/**
 * Run model-authored JavaScript on the controlled tab's MAIN world.
 *
 * Always prompted (the prompt shows the code), never trustable, and sharing
 * the optional debugger permission with trusted clicks — which is requested
 * from the panel here exactly as a verification click does.
 */
async function dispatchEvaluateCall(call: ToolCall, signal: AbortSignal): Promise<ToolAnswer> {
  await affinityReady
  if (signal.aborted) return cancelledAnswer()
  const target = await resolveToolTab()
  if ('ok' in target) return target
  const tabId = target.id
  if (tabId === undefined) {
    return { ok: false, error: { code: 'no-active-tab', message: 'No active tab is available for browser operations.' } }
  }
  const expression = typeof call.args.function === 'string' ? call.args.function : ''
  if (expression.trim() === '') {
    return { ok: false, error: { code: 'bad-args', message: 'Provide "function": the JavaScript to evaluate on the page.' } }
  }

  const prompt = evaluateApprovalPrompt(call, target.url ?? '')
  const refusal = await authorizeOrRefuse(prompt, signal, call.sessionId)
  if (refusal !== undefined) return refusal

  const deps = chromeEvaluateDeps()
  try {
    // Runtime.evaluate lives behind the same optional permission as trusted
    // input; request it from an open panel rather than failing opaquely.
    const granted = await chrome.permissions.contains({ permissions: ['debugger'] })
      ? true
      : await requestDebuggerPermission(signal)
    if (!granted) {
      return {
        ok: false,
        error: {
          code: 'action-failed',
          message: 'The user did not grant the browser debugging permission, so page scripts cannot be evaluated. Ask them to enable it in the side panel settings.',
        },
      }
    }
    if (signal.aborted) return cancelledAnswer()
    const value = await evaluateOnTab(tabId, expression, deps)
    return { ok: true, result: { text: `Evaluated on ${target.url ?? 'the page'}:\n${value}` } }
  } catch (error: unknown) {
    if (error instanceof EvaluateError) return { ok: false, error: { code: 'action-failed', message: error.message } }
    return { ok: false, error: { code: 'action-failed', message: error instanceof Error ? error.message : String(error) } }
  }
}

/**
 * Pending optional-permission requests, keyed by request id.
 *
 * `chrome.permissions.request` must run inside a user gesture in an extension
 * page, which the service worker is not — so the panel makes the call and the
 * worker waits here for its answer.
 */
const pendingPermissions = new Map<string, (granted: boolean) => void>()
const PERMISSION_REQUEST_TIMEOUT_MS = 60_000

/** Ask an open side panel to request the optional debugging permission. */
function requestDebuggerPermission(signal: AbortSignal): Promise<boolean> {
  if (panelPorts.size === 0) return Promise.resolve(false)
  const id = crypto.randomUUID()
  return new Promise<boolean>((resolve) => {
    let settled = false
    const settle = (granted: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      pendingPermissions.delete(id)
      resolve(granted)
    }
    const onAbort = (): void => { settle(false) }
    const timer = setTimeout(() => { settle(false) }, PERMISSION_REQUEST_TIMEOUT_MS)
    signal.addEventListener('abort', onAbort, { once: true })
    pendingPermissions.set(id, settle)
    let delivered = false
    for (const port of panelPorts) {
      try {
        port.postMessage({ type: 'permission.request', id, permission: 'debugger' })
        delivered = true
      } catch { /* port already closed */ }
    }
    if (!delivered) settle(false)
  })
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
  const work = call.name === 'browser_tabs'
    ? dispatchTabsCall(call, controller.signal)
    : PROACTIVE_TOOLS.has(call.name)
      ? dispatchProactiveCall(call, controller.signal)
      : call.name === 'browser_verify'
        ? dispatchVerifyCall(call, controller.signal)
        : call.name === 'browser_inspect'
          ? dispatchInspectCall(call, controller.signal)
          : call.name === 'browser_evaluate'
            ? dispatchEvaluateCall(call, controller.signal)
            : dispatchPageCall(call, controller.signal, budget)
  void work.then(
    (answer) => {
      if (controller.signal.aborted) {
        if (activeToolCalls.get(call.id) === controller) {
          bridge?.send({
            t: 'tool.result',
            id: call.id,
            ok: false,
            error: { code: 'action-failed', message: 'Tool call was cancelled' },
          })
        }
        return
      }
      const socket = bridge
      if (socket === null) return
      if (answer.ok) {
        socket.send({ t: 'tool.result', id: call.id, ok: true, result: answer.result })
      } else {
        socket.send({ t: 'tool.result', id: call.id, ok: false, error: answer.error! })
      }
    },
    (error: unknown) => {
      if (controller.signal.aborted) {
        if (activeToolCalls.get(call.id) === controller) {
          bridge?.send({
            t: 'tool.result',
            id: call.id,
            ok: false,
            error: { code: 'action-failed', message: 'Tool call was cancelled' },
          })
        }
        return
      }
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

// ---- Content script messages ----

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (typeof message !== 'object' || message === null) return
  if (sender.id !== chrome.runtime.id) return
  if (sender.tab?.id === undefined) return
  const type = (message as { type?: unknown }).type
  if (type === 'DSH_CONTENT_READY') {
    // navigation.ts also listens for this frame-ready announcement; only this
    // listener answers it, telling a fresh document whether to watch
    // selections. The revision lets a slow reply lose to a newer broadcast.
    sendResponse({
      selectionWatch: selectionWatchEnabled(sender.tab.windowId),
      selectionWatchEpoch: selectionWatchEpoch,
      selectionWatchRevision: selectionWatchRevision,
    })
    return
  }
  if (type !== 'DSH_SELECTION' || sender.tab === undefined) return
  recordSelection(sender.tab, sender.frameId ?? 0, (message as { selection?: unknown }).selection)
})

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
  void settingsReady.then(syncSelectionWatch)
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
        const rpcSessionId = typeof rpcMsg.payload === 'object' && rpcMsg.payload !== null
          ? (rpcMsg.payload as { sessionId?: string }).sessionId
          : undefined
        const refresh = rpcSessionId === undefined
          ? Promise.resolve()
          : sessionSnapshotRefreshes.get(rpcSessionId) ?? Promise.resolve()
        const prepare = rpcMsg.method === 'session.prompt'
          ? Promise.resolve().then(async () => {
              await refresh
              return rpcSessionId === undefined || tabAffinity.getSessionTab(rpcSessionId) !== undefined
            })
          : Promise.resolve(true)
        void prepare.then((ready) => {
          if (!ready) throw new Error('This session is not bound to a live browser tab')
          return gatewayRpc(rpcMsg.method, rpcMsg.payload)
        }).then(
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
          syncSelectionWatch()
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
      case 'panel.window': {
        // The panel reports its own window; a side panel has no sender.tab.
        const registration = message as { windowId?: unknown }
        if (typeof registration.windowId !== 'number'
          || !Number.isInteger(registration.windowId)
          || registration.windowId < 0) break
        panelWindows.set(port, registration.windowId)
        syncSelectionWatch()
        try {
          port.postMessage({ type: 'selection', selection: selections.current(registration.windowId) })
        } catch { /* port closed */ }
        break
      }
      case 'selection.clear': {
        // The user sent, dismissed, or explicitly abandoned this window's
        // quote. A send/dismiss names the value it acted on so a newer capture
        // that arrived while work was in flight cannot be cleared by mistake.
        const windowId = panelWindows.get(port)
        if (windowId === undefined) break
        const request = message as { selection?: unknown }
        const expected = request.selection === undefined ? undefined : parsePageSelection(request.selection)
        if (expected === null) break
        const source = selections.source(windowId)
        const cleared = expected === undefined
          ? selections.clear(windowId)
          : selections.clearIfCurrent(windowId, expected)
        if (cleared && source !== null) resetSelectionDedupe([source])
        // Also repairs a panel that acted on a stale attachment.
        broadcastSelection(windowId)
        break
      }
      case 'session.active': {
        const session = message as { sessionId?: unknown; isNew?: boolean }
        recentSession.remember(session.sessionId)
        if (typeof session.sessionId === 'string' && session.sessionId.trim() !== '') {
          const sid = session.sessionId
          if (session.isNew === true && tabAffinity.getSessionTab(sid) === undefined) {
            const bind = affinityReady.then(async () => {
              if (tabAffinity.getSessionTab(sid) !== undefined) return
              const tab = await syncActiveTab()
              const summary = tab === undefined ? null : summarizeTab(tab)
              if (summary === null) throw new Error('No active tab is available to bind this session')
              if (tabAffinity.getSessionTab(sid) !== undefined) return
              tabAffinity.bindNewSession(sid, summary)
              resetTabSnapshot(summary.tabId)
              persistTabAffinity()
              broadcastTabAffinity()
              await refreshSessionSnapshot(sid)
            }).catch(() => {})
            sessionSnapshotRefreshes.set(sid, bind)
            void bind.finally(() => {
              if (sessionSnapshotRefreshes.get(sid) === bind) sessionSnapshotRefreshes.delete(sid)
            })
          } else if (tabAffinity.focusSession(sid)) {
            persistTabAffinity()
            broadcastTabAffinity()
          }
        }
        break
      }
      case 'approval.response': {
        const approval = message as { id?: unknown; decision?: unknown }
        if (typeof approval.id === 'string' && isApprovalDecision(approval.decision)) {
          approvals.respond(approval.id, approval.decision)
        }
        break
      }
      case 'permission.response': {
        const response = message as { id?: unknown; granted?: unknown }
        if (typeof response.id !== 'string') break
        pendingPermissions.get(response.id)?.(response.granted === true)
        break
      }
      case 'tab-affinity.response': {
        const response = message as { revision?: unknown; decision?: unknown; sessionId?: unknown }
        if (typeof response.revision !== 'number'
          || (response.decision !== 'keep' && response.decision !== 'follow')) break
        const sid = typeof response.sessionId === 'string' ? response.sessionId : undefined
        const decision = resolveTabAffinityResponse({
          revision: response.revision,
          decision: response.decision,
          sessionId: response.sessionId,
        }).catch(() => {})
        if (response.decision === 'follow' && sid !== undefined) {
          sessionSnapshotRefreshes.set(sid, decision)
          void decision.finally(() => {
            if (sessionSnapshotRefreshes.get(sid) === decision) sessionSnapshotRefreshes.delete(sid)
          })
        } else {
          void decision
        }
        break
      }
      case 'tab-affinity.rebind': {
        const request = message as { id?: unknown; sessionId?: unknown }
        if (typeof request.id !== 'string') break
        const requestId = request.id
        const rebindSessionId = typeof request.sessionId === 'string' ? request.sessionId : undefined
        if (tabAffinityRebinds.has(requestId)) break
        const controller = new AbortController()
        const timer = setTimeout(() => {
          controller.abort(new TabAffinityRebindError('timeout', getUiLocale() === 'zh'
            ? '绑定当前标签页超时，请重试'
            : 'Binding the current tab timed out. Try again.'))
        }, TAB_AFFINITY_REBIND_TIMEOUT_MS)
        tabAffinityRebinds.set(requestId, { controller, timer })
        void rebindTabAffinityToActive(controller.signal, rebindSessionId).then(
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
          const statusWindowId = panelWindows.get(port)
          if (statusWindowId !== undefined) {
            port.postMessage({ type: 'selection', selection: selections.current(statusWindowId) })
          }
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
    const panelWindowId = panelWindows.get(port)
    panelPorts.delete(port)
    interactionResponses.removePort(port)
    if (panelWindowId !== undefined && !hasPanelInWindow(panelWindowId)) {
      const source = selections.source(panelWindowId)
      if (selections.clear(panelWindowId) && source !== null) resetSelectionDedupe([source])
    }
    syncSelectionWatch()
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
  // Notification clicks are extension user gestures; both panel APIs require
  // the call to remain inside this handler.
  openAssistantPanel(windowId)
})

// ---- Tab affinity ----

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
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
  // The old document is gone even though Chrome transfers the tab identity.
  broadcastSelections(selections.clearTab(removedTabId))
  void affinityReady.then(() => {
    // onReplaced is an identity swap (for example prerender activation), not
    // a close or user-visible switch. Transfer IDs synchronously before any
    // metadata lookup so tool resolution never observes the removed target.
    const affectedSessions = tabAffinity.sessionIdsForTab(removedTabId)
    if (!tabAffinity.replaceTab(removedTabId, addedTabId)) return
    for (const sid of affectedSessions) {
      activeFollowRefreshes.get(sid)?.abort()
      cancelPendingApprovals(sid)
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
  broadcastSelections(selections.clearTab(tabId))
  void affinityReady.then(() => {
    const affectedSessions = tabAffinity.sessionIdsForTab(tabId)
    if (!tabAffinity.removeTab(tabId)) return
    for (const sid of affectedSessions) {
      activeFollowRefreshes.get(sid)?.abort()
      cancelPendingApprovals(sid)
    }
    persistTabAffinity()
    broadcastTabAffinity()
  })
})

// A committed navigation replaces a document; a same-document history or
// fragment update does not, and must not drop a quote still on the screen.
// Matching the exact frame keeps an iframe's navigation from invalidating a
// quote taken from its parent page, and vice versa.
chrome.webNavigation.onCommitted.addListener(({ tabId, frameId }) => {
  broadcastSelections(selections.clearTab(tabId, frameId))
})

// Ports are cleaned up by their own disconnect; only the window's quote is
// left behind when the whole window goes away.
chrome.windows.onRemoved.addListener((windowId) => {
  selections.clear(windowId)
})

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return
  focusedWindow.markFocused(windowId)
  void affinityReady.then(() => syncActiveTab(windowId))
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

interface FirefoxSidebarAction {
  open(): Promise<void> | void
}

function openAssistantPanel(windowId?: number): void {
  if (import.meta.env.EXT_TARGET === 'firefox') {
    const sidebar = (chrome as unknown as { sidebarAction?: FirefoxSidebarAction }).sidebarAction
    if (sidebar === undefined) return
    void Promise.resolve(sidebar.open()).catch(() => {})
    return
  }
  if (windowId !== undefined) void chrome.sidePanel.open({ windowId }).catch(() => {})
}

// Open the side panel when the toolbar icon is clicked.
// Chrome 116+ uses chrome.sidePanel; Firefox has no sidePanel API, so the
// action click opens the sidebar via sidebarAction.open() (user gesture).
if (import.meta.env.EXT_TARGET === 'firefox') {
  chrome.action.onClicked.addListener(() => { openAssistantPanel() })
} else {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {})
}

// Alarms survive some extension/service-worker restarts. Remove any stale
// schedule left by an older eager-connection build; onConnect re-arms it.
disarmBridgeKeepalive()

// `settingsReady` intentionally has no bridge-start continuation: opening a
// side panel is the first action allowed to claim the bridge connection.
