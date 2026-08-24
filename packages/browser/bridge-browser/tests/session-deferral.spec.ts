import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy/api'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { ImageAttachmentLimits } from '@deepseek-ai/dsh-attachment'
import { withSessionDeferral } from '../src/session-deferral.ts'

type CreateRequest = Parameters<ApiProxy['sessions']['create']>[0]
type HistoryRequest = Parameters<ApiProxy['sessions']['history']>[0]
type PromptRequest = Parameters<ApiProxy['sessions']['prompt']>[0]
type PresetSelectRequest = Parameters<ApiProxy['agentPresets']['select']>[0]

const PROMPT = (sessionId: ReturnType<typeof SessionId>, rpcId: string): PromptRequest => ({
  rpcId: RpcId(rpcId),
  payload: { sessionId, mode: 'queue', content: [] },
})

function apiHarness() {
  const sessionCreate = vi.fn(async (request: CreateRequest) => ({
    rpcId: request.rpcId,
    result: { ok: true as const, value: { sessionId: request.payload.sessionId as ReturnType<typeof SessionId> } },
  }))
  const sessionHistory = vi.fn(async (request: HistoryRequest) => ({
    rpcId: request.rpcId,
    result: { ok: true as const, value: { events: [{ event: { type: 'user/message' } }], hasMore: false } },
  }))
  const sessionPrompt = vi.fn(async (request: PromptRequest) => ({
    rpcId: request.rpcId,
    result: { ok: true as const, value: { accepted: true } },
  }))
  const presetSelect = vi.fn(async (request: PresetSelectRequest) => ({
    rpcId: request.rpcId,
    result: { ok: true as const, value: { agentPreset: request.payload.agentPreset } },
  }))
  const api = {
    sessions: { create: sessionCreate, history: sessionHistory, prompt: sessionPrompt },
    agentPresets: { select: presetSelect },
  } as unknown as ApiProxy
  return { api, sessionCreate, sessionHistory, sessionPrompt, presetSelect }
}

async function provisionalId(wrapped: ApiProxy, rpcId = 'create-rpc'): Promise<ReturnType<typeof SessionId>> {
  const response = await wrapped.sessions.create({ rpcId: RpcId(rpcId), payload: {} })
  if (!response.result.ok) throw new Error('unreachable: provisional create must succeed')
  return response.result.value.sessionId
}

