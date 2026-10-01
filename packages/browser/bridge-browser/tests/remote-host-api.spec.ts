import { describe, expect, it, vi } from 'vitest'
import {
  createRemoteHostApi,
  type HostConnectionLike,
  type TypertGatewayLike,
} from '../src/remote-host-api.ts'
import type { HostRpcCall } from '../src/host-api.ts'

function call(method: string, payload: unknown, rpcId = 'rpc-1'): HostRpcCall {
  return { rpcId, method, payload, signal: new AbortController().signal }
}

function abortWait(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
}

function harness(options: {
  invoke?: TypertGatewayLike['invoke']
  open?: TypertGatewayLike['wireStream']['open']
  fetch?: (request: Request) => Promise<Response>
} = {}) {
  const invoke = vi.fn(options.invoke ?? (async () => ({ accepted: true })))
  const open = vi.fn(options.open ?? (async (_endpoint, _payload, _uplink, _peer, signal) => ({
    async *[Symbol.asyncIterator]() { await abortWait(signal) },
  })))
  const requestBodies: unknown[] = []
  const fetch = vi.fn(options.fetch ?? (async (request: Request) => {
    const body = await request.clone().json() as { rpcId: string }
    requestBodies.push(body)
    return Response.json({ type: 'server-response', rpcId: body.rpcId, result: { ok: true } })
  }))
  const gateway: TypertGatewayLike = {
    invoke,
    wireStream: {
      open,
      failure: (error: unknown) => {
        const value = error as { code?: unknown; message?: unknown; details?: unknown }
        return {
          code: typeof value.code === 'string' ? value.code : 'internal',
          message: typeof value.message === 'string' ? value.message : String(error),
          details: typeof value.details === 'object' && value.details !== null ? value.details : {},
        }
      },
    },
  }
  const connection: HostConnectionLike = {
    createSharedFetchHandler: () => ({ fetch }),
  }
  return { api: createRemoteHostApi(gateway, connection), invoke, open, fetch, requestBodies }
}

