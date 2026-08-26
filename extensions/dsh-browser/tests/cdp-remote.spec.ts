// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  discoverRemoteCdpPort,
  evaluateViaRemoteCdp,
  REMOTE_CDP_PORTS,
  type RemoteCdpDeps,
} from '../src/background/cdp-remote.ts'

/** One page target as /json/list reports it. */
function target(id: string, url: string, type = 'page'): Record<string, unknown> {
  return { id, url, type }
}

/**
 * A fake DevTools endpoint: HTTP for discovery and target listing, plus a
 * scripted WebSocket that records every frame the module sends.
 */
function endpoint(options: {
  ports?: number[]
  targets?: Record<string, unknown>[]
  reply?: (frame: { id: number; method: string; params?: Record<string, unknown> }) => unknown
  openFails?: boolean
  probeValue?: (targetId: string) => unknown
} = {}) {
  const listening = new Set(options.ports ?? [9222])
  const sent: { id: number; method: string; params?: Record<string, unknown> }[] = []
  const sockets: string[] = []
  let planted = ''
  const probes: string[] = []

  const deps: RemoteCdpDeps = {
    fetch: async (url) => {
      const port = Number(/:(\d+)\//.exec(url)?.[1] ?? 0)
      if (!listening.has(port)) throw new TypeError('Failed to fetch')
      if (url.endsWith('/json/version')) {
        return { ok: true, json: async () => ({ Browser: 'Edge/1.2.3' }) } as unknown as Response
      }
      return { ok: true, json: async () => options.targets ?? [] } as unknown as Response
    },
    connect: (url) => {
      sockets.push(url)
      const socketTargetId = url.split('/').pop() ?? ''
      const listeners = new Map<string, ((event: unknown) => void)[]>()
      const emit = (type: string, event: unknown): void => {
        for (const listener of listeners.get(type) ?? []) listener(event)
      }
      const socket = {
        addEventListener(type: string, listener: (event: unknown) => void) {
          listeners.set(type, [...(listeners.get(type) ?? []), listener])
          // Settle the handshake as soon as the module is listening for it.
          if (type === (options.openFails === true ? 'error' : 'open')) {
            queueMicrotask(() => { emit(type, {}) })
          }
        },
        send(raw: string) {
          const frame = JSON.parse(raw) as { id: number; method: string; params?: Record<string, unknown> }
          sent.push(frame)
          const expression = frame.params?.expression
          const isProbeRead = typeof expression === 'string' && expression.includes('data-dsh-probe')
          if (isProbeRead) probes.push(socketTargetId)
          const result = isProbeRead
            ? { result: { value: options.probeValue?.(socketTargetId) ?? planted } }
            : options.reply?.(frame) ?? { result: { type: 'string', value: 'ok' } }
          queueMicrotask(() => { emit('message', { data: JSON.stringify({ id: frame.id, result }) }) })
        },
        close() { emit('close', {}) },
      }
      return socket as unknown as WebSocket
    },
    plantProbe: async (_tabId, value) => { planted = value },
  }
  return { deps, sent, sockets, probes, plantedNow: () => planted }
}

describe('discoverRemoteCdpPort', () => {
  it('returns the first port whose /json/version answers', async () => {
    const { deps } = endpoint({ ports: [9223] })
    await expect(discoverRemoteCdpPort(deps)).resolves.toBe(9223)
  })

  it('names the exact flag to start the browser with when nothing answers', async () => {
    const { deps } = endpoint({ ports: [] })
    await expect(discoverRemoteCdpPort(deps)).rejects.toThrow(/no remote-debugging endpoint/)
    // evaluate.ts matches on this wording to decide whether to fall through.
    await expect(discoverRemoteCdpPort(deps)).rejects.toThrow(/--remote-debugging-port=9222/)
  })

  it('probes every configured port', async () => {
    expect(REMOTE_CDP_PORTS).toContain(9222)
    const { deps } = endpoint({ ports: [REMOTE_CDP_PORTS.at(-1)!] })
    await expect(discoverRemoteCdpPort(deps)).resolves.toBe(REMOTE_CDP_PORTS.at(-1))
  })
})

describe('evaluateViaRemoteCdp', () => {
  it('sends arguments under params, as the CDP wire format requires', async () => {
    const { deps, sent } = endpoint({
      targets: [target('T1', 'https://app.example/page')],
      reply: () => ({ result: { type: 'number', value: 7 } }),
    })

    const value = await evaluateViaRemoteCdp(5, 'https://app.example/page', '3 + 4', 9222, deps)

    expect(value).toBe('7')
    const evaluate = sent.find((frame) => frame.method === 'Runtime.evaluate')!
    // The bug this guards: spreading params at the top level sends a command
    // with no arguments, and the endpoint rejects it.
    expect(evaluate.params).toEqual({
      expression: '3 + 4',
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    })
    expect(evaluate).not.toHaveProperty('expression')
  })

  it('matches the tab by URL, ignoring the fragment', async () => {
    const { deps, sockets } = endpoint({
      targets: [target('OTHER', 'https://other.example/'), target('WANTED', 'https://app.example/p#section')],
    })

    await evaluateViaRemoteCdp(5, 'https://app.example/p#different', '1', 9222, deps)

    expect(sockets).toEqual(['ws://127.0.0.1:9222/devtools/page/WANTED'])
  })

  it('identifies the right target by probe when two pages share a URL', async () => {
    const { deps, sockets, plantedNow } = endpoint({
      targets: [target('A', 'https://app.example/'), target('B', 'https://app.example/')],
      probeValue: (id) => (id === 'B' ? plantedNow() : 'someone-else'),
    })

    await evaluateViaRemoteCdp(5, 'https://app.example/', '1', 9222, deps)

    expect(sockets.at(-1)).toContain('/devtools/page/B')
    // The probe attribute is cleared again once the target is known.
    expect(plantedNow()).toBe('')
  })

  it('reports a page exception instead of returning a value', async () => {
    const { deps } = endpoint({
      targets: [target('T1', 'https://app.example/')],
      reply: () => ({ exceptionDetails: { exception: { description: 'TypeError: x is not a function' } } }),
    })

    await expect(evaluateViaRemoteCdp(5, 'https://app.example/', 'x()', 9222, deps))
      .rejects.toThrow(/x is not a function/)
  })

  it('returns the literal undefined for an expression without a value', async () => {
    const { deps } = endpoint({
      targets: [target('T1', 'https://app.example/')],
      reply: () => ({ result: { type: 'undefined' } }),
    })

    await expect(evaluateViaRemoteCdp(5, 'https://app.example/', 'void 0', 9222, deps))
      .resolves.toBe('undefined')
  })

  it('fails clearly when the debugging socket will not open', async () => {
    const { deps } = endpoint({ targets: [target('T1', 'https://app.example/')], openFails: true })

    await expect(evaluateViaRemoteCdp(5, 'https://app.example/', '1', 9222, deps))
      .rejects.toThrow(/could not open a debugging socket/)
  })

  it('says the tab could not be matched when the endpoint lists no pages', async () => {
    const { deps } = endpoint({ targets: [] })

    await expect(evaluateViaRemoteCdp(5, 'https://app.example/', '1', 9222, deps))
      .rejects.toThrow(/could not match this tab to a debugging target/)
  })

  it('ignores non-page targets such as service workers', async () => {
    const { deps, sockets } = endpoint({
      targets: [target('SW', 'https://app.example/sw.js', 'service_worker'), target('PAGE', 'https://elsewhere.example/')],
    })

    await evaluateViaRemoteCdp(5, 'https://app.example/', '1', 9222, deps)

    expect(sockets).toEqual(['ws://127.0.0.1:9222/devtools/page/PAGE'])
  })

  it('survives a frame that is not JSON rather than throwing inside a listener', async () => {
    const { deps } = endpoint({ targets: [target('T1', 'https://app.example/')] })
    const connect = deps.connect
    deps.connect = (url) => {
      const socket = connect(url) as unknown as {
        addEventListener: (type: string, listener: (event: unknown) => void) => void
        send: (raw: string) => void
      }
      const originalSend = socket.send.bind(socket)
      const messageListeners: ((event: unknown) => void)[] = []
      const originalAdd = socket.addEventListener.bind(socket)
      socket.addEventListener = (type, listener) => {
        if (type === 'message') messageListeners.push(listener)
        originalAdd(type, listener)
      }
      socket.send = (raw) => {
        // Garbage first, then the real reply: the command must still resolve.
        for (const listener of messageListeners) listener({ data: '<html>not json</html>' })
        originalSend(raw)
      }
      return socket as unknown as WebSocket
    }

    await expect(evaluateViaRemoteCdp(5, 'https://app.example/', '1', 9222, deps)).resolves.toBe('"ok"')
  })
})
