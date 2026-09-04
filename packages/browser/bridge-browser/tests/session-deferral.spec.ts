import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ImageAttachmentLimits } from '@deepseek-ai/dsh-attachment'
import type { LegacyRpc } from '../src/legacy-rpc.ts'
import { withSessionDeferral } from '../src/session-deferral.ts'

function apiHarness() {
  const calls: Array<{ method: string; payload: unknown }> = []
  const api: LegacyRpc = vi.fn(async (method, payload) => {
    calls.push({ method, payload })
    if (method === 'session.create') return { sessionId: (payload as { sessionId?: string }).sessionId }
    if (method === 'session.history') return { events: [{ event: { type: 'user/message' } }], hasMore: false }
    if (method === 'session.prompt') return { accepted: true }
    return undefined
  })
  return { api, calls }
}

async function provisionalId(api: LegacyRpc, sessionId?: string): Promise<string> {
  const value = await api('session.create', sessionId === undefined ? {} : { sessionId }) as { sessionId: string }
  return value.sessionId
}

describe('withSessionDeferral', () => {
  afterEach(() => { vi.useRealTimers() })

  it('returns a provisional id without touching the Host', async () => {
    const { api, calls } = apiHarness()
    const wrapped = withSessionDeferral(api, true)
    expect(await provisionalId(wrapped)).toMatch(/^session-/)
    expect(calls).toEqual([])
  })

  it('honors an explicit session id', async () => {
    const { api } = apiHarness()
    expect(await provisionalId(withSessionDeferral(api, true), 'session-fixed')).toBe('session-fixed')
  })

  it('serves provisional history locally and forwards ordinary history', async () => {
    const { api, calls } = apiHarness()
    const wrapped = withSessionDeferral(api, true)
    const id = await provisionalId(wrapped)
    await expect(wrapped('session.history', { sessionId: id })).resolves.toEqual({ events: [], hasMore: false })
    await wrapped('session.history', { sessionId: 'session-real' })
    expect(calls).toEqual([{ method: 'session.history', payload: { sessionId: 'session-real' } }])
  })

  it('advertises image limits before materialization', async () => {
    const { api } = apiHarness()
    const imageLimits: ImageAttachmentLimits = {
      maxImageBytes: 1024,
      maxImagesPerMessage: 4,
      maxMessageImageBytes: 4096,
      maxImagePixels: 1_000_000,
      maxImageDimension: 1200,
      mediaTypes: ['image/png', 'image/jpeg'],
    }
    const wrapped = withSessionDeferral(api, true, imageLimits)
    const id = await provisionalId(wrapped)
    await expect(wrapped('session.history', { sessionId: id })).resolves.toEqual({
      events: [],
      hasMore: false,
      projections: { asOfSeq: -1, values: { imageLimits } },
    })
  })

  it('materializes once before concurrent first prompts', async () => {
    const { api, calls } = apiHarness()
    let release!: () => void
    const blocked: LegacyRpc = vi.fn(async (method, payload, signal) => {
      if (method === 'session.create') await new Promise<void>((resolve) => { release = resolve })
      return api(method, payload, signal)
    })
    const wrapped = withSessionDeferral(blocked, true)
    const id = await provisionalId(wrapped)
    const first = wrapped('session.prompt', { sessionId: id, content: [] })
    const second = wrapped('session.prompt', { sessionId: id, content: [] })
    release()
    await Promise.all([first, second])
    expect(calls.filter(call => call.method === 'session.create')).toEqual([
      { method: 'session.create', payload: { sessionId: id } },
    ])
    expect(calls.filter(call => call.method === 'session.prompt')).toHaveLength(2)
  })

  it('keeps a provisional entry after materialization failure', async () => {
    const { api, calls } = apiHarness()
    let fail = true
    const flaky: LegacyRpc = vi.fn(async (method, payload, signal) => {
      if (method === 'session.create' && fail) {
        fail = false
        throw new Error('create exploded')
      }
      return api(method, payload, signal)
    })
    const wrapped = withSessionDeferral(flaky, true)
    const id = await provisionalId(wrapped)
    await expect(wrapped('session.prompt', { sessionId: id })).rejects.toThrow('create exploded')
    await wrapped('session.prompt', { sessionId: id })
    expect(calls.filter(call => call.method === 'session.prompt')).toHaveLength(1)
  })

  it('prunes stale provisional entries and can be disabled', async () => {
    vi.useFakeTimers()
    const { api, calls } = apiHarness()
    const wrapped = withSessionDeferral(api, true)
    const stale = await provisionalId(wrapped)
    vi.advanceTimersByTime(31 * 60_000)
    const fresh = await provisionalId(wrapped)
    await wrapped('session.history', { sessionId: stale })
    await wrapped('session.history', { sessionId: fresh })
    expect(calls.filter(call => call.method === 'session.history')).toHaveLength(1)
    expect(withSessionDeferral(api, false)).toBe(api)
  })
})
