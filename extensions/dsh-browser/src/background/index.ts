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
 *   panel → bg: { type: 'settings', id, settings: Partial<Settings> }
 *   panel → bg: { type: 'devtools.detach', id }
 *   panel → bg: { type: 'session.active', sessionId }
 *   panel → bg: { type: 'approval.response', id, decision }
 *   panel → bg: { type: 'tab-affinity.response', revision, decision, sessionId }
 *   panel → bg: { type: 'tab-affinity.rebind', id }
 *   panel → bg: { type: 'panel.window', windowId }
 *   panel → bg: { type: 'selection.clear', selection? }
 *   panel → bg: { type: 'request-status' }
 *   bg → panel: { type: 'rpc.result', id, ok, result? | error? }
 *   bg → panel: { type: 'respond.result', id, ok, result? | error? }
 *   bg → panel: { type: 'settings.result', id, ok, error? }
 *   bg → panel: { type: 'devtools.status', supported, enabled, attached, tabId?, error? }
 *   bg → panel: { type: 'devtools.detach.result', id, ok, error? }
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
import { BRIDGE_CONFIG_PATH, BRIDGE_PATH, DEVTOOLS_CAPS_VERSION } from '@yuxianglin/dsh-bridge-browser/src/protocol.ts'
import { BridgeClient, type BridgeState } from './bridge.ts'
import { createRpc } from './rpc.ts'
import { listTabFrames } from './frames.ts'
import {
  dispatchOpenTab,
  dispatchToolCall,
  isNavigationCandidateTool,
  isTabManagementTool,
  resetTabSnapshot,
  type ToolAnswer,
  type ToolCall,
} from './tools.ts'
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
  isTabAffinityDecision,
  type AffinityTab,
  type TabAffinityDecision,
} from './tab-affinity.ts'
import { bindOpenedTabAffinity } from './open-tab-binding.ts'
import { FocusedWindowTracker } from './focused-window.ts'
import { SelectionTracker, type SelectionSource } from './selection.ts'
import { parsePageSelection, parseSelectionCapture } from '../selection.ts'
import { ApprovalCoordinator, type ApprovalRequestResult } from './approval-coordinator.ts'
import { devToolsSupported } from './debugger-session.ts'
import { createDevToolsController } from './devtools-controller.ts'
import { devToolsApprovalForCall, isDevToolsTool, resolveApprovalGate } from './authorization.ts'
import {
  LEGACY_RECENT_SESSION_STORAGE_KEY,
  PAGE_SESSION_CONTEXT_STORAGE_KEY,
  PageSessionContextTracker,
} from './session-continuity.ts'

/** User settings persisted in chrome.storage.local. */
export interface Settings {
  bridgeUrl: string
  token: string
  sharePageContent: 'ask' | 'auto' | 'off'
  /** Allow every browser operation without an approval prompt. */
  unrestrictedBrowserAccess: boolean
  /**
   * High-privilege developer tools (element/CSS debugging, page JavaScript,
   * network capture). Off by default: while it is off every devtools call
   * raises its own approval prompt, and the origin allowlist never covers it.
   */
  allowDevTools: boolean
  /** Origins whose state-changing actions may run without another prompt. */
  trustedActionOrigins: string[]
  /** Show an OS notification when no side panel can display an approval. */
  approvalNotifications: boolean
  /** Restore the current tab and page path's conversation when the panel reopens. */
  autoResumeSession: boolean
}