describe('dsh 0.2 Remote Host adapter', () => {
  it('passes the signal in the fifth argument for DSH Desktop 2.x streams', async () => {
    const open = vi.fn(async (_endpoint: string, _payload: unknown, uplink: AsyncIterable<unknown>, peer: unknown, signal: AbortSignal) => {
      expect(typeof uplink[Symbol.asyncIterator]).toBe('function')
      expect(peer).toBeUndefined()
      expect(signal).toBeInstanceOf(AbortSignal)
      return { async *[Symbol.asyncIterator]() { yield { type: 'ready', clientId: 'test', host: {} }; await abortWait(signal) } }
    })
    const { api } = harness({ open })
    const controller = new AbortController()
    const iterator = api.events(controller.signal)[Symbol.asyncIterator]()
    const pending = iterator.next()
    await vi.waitFor(() => expect(open).toHaveBeenCalled())
    controller.abort()
    await pending.catch(() => undefined)
    expect(open.mock.calls[0]?.[4]).toBeInstanceOf(AbortSignal)
  })
  it('preserves V3 durable streams and orders reconnect baselines before transient frames without advancing the durable cursor', async () => {
    const baseline = {
      revision: 2,
      activeAttempt: {
        attemptId: 'attempt-1', turn: 1, step: 0, startedAfterSeq: 8, nextIndex: 1,
        stream: [{ type: 'text-chunks', time0: 10, index: 0, dt: [], texts: ['Hello'] }],
      },
    }
    const previousMessage = {
      type: 'assistant/message', seq: 8, time: 9, surfaceOp: 'append',
      data: {
        turn: 0, step: 0,
        message: { role: 'assistant', content: [{ type: 'text', text: 'Previous' }] },
        stream: [{ type: 'text-chunks', time0: 8, index: 0, dt: [], texts: ['Previous'] }],
      },
    }
    const chunk = {
      type: 'chunk', attemptId: 'attempt-1', revision: 3, index: 1, time: 11,
      chunk: { type: 'text-delta', index: 0, text: ' world' },
    }
    const { api, invoke } = harness({
      invoke: async () => ({ records: [], hasMore: false }),
      open: async (endpoint, _payload, _uplink, _peer, signal) => ({
        async *[Symbol.asyncIterator]() {
          if (endpoint === '$events') yield { type: 'ready', clientId: 'client-1' }
          else {
            yield { type: 'snapshot', cursor: 8, records: [{ type: 'event', event: previousMessage }],
              hasMore: true, assistantStream: baseline }
            yield { type: 'assistant-stream', frame: chunk }
          }
          await abortWait(signal)
        },
      }),
    })
    const abort = new AbortController()
    const events = api.events(abort.signal)[Symbol.asyncIterator]()
    const opening = events.next()
    await expect(api.call(call('session.history', { sessionId: 'session-1' }))).resolves.toEqual({
      ok: true,
      value: { events: [{ event: previousMessage }], hasMore: true, assistantStream: baseline, snapshotId: expect.any(String) },
    })
    await expect(opening).resolves.toMatchObject({ value: {
      method: 'session/assistant-stream', payload: { sessionId: 'session-1', frame: { type: 'snapshot', baseline } },
    } })
    await expect(events.next()).resolves.toMatchObject({ value: {
      method: 'session/assistant-stream', payload: { sessionId: 'session-1', frame: chunk },
    } })
    await api.call(call('session.history', { sessionId: 'session-1', beforeSeq: 5 }))
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({
      namespace: 'session', method: 'page',
      args: { request: { address: { kind: 'session', sessionId: 'session-1' }, throughSeq: 8, beforeSeq: 5 } },
    }))
    abort.abort()
    await events.return?.()
  })

  it('maps unary extension calls to exact Typert namespaces and named args', async () => {
    const { api, invoke } = harness({
      invoke: async ({ namespace, method }) => {
        if (`${namespace}/${method}` === 'credentials/describe') return { TOKEN: { configured: true } }
        if (`${namespace}/${method}` === 'llm/discoverModels') return [{ id: 'deepseek-chat' }]
        if (`${namespace}/${method}` === 'session/modelCatalog') {
          return {
            default: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
            routableProviders: ['deepseek-official'],
            groups: [{
              id: 'deepseek-official',
              name: 'DeepSeek',
              models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }],
            }],
            failures: [],
          }
        }
        return { accepted: true }
      },
    })

    await api.call(call('session.list', {}))
    await api.call(call('session.prompt', { sessionId: 'session-1', mode: 'queue', content: [] }, 'prompt-id'))
    await expect(api.call(call('session.models', { sessionId: 'session-1' }))).resolves.toEqual({
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
    await api.call(call('settings.mutate', { ns: 'llm-pi-ai', ops: [] }))
    await expect(api.call(call('credentials.describe', { refs: ['TOKEN'] }))).resolves.toEqual({
      ok: true, value: { credentials: { TOKEN: { configured: true } } },
    })
    await expect(api.call(call('llm.discoverModels', {
      settingsNs: 'llm-pi-ai', provider: 'relay', baseURL: 'https://relay.example',
    }))).resolves.toEqual({ ok: true, value: { models: [{ id: 'deepseek-chat' }] } })

    expect(invoke).toHaveBeenNthCalledWith(1, expect.objectContaining({
      namespace: 'session', method: 'list', args: { _request: {} },
    }))
    expect(invoke).toHaveBeenNthCalledWith(2, expect.objectContaining({
      namespace: 'session',
      method: 'prompt',
      args: { request: { requestId: 'prompt-id', sessionId: 'session-1', mode: 'queue', content: [] } },
    }))
    expect(invoke).toHaveBeenNthCalledWith(3, expect.objectContaining({
      namespace: 'session',
      method: 'modelCatalog',
      args: {},
    }))
    expect(invoke).toHaveBeenNthCalledWith(4, expect.objectContaining({
      namespace: 'settings', method: 'mutate', args: { ns: 'llm-pi-ai', ops: [] },
    }))
    expect(invoke).toHaveBeenNthCalledWith(6, expect.objectContaining({
      namespace: 'llm',
      method: 'discoverModels',
      args: {
        settingsNs: 'llm-pi-ai',
        request: { provider: 'relay', baseURL: 'https://relay.example' },
      },
    }))
  })

  it('uses a session/follow snapshot for history and keeps that iterator for live events', async () => {
    const { api, open } = harness({
      open: async (endpoint, _payload, _uplink, _peer, signal) => {
        if (endpoint === '$events') {
          return {
            async *[Symbol.asyncIterator]() {
              yield { type: 'ready', clientId: 'client-1', host: { home: '/home/test' } }
              await abortWait(signal)
            },
          }
        }
        if (endpoint === 'session/follow') {
          return {
            async *[Symbol.asyncIterator]() {
              yield {
                type: 'snapshot',
                cursor: 3,
                records: [
                  { type: 'event', event: { type: 'user/message', seq: 0, time: 1, data: {} } },
                  {
                    type: 'chunks',
                    event: {
                      type: 'chunkrow/text-chunks',
                      seq: 1,
                      time: 2,
                      data: { turn: 0, step: 0, index: 0, dt: [2, -1], texts: ['Hel', 'lo', '!'] },
                    },
                  },
                ],
                hasMore: false,
                projections: { asOfSeq: 1, values: { imageLimits: { maxImageBytes: 10 } } },
              }
              yield { type: 'event', event: { type: 'turn/start', seq: 2, time: 3, data: {} } }
              await abortWait(signal)
            },
          }
        }
        throw new Error(endpoint)
      },
    })
    const abort = new AbortController()
    const events = api.events(abort.signal)[Symbol.asyncIterator]()
    const live = events.next()
    await vi.waitFor(() => { expect(open).toHaveBeenCalledWith('$events', { args: {} }, expect.anything(), undefined, expect.any(AbortSignal)) })

    await expect(api.call(call('session.history', {
      sessionId: 'session-1',
      maxMessages: 2,
    }))).resolves.toEqual({
      ok: true,
      value: {
        events: [
          { event: { type: 'user/message', seq: 0, time: 1, data: {} } },
          {
            event: {
              type: 'assistant/chunk', seq: 1, time: 2,
              data: { turn: 0, step: 0, chunk: { type: 'text-delta', index: 0, text: 'Hel' } },
            },
          },
          {
            event: {
              type: 'assistant/chunk', seq: 2, time: 4,
              data: { turn: 0, step: 0, chunk: { type: 'text-delta', index: 0, text: 'lo' } },
            },
          },
          {
            event: {
              type: 'assistant/chunk', seq: 3, time: 3,
              data: { turn: 0, step: 0, chunk: { type: 'text-delta', index: 0, text: '!' } },
            },
          },
        ],
        hasMore: false,
        projections: { asOfSeq: 1, values: { imageLimits: { maxImageBytes: 10 } } },
      },
    })
    await expect(live).resolves.toEqual({
      done: false,
      value: expect.objectContaining({
        method: 'session/event',
        payload: {
          type: 'session/event',
          sessionId: 'session-1',
          event: { type: 'turn/start', seq: 2, time: 3, data: {} },
        },
      }),
    })
    expect(open).toHaveBeenCalledWith('session/follow', {
      args: {
        request: {
          address: { kind: 'session', sessionId: 'session-1' },
          maxMessages: 2,
          assistantStream: true,
        },
      },
    }, expect.anything(), undefined, expect.any(AbortSignal))
    abort.abort()
    await events.return?.()
  })

  it('forwards tail-page size through a one-shot session/follow snapshot', async () => {
    const { api, open } = harness({
      open: async (endpoint) => {
        if (endpoint !== 'session/follow') throw new Error(endpoint)
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: 'snapshot', cursor: -1, records: [], hasMore: false }
          },
        }
      },
    })

    await expect(api.call(call('session.history', {
      sessionId: 'session-one-shot',
      maxMessages: 12,
    }))).resolves.toEqual({
      ok: true,
      value: { events: [], hasMore: false },
    })
    expect(open).toHaveBeenCalledWith('session/follow', {
      args: {
        request: {
          address: { kind: 'session', sessionId: 'session-one-shot' },
          maxMessages: 12,
          assistantStream: true,
        },
      },
    }, expect.anything(), undefined, expect.any(AbortSignal))
  })

  it('rejects invalid history pagination before calling the Host', async () => {
    const { api, invoke, open } = harness()

    await expect(api.call(call('session.history', {
      sessionId: 'session-1',
      beforeSeq: -1,
    }))).resolves.toEqual({
      ok: false,
      error: { code: 'bad-request', message: 'beforeSeq must be a non-negative safe integer', details: {} },
    })
    await expect(api.call(call('session.history', {
      sessionId: 'session-1',
      maxMessages: 0,
    }))).resolves.toEqual({
      ok: false,
      error: { code: 'bad-request', message: 'maxMessages must be a positive safe integer', details: {} },
    })
    expect(open).not.toHaveBeenCalled()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('pages older history with a Host-legal throughSeq, never MAX_SAFE_INTEGER', async () => {
    const { api, invoke, open } = harness({
      invoke: async ({ namespace, method, args }) => {
        if (`${namespace}/${method}` !== 'session/page') throw new Error(`${namespace}/${method}`)
        expect(args).toEqual({
          request: {
            address: { kind: 'session', sessionId: 'session-1' },
            throughSeq: 42,
            beforeSeq: 10,
            maxMessages: 20,
          },
        })
        return {
          records: [{ type: 'event', event: { type: 'user/message', seq: 9, time: 1, data: {} } }],
          hasMore: true,
        }
      },
      open: async (endpoint) => {
        if (endpoint === 'session/follow') {
          return {
            async *[Symbol.asyncIterator]() {
              yield { type: 'snapshot', cursor: 42, records: [], hasMore: false }
            },
          }
        }
        throw new Error(endpoint)
      },
    })

    await expect(api.call(call('session.history', {
      sessionId: 'session-1',
      beforeSeq: 10,
      maxMessages: 20,
    }))).resolves.toEqual({
      ok: true,
      value: {
        events: [{ event: { type: 'user/message', seq: 9, time: 1, data: {} } }],
        hasMore: true,
      },
    })
    expect(open).toHaveBeenCalledWith('session/follow', {
      args: { request: { address: { kind: 'session', sessionId: 'session-1' }, assistantStream: true } },
    }, expect.anything(), undefined, expect.any(AbortSignal))
    expect(invoke).toHaveBeenCalledOnce()
    const pageArgs = invoke.mock.calls[0]?.[0]?.args as { request: { throughSeq: number } }
    expect(pageArgs.request.throughSeq).toBe(42)
    expect(pageArgs.request.throughSeq).not.toBe(Number.MAX_SAFE_INTEGER)
  })

  it('fails closed when session/page returns a malformed history page', async () => {
    const { api } = harness({
      invoke: async ({ namespace, method }) => {
        if (`${namespace}/${method}` !== 'session/page') throw new Error(`${namespace}/${method}`)
        return { records: 'not-an-array' }
      },
      open: async (endpoint) => {
        if (endpoint === 'session/follow') {
          return {
            async *[Symbol.asyncIterator]() {
              yield { type: 'snapshot', cursor: 5, records: [], hasMore: false }
            },
          }
        }
        throw new Error(endpoint)
      },
    })

    await expect(api.call(call('session.history', {
      sessionId: 'session-1',
      beforeSeq: 3,
    }))).resolves.toEqual({
      ok: false,
      error: {
        code: 'internal',
        message: 'session/page returned an invalid history page',
        details: {},
      },
    })
  })

  it('fails closed when session/page records omit a usable event envelope', async () => {
    const { api } = harness({
      invoke: async ({ namespace, method }) => {
        if (`${namespace}/${method}` !== 'session/page') throw new Error(`${namespace}/${method}`)
        return {
          records: [
            { type: 'event', event: { type: 'user/message', seq: 1, time: 1, data: {} } },
            { type: 'event' },
          ],
          hasMore: false,
        }
      },
      open: async (endpoint) => {
        if (endpoint === 'session/follow') {
          return {
            async *[Symbol.asyncIterator]() {
              yield { type: 'snapshot', cursor: 5, records: [], hasMore: false }
            },
          }
        }
        throw new Error(endpoint)
      },
    })

    await expect(api.call(call('session.history', {
      sessionId: 'session-1',
      beforeSeq: 3,
    }))).resolves.toEqual({
      ok: false,
      error: {
        code: 'internal',
        message: 'session history carried an invalid record',
        details: {},
      },
    })
  })

  it('drops buffered events from a session follower after it is replaced', async () => {
    let releaseStale!: () => void
    let releaseFresh!: () => void
    let staleClosed = false
    const staleGate = new Promise<void>((resolve) => { releaseStale = resolve })
    const freshGate = new Promise<void>((resolve) => { releaseFresh = resolve })
    const { api } = harness({
      open: async (endpoint, payload, _uplink, _peer, signal) => {
        if (endpoint === '$events') {
          return {
            async *[Symbol.asyncIterator]() {
              yield { type: 'ready', clientId: 'client-1', host: { home: '/home/test' } }
              await abortWait(signal)
            },
          }
        }
        if (endpoint !== 'session/follow') throw new Error(endpoint)
        const sessionId = (payload as {
          args: { request: { address: { sessionId: string } } }
        }).args.request.address.sessionId
        const stale = sessionId === 'session-old'
        return {
          async *[Symbol.asyncIterator]() {
            try {
              yield { type: 'snapshot', cursor: -1, records: [], hasMore: false }
              // Deliberately ignore abort while this read is pending: some
              // iterators can still release one buffered frame after abort.
              await (stale ? staleGate : freshGate)
              yield {
                type: 'event',
                event: { type: 'turn/start', seq: stale ? 1 : 2, time: 3, data: {} },
              }
              await abortWait(signal)
            } finally {
              if (stale) staleClosed = true
            }
          },
        }
      },
    })
    const abort = new AbortController()
    const events = api.events(abort.signal)[Symbol.asyncIterator]()
    const nextEvent = events.next()

    await expect(api.call(call('session.history', { sessionId: 'session-old' })))
      .resolves.toMatchObject({ ok: true })
    await expect(api.call(call('session.history', { sessionId: 'session-new' })))
      .resolves.toMatchObject({ ok: true })

    releaseStale()
    await vi.waitFor(() => { expect(staleClosed).toBe(true) })
    releaseFresh()
    await expect(nextEvent).resolves.toEqual({
      done: false,
      value: expect.objectContaining({
        method: 'session/event',
        payload: {
          type: 'session/event',
          sessionId: 'session-new',
          event: { type: 'turn/start', seq: 2, time: 3, data: {} },
        },
      }),
    })

    abort.abort()
    await events.return?.()
  })

  it('reads workspace.list from the workspace/follow baseline', async () => {
    const { api, open } = harness({
      open: async (endpoint) => ({
        async *[Symbol.asyncIterator]() {
          if (endpoint === 'workspace/follow') {
            yield { type: 'baseline', value: { items: [{ workspaceId: 'w1' }], archivedSessionIds: ['s1'] } }
          }
        },
      }),
    })

    await expect(api.call(call('workspace.list', {}))).resolves.toEqual({
      ok: true,
      value: { items: [{ workspaceId: 'w1' }], archivedSessionIds: ['s1'] },
    })
    expect(open).toHaveBeenCalledWith('workspace/follow', { args: {} }, expect.anything(), undefined, expect.any(AbortSignal))
  })

  it('bridges user questions through $events/result and unwraps the extension answer', async () => {
    let releaseCancel: (() => void) | undefined
    const { api, fetch } = harness({
      open: async (endpoint, _payload, _uplink, _peer, signal) => {
        if (endpoint === 'session/follow') {
          return {
            async *[Symbol.asyncIterator]() {
              yield { type: 'snapshot', cursor: -1, records: [], hasMore: false }
              await abortWait(signal)
            },
          }
        }
        if (endpoint !== '$events') throw new Error(endpoint)
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: 'ready', clientId: 'client-questions', host: { home: '/home/test' } }
            yield {
              type: 'waterfall',
              event: 'user-questions/request',
              eventId: 'question-1',
              agentId: 'session-1',
              request: { questions: [{ id: 'db', question: 'Database?' }] },
            }
            await new Promise<void>((resolve) => { releaseCancel = resolve })
            yield { type: 'cancel', eventId: 'question-1' }
            await abortWait(signal)
          },
        }
      },
    })
    // Extension ownership is claimed only after a successful prompt/create.
    await expect(api.call(call('session.prompt', {
      sessionId: 'session-1',
      mode: 'queue',
      content: [],
    }, 'prompt-id'))).resolves.toEqual({ ok: true, value: { accepted: true } })

    const abort = new AbortController()
    const events = api.events(abort.signal)[Symbol.asyncIterator]()

    await expect(events.next()).resolves.toEqual({
      done: false,
      value: {
        rpcId: 'question-1',
        method: 'question/requested',
        payload: {
          type: 'question/requested',
          sessionId: 'session-1',
          questions: [{ id: 'db', question: 'Database?' }],
        },
      },
    })
    await expect(api.respond('question-1', {
      ok: true,
      value: {
        sessionId: 'session-1',
        answer: { answers: [{ id: 'db', selected: ['SQLite'] }] },
      },
    }, abort.signal)).resolves.toEqual({ accepted: true })

    const request = fetch.mock.calls[0]?.[0] as Request
    expect(request.url).toBe('http://dsh.internal/api/$events/result')
    expect(await request.clone().json()).toMatchObject({
      type: 'client-request',
      method: '$events/result',
      payload: {
        args: {
          clientId: 'client-questions',
          eventId: 'question-1',
          outcome: { kind: 'result', value: { answers: [{ id: 'db', selected: ['SQLite'] }] } },
        },
      },
    })

    const resolved = events.next()
    releaseCancel?.()
    await expect(resolved).resolves.toEqual({
      done: false,
      value: expect.objectContaining({
        method: 'question/resolved',
        payload: {
          type: 'question/resolved', sessionId: 'session-1', questionRpcId: 'question-1',
        },
      }),
    })
    abort.abort()
    await events.return?.()
  })

  it('declines Desktop user-question waterfalls so the native UI can answer', async () => {
    const { api, fetch, requestBodies } = harness({
      open: async (endpoint, _payload, _uplink, _peer, signal) => {
        if (endpoint !== '$events') throw new Error(endpoint)
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: 'ready', clientId: 'client-desktop', host: { home: '/home/test' } }
            yield {
              type: 'waterfall',
              event: 'user-questions/request',
              eventId: 'question-desktop',
              agentId: 'desktop-session',
              request: { questions: [{ id: 'db', question: 'Database?' }] },
            }
            await abortWait(signal)
          },
        }
      },
    })

    const abort = new AbortController()
    const iterator = api.events(abort.signal)[Symbol.asyncIterator]()
    const pending = iterator.next()
    await vi.waitFor(() => { expect(fetch.mock.calls.length).toBe(1) })
    expect(requestBodies[0]).toMatchObject({
      payload: { args: { eventId: 'question-desktop', outcome: { kind: 'next' } } },
    })
    abort.abort()
    await expect(pending).resolves.toEqual({ done: true, value: undefined })
  })

  it('does not claim session ownership when prompt fails', async () => {
    const error = Object.assign(new Error('rejected'), { code: 'bad-request', details: {} })
    const { api, fetch, requestBodies } = harness({
      invoke: async () => { throw error },
      open: async (endpoint, _payload, _uplink, _peer, signal) => {
        if (endpoint === 'session/follow') {
          return {
            async *[Symbol.asyncIterator]() {
              yield { type: 'snapshot', cursor: -1, records: [], hasMore: false }
              await abortWait(signal)
            },
          }
        }
        if (endpoint !== '$events') throw new Error(endpoint)
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: 'ready', clientId: 'client-fail', host: { home: '/home/test' } }
            yield {
              type: 'waterfall',
              event: 'user-questions/request',
              eventId: 'question-fail',
              agentId: 'session-fail',
              request: { questions: [{ id: 'db', question: 'Database?' }] },
            }
            await abortWait(signal)
          },
        }
      },
    })

    await expect(api.call(call('session.prompt', {
      sessionId: 'session-fail',
      mode: 'queue',
      content: [],
    }))).resolves.toEqual({
      ok: false,
      error: { code: 'bad-request', message: 'rejected', details: {} },
    })

    const abort = new AbortController()
    const iterator = api.events(abort.signal)[Symbol.asyncIterator]()
    const pending = iterator.next()
    await vi.waitFor(() => { expect(fetch.mock.calls.length).toBe(1) })
    expect(requestBodies[0]).toMatchObject({
      payload: { args: { eventId: 'question-fail', outcome: { kind: 'next' } } },
    })
    abort.abort()
    await expect(pending).resolves.toEqual({ done: true, value: undefined })
  })

  it('delegates unhandled waterfalls and preserves Gateway failure fields', async () => {
    const error = Object.assign(new Error('gone'), { code: 'session-not-found', details: { sessionId: 's1' } })
    const { api, fetch, requestBodies } = harness({
      invoke: async () => { throw error },
      open: async (endpoint, _payload, _uplink, _peer, signal) => ({
        async *[Symbol.asyncIterator]() {
          if (endpoint === '$events') {
            yield { type: 'ready', clientId: 'client-1', host: { home: '/home/test' } }
            yield { type: 'waterfall', event: 'approval/request', eventId: 'approval-1', agentId: 's1', request: {} }
            await abortWait(signal)
          }
        },
      }),
    })

    await expect(api.call(call('session.cancel', { sessionId: 's1' }))).resolves.toEqual({
      ok: false,
      error: { code: 'session-not-found', message: 'gone', details: { sessionId: 's1' } },
    })

    const abort = new AbortController()
    const iterator = api.events(abort.signal)[Symbol.asyncIterator]()
    const pending = iterator.next()
    await vi.waitFor(() => { expect(fetch.mock.calls.length).toBe(1) })
    expect(requestBodies[0]).toMatchObject({
      payload: { args: { eventId: 'approval-1', outcome: { kind: 'next' } } },
    })
    abort.abort()
    await expect(pending).resolves.toEqual({ done: true, value: undefined })
  })
})
