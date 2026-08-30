import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {
  SessionCreateRequest, SessionCreateValue, SessionPageRequest, SessionPromptRequest,
} from '../src/harness-types.ts'
import type { BridgeSessionApi } from '../src/session-api.ts'
import { withSessionDeferral } from '../src/session-deferral.ts'

const PROMPT = (sessionId: ReturnType<typeof SessionId>): SessionPromptRequest => ({
  requestId: 'req' as SessionPromptRequest['requestId'],
  sessionId,
  mode: 'queue',
  content: [],
})

const PAGE_REQUEST = (sessionId: ReturnType<typeof SessionId>): SessionPageRequest => ({
  address: { kind: 'session', sessionId },
  throughSeq: 0,
})

function apiHarness() {
  const create = vi.fn(async (request: SessionCreateRequest): Promise<SessionCreateValue> => ({
    sessionId: request.sessionId as ReturnType<typeof SessionId>,
  }))
  const page = vi.fn(async () => ({ records: [{ type: 'event', event: { type: 'user/message' } }], hasMore: false }))
  const prompt = vi.fn(async () => ({ accepted: true as const }))
  const api = { create, page, prompt } as unknown as BridgeSessionApi
  return { api, create, page, prompt }
}

async function provisionalId(wrapped: BridgeSessionApi): Promise<ReturnType<typeof SessionId>> {
  const response = await wrapped.create({})
  return response.sessionId as ReturnType<typeof SessionId>
}

const NO_SIGNAL = new AbortController().signal

describe('withSessionDeferral', () => {
  afterEach(() => { vi.useRealTimers() })

  it('answers create with a provisional id without touching the gateway', async () => {
    const { api, create } = apiHarness()
    const wrapped = withSessionDeferral(api, true)

    const id = await provisionalId(wrapped)

    expect(id).toMatch(/^session-/)
    expect(create).not.toHaveBeenCalled()
  })

  it('honors an explicit session id from the caller', async () => {
    const { api } = apiHarness()
    const wrapped = withSessionDeferral(api, true)

    const response = await wrapped.create({ sessionId: SessionId('session-fixed') })

    expect(response).toEqual({ sessionId: SessionId('session-fixed') })
  })

  it('serves an empty page for a provisional id and passes other ids through', async () => {
    const { api, page } = apiHarness()
    const wrapped = withSessionDeferral(api, true)
    const id = await provisionalId(wrapped)

    const empty = await wrapped.page(PAGE_REQUEST(id), NO_SIGNAL)
    expect(empty).toEqual({ records: [], hasMore: false })
    expect(page).not.toHaveBeenCalled()

    await wrapped.page(PAGE_REQUEST(SessionId('session-real')), NO_SIGNAL)
    expect(page).toHaveBeenCalledWith(PAGE_REQUEST(SessionId('session-real')), NO_SIGNAL)
  })

  it('materializes the session on the first prompt, replaying the create payload', async () => {
    const { api, create, prompt, page } = apiHarness()
    const wrapped = withSessionDeferral(api, true)
    const created = await wrapped.create({ cwd: '/work' })
    const id = created.sessionId as ReturnType<typeof SessionId>
    const promptRequest = PROMPT(id)

    await wrapped.prompt(promptRequest, NO_SIGNAL)

    expect(create).toHaveBeenCalledWith({ cwd: '/work', sessionId: id })
    expect(prompt).toHaveBeenCalledWith(promptRequest, NO_SIGNAL)

    // Materialized: page reads now reach the gateway.
    await wrapped.page(PAGE_REQUEST(id), NO_SIGNAL)
    expect(page).toHaveBeenCalledTimes(1)
  })

  it('passes prompts for unknown sessions through untouched', async () => {
    const { api, prompt } = apiHarness()
    const wrapped = withSessionDeferral(api, true)

    await wrapped.prompt(PROMPT(SessionId('session-existing')), NO_SIGNAL)

    expect(prompt).toHaveBeenCalledTimes(1)
  })

  it('deduplicates concurrent prompts into one materialization', async () => {
    const { api, create, prompt } = apiHarness()
    let release!: () => void
    create.mockImplementationOnce(async (request: SessionCreateRequest) => {
      await new Promise<void>((resolve) => { release = resolve })
      return { sessionId: request.sessionId as ReturnType<typeof SessionId> }
    })
    const wrapped = withSessionDeferral(api, true)
    const id = await provisionalId(wrapped)

    const first = wrapped.prompt(PROMPT(id), NO_SIGNAL)
    const second = wrapped.prompt(PROMPT(id), NO_SIGNAL)
    release()
    await Promise.all([first, second])

    expect(create).toHaveBeenCalledTimes(1)
    expect(prompt).toHaveBeenCalledTimes(2)
  })

  it('propagates a thrown materialization failure and keeps the entry for retry', async () => {
    const { api, create, prompt } = apiHarness()
    create.mockRejectedValueOnce(new Error('create exploded'))
    const wrapped = withSessionDeferral(api, true)
    const id = await provisionalId(wrapped)

    await expect(wrapped.prompt(PROMPT(id), NO_SIGNAL)).rejects.toThrow('create exploded')
    expect(prompt).not.toHaveBeenCalled()

    // The entry survives the failure: a later prompt retries materialization.
    await wrapped.prompt(PROMPT(id), NO_SIGNAL)
    expect(create).toHaveBeenCalledTimes(2)
    expect(prompt).toHaveBeenCalledTimes(1)
  })

  it('prunes stale provisional entries on the next create', async () => {
    vi.useFakeTimers()
    const { api, page } = apiHarness()
    const wrapped = withSessionDeferral(api, true)
    const first = await provisionalId(wrapped)

    vi.advanceTimersByTime(31 * 60_000)
    const second = await provisionalId(wrapped)

    // The stale id now reaches the gateway; the fresh id stays provisional.
    await wrapped.page(PAGE_REQUEST(first), NO_SIGNAL)
    expect(page).toHaveBeenCalledTimes(1)
    await wrapped.page(PAGE_REQUEST(second), NO_SIGNAL)
    expect(page).toHaveBeenCalledTimes(1)
  })

  it('returns the original API when disabled', () => {
    const { api } = apiHarness()

    expect(withSessionDeferral(api, false)).toBe(api)
  })
})