const SETTINGS_DEFAULTS: Settings = {
  // 空地址 = 自动探测本机 dsh（零配置）；手动填地址时优先手动。
  bridgeUrl: '',
  token: '',
  sharePageContent: 'auto',
  unrestrictedBrowserAccess: false,
  allowDevTools: false,
  trustedActionOrigins: [],
  approvalNotifications: true,
  autoResumeSession: true,
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
  | { controlledTabId: number; keptActiveTabId?: number; pinned?: true; sessionTabs?: Record<string, AffinityTab>; focusedSessionId?: string }
  | { lost: true; sessionTabs?: Record<string, AffinityTab>; focusedSessionId?: string }

let settings: Settings = { ...SETTINGS_DEFAULTS }
let unrestrictedAccessActive = SETTINGS_DEFAULTS.unrestrictedBrowserAccess
let unrestrictedAccessRevision = 0
let unrestrictedRevocation: Promise<void> | undefined
let settingsPersistence = Promise.resolve()
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

/** Whether this browser build can serve the developer-tools group at all. */
const devToolsCapability = devToolsSupported()

/**
 * High-privilege developer tools. The controller refuses every call unless the
 * user's setting is on, and the background still routes each call through the
 * approval gate first.
 */
const devTools = createDevToolsController({
  // Consent is enforced by the approval gate in `dispatchDevToolsTool`: with the
  // setting off every call raises its own dialog, and unrelated switches never
  // cover this group. The controller only owns capability and target policy.
  resolveTarget: async (sessionId) => {
    const target = await resolveToolTab(sessionId)
    if ('ok' in target || target.id === undefined) return undefined
    return {
      tabId: target.id,
      ...(target.url === undefined ? {} : { url: target.url }),
      ...(target.title === undefined ? {} : { title: target.title }),
    }
  },
  onStateChange: () => { broadcastDevToolsState() },
})
const pageSessionContexts = new PageSessionContextTracker({
  read: async () => (await chrome.storage.session.get(PAGE_SESSION_CONTEXT_STORAGE_KEY))[PAGE_SESSION_CONTEXT_STORAGE_KEY],
  write: async (value) => {
    await chrome.storage.session.set({ [PAGE_SESSION_CONTEXT_STORAGE_KEY]: value })
  },
})
void chrome.storage.session.remove(LEGACY_RECENT_SESSION_STORAGE_KEY).catch(() => {})
/** Ephemeral allowlist: cleared when the last side panel closes or this worker restarts. */
const sessionTrustedActionOrigins = new Set<string>()
/**
 * Ephemeral developer-tools grant for this panel lease. Set when the user
 * chooses "trust this session" on a devtools prompt; never persisted, and
 * never implied by the origin allowlist or unrestricted access.
 */
let sessionDevToolsGrant = false
/** Tool calls that are either withdrawable or completing an already-dispatched action. */
interface ActiveToolCall {
  controller: AbortController
  /** Tool name, so a revocation can target the developer-tools group only. */
  name: string
  unrestrictedAccess: boolean
  committed: boolean
  revocationRequested: boolean
  settled: Promise<void>
  settle: () => void
}

const activeToolCalls = new Map<string, ActiveToolCall>()
/** Disconnection drops result ownership, but dispatched operations must still settle before revocation. */
const unsettledToolCalls = new Set<ActiveToolCall>()
let lastPersistedAffinity: string | undefined
let affinityPersistence = Promise.resolve()
/** Per-session snapshot refreshes preserve prompt ordering without cross-session cancellation. */
const sessionSnapshotRefreshes = new Map<string, Promise<void>>()
interface ActiveFollowRefresh {
  controller: AbortController
  unrestrictedAccess: boolean
  settled: Promise<void>
  settle: () => void
}

const activeFollowRefreshes = new Map<string, ActiveFollowRefresh>()
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
  const changesUnrestrictedAccess = typeof next.unrestrictedBrowserAccess === 'boolean'
  const accessRevision = changesUnrestrictedAccess ? ++unrestrictedAccessRevision : unrestrictedAccessRevision
  const updated = normalizeSettings({ ...settings, ...next })
  const revokesUnrestrictedAccess = settings.unrestrictedBrowserAccess && !updated.unrestrictedBrowserAccess
  const changesDevTools = typeof next.allowDevTools === 'boolean'
  const revokesDevTools = changesDevTools && (settings.allowDevTools || sessionDevToolsGrant) && !updated.allowDevTools
  settings = updated
  if (!updated.unrestrictedBrowserAccess) unrestrictedAccessActive = false
  if (revokesDevTools) sessionDevToolsGrant = false
  syncSelectionWatch()
  let accessTransition: Promise<void> | undefined
  if (revokesUnrestrictedAccess) {
    let trackedRevocation!: Promise<void>
    trackedRevocation = revokeUnrestrictedAccess().finally(() => {
      if (unrestrictedRevocation !== trackedRevocation) return
      unrestrictedRevocation = undefined
      syncSelectionWatch()
    })
    unrestrictedRevocation = trackedRevocation
    accessTransition = trackedRevocation
  } else if (unrestrictedRevocation !== undefined) {
    accessTransition = unrestrictedRevocation
  }
  const persisted = updated
  const write = settingsPersistence.then(async () => {
    await accessTransition
    await chrome.storage.local.set({ [STORAGE_KEY]: persisted })
  })
  settingsPersistence = write.catch(() => {})
  await write
  if (changesUnrestrictedAccess
    && accessRevision === unrestrictedAccessRevision
    && settings.unrestrictedBrowserAccess
    && persisted.unrestrictedBrowserAccess
    && unrestrictedRevocation === undefined) {
    unrestrictedAccessActive = true
    syncSelectionWatch()
  }
  if (changesDevTools) {
    // Turning the allowance off is a revocation: detach the debugger and abort
    // every in-flight devtools call so the capability cannot outlive the choice.
    if (revokesDevTools) {
      cancelDevToolsCalls()
      await devTools.revoke()
    } else if (updated.allowDevTools) {
      devTools.resume()
      await prewarmDevTools()
    } else {
      // Still off: nothing to prewarm, and no consent was granted.
      devTools.resume()
    }
    broadcastDevToolsState()
  }
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
    unrestrictedBrowserAccess: candidate.unrestrictedBrowserAccess === true,
    // A browser without a debugger API can never use the developer tools, so
    // the persisted choice is kept but the runtime path stays disabled.
    allowDevTools: candidate.allowDevTools === true && devToolsCapability,
    trustedActionOrigins: trusted,
    approvalNotifications: candidate.approvalNotifications !== false,
    autoResumeSession: candidate.autoResumeSession !== false,
  }
}

