/**
 * Resolve the browser-extension bridge WebSocket URL from the current page
 * location or a discovery response. Shared by the settings row and tests.
 * @module @yuxianglin/dsh-bridge-browser/src/bridge-url
 */

import { BRIDGE_CONFIG_PATH, BRIDGE_PATH } from './protocol.ts'

/** Minimal Location fields needed to rebuild a loopback-friendly ws URL. */
export interface BridgeLocationLike {
  protocol: string
  hostname: string
  port: string
  host: string
}

/**
 * Build `ws(s)://…/ext/bridge` from the page that hosts the dsh web UI.
 * Loopback hostnames are normalized to `127.0.0.1` so the address pastes cleanly
 * into the Chrome extension settings.
 */
export function bridgeWsUrlFromLocation(
  location: BridgeLocationLike,
  bridgePath: string = BRIDGE_PATH,
): string {
  const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const hostname = location.hostname === 'localhost' ? '127.0.0.1' : location.hostname
  const host = location.port === '' ? hostname : `${hostname}:${location.port}`
  return `${wsProtocol}//${host}${bridgePath}`
}

/** Options for reconstructing a bridge URL from an HTTP discovery request. */
export interface BridgeWsUrlFromHttpHostOptions {
  /** Port used when `Host` is missing or omits one (the listening webServer port). */
  fallbackPort: number
  /** When true, emit `wss:` (TLS / `X-Forwarded-Proto: https`). */
  secure?: boolean
  bridgePath?: string
}

/**
 * Build `ws(s)://…/ext/bridge` from an HTTP `Host` header.
 *
 * Used by `/ext/bridge-config` so LAN / `--host 0.0.0.0` clients receive a URL
 * they can actually dial, instead of a hard-coded loopback address. Missing or
 * unusable hosts fall back to `127.0.0.1:<fallbackPort>` (local discovery).
 */
export function bridgeWsUrlFromHttpHost(
  hostHeader: string | undefined,
  options: BridgeWsUrlFromHttpHostOptions,
): string {
  const bridgePath = options.bridgePath ?? BRIDGE_PATH
  const wsProtocol = options.secure === true ? 'wss:' : 'ws:'
  const parsed = parseHttpHostHeader(hostHeader)
  const hostname = parsed === undefined
    ? '127.0.0.1'
    : parsed.hostname === 'localhost' ? '127.0.0.1' : parsed.hostname
  const port = parsed?.port !== undefined && parsed.port !== ''
    ? parsed.port
    : String(options.fallbackPort)
  const hostLabel = hostname.includes(':') ? `[${hostname}]` : hostname
  const host = port === '' ? hostLabel : `${hostLabel}:${port}`
  return `${wsProtocol}//${host}${bridgePath}`
}

/** Split `Host` / `X-Forwarded-Host` into hostname + optional port. */
export function parseHttpHostHeader(
  hostHeader: string | undefined,
): { hostname: string; port: string } | undefined {
  const raw = hostHeader?.trim() ?? ''
  if (raw === '') return undefined
  // First value only when proxies send a comma-separated list.
  const host = raw.split(',', 1)[0]!.trim()
  if (host === '') return undefined

  if (host.startsWith('[')) {
    const end = host.indexOf(']')
    if (end <= 1) return undefined
    const hostname = host.slice(1, end)
    if (hostname === '') return undefined
    if (host[end + 1] === ':' && host.length > end + 2) {
      return { hostname, port: host.slice(end + 2) }
    }
    return { hostname, port: '' }
  }

  const colon = host.lastIndexOf(':')
  if (colon > 0 && host.indexOf(':') === colon) {
    const hostname = host.slice(0, colon)
    const port = host.slice(colon + 1)
    if (hostname === '' || port === '') return undefined
    return { hostname, port }
  }
  return { hostname: host, port: '' }
}

/**
 * Prefer the discovery endpoint; fall back to reconstructing from `location`.
 * @param fetchImpl - injectable fetch (defaults to global fetch).
 * @param location - page location used for fallback and relative discovery URL.
 */
export async function resolveBridgeWsUrl(
  location: BridgeLocationLike & { origin?: string },
  fetchImpl: typeof fetch = fetch,
  bridgeConfigPath: string = BRIDGE_CONFIG_PATH,
): Promise<string> {
  const fallback = bridgeWsUrlFromLocation(location)
  try {
    const base = location.origin ?? `${location.protocol}//${location.host}`
    const response = await fetchImpl(`${base}${bridgeConfigPath}`, {
      signal: AbortSignal.timeout(1_500),
    })
    if (!response.ok) return fallback
    const body = await response.json() as { wsUrl?: unknown }
    if (typeof body.wsUrl === 'string' && (body.wsUrl.startsWith('ws://') || body.wsUrl.startsWith('wss://'))) {
      return body.wsUrl
    }
  } catch {
    // Discovery is best-effort: the settings row still shows the reconstructed URL.
  }
  return fallback
}
