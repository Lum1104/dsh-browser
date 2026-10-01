import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ImageAttachmentLimits } from '@deepseek-ai/dsh-attachment'
import type { BrowserHostApi, HostRpcCall, HostRpcResult } from '../src/host-api.ts'
import { withSessionDeferral } from '../src/session-deferral.ts'

function apiHarness() {
  const sessionCreate = vi.fn(async (call: HostRpcCall): Promise<HostRpcResult> => ({
    ok: true,
    value: { sessionId: (call.payload as { sessionId: string }).sessionId },
  }))
  const sessionHistory = vi.fn(async (): Promise<HostRpcResult> => ({
    ok: true,
    value: { events: [{ event: { type: 'user/message' } }], hasMore: false },
  }))
  const sessionPrompt = vi.fn(async (): Promise<HostRpcResult> => ({
    ok: true,
    value: { accepted: true },
  }))
  const call = vi.fn(async (request: HostRpcCall): Promise<HostRpcResult> => {
    if (request.method === 'session.create') return sessionCreate(request)
    if (request.method === 'session.history') return sessionHistory(request)
    if (request.method === 'session.prompt') return sessionPrompt(request)
    return { ok: false, error: { code: 'not-found', message: request.method, details: {} } }
  })
  const api: BrowserHostApi = {
    call,
    async *events() {},
    respond: async () => ({ accepted: false }),
  }
  return { api, call, sessionCreate, sessionHistory, sessionPrompt }
}

function request(method: string, payload: unknown, rpcId = method): HostRpcCall {
  return { rpcId, method, payload, signal: new AbortController().signal }
}

async function provisionalId(api: BrowserHostApi, rpcId = 'create-rpc'): Promise<string> {
  const response = await api.call(request('session.create', {}, rpcId))
  if (!response.ok || typeof (response.value as { sessionId?: unknown }).sessionId !== 'string') {
    throw new Error('provisional create failed')
  }
  return (response.value as { sessionId: string }).sessionId
}