describe('withSessionDeferral', () => {
  afterEach(() => { vi.useRealTimers() })

  it('answers create with a provisional id without touching the gateway', async () => {
    const { api, sessionCreate } = apiHarness()
    const wrapped = withSessionDeferral(api, true)

    const id = await provisionalId(wrapped)

    expect(id).toMatch(/^session-/)
    expect(sessionCreate).not.toHaveBeenCalled()
  })

  it('honors an explicit session id from the caller', async () => {
    const { api } = apiHarness()
    const wrapped = withSessionDeferral(api, true)

    const response = await wrapped.sessions.create({
      rpcId: RpcId('r1'),
      payload: { sessionId: SessionId('session-fixed') },
    })

    expect(response.result).toEqual({ ok: true, value: { sessionId: SessionId('session-fixed') } })
  })

  it('serves empty history for a provisional id and passes other ids through', async () => {
    const { api, sessionHistory } = apiHarness()
    const wrapped = withSessionDeferral(api, true)
    const id = await provisionalId(wrapped)

    const empty = await wrapped.sessions.history({ rpcId: RpcId('r2'), payload: { sessionId: id } })
    expect(empty.result).toEqual({ ok: true, value: { events: [], hasMore: false } })
    expect(sessionHistory).not.toHaveBeenCalled()

    await wrapped.sessions.history({ rpcId: RpcId('r3'), payload: { sessionId: SessionId('session-real') } })
    expect(sessionHistory).toHaveBeenCalledWith(
      expect.objectContaining({ payload: { sessionId: SessionId('session-real') } }),
    )
  })

  it('advertises the real host image limits before a deferred session materializes', async () => {
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

    const history = await wrapped.sessions.history({ rpcId: RpcId('history'), payload: { sessionId: id } })

    expect(history.result).toEqual({
      ok: true,
      value: {
        events: [],
        hasMore: false,
        projections: { asOfSeq: -1, values: { imageLimits } },
      },
    })
  })

  it('materializes the session on the first prompt, replaying the create payload', async () => {
    const { api, sessionCreate, sessionPrompt, sessionHistory } = apiHarness()
    const wrapped = withSessionDeferral(api, true)
    const created = await wrapped.sessions.create({ rpcId: RpcId('r1'), payload: { cwd: '/work' } })
    if (!created.result.ok) throw new Error('unreachable: provisional create must succeed')
    const id = created.result.value.sessionId
    const prompt = PROMPT(id, 'r2')

    await wrapped.sessions.prompt(prompt)

    expect(sessionCreate).toHaveBeenCalledWith({
      rpcId: expect.anything(),
      payload: { cwd: '/work', sessionId: id },
    })
    expect(sessionPrompt).toHaveBeenCalledWith(prompt)

    // Materialized: history now reaches the gateway.
    await wrapped.sessions.history({ rpcId: RpcId('r3'), payload: { sessionId: id } })
    expect(sessionHistory).toHaveBeenCalledTimes(1)
  })

  it('passes prompts for unknown sessions through untouched', async () => {
    const { api, sessionPrompt } = apiHarness()
    const wrapped = withSessionDeferral(api, true)

    await wrapped.sessions.prompt(PROMPT(SessionId('session-existing'), 'r1'))

    expect(sessionPrompt).toHaveBeenCalledTimes(1)
  })

  it('deduplicates concurrent prompts into one materialization', async () => {
    const { api, sessionCreate, sessionPrompt } = apiHarness()
    let release!: () => void
    sessionCreate.mockImplementationOnce(async (request: CreateRequest) => {
      await new Promise<void>((resolve) => { release = resolve })
      return {
        rpcId: request.rpcId,
        result: { ok: true as const, value: { sessionId: request.payload.sessionId as ReturnType<typeof SessionId> } },
      }
    })
    const wrapped = withSessionDeferral(api, true)
    const id = await provisionalId(wrapped)

    const first = wrapped.sessions.prompt(PROMPT(id, 'p1'))
    const second = wrapped.sessions.prompt(PROMPT(id, 'p2'))
    release()
    await Promise.all([first, second])

    expect(sessionCreate).toHaveBeenCalledTimes(1)
    expect(sessionPrompt).toHaveBeenCalledTimes(2)
  })

  it('propagates a materialization failure without forwarding the prompt, and retries later', async () => {
    const { api, sessionCreate, sessionPrompt } = apiHarness()
    sessionCreate.mockResolvedValueOnce({
      rpcId: RpcId('materialize'),
      result: {
        ok: false as const,
        error: { code: 'internal' as const, message: 'boom', details: {} },
      },
    })
    const wrapped = withSessionDeferral(api, true)
    const id = await provisionalId(wrapped)

    const failed = await wrapped.sessions.prompt(PROMPT(id, 'p1'))
    expect(failed.result).toEqual({
      ok: false,
      error: { code: 'internal', message: 'boom', details: {} },
    })
    expect(sessionPrompt).not.toHaveBeenCalled()

    // The entry survives the failure: a later prompt retries materialization.
    await wrapped.sessions.prompt(PROMPT(id, 'p2'))
    expect(sessionCreate).toHaveBeenCalledTimes(2)
    expect(sessionPrompt).toHaveBeenCalledTimes(1)
  })

  it('propagates a thrown materialization failure and keeps the entry for retry', async () => {
    const { api, sessionCreate, sessionPrompt } = apiHarness()
    sessionCreate.mockRejectedValueOnce(new Error('create exploded'))
    const wrapped = withSessionDeferral(api, true)
    const id = await provisionalId(wrapped)

    await expect(wrapped.sessions.prompt(PROMPT(id, 'p1'))).rejects.toThrow('create exploded')
    expect(sessionPrompt).not.toHaveBeenCalled()

    // The cleanup ran: a later prompt retries materialization.
    await wrapped.sessions.prompt(PROMPT(id, 'p2'))
    expect(sessionCreate).toHaveBeenCalledTimes(2)
    expect(sessionPrompt).toHaveBeenCalledTimes(1)
  })

  it('prunes stale provisional entries on the next create', async () => {
    vi.useFakeTimers()
    const { api, sessionHistory } = apiHarness()
    const wrapped = withSessionDeferral(api, true)
    const first = await provisionalId(wrapped, 'c1')

    vi.advanceTimersByTime(31 * 60_000)
    const second = await provisionalId(wrapped, 'c2')

    // The stale id now reaches the gateway; the fresh id stays provisional.
    await wrapped.sessions.history({ rpcId: RpcId('h1'), payload: { sessionId: first } })
    expect(sessionHistory).toHaveBeenCalledTimes(1)
    await wrapped.sessions.history({ rpcId: RpcId('h2'), payload: { sessionId: second } })
    expect(sessionHistory).toHaveBeenCalledTimes(1)
  })

  it('returns the original API when disabled', () => {
    const { api } = apiHarness()

    expect(withSessionDeferral(api, false)).toBe(api)
  })
})

