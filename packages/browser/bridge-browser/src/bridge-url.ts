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