describe('withSessionDeferral', () => {
  afterEach(() => { vi.useRealTimers() })

  it('mints a provisional id without touching the Host', async () => {
    const { api, call } = apiHarness()
    const wrapped = withSessionDeferral(api, true)

    expect(await provisionalId(wrapped)).toMatch(/^session-/)
    expect(call).not.toHaveBeenCalled()
  })

  it('honors an explicit session id', async () => {
    const { api } = apiHarness()
    const wrapped = withSessionDeferral(api, true)

    await expect(wrapped.call(request('session.create', { sessionId: 'session-fixed' })))
      .resolves.toEqual({ ok: true, value: { sessionId: 'session-fixed' } })
  })

  it('serves provisional history locally and passes real history through', async () => {
    const { api, sessionHistory } = apiHarness()
    const wrapped = withSessionDeferral(api, true)
    const id = await provisionalId(wrapped)

    await expect(wrapped.call(request('session.history', { sessionId: id })))
      .resolves.toEqual({ ok: true, value: { events: [], hasMore: false } })
    expect(sessionHistory).not.toHaveBeenCalled()

    await wrapped.call(request('session.history', { sessionId: 'session-real' }))
    expect(sessionHistory).toHaveBeenCalledOnce()
  })

  it('projects image limits before materialization', async () => {
    const { api } = apiHarness()
    const limits: ImageAttachmentLimits = {
      maxImageBytes: 1024,
      maxImagesPerMessage: 4,
      maxMessageImageBytes: 4096,
      maxImagePixels: 1_000_000,
      maxImageDimension: 1200,
      mediaTypes: ['image/png', 'image/jpeg'],
    }
    const wrapped = withSessionDeferral(api, true, limits)
    const id = await provisionalId(wrapped)

    await expect(wrapped.call(request('session.history', { sessionId: id }))).resolves.toEqual({
      ok: true,
      value: {
        events: [],
        hasMore: false,
        projections: { asOfSeq: -1, values: { imageLimits: limits } },
      },
    })
  })

  it('materializes on first prompt and replays the create payload', async () => {
    const { api, sessionCreate, sessionPrompt, sessionHistory } = apiHarness()
    const wrapped = withSessionDeferral(api, true)
    const created = await wrapped.call(request('session.create', { cwd: '/work' }))
    if (!created.ok) throw new Error('create failed')
    const id = (created.value as { sessionId: string }).sessionId
    const prompt = request('session.prompt', { sessionId: id, mode: 'queue', content: [] }, 'prompt')

    await wrapped.call(prompt)

    expect(sessionCreate).toHaveBeenCalledWith(expect.objectContaining({
      method: 'session.create', payload: { cwd: '/work', sessionId: id },
    }))
    expect(sessionPrompt).toHaveBeenCalledWith(prompt)
    await wrapped.call(request('session.history', { sessionId: id }))
    expect(sessionHistory).toHaveBeenCalledOnce()
  })

  it('deduplicates concurrent prompts into one materialization', async () => {
    const { api, sessionCreate, sessionPrompt } = apiHarness()
    let release: (() => void) | undefined
    sessionCreate.mockImplementationOnce(async (call: HostRpcCall) => {
      await new Promise<void>((resolve) => { release = resolve })
      return { ok: true, value: { sessionId: (call.payload as { sessionId: string }).sessionId } }
    })
    const wrapped = withSessionDeferral(api, true)
    const id = await provisionalId(wrapped)

    const first = wrapped.call(request('session.prompt', { sessionId: id }, 'p1'))
    const second = wrapped.call(request('session.prompt', { sessionId: id }, 'p2'))
    await vi.waitFor(() => { expect(release).toBeDefined() })
    release?.()
    await Promise.all([first, second])

    expect(sessionCreate).toHaveBeenCalledOnce()
    expect(sessionPrompt).toHaveBeenCalledTimes(2)
  })

  it('retains the provisional entry after a business failure and retries', async () => {
    const { api, sessionCreate, sessionPrompt } = apiHarness()
    sessionCreate.mockResolvedValueOnce({
      ok: false,
      error: { code: 'internal', message: 'boom', details: {} },
    })
    const wrapped = withSessionDeferral(api, true)
    const id = await provisionalId(wrapped)

    await expect(wrapped.call(request('session.prompt', { sessionId: id }, 'p1'))).resolves.toEqual({
      ok: false, error: { code: 'internal', message: 'boom', details: {} },
    })
    expect(sessionPrompt).not.toHaveBeenCalled()
    await wrapped.call(request('session.prompt', { sessionId: id }, 'p2'))
    expect(sessionCreate).toHaveBeenCalledTimes(2)
    expect(sessionPrompt).toHaveBeenCalledOnce()
  })

  it('serves provisional model catalogs from session.models and defers selectModel', async () => {
    const { api, call } = apiHarness()
    call.mockImplementation(async (request: HostRpcCall): Promise<HostRpcResult> => {
      if (request.method === 'session.create') {
        return { ok: true, value: { sessionId: (request.payload as { sessionId: string }).sessionId } }
      }
      if (request.method === 'session.prompt') return { ok: true, value: { accepted: true } }
      if (request.method === 'session.models') {
        return {
          ok: true,
          value: {
            current: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
            routable: true,
            groups: [{
              id: 'deepseek-official',
              name: 'DeepSeek',
              models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }],
            }],
            failures: [],
          },
        }
      }
      if (request.method === 'session.selectModel') {
        return { ok: true, value: { selected: request.payload } }
      }
      return { ok: false, error: { code: 'not-found', message: request.method, details: {} } }
    })
    const wrapped = withSessionDeferral(api, true)
    const id = await provisionalId(wrapped)

    await expect(wrapped.call(request('session.models', { sessionId: id }))).resolves.toEqual({
      ok: true,
      value: {
        current: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
        routable: true,
        groups: [{
          id: 'deepseek-official',
          name: 'DeepSeek',
          models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }],
        }],
        failures: [],
      },
    })

    await expect(wrapped.call(request('session.selectModel', {
      sessionId: id,
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
    }))).resolves.toEqual({
      ok: true,
      value: { selected: { provider: 'deepseek-official', model: 'deepseek-v4-pro' } },
    })

    await wrapped.call(request('session.prompt', { sessionId: id, mode: 'queue', content: [] }, 'prompt'))
    expect(call).toHaveBeenCalledWith(expect.objectContaining({
      method: 'session.selectModel',
      payload: { sessionId: id, provider: 'deepseek-official', model: 'deepseek-v4-pro' },
    }))
  })

  it('prunes stale provisional entries and returns the original API when disabled', async () => {
    vi.useFakeTimers()
    const { api, sessionHistory } = apiHarness()
    const wrapped = withSessionDeferral(api, true)
    const first = await provisionalId(wrapped, 'c1')
    vi.advanceTimersByTime(31 * 60_000)
    const second = await provisionalId(wrapped, 'c2')

    await wrapped.call(request('session.history', { sessionId: first }))
    await wrapped.call(request('session.history', { sessionId: second }))
    expect(sessionHistory).toHaveBeenCalledOnce()
    expect(withSessionDeferral(api, false)).toBe(api)
  })
})
