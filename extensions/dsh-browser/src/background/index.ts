/**
 * Background service worker entry: owns the bridge connection, the gateway
 * RPC client, tool dispatch to the active tab, and the panel port service.
 *
 * MV3 survival: the service worker is kept alive by the panel's open port
 * plus a half-minute `alarms` keepalive that re-arms the reconnect loop.
 *
 * Panel port protocol (chrome.runtime.connect, name "dsh-panel"):
 *   panel → bg: { type: 'rpc', id, method, payload }
 *   panel → bg: { type: 'respond', id, rpcId, result }
 *   panel → bg: { type: 'settings', settings: Partial<Settings> }
 *   panel → bg: { type: 'approval.response', id, decision }
 *   panel → bg: { type: 'request-status' }
 *   bg → panel: { type: 'rpc.result', id, ok, result? | error? }
 *   bg → panel: { type: 'respond.result', id, ok, result? | error? }
 *   bg → panel: { type: 'status', state: BridgeState, caps? }
 *   bg → panel: { type: 'event', frame: ServerFrame }
 *   bg → panel: { type: 'approval.request', request }
 *   bg → panel: { type: 'approval.resolved', id }
 *
 * @module
 */

import { isRespondResult, type BridgeCaps, type RespondResult } from '@deepseek-ai/dsh-bridge-browser/src/protocol.ts'
import type { ServerFrame } from '@deepseek-ai/dsh-bridge-browser/src/protocol.ts'
import { BRIDGE_CONFIG_PATH, BRIDGE_PATH } from '@deepseek-ai/dsh-bridge-browser/src/protocol.ts'
import { BridgeClient, type BridgeState } from './bridge.ts'
import { createRpc } from './rpc.ts'
import { dispatchToolCall, type ToolCall } from './tools.ts'
import {
  isApprovalDecision,
  type ApprovalDecision,
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

/** User settings persisted in chrome.storage.local. */
export interface Settings {
  bridgeUrl: string
  token: string
  sharePageContent: 'ask' | 'auto' | 'off'
  /** Origins whose state-changing actions may run without another prompt. */
  trustedActionOrigins: string[]
  /** Auto-open the side panel when a browser action needs approval while it is closed. */
  autoOpenSidePanel: boolean
  /** Auto-resume the most recent session when the panel connects. */
  autoResumeSession: boolean
}

const SETTINGS_DEFAULTS: Settings = {
  // 空地址 = 自动探测本机 dsh（零配置）；手动填地址时优先手动。
  bridgeUrl: '',
  token: '',
  sharePageContent: 'auto',
  trustedActionOrigins: [],
  autoOpenSidePanel: true,
  autoResumeSession: true,
}

/** 自动探测的候选端口（dsh web 默认 3080；--port 覆盖的常见值）。 */
const DISCOVERY_PORTS = [3080, 3081, 3090]
const LEGACY_LOCAL_URL = 'ws://127.0.0.1:3080'

/** 探测本机 dsh 的桥地址：fetch /ext/bridge-config 直到成功。 */
async function discoverBridge(): Promise<string | undefined> {
  for (const port of DISCOVERY_PORTS) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/ext/bridge-config`, {
        signal: AbortSignal.timeout(1_500),
      })
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

let settings: Settings = { ...SETTINGS_DEFAULTS }
let caps: BridgeCaps | null = null
let bridge: BridgeClient | null = null
let rpc: ReturnType<typeof createRpc> | null = null
/** Most recently observed session id from the event stream (the session that triggered the last browser action). */
let lastActiveSessionId: string | null = null
const panelPorts = new Set<chrome.runtime.Port>()
const interactionResponses = new InteractionResponseRouter()
const transientEvents = new TransientEventCache()
/** Ephemeral allowlist: cleared when the last side panel closes or this worker restarts. */
const sessionTrustedActionOrigins = new Set<string>()
/** Tool calls that can still be withdrawn by a bridge `tool.cancel` frame. */
const activeToolCalls = new Map<string, AbortController>()
const pendingApprovals = new Map<string, {
  resolve: (decision: ApprovalDecision) => void
  timer: ReturnType<typeof setTimeout>
}>()
const APPROVAL_TIMEOUT_MS = 60_000

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
    autoOpenSidePanel: candidate.autoOpenSidePanel !== false,
    autoResumeSession: candidate.autoResumeSession !== false,
  }
}

function broadcastStatus(): void {
  const payload = { type: 'status', state: bridge?.state ?? ('stopped' as BridgeState), caps }
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

function settleApproval(id: string, decision: ApprovalDecision): void {
  const pending = pendingApprovals.get(id)
  if (pending === undefined) return
  pendingApprovals.delete(id)
  clearTimeout(pending.timer)
  pending.resolve(decision)
  broadcastApprovalResolved(id)
}

/** Auto-open the side panel (setting-gated). Falls back to a notification when the browser rejects the call. */
async function ensureSidePanelOpen(): Promise<void> {
  if (settings.autoOpenSidePanel !== true) return
  const zh = getUiLocale() === 'zh'
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    const windowId = tab?.windowId ?? (await chrome.windows.getLastFocused()).id
    if (windowId !== undefined) await chrome.sidePanel.open({ windowId })
  } catch {
    try {
      await chrome.notifications.create('dsh-browser-approval', {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('assets/icons/icon128.png'),
        title: zh ? 'dsh 浏览器助手' : 'dsh Browser Assistant',
        message: zh
          ? '侧边栏有浏览器操作待审批，请点击工具栏鲸鱼图标打开侧边栏（审批会等待 60 秒）。'
          : 'A browser action is waiting for approval. Click the whale icon in the toolbar to open the side panel (the request waits 60s).',
      })
    } catch { /* notifications unavailable */ }
  }
}

function requestApproval(prompt: ApprovalPrompt, signal: AbortSignal): Promise<ApprovalDecision> {
  if (signal.aborted) return Promise.resolve('deny')
  const request: ApprovalRequest = { ...prompt, id: crypto.randomUUID() }
  return new Promise((resolve) => {
    const onAbort = (): void => { settleApproval(request.id, 'deny') }
    const resolveWithCleanup = (decision: ApprovalDecision): void => {
      signal.removeEventListener('abort', onAbort)
      resolve(decision)
    }
    const timer = setTimeout(() => { settleApproval(request.id, 'deny') }, APPROVAL_TIMEOUT_MS)
    pendingApprovals.set(request.id, { resolve: resolveWithCleanup, timer })
    signal.addEventListener('abort', onAbort, { once: true })
    // Close the small race between the initial check and listener setup.
    if (signal.aborted) {
      settleApproval(request.id, 'deny')
      return
    }
    // 侧边栏未打开时不再立即拒绝：自动弹出（受设置开关控制），并在超时窗口内
    // 轮询等待面板端口出现后再送达审批；超时仍 fail-closed 拒绝。
    if (panelPorts.size === 0) void ensureSidePanelOpen()
    let delivered = false
    let poll: ReturnType<typeof setInterval> | undefined
    const tryDeliver = (): void => {
      if (delivered) return
      if (pendingApprovals.get(request.id) === undefined) {
        // 已被 settle（超时/abort）：停止轮询。
        if (poll !== undefined) clearInterval(poll)
        return
      }
      for (const port of panelPorts) {
        try {
          port.postMessage({ type: 'approval.request', request })
          delivered = true
          if (poll !== undefined) clearInterval(poll)
          return
        } catch { /* port already closed */ }
      }
    }
    tryDeliver()
    if (!delivered) poll = setInterval(tryDeliver, 500)
  })
}

async function authorizeToolCall(prompt: ApprovalPrompt, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false
  if (actionCoveredByTrustedOrigins(
    prompt,
    sessionTrustedActionOrigins,
    settings.trustedActionOrigins,
  )) {
    return true
  }
  const decision = await requestApproval(prompt, signal)
  if (signal.aborted) return false
  if (decision === 'always-allow-reads' && prompt.kind === 'read') {
    await persistSettings({ sharePageContent: 'auto' })
    return true
  }
  if (decision === 'trust-session' && prompt.kind === 'action' && prompt.canTrust && prompt.origins.length === 1) {
    sessionTrustedActionOrigins.add(prompt.origins[0]!)
    return true
  }
  // Retain wire compatibility with panels from the previous build. The new UI
  // manages permanent trust explicitly in Settings instead of offering it in
  // the action dialog.
  if (decision === 'trust-origin' && prompt.kind === 'action' && prompt.canTrust && prompt.origins.length === 1) {
    await persistSettings({ trustedActionOrigins: [...settings.trustedActionOrigins, prompt.origins[0]!] })
    return true
  }
  return decision === 'allow-once'
}

/** 把协商的快照预算下发到活动标签页的 content script（配置生效）。 */
async function pushBudgetToActiveTab(negotiated: BridgeCaps): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  if (tab?.id === undefined) return
  try {
    await chrome.tabs.sendMessage(tab.id, {
      type: 'DSH_BUDGET',
      budget: { maxItems: negotiated.maxInteractiveItems, maxChars: negotiated.snapshotMaxChars },
    })
  } catch {
    // 页面尚未注入 content script：下一次快照仍用默认预算，可接受。
  }
}

/** Route one tool.call frame to the active tab and answer over the bridge. */
function routeToolCall(call: ToolCall): void {
  if (bridge === null) return
  activeToolCalls.get(call.id)?.abort()
  const controller = new AbortController()
  activeToolCalls.set(call.id, controller)
  const expiryTimer = call.expiresAt === undefined
    ? undefined
    : setTimeout(() => { controller.abort() }, Math.max(0, call.expiresAt - Date.now()))
  const budget = caps === null
    ? undefined
    : { maxItems: caps.maxInteractiveItems, maxChars: caps.snapshotMaxChars }
  void dispatchToolCall(
    call,
    settings.sharePageContent,
    budget,
    (prompt) => authorizeToolCall(prompt, controller.signal),
    controller.signal,
  ).then(
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
  let url = settings.bridgeUrl
  if (url === '') {
    url = await discoverBridge() ?? ''
  }
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
      },
      onFrame: (frame) => {
        if (frame.t === 'event') {
          transientEvents.ingest(frame)
          broadcastEvent(frame)
          const payload = frame.frame.payload as { sessionId?: string } | undefined
          if (typeof payload?.sessionId === 'string') lastActiveSessionId = payload.sessionId
        }
        else if (frame.t === 'tool.call') routeToolCall(frame)
        else if (frame.t === 'tool.cancel') cancelToolCall(frame.id)
        else if (frame.t === 'respond.result') interactionResponses.route(frame)
        // rpc.result is settled by the rpc facade (wrapped below).
      },
      onHelloOk: (negotiated) => {
        caps = negotiated
        broadcastStatus()
        void pushBudgetToActiveTab(negotiated)
      },
    }, probeBridge)
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
  panelPorts.add(port)
  if (bridge === null) void startBridge()
  try { port.postMessage({ type: 'status', state: bridge?.state ?? ('stopped' as BridgeState), caps }) } catch { /* port closed */ }
  try {
    port.postMessage({ type: 'resume-hint', sessionId: lastActiveSessionId })
  } catch { /* port closed */ }
  port.onMessage.addListener((message: unknown) => {
    if (typeof message !== 'object' || message === null) return
    const msg = message as { type?: string }
    switch (msg.type) {
      case 'rpc': {
        const rpcMsg = message as { id: string; method: string; payload?: unknown }
        void gatewayRpc(rpcMsg.method, rpcMsg.payload).then(
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
        void persistSettings(settingsMsg.settings).then(async () => {
          await startBridge()
          broadcastStatus()
        })
        break
      }
      case 'approval.response': {
        const approval = message as { id?: unknown; decision?: unknown }
        if (typeof approval.id === 'string' && isApprovalDecision(approval.decision)) {
          settleApproval(approval.id, approval.decision)
        }
        break
      }
      case 'request-status':
        try {
          port.postMessage({ type: 'status', state: bridge?.state ?? ('stopped' as BridgeState), caps })
          for (const frame of transientEvents.replay()) port.postMessage({ type: 'event', frame })
        } catch { /* port closed */ }
        break
    }
  })
  port.onDisconnect.addListener(() => {
    panelPorts.delete(port)
    interactionResponses.removePort(port)
    if (panelPorts.size === 0) {
      sessionTrustedActionOrigins.clear()
      for (const id of [...pendingApprovals.keys()]) settleApproval(id, 'deny')
    }
  })
})

// ---- Keepalive ----

chrome.alarms.create('bridge-keepalive', { periodInMinutes: 0.5 })
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'bridge-keepalive') return
  if (bridge === null || bridge.state === 'reconnecting') void startBridge()
})

// ---- Boot ----

// Clicking the toolbar icon opens the side panel directly (Chrome 116+).
void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {})

void loadSettings().then(async (loaded) => {
  settings = loaded
  await startBridge()
})
