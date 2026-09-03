import { describe, expect, it, vi } from 'vitest'
import { bridgeWsUrlFromLocation, resolveBridgeWsUrl } from '../src/bridge-url.ts'

describe('bridgeWsUrlFromLocation', () => {
  it('builds a loopback ws URL and normalizes localhost', () => {
    expect(bridgeWsUrlFromLocation({
      protocol: 'http:',
      hostname: '127.0.0.1',
      port: '63566',
      host: '127.0.0.1:63566',
    })).toBe('ws://127.0.0.1:63566/ext/bridge')

    expect(bridgeWsUrlFromLocation({
      protocol: 'http:',
      hostname: 'localhost',
      port: '43189',
      host: 'localhost:43189',
    })).toBe('ws://127.0.0.1:43189/ext/bridge')
  })

  it('uses wss on https pages and omits the default port when absent', () => {
    expect(bridgeWsUrlFromLocation({
      protocol: 'https:',
      hostname: 'example.com',
      port: '',
      host: 'example.com',
    })).toBe('wss://example.com/ext/bridge')
  })
})

describe('resolveBridgeWsUrl', () => {
  it('prefers /ext/bridge-config when available', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ wsUrl: 'ws://127.0.0.1:43189/ext/bridge' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ))
    await expect(resolveBridgeWsUrl({
      protocol: 'http:',
      hostname: '127.0.0.1',
      port: '9999',
      host: '127.0.0.1:9999',
      origin: 'http://127.0.0.1:9999',
    }, fetchImpl as unknown as typeof fetch)).resolves.toBe('ws://127.0.0.1:43189/ext/bridge')
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:9999/ext/bridge-config',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })

  it('falls back to the page location when discovery fails', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('offline')
    })
    await expect(resolveBridgeWsUrl({
      protocol: 'http:',
      hostname: '127.0.0.1',
      port: '63566',
      host: '127.0.0.1:63566',
      origin: 'http://127.0.0.1:63566',
    }, fetchImpl as unknown as typeof fetch)).resolves.toBe('ws://127.0.0.1:63566/ext/bridge')
  })
})
