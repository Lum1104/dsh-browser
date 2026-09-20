/**
 * Bridge WebSocket client (background side): connects to the dsh bridge,
 * authenticates with the bearer token, keeps the connection alive with
 * exponential-backoff reconnects, and answers protocol pings.
 *
 * The reconnect policy mirrors the dsh GUI's own ConnectionController: base
 * 500ms, ×2 per attempt, capped at 10s, jittered 0.5–1×. After a streak of
 * failed probes the optional `resolveUrl` hook may replace the target URL so
 * Desktop random-port restarts can be followed without user action.
 *
 * @module
 */

import type { BridgeCaps, ClientFrame, ServerFrame } from '@yuxianglin/dsh-bridge-browser/src/protocol.ts'
import {
  DEFAULT_SNAPSHOT_MAX_CHARS,
  isServerFrame,
  parseBridgeFrame,
} from '@yuxianglin/dsh-bridge-browser/src/protocol.ts'

/** Coarse connection state for the UI. */
export type BridgeState = 'connecting' | 'connected' | 'reconnecting' | 'stopped'

/** Frame/state sinks owned by the background assembly. */
export interface BridgeSinks {
  onStateChange(state: BridgeState): void
  onFrame(frame: ServerFrame): void
  onHelloOk(caps: BridgeCaps): void
}

/** Resolve whether opening a WebSocket is expected to succeed. */
type BridgeProbe = (url: string) => Promise<boolean>

/** Re-discover a bridge URL after repeated probe failures. */
export type BridgeResolveUrl = (shouldContinue: () => boolean) => Promise<string | undefined>

const BACKOFF_BASE_MS = 500
const BACKOFF_MAX_MS = 10_000
const HELLO_ACK_TIMEOUT_MS = 5_000
/** Probe failures before asking `resolveUrl` for a replacement address. */
const REDISCOVER_AFTER_FAILURES = 3

/**
 * Owns one WebSocket connection generation and the reconnect loop.
 */
export class BridgeClient {
  private ws: WebSocket | null = null
  private attempt = 0
  private running = false
  /** Per-start generation token: a new start() invalidates any in-flight loop. */
  private generation = 0
  private url = ''
  private token = ''
  private ackTimer: ReturnType<typeof setTimeout> | undefined

  constructor(
    readonly sinks: BridgeSinks,
    private readonly probe: BridgeProbe = async () => true,
    /** Whether a disconnected client still has an active user-owned lease. */
    private readonly shouldReconnect: () => boolean = () => true,
    private readonly resolveUrl?: BridgeResolveUrl,
  ) {}

  /** Current coarse state (mirrors the last emitted sink value). */
  state: BridgeState = 'stopped'

  /** Active bridge WebSocket URL (may change after rediscovery). */
  get currentUrl(): string {
    return this.url
  }

  /**
   * Connect (or reconnect) to the bridge. Idempotent: calling again with the
   * same url/token restarts the loop from attempt 0.
   * @param url - bridge WebSocket URL (e.g. ws://127.0.0.1:3080/ext/bridge).
   * @param token - bearer token from settings.
   */
  start(url: string, token: string): void {
    this.stop()
    this.url = url
    this.token = token
    this.running = true
    this.attempt = 0
    this.generation += 1
    void this.loop(this.generation)
  }

  /** Stop the loop and close the current socket. */
  stop(): void {
    this.running = false
    this.clearAckTimer()
    this.ws?.close()
    this.ws = null
    this.emitState('stopped')
  }

  /**
   * Drop an in-progress reconnect when its UI lease disappears, while keeping
   * an authenticated socket alive for background approvals already enabled by
   * the user. A later socket loss will still consult shouldReconnect().
   */
  suspendReconnect(): void {
    if (this.state === 'connected') return
    this.stop()
  }

