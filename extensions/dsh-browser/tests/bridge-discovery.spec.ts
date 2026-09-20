// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DISCOVERY_PORTS,
  EPHEMERAL_PORT_RANGE,
  SCAN_CONCURRENCY,
  SCAN_TOTAL_BUDGET_MS,
  isLoopbackHttpUrl,
  normalizeBridgeUrl,
  rememberAutoBridgeUrl,
  resetBridgeScanState,
  resolveBridgeUrl,
  type BridgeDiscoveryDeps,
} from '../src/background/bridge-discovery.ts'

afterEach(() => {
  resetBridgeScanState()
  vi.useRealTimers()
})

function deps(overrides: Partial<BridgeDiscoveryDeps> = {}): BridgeDiscoveryDeps {
  return {
    probe: async () => false,
    loadAuto: async () => ({}),
    saveAuto: async () => {},
    queryLoopbackTabs: async () => [],
    now: Date.now,
    fetchImpl: async () => new Response(null, { status: 503 }),
    ...overrides,
  }
}

function configOk(wsUrl: string): Response {
  return new Response(JSON.stringify({ wsUrl }), { status: 200 })
}

describe('isLoopbackHttpUrl', () => {
  it('accepts only loopback http(s)', () => {
    expect(isLoopbackHttpUrl('http://127.0.0.1:50403/')).toBe(true)
    expect(isLoopbackHttpUrl('https://localhost/app')).toBe(true)
    expect(isLoopbackHttpUrl('ws://127.0.0.1:3080/ext/bridge')).toBe(false)
    expect(isLoopbackHttpUrl('http://example.com/')).toBe(false)
  })
})

describe('normalizeBridgeUrl', () => {
  it('appends /ext/bridge when the path is missing', () => {
    expect(normalizeBridgeUrl('ws://127.0.0.1:3080')).toBe('ws://127.0.0.1:3080/ext/bridge')
  })
})

