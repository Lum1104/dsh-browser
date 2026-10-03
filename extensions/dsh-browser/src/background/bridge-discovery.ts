/**
 * Layered local-bridge URL discovery for the extension background.
 *
 * Order: manual override → cached auto URL → known CLI/Desktop ports →
 * open loopback tabs → bounded ephemeral-port scan. Every candidate is
 * confirmed by fetching `/ext/bridge-config` and checking `wsUrl`.
 *
 * @module
 */

import { bridgeWsUrlFromLocation } from '@yuxianglin/dsh-bridge-browser/src/bridge-url.ts'
import { BRIDGE_CONFIG_PATH, BRIDGE_PATH } from '@yuxianglin/dsh-bridge-browser/src/protocol.ts'

/** CLI defaults plus pinned Desktop / legacy ports. */
export const DISCOVERY_PORTS = [3080, 3081, 3090, 14389, 43189] as const

/** chrome.storage.local key for automatic discovery results (never write settings.bridgeUrl). */
export const AUTO_STORAGE_KEY = 'dshBridgeAuto'

/** macOS / typical ephemeral client port range used by Desktop `--port 0`. */
export const EPHEMERAL_PORT_RANGE = { from: 49152, to: 65535 } as const

export const SCAN_CONCURRENCY = 8
export const SCAN_PER_REQUEST_TIMEOUT_MS = 300
export const SCAN_TOTAL_BUDGET_MS = 10_000
export const SCAN_COOLDOWN_MS = 30_000

/** Persisted automatic discovery cache. */
export interface BridgeAutoCache {
  url?: string
  lastGoodPort?: number
  discoveredAt?: number
}

/** Where a resolved URL came from. */
export type BridgeResolveSource =
  | 'manual'
  | 'auto-cache'
  | 'known-ports'
  | 'open-tabs'
  | 'ephemeral-scan'

/** One successful resolution. */
export interface BridgeResolveResult {
  url: string
  source: BridgeResolveSource
}

/** Injectable dependencies for tests. */
export interface BridgeDiscoveryDeps {
  probe: (url: string) => Promise<boolean>
  loadAuto: () => Promise<BridgeAutoCache>
  saveAuto: (cache: BridgeAutoCache) => Promise<void>
  queryLoopbackTabs: () => Promise<Array<{ url?: string }>>
  now: () => number
  fetchImpl: typeof fetch
}

/** Process-local scan bookkeeping (not persisted). */
export interface ScanRuntimeState {
  lastScanAt: number
  triedPorts: Set<number>
}

const defaultScanState = (): ScanRuntimeState => ({ lastScanAt: 0, triedPorts: new Set() })

let scanState: ScanRuntimeState = defaultScanState()

/** Reset in-process scan cooldown / tried set (tests). */
export function resetBridgeScanState(): void {
  scanState = defaultScanState()
}

/** Expose scan state for assertions. */
export function getBridgeScanState(): ScanRuntimeState {
  return scanState
}

/** Whether a URL is loopback http(s) suitable for tab-derived discovery. */
export function isLoopbackHttpUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    return url.hostname === '127.0.0.1' || url.hostname === 'localhost'
  } catch {
    return false
  }
}

/** Normalize a bridge URL so bare hosts get `/ext/bridge`. */
export function normalizeBridgeUrl(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.pathname === '' || parsed.pathname === '/') parsed.pathname = BRIDGE_PATH
    return parsed.toString()
  } catch {
    return url
  }
}

