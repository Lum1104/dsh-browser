import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createApiCompatibility } from '../src/api-compat.ts'

interface CurrentCall {
  readonly endpoint: string
  readonly args: Record<string, unknown>
}

function harness(eventFrames: readonly unknown[] = []) {
  const calls: CurrentCall[] = []
  const context = {
    connection: {
      createSharedFetchHandler: () => ({
        fetch: async (request: Request) => {
          const body = await request.json() as {
            rpcId: string
            method: string
            payload: { args: Record<string, unknown> }
          }
          calls.push({ endpoint: body.method, args: body.payload.args })
          const value = body.method === 'credentials/describe'
            ? { DEEPSEEK_API_KEY: { configured: true } }
            : body.method === 'llm/discoverModels'
              ? [{ id: 'deepseek-chat' }]
              : { accepted: true }
          return Response.json({
            type: 'server-response',
            rpcId: body.rpcId,
            result: { ok: true, value },
          })
        },
      }),
    },
    typertGateway: {
      wireStream: {
        open: async (endpoint: string, _payload: unknown, signal: AbortSignal) => {
          async function* stream(): AsyncGenerator<unknown> {
            if (endpoint === 'session/follow') {
              yield {
                type: 'snapshot',
                records: [{ event: { type: 'user/message', seq: 0 } }],
                hasMore: false,
                projections: { asOfSeq: 0, values: {} },
              }
              return
            }
            if (endpoint === 'workspace/follow') {
              yield { type: 'baseline', value: { workspaces: [], archivedSessionIds: ['session-old'] } }
              return
            }
            for (const frame of eventFrames) yield frame
            await new Promise<void>((resolve) => {
              if (signal.aborted) resolve()
              else signal.addEventListener('abort', () => { resolve() }, { once: true })
            })
          }
          return stream()
        },
      },
    },
    on: () => () => {},
  } as unknown as Context
  return { api: createApiCompatibility(context, rpc => rpc), calls }
}

describe('current API compatibility', () => {
  it('maps dotted Session calls to current endpoints and named arguments', async () => {
    const { api, calls } = harness()
    await api.rpc('session.list', {})
    await api.rpc('session.create', { cwd: 'D:/workspace' })
    await api.rpc('session.prompt', {
      sessionId: 'session-1',
      content: [{ type: 'text', text: 'hello' }],
    })
    expect(calls[0]).toEqual({
      endpoint: 'session/list',
      args: { _request: {} },
    })
    expect(calls[1]).toEqual({
      endpoint: 'session/create',
      args: { request: { cwd: 'D:/workspace' } },
    })
    expect(calls[2]).toMatchObject({
      endpoint: 'session/prompt',
      args: {
        request: {
          sessionId: 'session-1',
          content: [{ type: 'text', text: 'hello' }],
          requestId: expect.any(String),
        },
      },
    })
  })

  it('projects current credentials and model discovery results into the extension protocol', async () => {
    const { api, calls } = harness()
    await expect(api.rpc('credentials.describe', { refs: ['DEEPSEEK_API_KEY'] })).resolves.toEqual({
      credentials: { DEEPSEEK_API_KEY: { configured: true } },
    })
    await expect(api.rpc('llm.discoverModels', {
      settingsNs: 'llm-pi-ai',
      provider: 'relay',
      baseURL: 'https://example.test/v1',
    })).resolves.toEqual({ models: [{ id: 'deepseek-chat' }] })
    expect(calls.at(-1)).toEqual({
      endpoint: 'llm/discoverModels',
      args: {
        settingsNs: 'llm-pi-ai',
        request: { provider: 'relay', baseURL: 'https://example.test/v1' },
      },
    })
  })

  it('derives legacy history and workspace lists from current opening stream frames', async () => {
    const { api } = harness()
    await expect(api.rpc('session.history', { sessionId: 'session-1' })).resolves.toEqual({
      events: [{ event: { type: 'user/message', seq: 0 } }],
      hasMore: false,
      projections: { asOfSeq: 0, values: {} },
    })
    await expect(api.rpc('workspace.list', {})).resolves.toEqual({
      workspaces: [],
      archivedSessionIds: ['session-old'],
    })
  })

  it('forwards current question waterfalls and returns extension answers', async () => {
    const { api, calls } = harness([
      { type: 'ready', clientId: 'client-1' },
      {
        type: 'waterfall',
        event: 'user-questions/request',
        eventId: 'question-1',
        agentId: 'session-1',
        request: { questions: [{ id: 'choice', question: 'Choose one' }] },
      },
    ])
    const abort = new AbortController()
    const iterator = api.openEvents(abort.signal)[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: {
        rpcId: 'question-1',
        payload: {
          type: 'question/requested',
          sessionId: 'session-1',
          questions: [{ id: 'choice', question: 'Choose one' }],
        },
      },
    })
    const response = await api.fetchHandler.fetch(new Request('http://dsh.internal/api/respond', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-response',
        rpcId: 'question-1',
        result: { ok: true, value: { sessionId: 'session-1', answer: { answers: [] } } },
      }),
    }))
    expect(response.status).toBe(200)
    expect(calls.at(-1)).toEqual({
      endpoint: '$events/result',
      args: {
        clientId: 'client-1',
        eventId: 'question-1',
        outcome: { kind: 'result', value: { answers: [] } },
      },
    })
    abort.abort()
    await iterator.return?.()
  })
})