describe('resolveBridgeUrl layering', () => {
  it('returns a manual override without probing', async () => {
    const probe = vi.fn(async () => true)
    const fetchImpl = vi.fn()
    const result = await resolveBridgeUrl('ws://127.0.0.1:9999', () => true, deps({ probe, fetchImpl }))
    expect(result).toEqual({
      url: 'ws://127.0.0.1:9999/ext/bridge',
      source: 'manual',
    })
    expect(probe).not.toHaveBeenCalled()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('prefers a reachable auto-cache before known ports', async () => {
    const probe = vi.fn(async (url: string) => url.includes('50403'))
    const fetchImpl = vi.fn()
    const result = await resolveBridgeUrl('', () => true, deps({
      probe,
      fetchImpl,
      loadAuto: async () => ({ url: 'ws://127.0.0.1:50403/ext/bridge', lastGoodPort: 50403 }),
    }))
    expect(result).toEqual({
      url: 'ws://127.0.0.1:50403/ext/bridge',
      source: 'auto-cache',
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('tries known ports before open tabs and skips L4/L5 on a CLI hit', async () => {
    const order: string[] = []
    const queryLoopbackTabs = vi.fn(async () => {
      order.push('tabs')
      return [{ url: 'http://127.0.0.1:50403/' }]
    })
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const href = String(input)
      order.push(`fetch:${href}`)
      if (href.includes(':3080/')) return configOk('ws://127.0.0.1:3080/ext/bridge')
      return new Response(null, { status: 503 })
    })
    const result = await resolveBridgeUrl('', () => true, deps({ fetchImpl, queryLoopbackTabs }))
    expect(result).toEqual({
      url: 'ws://127.0.0.1:3080/ext/bridge',
      source: 'known-ports',
    })
    expect(order[0]).toBe('fetch:http://127.0.0.1:3080/ext/bridge-config')
    expect(queryLoopbackTabs).not.toHaveBeenCalled()
    expect(order.some((entry) => entry === 'tabs')).toBe(false)
  })

  it('uses an open loopback tab after known ports fail', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const href = String(input)
      if (DISCOVERY_PORTS.some((port) => href.includes(`:${port}/`))) {
        return new Response(null, { status: 503 })
      }
      if (href.includes(':50403/')) return configOk('ws://127.0.0.1:50403/ext/bridge')
      return new Response(null, { status: 503 })
    })
    const probe = vi.fn(async (url: string) => url.includes('50403'))
    const result = await resolveBridgeUrl('', () => true, deps({
      fetchImpl,
      probe,
      queryLoopbackTabs: async () => [{ url: 'http://127.0.0.1:50403/chat' }],
    }))
    expect(result?.source).toBe('open-tabs')
    expect(result?.url).toBe('ws://127.0.0.1:50403/ext/bridge')
    expect(probe).toHaveBeenCalled()
    // Known ports are contacted before tab derivation.
    const firstFetch = String(fetchImpl.mock.calls[0]![0])
    expect(firstFetch).toContain(`:${DISCOVERY_PORTS[0]}/`)
  })

  it('scans ephemeral ports with bounded concurrency after L1–L4 fail', async () => {
    vi.useFakeTimers()
    let inFlight = 0
    let maxInFlight = 0
    const seen = new Set<number>()
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const href = String(input)
      const match = /:(\d+)\//.exec(href)
      const port = match === null ? 0 : Number(match[1])
      seen.add(port)
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      try {
        await new Promise<void>((resolve) => { setTimeout(resolve, 20) })
        if (port === EPHEMERAL_PORT_RANGE.from + 20) {
          return configOk(`ws://127.0.0.1:${port}/ext/bridge`)
        }
        return new Response(null, { status: 503 })
      } finally {
        inFlight -= 1
      }
    })

    const pending = resolveBridgeUrl('', () => true, deps({
      fetchImpl,
      now: () => Date.now(),
      queryLoopbackTabs: async () => [],
    }))
    await vi.advanceTimersByTimeAsync(SCAN_TOTAL_BUDGET_MS)
    const result = await pending

    expect(result?.source).toBe('ephemeral-scan')
    expect(result?.url).toBe(`ws://127.0.0.1:${EPHEMERAL_PORT_RANGE.from + 20}/ext/bridge`)
    expect(maxInFlight).toBeLessThanOrEqual(SCAN_CONCURRENCY)
    for (const port of DISCOVERY_PORTS) expect(seen.has(port)).toBe(true)
  })

  it('stops the ephemeral scan when shouldContinue becomes false', async () => {
    let continueScan = true
    let fetches = 0
    const fetchImpl = vi.fn(async () => {
      fetches += 1
      if (fetches > DISCOVERY_PORTS.length + 4) continueScan = false
      await new Promise<void>((resolve) => { setTimeout(resolve, 5) })
      return new Response(null, { status: 503 })
    })
    const result = await resolveBridgeUrl('', () => continueScan, deps({
      fetchImpl,
      queryLoopbackTabs: async () => [],
    }))
    expect(result).toBeUndefined()
    expect(fetches).toBeLessThan(200)
  })
})

describe('rememberAutoBridgeUrl', () => {
  it('writes url and lastGoodPort without touching settings', async () => {
    const saved: unknown[] = []
    await rememberAutoBridgeUrl(
      'ws://127.0.0.1:50403/ext/bridge',
      async (cache) => { saved.push(cache) },
      async () => ({}),
      () => 1_700_000_000_000,
    )
    expect(saved).toEqual([{
      url: 'ws://127.0.0.1:50403/ext/bridge',
      discoveredAt: 1_700_000_000_000,
      lastGoodPort: 50403,
    }])
  })

  it('skips a no-op write when the cache already matches', async () => {
    const saveAuto = vi.fn(async () => {})
    await rememberAutoBridgeUrl(
      'ws://127.0.0.1:50403/ext/bridge',
      saveAuto,
      async () => ({
        url: 'ws://127.0.0.1:50403/ext/bridge',
        lastGoodPort: 50403,
      }),
    )
    expect(saveAuto).not.toHaveBeenCalled()
  })
})