/** Probe `/ext/bridge-config` for a candidate ws(s) URL (loopback only). */
export async function probeBridgeConfig(
  url: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 1_500,
): Promise<boolean> {
  try {
    const target = new URL(url)
    if (target.hostname !== '127.0.0.1' && target.hostname !== 'localhost') return true
    target.protocol = target.protocol === 'wss:' ? 'https:' : 'http:'
    target.pathname = BRIDGE_CONFIG_PATH
    target.search = ''
    target.hash = ''
    const response = await fetchImpl(target, { signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) return false
    const body = await response.json() as { wsUrl?: unknown }
    return typeof body.wsUrl === 'string'
      && (body.wsUrl.startsWith('ws://') || body.wsUrl.startsWith('wss://'))
  } catch {
    return false
  }
}

/** Fetch config on a known HTTP port and return its wsUrl when valid. */
async function fetchWsUrlOnPort(
  port: number,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  shouldContinue: () => boolean,
): Promise<string | undefined> {
  if (!shouldContinue()) return undefined
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}${BRIDGE_CONFIG_PATH}`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!shouldContinue()) return undefined
    if (!response.ok) return undefined
    const body = await response.json() as { wsUrl?: unknown }
    if (typeof body.wsUrl === 'string' && body.wsUrl.startsWith('ws://')) {
      return normalizeBridgeUrl(body.wsUrl)
    }
  } catch {
    // Port empty or not a DSH bridge.
  }
  return undefined
}

async function fromKnownPorts(
  deps: BridgeDiscoveryDeps,
  shouldContinue: () => boolean,
  tried: Set<number>,
): Promise<string | undefined> {
  for (const port of DISCOVERY_PORTS) {
    tried.add(port)
    const url = await fetchWsUrlOnPort(port, deps.fetchImpl, 1_500, shouldContinue)
    if (url !== undefined) return url
    if (!shouldContinue()) return undefined
  }
  return undefined
}

async function fromOpenTabs(
  deps: BridgeDiscoveryDeps,
  shouldContinue: () => boolean,
): Promise<string | undefined> {
  let tabs: Array<{ url?: string }>
  try {
    tabs = await deps.queryLoopbackTabs()
  } catch {
    return undefined
  }
  for (const tab of tabs) {
    if (!shouldContinue()) return undefined
    if (tab.url === undefined || !isLoopbackHttpUrl(tab.url)) continue
    let page: URL
    try {
      page = new URL(tab.url)
    } catch {
      continue
    }
    const candidate = normalizeBridgeUrl(bridgeWsUrlFromLocation(page))
    if (await deps.probe(candidate)) return candidate
  }
  return undefined
}

async function fromEphemeralScan(
  deps: BridgeDiscoveryDeps,
  shouldContinue: () => boolean,
  auto: BridgeAutoCache,
): Promise<string | undefined> {
  const now = deps.now()
  if (now - scanState.lastScanAt < SCAN_COOLDOWN_MS) return undefined
  scanState.lastScanAt = now

  const preferred: number[] = []
  if (
    typeof auto.lastGoodPort === 'number'
    && auto.lastGoodPort >= EPHEMERAL_PORT_RANGE.from
    && auto.lastGoodPort <= EPHEMERAL_PORT_RANGE.to
    && !scanState.triedPorts.has(auto.lastGoodPort)
  ) {
    preferred.push(auto.lastGoodPort)
  }

  const queue: number[] = [...preferred]
  for (let port = EPHEMERAL_PORT_RANGE.from; port <= EPHEMERAL_PORT_RANGE.to; port += 1) {
    if (scanState.triedPorts.has(port) || preferred.includes(port)) continue
    queue.push(port)
  }

  const deadline = now + SCAN_TOTAL_BUDGET_MS
  let cursor = 0

  while (cursor < queue.length) {
    if (!shouldContinue() || deps.now() >= deadline) return undefined
    const batch = queue.slice(cursor, cursor + SCAN_CONCURRENCY)
    cursor += batch.length
    for (const port of batch) scanState.triedPorts.add(port)

    const results = await Promise.all(batch.map(async (port) => {
      if (!shouldContinue() || deps.now() >= deadline) return undefined
      return fetchWsUrlOnPort(port, deps.fetchImpl, SCAN_PER_REQUEST_TIMEOUT_MS, shouldContinue)
    }))
    for (const url of results) {
      if (url !== undefined) return url
    }
  }
  return undefined
}

/**
 * Resolve a bridge WebSocket URL using the layered discovery policy.
 * Manual `bridgeUrl` always wins and is never overwritten by this function.
 */
export async function resolveBridgeUrl(
  manualUrl: string,
  shouldContinue: () => boolean,
  deps: BridgeDiscoveryDeps,
): Promise<BridgeResolveResult | undefined> {
  const trimmed = manualUrl.trim()
  if (trimmed !== '') {
    return { url: normalizeBridgeUrl(trimmed), source: 'manual' }
  }

  const tried = new Set<number>()
  const auto = await deps.loadAuto()

  if (typeof auto.url === 'string' && auto.url !== '') {
    const cached = normalizeBridgeUrl(auto.url)
    if (await deps.probe(cached)) {
      return { url: cached, source: 'auto-cache' }
    }
    try {
      const port = Number(new URL(cached).port)
      if (Number.isFinite(port) && port > 0) tried.add(port)
    } catch { /* ignore */ }
  }

  const known = await fromKnownPorts(deps, shouldContinue, tried)
  if (known !== undefined) return { url: known, source: 'known-ports' }
  if (!shouldContinue()) return undefined

  const fromTabs = await fromOpenTabs(deps, shouldContinue)
  if (fromTabs !== undefined) return { url: fromTabs, source: 'open-tabs' }
  if (!shouldContinue()) return undefined

  for (const port of tried) scanState.triedPorts.add(port)
  const scanned = await fromEphemeralScan(deps, shouldContinue, auto)
  if (scanned !== undefined) return { url: scanned, source: 'ephemeral-scan' }
  return undefined
}

/** Persist a successful automatic discovery for the next cold start. */
export async function rememberAutoBridgeUrl(
  url: string,
  saveAuto: (cache: BridgeAutoCache) => Promise<void>,
  loadAuto: () => Promise<BridgeAutoCache>,
  now: () => number = Date.now,
): Promise<void> {
  const normalized = normalizeBridgeUrl(url)
  let lastGoodPort: number | undefined
  try {
    const port = Number(new URL(normalized).port)
    if (Number.isFinite(port) && port > 0) lastGoodPort = port
  } catch { /* ignore */ }
  const previous = await loadAuto()
  if (
    previous.url === normalized
    && previous.lastGoodPort === lastGoodPort
  ) {
    return
  }
  await saveAuto({
    ...previous,
    url: normalized,
    discoveredAt: now(),
    ...lastGoodPort !== undefined ? { lastGoodPort } : {},
  })
}

/** Default chrome.storage-backed auto cache IO. */
export function createChromeAutoCacheIo(): Pick<BridgeDiscoveryDeps, 'loadAuto' | 'saveAuto'> {
  return {
    loadAuto: async () => {
      const stored = await chrome.storage.local.get(AUTO_STORAGE_KEY)
      const raw = stored[AUTO_STORAGE_KEY]
      if (typeof raw !== 'object' || raw === null) return {}
      const record = raw as Record<string, unknown>
      return {
        ...typeof record.url === 'string' ? { url: record.url } : {},
        ...typeof record.lastGoodPort === 'number' ? { lastGoodPort: record.lastGoodPort } : {},
        ...typeof record.discoveredAt === 'number' ? { discoveredAt: record.discoveredAt } : {},
      }
    },
    saveAuto: async (cache) => {
      await chrome.storage.local.set({ [AUTO_STORAGE_KEY]: cache })
    },
  }
}