/** Settings load is shared by every lazy connection trigger. */
let settingsLoaded = false
const settingsReady = loadSettings().then((loaded) => {
  settings = loaded
  unrestrictedAccessActive = loaded.unrestrictedBrowserAccess
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

/** Broadcast developer-tools support, attachment state, and the user's choice. */
function broadcastDevToolsState(): void {
  for (const port of panelPorts) postDevToolsState(port)
}

/** Report developer-tools state to one panel port. */
function postDevToolsState(port: chrome.runtime.Port): void {
  const state = devTools.state()
  try {
    port.postMessage({
      type: 'devtools.status',
      supported: state.supported,
      enabled: settingsLoaded && settings.allowDevTools,
      attached: state.attached,
      ...(state.tabId === undefined ? {} : { tabId: state.tabId }),
      ...(state.error === undefined ? {} : { error: state.error }),
    })
  } catch { /* port already closed */ }
}

function broadcastTabAffinity(): void {
  const payload = { type: 'tab-affinity', state: tabAffinity.snapshot() }
  for (const port of panelPorts) {
    try { port.postMessage(payload) } catch { /* port already closed */ }
  }
}

/** Which window each panel port belongs to, so a quote stays in its window. */
const panelWindows = new WeakMap<chrome.runtime.Port, number>()
/** The conversation each live panel is displaying, used for close checkpoints. */
const panelActiveSessions = new WeakMap<chrome.runtime.Port, string>()

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
  return settingsLoaded && (unrestrictedAccessEnabled() || settings.sharePageContent !== 'off')
}

/** Whether unrestricted access is enabled and no earlier grant is still being revoked. */
function unrestrictedAccessEnabled(): boolean {
  return unrestrictedAccessActive && unrestrictedRevocation === undefined
}

/**
 * Whether the user has opted into developer tools without a per-call prompt.
 * The ephemeral session grant is applied by the approval gate instead, so this
 * reports only the persisted setting.
 */
function devToolsAllowed(): boolean {
  return settingsLoaded && settings.allowDevTools
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
      ...(state.pinned ? { pinned: true as const } : {}),
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
      activeFollowRefreshes.get(focused)?.controller.abort()
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
        ...((candidate as { pinned?: unknown }).pinned === true ? { pinned: true as const } : {}),
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

  // Restore the pin before syncing the active tab: otherwise the sync would
  // surface a handoff prompt for a switch the user already said not to ask about.
  if (record !== null && 'pinned' in record && record.pinned === true) tabAffinity.restorePinned()
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

function validSessionId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/** Refresh one session's recovery checkpoint from its actual controlled tab. */
async function checkpointSessionPage(sessionValue: unknown): Promise<void> {
  const sessionId = validSessionId(sessionValue)
  if (sessionId === undefined) return
  await Promise.all([affinityReady, pageSessionContexts.ready])
  const bound = tabAffinity.getSessionTab(sessionId)
  if (bound === undefined) return
  try {
    const tab = await chrome.tabs.get(bound.tabId)
    if (tabAffinity.getSessionTab(sessionId)?.tabId !== bound.tabId) return
    pageSessionContexts.bind(sessionId, tab)
  } catch {
    // A concurrently closed tab is cleaned by tabs.onRemoved.
  }
}

/** Resolve the contextual hint only after the panel has identified its window. */
async function postResumeHint(port: chrome.runtime.Port, windowId: number): Promise<void> {
  await pageSessionContexts.ready
  let sessionId: string | null = null
  try {
    const [tab] = await chrome.tabs.query({ active: true, windowId })
    if (tab !== undefined) sessionId = pageSessionContexts.candidate(tab)
  } catch {
    // Without an exact live page the panel must start a new conversation.
  }
  if (!panelPorts.has(port) || panelWindows.get(port) !== windowId) return
  try { port.postMessage({ type: 'session.resume-hint', sessionId }) } catch { /* port closed */ }
}

/** Re-checkpoint each open panel before issuing a bridge-epoch resume hint. */
function refreshPanelResumeHints(): void {
  for (const port of panelPorts) {
    const windowId = panelWindows.get(port)
    if (windowId === undefined) continue
    const sessionId = panelActiveSessions.get(port)
    const checkpoint = sessionId === undefined
      ? Promise.resolve()
      : checkpointSessionPage(sessionId)
    void checkpoint.then(() => postResumeHint(port, windowId), () => postResumeHint(port, windowId))
  }
}

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
async function resolveToolTab(sessionId?: string): Promise<Pick<chrome.tabs.Tab, 'id' | 'url' | 'title' | 'windowId'> | ToolAnswer> {
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
          activeFollowRefreshes.get(sid)?.controller.abort()
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

/**
 * Pick a window for browser_open_tab without requiring an already-controlled page.
 * Handoff still blocks: the user must finish the keep/follow choice first.
 */
async function resolveOpenTabWindow(sessionId?: string): Promise<{ windowId: number } | ToolAnswer> {
  await affinityReady
  const resolution = tabAffinity.resolveTarget(sessionId)
  if (resolution.kind === 'handoff') return affinityFailure('handoff')
  if (resolution.kind === 'target') {
    try {
      const tab = await chrome.tabs.get(resolution.tab.tabId)
      return { windowId: tab.windowId }
    } catch {
      // Fall through to the focused window when the prior controlled tab is gone.
    }
  }
  try {
    const focused = await chrome.windows.getLastFocused()
    if (focused.id !== undefined) return { windowId: focused.id }
  } catch { /* no focused window */ }
  const [fallback] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  if (fallback?.windowId !== undefined) return { windowId: fallback.windowId }
  return affinityFailure('missing')
}

function bindOpenedTab(
  tab: chrome.tabs.Tab,
  sessionId?: string,
  options: { active?: boolean } = {},
): boolean {
  const summary = summarizeTab(tab)
  if (summary === null) return false
  const sid = sessionId?.trim()
  bindOpenedTabAffinity(tabAffinity, summary, {
    active: options.active,
    sessionId: sid,
  })
  if (sid !== undefined && sid !== '') {
    void pageSessionContexts.ready.then(() => {
      pageSessionContexts.bind(sid, { id: summary.tabId, ...summary })
    })
  }
  persistTabAffinity()
  broadcastTabAffinity()
  return true
}

async function authorizeToolCall(
  prompt: ApprovalPrompt,
  signal: AbortSignal,
  windowId: number,
  sessionId?: string,
  unrestrictedAccess: boolean = unrestrictedAccessEnabled(),
): Promise<ApprovalAuthorization> {
  if (signal.aborted) return 'cancelled'
  const gate = resolveApprovalGate({
    prompt,
    devToolsAllowed: devToolsAllowed(),
    devToolsSessionGrant: sessionDevToolsGrant,
    unrestrictedAccess,
    coveredByTrustedOrigins: actionCoveredByTrustedOrigins(
      prompt,
      sessionTrustedActionOrigins,
      settings.trustedActionOrigins,
    ),
  })
  if (gate !== 'prompt') return gate
  const result: ApprovalRequestResult = await approvals.request(prompt, signal, windowId, sessionId)
  if (signal.aborted) return 'cancelled'
  if (result.status !== 'decision') return result.status
  const { decision } = result
  if (prompt.devTools === true) {
    // "Trust this session" and the dedicated decision both arm the ephemeral
    // devtools grant until the panel lease, the worker, or the setting ends it.
    if (decision === 'trust-session' || decision === 'trust-dev-tools') {
      sessionDevToolsGrant = true
      return 'approved'
    }
    return decision === 'allow-once' ? 'approved' : 'denied'
  }
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
  activeFollowRefreshes.get(sessionId)?.controller.abort()
  const controller = new AbortController()
  const unrestrictedAccess = unrestrictedAccessEnabled()
  let settle!: () => void
  const activeRefresh: ActiveFollowRefresh = {
    controller,
    unrestrictedAccess,
    settled: new Promise<void>((resolve) => { settle = resolve }),
    settle: () => { settle() },
  }
  activeFollowRefreshes.set(sessionId, activeRefresh)
  try {
    const target = await resolveToolTab(sessionId)
    if ('ok' in target || target.id !== tabId || controller.signal.aborted) return
    const budget = caps === null
      ? undefined
      : { maxItems: caps.maxInteractiveItems, maxChars: caps.snapshotMaxChars }
    const answer = await dispatchToolCall(
      { id: crypto.randomUUID(), name: 'browser_snapshot', args: {} },
      unrestrictedAccess ? 'auto' : settings.sharePageContent,
      budget,
      (prompt) => authorizeToolCall(prompt, controller.signal, target.windowId, sessionId, unrestrictedAccess),
      controller.signal,
      target,
      () => target.id !== undefined && tabAffinity.allowsTarget(target.id, sessionId),
      { unrestrictedAccess },
    )
    if (!answer.ok || controller.signal.aborted || !tabAffinity.allowsTarget(tabId, sessionId)) return
    if (typeof answer.result !== 'object' || answer.result === null) return
    const snapshot = (answer.result as { text?: unknown }).text
    if (typeof snapshot !== 'string' || snapshot.trim() === '') return
    await gatewayRpc(BRIDGE_INJECT_BROWSER_SNAPSHOT_METHOD, { sessionId, snapshot })
  } finally {
    activeRefresh.settle()
    if (activeFollowRefreshes.get(sessionId) === activeRefresh) activeFollowRefreshes.delete(sessionId)
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
  if (accepted) {
    persistTabAffinity()
    if (controlled !== null && sid !== undefined) {
      await pageSessionContexts.ready
      pageSessionContexts.bind(sid, { id: controlled.tabId, ...controlled })
    }
  }
  broadcastTabAffinity()
  if (controlled !== null && typeof response.sessionId === 'string' && response.sessionId.trim() !== '') {
    await refreshFollowedPage(response.sessionId, controlled.tabId)
  }
}

/** Move browser control to the current tab only after a fresh, valid query. */
async function rebindTabAffinityToActive(signal: AbortSignal, sessionId?: string): Promise<void> {
  await abortable(Promise.all([affinityReady, pageSessionContexts.ready]).then(() => undefined), signal)
  const tab = await syncActiveTab(undefined, signal)
  throwIfRebindAborted(signal)
  const summary = tab === undefined ? null : summarizeTab(tab)
  if (summary === null) {
    throw new TabAffinityRebindError('no-active-tab', getUiLocale() === 'zh'
      ? '无法确定当前标签页，原会话和标签页绑定保持不变'
      : 'The current tab could not be determined; the existing session and tab binding were left unchanged')
  }

  commitTabAffinityRebind(summary, sessionId)
}

/** Commit one explicit tab handoff and clear stale element references. */
function commitTabAffinityRebind(
  summary: AffinityTab,
  sessionId?: string,
  mode: 'active' | 'background' = 'active',
): void {
  const previousControlledTabId = tabAffinity.snapshot().controlled?.tabId
  if (sessionId !== undefined) {
    activeFollowRefreshes.get(sessionId)?.controller.abort()
    cancelPendingApprovals(sessionId)
  }
  if (mode === 'active') tabAffinity.rebindActive(summary, sessionId)
  else tabAffinity.rebindControlled(summary, sessionId)
  if (sessionId !== undefined) {
    pageSessionContexts.bind(sessionId, { id: summary.tabId, ...summary })
  }
  if (previousControlledTabId !== undefined && previousControlledTabId !== summary.tabId) {
    resetTabSnapshot(previousControlledTabId)
  }
  resetTabSnapshot(summary.tabId)
  persistTabAffinity()
  broadcastTabAffinity()
}

async function followModelSelectedTab(tab: chrome.tabs.Tab, sessionId?: string): Promise<void> {
  const summary = summarizeTab(tab)
  if (summary === null) throw new Error('the selected tab has no usable identifier')
  await pageSessionContexts.ready
  commitTabAffinityRebind(summary, sessionId, 'background')
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
  activeToolCalls.get(call.id)?.controller.abort()
  const controller = new AbortController()
  const unrestrictedAccess = unrestrictedAccessEnabled()
  let settle!: () => void
  const activeCall: ActiveToolCall = {
    controller,
    name: call.name,
    unrestrictedAccess,
    committed: false,
    revocationRequested: false,
    settled: new Promise<void>((resolve) => { settle = resolve }),
    settle: () => { settle() },
  }
  activeToolCalls.set(call.id, activeCall)
  unsettledToolCalls.add(activeCall)
  const commitAction = (): void => { activeCall.committed = true }
  const rollbackActionCommit = (): void => {
    activeCall.committed = false
    if (activeCall.revocationRequested) controller.abort()
  }
  const expiryTimer = call.expiresAt === undefined
    ? undefined
    : setTimeout(() => {
        if (!activeCall.committed) controller.abort()
      }, Math.max(0, call.expiresAt - Date.now()))
  const budget = caps === null
    ? undefined
    : { maxItems: caps.maxInteractiveItems, maxChars: caps.snapshotMaxChars }
  const sharePageContent = unrestrictedAccess ? 'auto' : settings.sharePageContent
  const managementDispatch = async (): Promise<ToolAnswer> => {
    await affinityReady
    const affinity = tabAffinity.snapshot()
    let windowId = affinity.active?.windowId ?? affinity.controlled?.windowId
    if (windowId === undefined) {
      try {
        windowId = (await chrome.windows.getLastFocused()).id
      } catch { /* approvals can still report unavailable without a focused window */ }
    }
    const controlledTabId = call.sessionId === undefined
      ? affinity.controlled?.tabId
      : tabAffinity.getSessionTab(call.sessionId)?.tabId
    return dispatchToolCall(
      call,
      sharePageContent,
      budget,
      (prompt) => authorizeToolCall(prompt, controller.signal, windowId ?? 0, call.sessionId, unrestrictedAccess),
      controller.signal,
      undefined,
      undefined,
      {
        unrestrictedAccess,
        ...(controlledTabId === undefined ? {} : { controlledTabId }),
        followTab: (tab) => followModelSelectedTab(tab, call.sessionId),
        commitAction,
        rollbackActionCommit,
      },
    )
  }
  void (isTabManagementTool(call.name)
    ? managementDispatch()
    : isDevToolsTool(call.name)
    ? dispatchDevToolsTool(call, controller.signal)
    : call.name === 'browser_open_tab'
    ? resolveOpenTabWindow(call.sessionId).then((target) => 'ok' in target
      ? target
      : dispatchOpenTab(
          call,
          target.windowId,
          sharePageContent,
          budget,
          (prompt) => authorizeToolCall(prompt, controller.signal, target.windowId, call.sessionId, unrestrictedAccess),
          controller.signal,
          (tab) => bindOpenedTab(tab, call.sessionId, { active: call.args.active !== false }),
          (tabId) => tabAffinity.allowsTarget(tabId, call.sessionId),
          commitAction,
        ))
    : resolveToolTab(call.sessionId).then((target) => 'ok' in target
      ? target
      : dispatchToolCall(
          call,
          sharePageContent,
          budget,
          (prompt) => authorizeToolCall(prompt, controller.signal, target.windowId, call.sessionId, unrestrictedAccess),
          controller.signal,
          target,
          () => target.id !== undefined && tabAffinity.allowsTarget(target.id, call.sessionId),
          { unrestrictedAccess, commitAction, rollbackActionCommit },
        ))
  ).then(
    async (answer) => {
      if (activeToolCalls.get(call.id) !== activeCall) return
      // A committed browser_open_tab already rebound affinity; prefer that
      // factual success over a generic cancel that would leave the model wrong.
      if (controller.signal.aborted && !(call.name === 'browser_open_tab' && answer.ok)) {
        if (activeToolCalls.get(call.id) === activeCall) {
          bridge?.send({
            t: 'tool.result',
            id: call.id,
            ok: false,
            error: { code: 'action-failed', message: 'Tool call was cancelled' },
          })
        }
        return
      }
      if (answer.ok) {
        if (isNavigationCandidateTool(call.name)) await checkpointSessionPage(call.sessionId)
        if (activeToolCalls.get(call.id) !== activeCall) return
        const socket = bridge
        if (socket === null) return
        socket.send({ t: 'tool.result', id: call.id, ok: true, result: answer.result })
      } else {
        const socket = bridge
        if (socket === null) return
        socket.send({ t: 'tool.result', id: call.id, ok: false, error: answer.error! })
      }
    },
    (error: unknown) => {
      if (activeToolCalls.get(call.id) !== activeCall) return
      if (controller.signal.aborted) {
        if (activeToolCalls.get(call.id) === activeCall) {
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
    unsettledToolCalls.delete(activeCall)
    activeCall.settle()
    if (activeToolCalls.get(call.id) === activeCall) activeToolCalls.delete(call.id)
  })
}

function cancelToolCall(id: string): void {
  const call = activeToolCalls.get(id)
  if (call !== undefined && !call.committed) call.controller.abort()
}

/**
 * Run one developer-tools call: approve it, then hand it to the debugger
 * controller. Devtools calls take a dedicated path because they never touch the
 * content script and must not be satisfied by the page-sharing relaxations.
 */
async function dispatchDevToolsTool(call: ToolCall, signal: AbortSignal): Promise<ToolAnswer> {
  if (signal.aborted) return devToolsCancelled()
  const target = await resolveToolTab(call.sessionId)
  if ('ok' in target) return target
  if (signal.aborted) return devToolsCancelled()
  const frames = await listTabFrames(target.id!, target.url)
  const prompt = devToolsApprovalForCall(call, frames)
  const authorization = await authorizeToolCall(prompt, signal, target.windowId ?? 0, call.sessionId)
  if (signal.aborted) return devToolsCancelled()
  if (authorization !== 'approved') {
    return {
      ok: false,
      error: { code: authorization === 'timed-out' ? 'timeout' : 'action-failed', message: approvalFailureMessage(prompt, authorization) },
    }
  }
  try {
    return { ok: true, result: await devTools.handle(call.name, call.args, call.sessionId) }
  } catch (error: unknown) {
    return {
      ok: false,
      error: {
        code: signal.aborted ? 'bridge-closed' : 'action-failed',
        message: error instanceof Error ? error.message : String(error),
      },
    }
  }
}

function devToolsCancelled(): ToolAnswer {
  return { ok: false, error: { code: 'bridge-closed', message: 'The browser tool call was cancelled.' } }
}

/** Abort every in-flight developer-tools call (setting revoked). */
function cancelDevToolsCalls(): void {
  for (const call of activeToolCalls.values()) {
    if (isDevToolsTool(call.name) && !call.committed) call.controller.abort()
  }
}

/**
 * Attach the debugger to the controlled tab as soon as the user enables the
 * allowance, so network capture sees traffic from the start instead of only
 * after the first devtools call.
 */
async function prewarmDevTools(): Promise<void> {
  await affinityReady
  const target = await resolveToolTab()
  if ('ok' in target || target.id === undefined) return
  await devTools.prewarm(target.id).catch(() => {
    // Attach is lazy by design: a tab that cannot be debugged right now only
    // surfaces an error when a devtools call actually needs it.
  })
}

function approvalFailureMessage(prompt: ApprovalPrompt, authorization: Exclude<ApprovalAuthorization, 'approved'>): string {
  switch (authorization) {
    case 'denied':
      return `The user denied the browser approval request for "${prompt.action}".`
    case 'unavailable':
      return `No browser side panel was available to receive or complete the approval request for "${prompt.action}".`
    case 'timed-out':
      return `The browser approval request for "${prompt.action}" timed out before the user responded.`
    case 'cancelled':
      return `The browser approval request for "${prompt.action}" was cancelled.`
  }
}

async function revokeUnrestrictedAccess(): Promise<void> {
  const calls = [...unsettledToolCalls].filter((call) => call.unrestrictedAccess)
  const refreshes = [...activeFollowRefreshes.values()].filter((refresh) => refresh.unrestrictedAccess)
  for (const call of calls) {
    call.revocationRequested = true
    if (!call.committed) call.controller.abort()
  }
  for (const refresh of refreshes) refresh.controller.abort()
  await Promise.allSettled([
    ...calls.map(async (call) => { await call.settled }),
    ...refreshes.map(async (refresh) => { await refresh.settled }),
  ])
}

function cancelAllToolCalls(): void {
  for (const call of activeToolCalls.values()) {
    if (!call.committed) call.controller.abort()
  }
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
        if (state === 'stopped') refreshPanelResumeHints()
        if (state === 'stopped' && panelPorts.size === 0) disarmBridgeKeepalive()
      },
      onFrame: (frame) => {
        if (frame.t === 'event') {
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
    }, probeBridge, () => panelPorts.size > 0, {
      // Advertised as soon as the platform can serve it, so the host registers
      // the developer-tools group; the user's setting and per-call approval
      // still gate every one of those calls.
      ...devToolsCapability ? { devTools: { version: DEVTOOLS_CAPS_VERSION } } : {},
    })
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
  broadcastDevToolsState()
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
        const settingsMsg = message as { id?: unknown; settings: Partial<Settings> }
        const requestId = typeof settingsMsg.id === 'string' ? settingsMsg.id : undefined
        void settingsReady.then(async () => {
          try {
            const previousConnection = { bridgeUrl: settings.bridgeUrl, token: settings.token }
            await persistSettings(settingsMsg.settings)
            const connectionChanged = settings.bridgeUrl !== previousConnection.bridgeUrl
              || settings.token !== previousConnection.token
            if (panelPorts.size > 0) {
              if (connectionChanged) await startBridge()
              broadcastStatus()
            } else if (connectionChanged) {
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
            }
            if (requestId !== undefined) {
              try { port.postMessage({ type: 'settings.result', id: requestId, ok: true }) } catch { /* port closed */ }
            }
          } catch (error: unknown) {
            if (requestId === undefined) return
            try {
              port.postMessage({
                type: 'settings.result',
                id: requestId,
                ok: false,
                error: { message: error instanceof Error ? error.message : String(error) },
              })
            } catch { /* port closed */ }
          }
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
        void postResumeHint(port, registration.windowId)
        break
      }
      case 'devtools.detach': {
        // The user asked for an immediate detach from the settings page; keep
        // the persisted allowance but drop the current attachment.
        const request = message as { id?: unknown }
        void devTools.detachAll().then(
          () => {
            broadcastDevToolsState()
            if (typeof request.id === 'string') {
              try { port.postMessage({ type: 'devtools.detach.result', id: request.id, ok: true }) } catch { /* port closed */ }
            }
          },
          (error: unknown) => {
            if (typeof request.id !== 'string') return
            try {
              port.postMessage({
                type: 'devtools.detach.result',
                id: request.id,
                ok: false,
                error: { message: error instanceof Error ? error.message : String(error) },
              })
            } catch { /* port closed */ }
          },
        )
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
        const sid = validSessionId(session.sessionId)
        if (sid === undefined) {
          panelActiveSessions.delete(port)
        } else {
          panelActiveSessions.set(port, sid)
          if (session.isNew === true) {
            const bind = Promise.all([affinityReady, pageSessionContexts.ready]).then(async () => {
              const tab = await syncActiveTab()
              const summary = tab === undefined ? null : summarizeTab(tab)
              if (summary === null) throw new Error('No active tab is available to bind this session')
              if (tabAffinity.getSessionTab(sid) === undefined) tabAffinity.bindNewSession(sid, summary)
              pageSessionContexts.bind(sid, { id: summary.tabId, ...summary })
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
      case 'tab-affinity.response': {
        const response = message as { revision?: unknown; decision?: unknown; sessionId?: unknown }
        if (typeof response.revision !== 'number' || !isTabAffinityDecision(response.decision)) break
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
        const rebindSessionId = validSessionId(request.sessionId) ?? panelActiveSessions.get(port)
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
          // A push on connect cannot reach a panel that has not subscribed yet,
          // so the status request is also the pull path for developer tools.
          postDevToolsState(port)
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
          const resumeWindowId = panelWindows.get(port)
          if (resumeWindowId !== undefined) void postResumeHint(port, resumeWindowId)
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
    const panelSessionId = panelActiveSessions.get(port)
    panelActiveSessions.delete(port)
    panelPorts.delete(port)
    if (panelSessionId !== undefined) void checkpointSessionPage(panelSessionId)
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
  void pageSessionContexts.ready.then(() => {
    pageSessionContexts.replaceTab(removedTabId, addedTabId)
  })
  void affinityReady.then(() => {
    // onReplaced is an identity swap (for example prerender activation), not
    // a close or user-visible switch. Transfer IDs synchronously before any
    // metadata lookup so tool resolution never observes the removed target.
    const affectedSessions = tabAffinity.sessionIdsForTab(removedTabId)
    if (!tabAffinity.replaceTab(removedTabId, addedTabId)) return
    for (const sid of affectedSessions) {
      activeFollowRefreshes.get(sid)?.controller.abort()
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
  void pageSessionContexts.ready.then(() => {
    pageSessionContexts.removeTab(tabId)
  })
  void affinityReady.then(() => {
    const affectedSessions = tabAffinity.sessionIdsForTab(tabId)
    if (!tabAffinity.removeTab(tabId)) return
    for (const sid of affectedSessions) {
      activeFollowRefreshes.get(sid)?.controller.abort()
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

// A closed tab cannot stay debugged; release the attachment immediately so the
// "being debugged" banner never outlives its page.
chrome.tabs.onRemoved.addListener((tabId) => {
  devTools.releaseTab(tabId)
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