describe('withSessionDeferral: agent presets', () => {
  it('records a preset chosen on a provisional session and applies it at materialization', async () => {
    const { api, sessionCreate, presetSelect } = apiHarness()
    const wrapped = withSessionDeferral(api, true)
    const sessionId = await provisionalId(wrapped)

    const selected = await wrapped.agentPresets.select({
      rpcId: RpcId('select-rpc'),
      payload: { sessionId, agentPreset: 'tavern' },
    })

    // Nothing exists to recompose yet, so the gateway is not called at all.
    expect(presetSelect).not.toHaveBeenCalled()
    expect(selected.result.ok).toBe(true)
    expect(selected.result.ok && selected.result.value).toEqual({ agentPreset: 'tavern' })

    await wrapped.sessions.prompt(PROMPT(sessionId, 'prompt-rpc'))
    expect(sessionCreate).toHaveBeenCalledTimes(1)
    expect(sessionCreate.mock.calls[0]![0].payload).toMatchObject({ sessionId, agentPreset: 'tavern' })
  })

  it('keeps the last choice when the preset is switched twice before the first message', async () => {
    const { api, sessionCreate } = apiHarness()
    const wrapped = withSessionDeferral(api, true)
    const sessionId = await provisionalId(wrapped)

    await wrapped.agentPresets.select({ rpcId: RpcId('s1'), payload: { sessionId, agentPreset: 'tavern' } })
    await wrapped.agentPresets.select({ rpcId: RpcId('s2'), payload: { sessionId, agentPreset: 'router-flash' } })
    await wrapped.sessions.prompt(PROMPT(sessionId, 'prompt-rpc'))

    expect(sessionCreate.mock.calls[0]![0].payload).toMatchObject({ agentPreset: 'router-flash' })
  })

  it('passes a real session straight through to the gateway', async () => {
    const { api, presetSelect } = apiHarness()
    const wrapped = withSessionDeferral(api, true)
    const request = { rpcId: RpcId('select-rpc'), payload: { sessionId: SessionId('session-real'), agentPreset: 'standard' } }

    await wrapped.agentPresets.select(request)
    expect(presetSelect).toHaveBeenCalledWith(request)
  })

  it('echoes a preset supplied at create time', async () => {
    const { api } = apiHarness()
    const wrapped = withSessionDeferral(api, true)
    const created = await wrapped.sessions.create({ rpcId: RpcId('create-rpc'), payload: { agentPreset: 'minimal' } })
    expect(created.result.ok && created.result.value).toMatchObject({ agentPreset: 'minimal' })
  })
})