  /** Whether a frame can be sent right now. */
  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN
  }

  /**
   * Send one client frame.
   * @param frame - frame to send.
   * @returns false when no live socket exists.
   */
  send(frame: ClientFrame): boolean {
    const socket = this.ws
    if (socket === null || socket.readyState !== WebSocket.OPEN) return false
    socket.send(JSON.stringify(frame))
    return true
  }

  private async loop(generation: number): Promise<void> {
    let failStreak = 0
    while (this.running && generation === this.generation) {
      if (!this.retryAllowed()) return
      const reachable = await this.probe(this.url).catch(() => false)
      if (!this.running || generation !== this.generation) return
      if (!this.retryAllowed()) return
      if (!reachable) {
        failStreak += 1
        if (failStreak >= REDISCOVER_AFTER_FAILURES && this.resolveUrl !== undefined) {
          const next = await this.resolveUrl(() => this.running && generation === this.generation)
          failStreak = 0
          if (!this.running || generation !== this.generation) return
          if (next !== undefined && next !== this.url) {
            this.url = next
            this.attempt = 0
            this.emitState('connecting')
            continue
          }
        }
        this.emitState('reconnecting')
        await this.waitBeforeRetry()
        continue
      }

      failStreak = 0
      const socket = new WebSocket(this.url)
      this.ws = socket
      // A replacement is an ownership handoff, not a transient transport
      // failure. Yield permanently so two open profiles cannot reconnect in a
      // tight loop and repeatedly evict one another.
      socket.addEventListener('close', (event) => {
        if (event.code !== 4000 || this.ws !== socket || !this.running) return
        this.running = false
        this.clearAckTimer()
        this.ws = null
        this.emitState('stopped')
      }, { once: true })
      this.emitState('connecting')

      await new Promise<void>((resolve) => {
        socket.addEventListener('open', () => { resolve() }, { once: true })
        socket.addEventListener('close', () => { resolve() }, { once: true })
        socket.addEventListener('error', () => { resolve() }, { once: true })
      })
      if (!this.running || generation !== this.generation) {
        socket.close()
        return
      }
      if (socket.readyState !== WebSocket.OPEN) {
        await this.fail(socket)
        continue
      }

      // Authenticate: hello must be accepted before any other traffic.
      socket.send(JSON.stringify({
        t: 'hello',
        token: this.token,
        caps: { textOnly: true, snapshotMaxChars: DEFAULT_SNAPSHOT_MAX_CHARS, maxInteractiveItems: 60 },
      } satisfies ClientFrame))

      let authed = false
      const accepted = await new Promise<boolean>((resolve) => {
        const onMessage = (event: MessageEvent): void => {
          const frame = parseBridgeFrame(String(event.data))
          if (frame === undefined) return
          if (!authed) {
            if (frame.t === 'hello.ok') {
              authed = true
              this.clearAckTimer()
              resolve(true)
              this.sinks.onHelloOk(frame.caps)
            } else if (frame.t === 'error' || frame.t === 'rpc.result' || frame.t === 'event') {
              this.sinks.onFrame(frame)
            }
            return
          }
          if (frame.t === 'ping') {
            socket.send(JSON.stringify({ t: 'pong' } satisfies ClientFrame))
            return
          }
          if (isServerFrame(frame)) this.sinks.onFrame(frame)
        }
        socket.addEventListener('message', onMessage)
        socket.addEventListener('close', () => {
          this.clearAckTimer()
          resolve(false)
        }, { once: true })
        this.ackTimer = setTimeout(() => resolve(false), HELLO_ACK_TIMEOUT_MS)
      })
      if (!accepted || !this.running || generation !== this.generation) {
        await this.fail(socket)
        continue
      }

      this.attempt = 0
      this.emitState('connected')

      await new Promise<void>((resolve) => {
        socket.addEventListener('close', () => resolve(), { once: true })
        socket.addEventListener('error', () => resolve(), { once: true })
      })
      if (!this.running || generation !== this.generation) {
        socket.close()
        return
      }
      await this.fail(socket)
    }
  }

  private async fail(socket: WebSocket): Promise<void> {
    if (this.ws === socket) this.ws = null
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close()
    }
    if (!this.running) return
    if (!this.retryAllowed()) return
    this.emitState('reconnecting')
    await this.waitBeforeRetry()
  }

  private retryAllowed(): boolean {
    if (this.shouldReconnect()) return true
    this.running = false
    this.emitState('stopped')
    return false
  }

  private async waitBeforeRetry(): Promise<void> {
    this.attempt += 1
    const cap = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, this.attempt - 1))
    const delay = cap / 2 + Math.random() * (cap / 2)
    await new Promise<void>((resolve) => { setTimeout(resolve, delay) })
  }

  private clearAckTimer(): void {
    if (this.ackTimer !== undefined) {
      clearTimeout(this.ackTimer)
      this.ackTimer = undefined
    }
  }

  private emitState(state: BridgeState): void {
    this.state = state
    this.sinks.onStateChange(state)
  }
}
