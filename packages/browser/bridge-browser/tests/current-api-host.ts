/** Test Host that exposes the current Connection/Typert services without a network transport. */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

interface ClientRequest {
  readonly type: 'client-request'
  readonly rpcId: string
  readonly method: string
  readonly payload: { readonly args: Record<string, unknown> }
}

interface PendingOutcome {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: unknown) => void
  readonly next: () => Promise<unknown>
}

class AsyncQueue {
  private readonly values: unknown[] = []
  private wake: (() => void) | undefined

  push(value: unknown): void {
    this.values.push(value)
    this.wake?.()
  }

  async *iterate(signal: AbortSignal): AsyncGenerator<unknown> {
    while (!signal.aborted) {
      while (this.values.length > 0) yield this.values.shift()
      if (signal.aborted) return
      await new Promise<void>((resolve) => {
        this.wake = resolve
        signal.addEventListener('abort', resolve, { once: true })
      })
      this.wake = undefined
    }
  }
}

/** Current API test plugin used by Loader and browser-extension integration coverage. */
export const CurrentApiHost = {
  name: 'current-api-host',
  inject: ['sessions', 'agents'],
  apply(ctx: Context, config: { cwd: string }): void {
    const eventQueue = new AsyncQueue()
    const pending = new Map<string, PendingOutcome>()
    const clientId = `client-${randomUUID()}`

    ctx.on('user-questions/request', async (request, next) => {
      if (request.agent === undefined) return next()
      const eventId = randomUUID()
      const answer = new Promise<unknown>((resolve, reject) => {
        pending.set(eventId, { resolve, reject, next })
      })
      const { agent: _agent, signal: _signal, ...projected } = request
      eventQueue.push({
        type: 'waterfall',
        event: 'user-questions/request',
        eventId,
        agentId: request.agent.id,
        request: projected,
      })
      return answer as ReturnType<typeof next>
    })

    const invoke = async (method: string, args: Record<string, unknown>): Promise<unknown> => {
      if (method === '$events/result') {
        const eventId = stringField(args, 'eventId')
        const settled = pending.get(eventId)
        if (settled === undefined) return { accepted: false }
        pending.delete(eventId)
        const outcome = record(args.outcome)
        if (outcome.kind === 'result') settled.resolve(outcome.value)
        else if (outcome.kind === 'next') settled.resolve(await settled.next())
        else {
          const error = record(outcome.error)
          settled.reject(Object.assign(new Error(String(error.message ?? 'rejected')), error))
        }
        return { accepted: true }
      }
      if (method === 'workspace/create') {
        const request = requestArg(args)
        const path = stringField(request, 'path')
        const registry = ctx.get('workspaceRegistry')
        if (registry === undefined) {
          return { workspace: { workspaceId: 'workspace-test', path }, created: true }
        }
        const existing = await registry.resolveByPath(path)
        const workspace = existing ?? await registry.create(path)
        return {
          workspace: workspaceView(workspace),
          created: existing === undefined,
        }
      }
      if (method === 'workspace/archiveSession') {
        const request = requestArg(args)
        await ctx.get('workspaceRegistry')?.archiveSession(SessionId(stringField(request, 'sessionId')))
        return { archived: true }
      }
      if (method === 'session/create') {
        const request = requestArg(args)
        const id = typeof request.sessionId === 'string'
          ? SessionId(request.sessionId)
          : SessionId(`session-${randomUUID()}`)
        const workspace = typeof request.workspaceId === 'string'
          ? ctx.get('workspaceRegistry')?.get(request.workspaceId as never)
          : undefined
        const cwd = workspace?.path
          ?? (typeof request.cwd === 'string' ? request.cwd : config.cwd)
        try {
          await ctx.agents.create({
            sessionId: id,
            meta: { cwd },
            agentOptions: { provider: 'p', model: 'm' },
          })
        } catch (error: unknown) {
          if (!(error instanceof Error) || !error.message.includes('no agent factory registered')) throw error
          ctx.sessions.create(id, { meta: { cwd } })
        }
        await workspace?.attachSession(id)
        return { sessionId: id }
      }
      if (method === 'session/list') {
        if (Reflect.ownKeys(args).length !== 1 || !Object.hasOwn(args, '_request')) {
          throw new Error('session/list expects exactly the _request argument')
        }
        record(args._request)
        return {
          items: ctx.sessions.list().map((session) => {
            const events = session.snapshotEvents()
            return {
              sessionId: session.id,
              updatedAt: events.at(-1)?.time ?? session.header.createdAt,
              running: ctx.agents.get(session.id) !== undefined,
              blank: events.length === 0,
              ...(session.header.cwd === undefined ? {} : { cwd: session.header.cwd }),
            }
          }),
        }
      }
      if (method === 'session/prompt') {
        const request = requestArg(args)
        const agent = ctx.agents.get(SessionId(stringField(request, 'sessionId')))
        if (agent === undefined) throw new Error('session has no live agent')
        agent.followup(createUserMessage({
          content: request.content as never,
          source: { kind: 'user', rpcId: stringField(request, 'requestId') },
        }))
        return { accepted: true }
      }
      if (method === 'session/cancel') {
        ctx.agents.get(SessionId(stringField(requestArg(args), 'sessionId')))?.cancel()
        return { accepted: true }
      }
      if (method === 'settings/describe') return { namespaces: [] }
      if (method === 'credentials/describe') return {}
      if (method === 'llm/discoverModels') return []
      throw new Error(`unsupported current API fixture endpoint ${method}`)
    }

    ctx.provide('connection', {
      createSharedFetchHandler: () => ({
        fetch: async (request: Request) => {
          const body = await request.json() as ClientRequest
          try {
            const value = await invoke(body.method, body.payload.args)
            return Response.json({
              type: 'server-response',
              rpcId: body.rpcId,
              result: { ok: true, value },
            })
          } catch (error: unknown) {
            return Response.json({
              type: 'server-response',
              rpcId: body.rpcId,
              result: {
                ok: false,
                error: { code: 'fixture', message: error instanceof Error ? error.message : String(error) },
              },
            })
          }
        },
      }),
    } as never)

    ctx.provide('typertGateway', {
      wireStream: {
        open: async (endpoint: string, payload: unknown, signal: AbortSignal) => {
          async function* stream(): AsyncGenerator<unknown> {
            if (endpoint === '$events') {
              yield { type: 'ready', clientId }
              yield* eventQueue.iterate(signal)
              return
            }
            const args = record(record(payload).args)
            if (endpoint === 'session/follow') {
              const request = requestArg(args)
              const address = record(request.address)
              const session = ctx.sessions.get(SessionId(stringField(address, 'sessionId')))
              if (session === undefined) throw new Error('session not found')
              yield {
                type: 'snapshot',
                records: session.snapshotEvents().map(event => ({ event })),
                hasMore: false,
              }
              return
            }
            if (endpoint === 'workspace/follow') {
              const registry = ctx.get('workspaceRegistry')
              yield {
                type: 'baseline',
                value: {
                  workspaces: registry?.list().map(workspaceView) ?? [],
                  archivedSessionIds: registry?.archivedSessionIds ?? [],
                },
              }
              return
            }
            throw new Error(`unsupported current API fixture stream ${endpoint}`)
          }
          return stream()
        },
      },
    } as never)
  },
}

function workspaceView(workspace: { id: string; path: string; title: string; sessionIds: readonly string[] }): object {
  return {
    workspaceId: workspace.id,
    path: workspace.path,
    title: workspace.title,
    sessionIds: workspace.sessionIds,
  }
}

function requestArg(args: Record<string, unknown>): Record<string, unknown> {
  return record(args.request)
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('expected object')
  }
  return value as Record<string, unknown>
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key]
  if (typeof field !== 'string' || field === '') throw new Error(`${key} must be a non-empty string`)
  return field
}
