// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { BridgeClient, type BridgeState } from '../src/background/bridge.ts'

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 3
  static instances: FakeWebSocket[] = []

  readyState = FakeWebSocket.CONNECTING

  constructor(readonly url: string) {
    super()
    FakeWebSocket.instances.push(this)
  }

  send(): void {}

  open(): void {
    this.readyState = FakeWebSocket.OPEN
    this.dispatchEvent(new Event('open'))
  }

  receive(frame: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(frame) }))
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === FakeWebSocket.CLOSED) return
    this.readyState = FakeWebSocket.CLOSED
    this.dispatchEvent(new CloseEvent('close', { code, reason }))
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  FakeWebSocket.instances = []
})

describe('BridgeClient connection probe', () => {
  it('waits without opening a WebSocket while the local bridge is unavailable', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const states: BridgeState[] = []
    const probe = vi.fn(async () => false)
    const client = new BridgeClient({
      onStateChange: (state) => { states.push(state) },
      onFrame: () => {},
      onHelloOk: () => {},
    }, probe)

    client.start('ws://127.0.0.1:3080/ext/bridge', '')
    await vi.advanceTimersByTimeAsync(0)

    expect(probe).toHaveBeenCalledOnce()
    expect(FakeWebSocket.instances).toHaveLength(0)
    expect(states.at(-1)).toBe('reconnecting')
    client.stop()
  })

  it('opens the WebSocket after the probe succeeds', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const client = new BridgeClient({
      onStateChange: () => {},
      onFrame: () => {},
      onHelloOk: () => {},
    }, async () => true)

    client.start('ws://127.0.0.1:3080/ext/bridge', '')
    await vi.advanceTimersByTimeAsync(0)

    expect(FakeWebSocket.instances).toHaveLength(1)
    client.stop()
  })

  it('does not retry after the bridge explicitly replaces this connection', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const states: BridgeState[] = []
    const client = new BridgeClient({
      onStateChange: (state) => { states.push(state) },
      onFrame: () => {},
      onHelloOk: () => {},
    })

    client.start('ws://127.0.0.1:3080/ext/bridge', '')
    await vi.advanceTimersByTimeAsync(0)
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    await vi.advanceTimersByTimeAsync(0)
    socket.receive({
      t: 'hello.ok',
      caps: { textOnly: true, snapshotMaxChars: 32_000, maxInteractiveItems: 60 },
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(states.at(-1)).toBe('connected')

    socket.close(4000, 'replaced')
    await vi.advanceTimersByTimeAsync(30_000)

    expect(states.at(-1)).toBe('stopped')
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('stops reconnecting after its user-owned lease disappears', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    let active = true
    const states: BridgeState[] = []
    const client = new BridgeClient({
      onStateChange: (state) => { states.push(state) },
      onFrame: () => {},
      onHelloOk: () => {},
    }, async () => true, () => active)

    client.start('ws://127.0.0.1:3080/ext/bridge', '')
    await vi.advanceTimersByTimeAsync(0)
    const socket = FakeWebSocket.instances[0]!
    active = false
    socket.close()
    await vi.advanceTimersByTimeAsync(30_000)

    expect(states.at(-1)).toBe('stopped')
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('rediscovers a new URL after repeated probe failures and resets backoff', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const states: BridgeState[] = []
    let probes = 0
    const resolveUrl = vi.fn(async () => 'ws://127.0.0.1:50403/ext/bridge')
    const client = new BridgeClient({
      onStateChange: (state) => { states.push(state) },
      onFrame: () => {},
      onHelloOk: () => {},
    }, async () => {
      probes += 1
      return probes > 3
    }, () => true, resolveUrl)

    client.start('ws://127.0.0.1:3080/ext/bridge', '')
    await vi.advanceTimersByTimeAsync(0)
    expect(states.at(-1)).toBe('reconnecting')
    await vi.advanceTimersByTimeAsync(30_000)

    expect(resolveUrl).toHaveBeenCalled()
    expect(client.currentUrl).toBe('ws://127.0.0.1:50403/ext/bridge')
    expect(states).toContain('connecting')
    expect(FakeWebSocket.instances.some((socket) => socket.url.includes('50403'))).toBe(true)
    client.stop()
  })
})
