/**
 * Panel ↔ background port client. The panel never touches the bridge or the
 * gateway directly; everything goes through the service worker's port.
 *
 * @module
 */

import type { BridgeCaps, RespondResult } from '@deepseek-ai/dsh-bridge-browser/src/protocol.ts'
import type { ServerFrame } from '@deepseek-ai/dsh-bridge-browser/src/protocol.ts'
import type { BridgeState } from '../background/bridge.ts'
import type { Settings } from '../background/index.ts'
import type { ApprovalDecision, ApprovalRequest } from '../security/approval.ts'
import { getUiLocale } from '../i18n.ts'

/** Panel-side subset of the extension settings. */
export type PanelSettings = Settings

interface RpcResultMessage {
  type: 'rpc.result'
  id: string
  ok: boolean
  result?: unknown
  error?: { code: string; message: string }
}

interface RespondResultMessage {
  type: 'respond.result'
  id: string
  ok: boolean
  result?: unknown
  error?: { code: string; message: string }
}

interface StatusMessage {
  type: 'status'
  state: BridgeState
  caps: BridgeCaps | null
}

interface ResumeHintMessage {
  type: 'resume-hint'
  sessionId: string | null
}

interface EventMessage {
  type: 'event'
  frame: ServerFrame
}

interface ApprovalRequestMessage {
  type: 'approval.request'
  request: ApprovalRequest
}

interface ApprovalResolvedMessage {
  type: 'approval.resolved'
  id: string
}

type BackgroundMessage = RpcResultMessage | RespondResultMessage | StatusMessage | ResumeHintMessage | EventMessage | ApprovalRequestMessage | ApprovalResolvedMessage

/** The panel API surface. */
export interface PanelApi {
  rpc<T = unknown>(method: string, payload?: unknown): Promise<T>
  respond(rpcId: string, result: RespondResult): Promise<unknown>
  onStatus(callback: (state: BridgeState, caps: BridgeCaps | null) => void): () => void
  onResumeHint(callback: (sessionId: string | null) => void): () => void
  onEvent(callback: (frame: ServerFrame) => void): () => void
  onApprovalRequest(callback: (request: ApprovalRequest) => void): () => void
  onApprovalResolved(callback: (id: string) => void): () => void
  respondToApproval(id: string, decision: ApprovalDecision): void
  updateSettings(settings: Partial<PanelSettings>): void
  requestStatus(): void
}

/** Connect to the background service worker and return the panel API. */
export function connectPanel(): PanelApi {
  const port = chrome.runtime.connect({ name: 'dsh-panel' })
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  const pendingResponses = new Map<string, {
    resolve: (value: unknown) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  }>()
  const statusListeners = new Set<(state: BridgeState, caps: BridgeCaps | null) => void>()
  const resumeHintListeners = new Set<(sessionId: string | null) => void>()
  const eventListeners = new Set<(frame: ServerFrame) => void>()
  const approvalListeners = new Set<(request: ApprovalRequest) => void>()
  const approvalResolvedListeners = new Set<(id: string) => void>()

  port.onMessage.addListener((message: unknown) => {
    if (typeof message !== 'object' || message === null) return
    const msg = message as BackgroundMessage
    switch (msg.type) {
      case 'rpc.result': {
        const entry = pending.get(msg.id)
        if (entry === undefined) return
        pending.delete(msg.id)
        // The bridge relays the gateway's ServerResponse envelope verbatim
        // ({ type, rpcId, result: { ok, value | error } }); unwrap the value
        // so callers get the business payload, and surface business errors.
        const envelope = msg.result as { result?: { ok?: boolean; value?: unknown; error?: { message?: string } } } | undefined
        const business = envelope?.result
        if (msg.ok && business?.ok !== false) entry.resolve(business?.value)
        else entry.reject(new Error(business?.error?.message ?? msg.error?.message
          ?? (getUiLocale() === 'zh' ? 'RPC 请求失败' : 'RPC request failed')))
        break
      }
      case 'respond.result': {
        const entry = pendingResponses.get(msg.id)
        if (entry === undefined) return
        pendingResponses.delete(msg.id)
        clearTimeout(entry.timer)
        if (msg.ok) entry.resolve(msg.result)
        else entry.reject(new Error(msg.error?.message
          ?? (getUiLocale() === 'zh' ? '回答提交失败' : 'Failed to send the answer')))
        break
      }
      case 'status':
        for (const listener of statusListeners) listener(msg.state, msg.caps)
        break
      case 'resume-hint':
        for (const listener of resumeHintListeners) listener(msg.sessionId)
        break
      case 'event':
        for (const listener of eventListeners) listener(msg.frame)
        break
      case 'approval.request':
        for (const listener of approvalListeners) listener(msg.request)
        break
      case 'approval.resolved':
        for (const listener of approvalResolvedListeners) listener(msg.id)
        break
    }
  })

  port.onDisconnect.addListener(() => {
    const error = new Error(getUiLocale() === 'zh' ? '后台连接已断开' : 'Background connection lost')
    for (const entry of pending.values()) entry.reject(error)
    pending.clear()
    for (const entry of pendingResponses.values()) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    pendingResponses.clear()
  })

  return {
    rpc<T>(method: string, payload?: unknown): Promise<T> {
      const id = crypto.randomUUID()
      return new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve: (value) => resolve(value as T), reject })
        port.postMessage({ type: 'rpc', id, method, payload })
      })
    },
    respond(rpcId, result) {
      const id = crypto.randomUUID()
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingResponses.delete(id)
          reject(new Error(getUiLocale() === 'zh' ? '回答提交超时，请重试' : 'Sending the answer timed out. Try again.'))
        }, 35_000)
        pendingResponses.set(id, { resolve, reject, timer })
        port.postMessage({ type: 'respond', id, rpcId, result })
      })
    },
    onStatus(callback) {
      statusListeners.add(callback)
      return () => { statusListeners.delete(callback) }
    },
    onResumeHint(callback) {
      resumeHintListeners.add(callback)
      return () => { resumeHintListeners.delete(callback) }
    },
    onEvent(callback) {
      eventListeners.add(callback)
      return () => { eventListeners.delete(callback) }
    },
    onApprovalRequest(callback) {
      approvalListeners.add(callback)
      return () => { approvalListeners.delete(callback) }
    },
    onApprovalResolved(callback) {
      approvalResolvedListeners.add(callback)
      return () => { approvalResolvedListeners.delete(callback) }
    },
    respondToApproval(id, decision) {
      port.postMessage({ type: 'approval.response', id, decision })
    },
    updateSettings(next) {
      port.postMessage({ type: 'settings', settings: next })
    },
    requestStatus() {
      port.postMessage({ type: 'request-status' })
    },
  }
}
