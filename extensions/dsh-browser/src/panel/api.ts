/**
 * Panel ↔ background port client. The panel never touches the bridge or the
 * gateway directly; everything goes through the service worker's port.
 *
 * @module
 */

import type { BridgeCaps } from '@deepseek-ai/dsh-bridge-browser/src/protocol.ts'
import type { ServerFrame } from '@deepseek-ai/dsh-bridge-browser/src/protocol.ts'
import type { BridgeState } from '../background/bridge.ts'
import type { Settings } from '../background/index.ts'

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

interface EventMessage {
  type: 'event'
  frame: ServerFrame
}

type BackgroundMessage = RpcResultMessage | RespondResultMessage | StatusMessage | EventMessage

/** The panel API surface. */
export interface PanelApi {
  rpc<T = unknown>(method: string, payload?: unknown): Promise<T>
  /**
   * Answer a pending host interaction (user question / approval) by its rpcId.
   * Resolves with the gateway's receipt ({ accepted }).
   */
  respond(id: string, rpcId: string, result: { ok: boolean; value?: unknown; error?: { code: string; message: string } }): Promise<unknown>
  onStatus(callback: (state: BridgeState, caps: BridgeCaps | null) => void): () => void
  onEvent(callback: (frame: ServerFrame) => void): () => void
  updateSettings(settings: Partial<PanelSettings>): void
  requestStatus(): void
}

/** Connect to the background service worker and return the panel API. */
export function connectPanel(): PanelApi {
  const port = chrome.runtime.connect({ name: 'dsh-panel' })
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  const pendingRespond = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  const statusListeners = new Set<(state: BridgeState, caps: BridgeCaps | null) => void>()
  const eventListeners = new Set<(frame: ServerFrame) => void>()

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
        else entry.reject(new Error(business?.error?.message ?? msg.error?.message ?? 'rpc failed'))
        break
      }
      case 'status':
        for (const listener of statusListeners) listener(msg.state, msg.caps)
        break
      case 'respond.result': {
        const entry = pendingRespond.get(msg.id)
        if (entry === undefined) return
        pendingRespond.delete(msg.id)
        if (msg.ok) entry.resolve(msg.result)
        else entry.reject(new Error(msg.error?.message ?? 'respond failed'))
        break
      }
      case 'event':
        for (const listener of eventListeners) listener(msg.frame)
        break
    }
  })

  port.onDisconnect.addListener(() => {
    const error = new Error('background disconnected')
    for (const entry of pending.values()) entry.reject(error)
    pending.clear()
    for (const entry of pendingRespond.values()) entry.reject(error)
    pendingRespond.clear()
  })

  return {
    rpc<T>(method: string, payload?: unknown): Promise<T> {
      const id = crypto.randomUUID()
      return new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve: (value) => resolve(value as T), reject })
        port.postMessage({ type: 'rpc', id, method, payload })
      })
    },
    respond(id, rpcId, result): Promise<unknown> {
      return new Promise((resolve, reject) => {
        pendingRespond.set(id, { resolve, reject })
        port.postMessage({ type: 'respond', id, rpcId, result })
      })
    },
    onStatus(callback) {
      statusListeners.add(callback)
      return () => { statusListeners.delete(callback) }
    },
    onEvent(callback) {
      eventListeners.add(callback)
      return () => { eventListeners.delete(callback) }
    },
    updateSettings(next) {
      port.postMessage({ type: 'settings', settings: next })
    },
    requestStatus() {
      port.postMessage({ type: 'request-status' })
    },
  }
}
