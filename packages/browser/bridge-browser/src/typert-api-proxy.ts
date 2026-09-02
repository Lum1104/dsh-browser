// @ts-nocheck
/**
 * ApiProxy-shaped adapter over TypertGateway for Desktop alpha hosts.
 * @module @yuxianglin/dsh-bridge-browser/src/typert-api-proxy
 */

import type { Context } from '@deepseek-ai/cordis'
import type {
  ApiProxy,
  MuxFrame,
  RpcRequest,
  RpcResponse,
} from '@deepseek-ai/dsh-host-apiproxy/api'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api'
import { clientRequestSchema, clientResponseSchema } from '@deepseek-ai/dsh-host-apiproxy/api/rpc.schema'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TypertGatewayLike } from './gateway-types.ts'
import { ExtensionSessionRegistry } from './extension-sessions.ts'
import { createTypertEventsMux } from './typert-events-mux.ts'

const INVALID_REQUEST_RPC_ID = RpcId('invalid-request')

/** Split `session.create` into Typert namespace and method. */
export function dotMethodToTypert(method: string): { namespace: string; method: string } {
  const dot = method.indexOf('.')
  if (dot <= 0 || dot === method.length - 1) {
    throw new Error(`bridge-browser: invalid gateway method ${JSON.stringify(method)}`)
  }
  return { namespace: method.slice(0, dot), method: method.slice(dot + 1) }
}

function ok<T>(request: RpcRequest<unknown>, value: T): RpcResponse<T> {
  return { rpcId: request.rpcId, result: { ok: true, value } }
}

function err(request: RpcRequest<unknown>, error: { code: string; message: string; details?: object }): RpcResponse<never> {
  return {
    rpcId: request.rpcId,
    result: {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        details: error.details ?? {},
      } as RpcResponse<never>['result'] extends { ok: false; error: infer E } ? E : never,
    },
  }
}

function rpcFailure(request: RpcRequest<unknown>, error: unknown): RpcResponse<never> {
  if (typeof error === 'object' && error !== null) {
    const record = error as { code?: unknown; message?: unknown; details?: unknown }
    if (typeof record.code === 'string' && typeof record.message === 'string') {
      return err(request, {
        code: record.code,
        message: record.message,
        ...(typeof record.details === 'object' && record.details !== null ? { details: record.details as object } : {}),
      })
    }
  }
  return err(request, { code: 'internal', message: error instanceof Error ? error.message : String(error) })
}

/** Map ApiProxy payload objects to Typert wire argument names. */
function typertArgs(namespace: string, method: string, payload: Record<string, unknown>): Record<string, unknown> {
  if ((namespace === 'session' || namespace === 'workspace') && method === 'list') {
    return { _request: payload }
  }
  return { request: payload }
}

async function invokeUnary(
  gateway: TypertGatewayLike,
  request: RpcRequest<Record<string, unknown>>,
  namespace: string,
  method: string,
  payload: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<RpcResponse<unknown>> {
  try {
    const value = await gateway.invoke({
      namespace,
      method,
      args: typertArgs(namespace, method, payload),
      ...(signal === undefined ? {} : { signal }),
    })
    return ok(request, value)
  } catch (error: unknown) {
    return rpcFailure(request, error)
  }
}

function sessionAddress(sessionId: SessionId): { kind: 'session'; sessionId: SessionId } {
  return { kind: 'session', sessionId }
}

function adaptHistoryPage(value: unknown): { events: Array<{ event: unknown }>; hasMore: boolean; projections?: unknown } {
  if (typeof value !== 'object' || value === null) {
    return { events: [], hasMore: false }
  }
  const page = value as { records?: unknown; hasMore?: unknown; projections?: unknown }
  const events: Array<{ event: unknown }> = []
  if (Array.isArray(page.records)) {
    for (const record of page.records) {
      if (typeof record === 'object' && record !== null && (record as { type?: unknown }).type === 'event') {
        events.push({ event: (record as { event: unknown }).event })
      }
    }
  }
  return {
    events,
    hasMore: page.hasMore === true,
    ...(page.projections === undefined ? {} : { projections: page.projections }),
  }
}

function noteSessionId(extensionSessions: ExtensionSessionRegistry, value: unknown): void {
  if (typeof value === 'string') {
    extensionSessions.note(value)
    return
  }
  if (typeof value !== 'object' || value === null) return
  const record = value as { sessionId?: unknown }
  if (typeof record.sessionId === 'string') extensionSessions.note(record.sessionId)
}

/**
 * Build an ApiProxy-compatible face backed by Typert RPC plus a bridge-local mux.
 */
export function createTypertApiProxy(
  ctx: Context,
  gateway: TypertGatewayLike,
  connection: { hasConnection(): boolean },
): ApiProxy {
  const extensionSessions = new ExtensionSessionRegistry()
  const mux = createTypertEventsMux(ctx, connection, extensionSessions)

  const call = (
    namespace: string,
    method: string,
    request: RpcRequest<Record<string, unknown>>,
    adaptArgs?: (payload: Record<string, unknown>) => Record<string, unknown>,
    adaptResult?: (value: unknown) => unknown,
    signal?: AbortSignal,
  ): Promise<RpcResponse<unknown>> => invokeUnary(
    gateway,
    request,
    namespace,
    method,
    adaptArgs === undefined ? request.payload : adaptArgs(request.payload),
    signal,
  ).then((response) => {
    if (!response.result.ok || adaptResult === undefined) return response
    return ok(request, adaptResult(response.result.value))
  })

  const trackSessionCall = async (
    namespace: string,
    method: string,
    request: RpcRequest<Record<string, unknown>>,
    adaptArgs?: (payload: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<RpcResponse<unknown>> => {
    const response = await call(namespace, method, request, adaptArgs)
    // Only claim ownership after a successful create/prompt. A failed prompt
    // against a Desktop session must not steal later ask_user_question away
    // from the native waterfall.
    if (response.result.ok) {
      noteSessionId(extensionSessions, request.payload.sessionId)
      noteSessionId(extensionSessions, response.result.value)
    }
    return response
  }

  const api: Record<string, unknown> = {
    sessions: {
      create: (request: RpcRequest<Record<string, unknown>>) => trackSessionCall('session', 'create', request),
      list: (request: RpcRequest<Record<string, unknown>>) => call('session', 'list', request as RpcRequest<Record<string, unknown>>),
      history: (request: RpcRequest<Record<string, unknown>>) => {
        const payload = request.payload
        const throughSeq = payload.beforeSeq ?? Number.MAX_SAFE_INTEGER
        return call(
          'session',
          'page',
          request as RpcRequest<Record<string, unknown>>,
          () => ({
            address: sessionAddress(payload.sessionId),
            throughSeq,
            ...(payload.beforeSeq === undefined ? {} : { beforeSeq: payload.beforeSeq }),
            ...(payload.maxMessages === undefined ? {} : { maxMessages: payload.maxMessages }),
          }),
          adaptHistoryPage,
        )
      },
      prompt: (request: RpcRequest<Record<string, unknown>>) => trackSessionCall(
        'session',
        'prompt',
        request as RpcRequest<Record<string, unknown>>,
        (payload) => ({ ...payload, requestId: String(request.rpcId) }),
      ),
      cancel: (request: RpcRequest<Record<string, unknown>>) => call('session', 'cancel', request as RpcRequest<Record<string, unknown>>),
      attachment: (request: RpcRequest<Record<string, unknown>>) => call('session', 'attachment', request as RpcRequest<Record<string, unknown>>),
      selectModel: (request: RpcRequest<Record<string, unknown>>) => call('session', 'selectModel', request as RpcRequest<Record<string, unknown>>),
      rename: (request: RpcRequest<Record<string, unknown>>) => call('session', 'rename', request as RpcRequest<Record<string, unknown>>),
      models: (request: RpcRequest<Record<string, unknown>>) => call('session', 'modelCatalog', request as RpcRequest<Record<string, unknown>>),
      fork: (request: RpcRequest<Record<string, unknown>>) => call('session', 'fork', request as RpcRequest<Record<string, unknown>>),
      search: (request: RpcRequest<Record<string, unknown>>) => call('session', 'search', request as RpcRequest<Record<string, unknown>>),
      updateQueue: (request: RpcRequest<Record<string, unknown>>) => call('session', 'updateQueue', request as RpcRequest<Record<string, unknown>>),
    },
    workspace: {
      create: (request: RpcRequest<Record<string, unknown>>) => call('workspace', 'create', request as RpcRequest<Record<string, unknown>>),
      list: (request: RpcRequest<Record<string, unknown>>) => call('workspace', 'list', request as RpcRequest<Record<string, unknown>>),
      archiveSession: (request: RpcRequest<Record<string, unknown>>) => call('workspace', 'archiveSession', request as RpcRequest<Record<string, unknown>>),
      delete: (request: RpcRequest<Record<string, unknown>>) => call('workspace', 'delete', request as RpcRequest<Record<string, unknown>>),
      rename: (request: RpcRequest<Record<string, unknown>>) => call('workspace', 'rename', request as RpcRequest<Record<string, unknown>>),
      insertBefore: (request: RpcRequest<Record<string, unknown>>) => call('workspace', 'insertBefore', request as RpcRequest<Record<string, unknown>>),
      insertSessionBefore: (request: RpcRequest<Record<string, unknown>>) => call('workspace', 'insertSessionBefore', request as RpcRequest<Record<string, unknown>>),
      follow: (request, signal) => call('workspace', 'follow', request as RpcRequest<Record<string, unknown>>, undefined, undefined, signal),
    },
    settings: {
      describe: (request: RpcRequest<Record<string, unknown>>) => call('settings', 'describe', request as RpcRequest<Record<string, unknown>>),
      mutate: (request: RpcRequest<Record<string, unknown>>) => call('settings', 'mutate', request as RpcRequest<Record<string, unknown>>),
      update: (request: RpcRequest<Record<string, unknown>>) => call('settings', 'update', request as RpcRequest<Record<string, unknown>>),
      replace: (request: RpcRequest<Record<string, unknown>>) => call('settings', 'replace', request as RpcRequest<Record<string, unknown>>),
      openDocument: (request: RpcRequest<Record<string, unknown>>) => call('settings', 'openDocument', request as RpcRequest<Record<string, unknown>>),
    },
    credentials: {
      describe: (request: RpcRequest<Record<string, unknown>>) => call('credentials', 'describe', request as RpcRequest<Record<string, unknown>>),
      set: (request: RpcRequest<Record<string, unknown>>) => call('credentials', 'set', request as RpcRequest<Record<string, unknown>>),
      unset: (request: RpcRequest<Record<string, unknown>>) => call('credentials', 'unset', request as RpcRequest<Record<string, unknown>>),
    },
    llm: {
      discoverModels: (request, signal) => call('llm', 'discoverModels', request as RpcRequest<Record<string, unknown>>, undefined, undefined, signal),
      models: (request, signal) => call('llm', 'models', request as RpcRequest<Record<string, unknown>>, undefined, undefined, signal),
      providers: (request, signal) => call('llm', 'providers', request as RpcRequest<Record<string, unknown>>, undefined, undefined, signal),
    },
    host: {
      describe: async (request: RpcRequest<Record<string, unknown>>) => err(request, { code: 'not-found', message: 'host.describe is unavailable on Typert hosts' }),
      pickDirectory: (request: RpcRequest<Record<string, unknown>>) => call('directoryPicker', 'pick', request as RpcRequest<Record<string, unknown>>),
      listDirectory: (request: RpcRequest<Record<string, unknown>>) => call('directoryPicker', 'list', request as RpcRequest<Record<string, unknown>>),
      createDirectory: (request: RpcRequest<Record<string, unknown>>) => call('directoryPicker', 'createDirectory', request as RpcRequest<Record<string, unknown>>),
      openPath: async (request: RpcRequest<Record<string, unknown>>) => err(request, { code: 'not-found', message: 'host.openPath is unavailable on Typert hosts' }),
    },
    skills: {
      list: (request: RpcRequest<Record<string, unknown>>) => call('skills', 'list', request as RpcRequest<Record<string, unknown>>),
    },
    agentPresets: {
      list: async (request: RpcRequest<Record<string, unknown>>) => err(request, { code: 'not-found', message: 'agentPreset.list is unavailable on Typert hosts' }),
      select: async (request: RpcRequest<Record<string, unknown>>) => err(request, { code: 'not-found', message: 'agentPreset.select is unavailable on Typert hosts' }),
      read: async (request: RpcRequest<Record<string, unknown>>) => err(request, { code: 'not-found', message: 'agentPreset.read is unavailable on Typert hosts' }),
      copy: async (request: RpcRequest<Record<string, unknown>>) => err(request, { code: 'not-found', message: 'agentPreset.copy is unavailable on Typert hosts' }),
      remove: async (request: RpcRequest<Record<string, unknown>>) => err(request, { code: 'not-found', message: 'agentPreset.remove is unavailable on Typert hosts' }),
      openDocument: async (request: RpcRequest<Record<string, unknown>>) => err(request, { code: 'not-found', message: 'agentPreset.openDocument is unavailable on Typert hosts' }),
    },
    subagents: {
      list: async (request: RpcRequest<Record<string, unknown>>) => err(request, { code: 'not-found', message: 'subagent.list is unavailable on Typert hosts' }),
      prompt: async (request: RpcRequest<Record<string, unknown>>) => err(request, { code: 'not-found', message: 'subagent.prompt is unavailable on Typert hosts' }),
      interrupt: async (request: RpcRequest<Record<string, unknown>>) => err(request, { code: 'not-found', message: 'subagent.interrupt is unavailable on Typert hosts' }),
      history: async (request: RpcRequest<Record<string, unknown>>) => err(request, { code: 'not-found', message: 'subagent.history is unavailable on Typert hosts' }),
    },
    goals: {
      create: async (request: RpcRequest<Record<string, unknown>>) => err(request, { code: 'not-found', message: 'goal.create is unavailable on Typert hosts' }),
      edit: async (request: RpcRequest<Record<string, unknown>>) => err(request, { code: 'not-found', message: 'goal.edit is unavailable on Typert hosts' }),
      pause: async (request: RpcRequest<Record<string, unknown>>) => err(request, { code: 'not-found', message: 'goal.pause is unavailable on Typert hosts' }),
      resume: async (request: RpcRequest<Record<string, unknown>>) => err(request, { code: 'not-found', message: 'goal.resume is unavailable on Typert hosts' }),
      complete: async (request: RpcRequest<Record<string, unknown>>) => err(request, { code: 'not-found', message: 'goal.complete is unavailable on Typert hosts' }),
      clear: async (request: RpcRequest<Record<string, unknown>>) => err(request, { code: 'not-found', message: 'goal.clear is unavailable on Typert hosts' }),
    },
    downloads: {
      sessionLog: async () => new Response('not available', { status: 404 }),
    },
    events: {
      mux: (_request, signal) => mux.openEvents(signal),
      host: (_request, signal) => emptyMux(signal),
    },
    respond: async (message) => {
      const parsed = clientResponseSchema.safeParse(message)
      if (!parsed.success) {
        return { rpcId: message.rpcId, accepted: false as const }
      }
      const questionRpcId = String(parsed.data.rpcId)
      const payload = parsed.data.result
      if (!payload.ok) {
        if (mux.cancelQuestion(questionRpcId)) {
          return { rpcId: message.rpcId, accepted: true as const }
        }
        return { rpcId: message.rpcId, accepted: false as const }
      }
      if (typeof payload.value === 'object' && payload.value !== null) {
        const value = payload.value as {
          type?: unknown
          answer?: unknown
          questionRpcId?: unknown
          sessionId?: unknown
        }
        // Extension respond shape: { sessionId, answer }; legacy: { type:'question', questionRpcId, answer }.
        const legacyId = typeof value.questionRpcId === 'string' ? value.questionRpcId : undefined
        const answer = value.answer ?? (value.type === 'question' ? undefined : value)
        if (mux.answerQuestion(legacyId ?? questionRpcId, answer)) {
          return { rpcId: message.rpcId, accepted: true as const }
        }
      }
      return { rpcId: message.rpcId, accepted: false as const }
    },
  }

  return api as unknown as ApiProxy
}

async function* emptyMux(signal: AbortSignal): AsyncIterable<RpcRequest<MuxFrame>> {
  await new Promise<void>((resolve) => {
    signal.addEventListener('abort', () => { resolve() }, { once: true })
  })
}

/** Fetch-shaped carrier translating dot-notation bridge RPCs to Typert endpoints. */
export function createTypertFetchHandler(api: ApiProxy): { fetch: (request: Request) => Promise<Response> } {
  return {
    async fetch(request: Request) {
      const url = new URL(request.url)
      const path = url.pathname
      if (request.method !== 'POST' || !path.startsWith('/api/')) {
        return new Response('not found', { status: 404 })
      }
      const endpoint = path.slice('/api/'.length)
      const wireMethod = endpoint
      const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
      if (mediaType !== 'application/json') {
        return new Response('content type must be application/json', { status: 415 })
      }
      let body: unknown
      try {
        body = await request.json()
      } catch {
        return new Response('body is not JSON', { status: 400 })
      }
      if (path === '/api/respond') {
        const parsed = clientResponseSchema.safeParse(body)
        if (!parsed.success) {
          return Response.json({
            type: 'server-response',
            rpcId: INVALID_REQUEST_RPC_ID,
            result: { ok: false, error: { code: 'bad-request', message: 'invalid client-response message', details: {} } },
          })
        }
        const receipt = await api.respond(parsed.data)
        return Response.json({
          type: 'server-response',
          rpcId: parsed.data.rpcId,
          result: { ok: true, value: receipt },
        })
      }
      const envelope = clientRequestSchema.safeParse(body)
      if (!envelope.success) {
        const rawId = (body as { rpcId?: unknown } | undefined)?.rpcId
        return Response.json({
          type: 'server-response',
          rpcId: typeof rawId === 'string' ? RpcId(rawId) : INVALID_REQUEST_RPC_ID,
          result: { ok: false, error: { code: 'bad-request', message: 'invalid client-request message', details: {} } },
        })
      }
      const message = envelope.data
      if (message.method !== wireMethod) {
        return Response.json({
          type: 'server-response',
          rpcId: message.rpcId,
          result: {
            ok: false,
            error: {
              code: 'bad-request',
              message: `method ${JSON.stringify(message.method)} does not match endpoint ${JSON.stringify(wireMethod)}`,
              details: {},
            },
          },
        })
      }
      const handler = resolveMethod(api, message.method)
      if (handler === undefined) {
        return Response.json({
          type: 'server-response',
          rpcId: message.rpcId,
          result: { ok: false, error: { code: 'not-found', message: `unknown method ${JSON.stringify(message.method)}`, details: {} } },
        })
      }
      try {
        const result = await handler({ rpcId: message.rpcId, payload: message.payload }, request.signal)
        return Response.json({ type: 'server-response', rpcId: message.rpcId, result: result.result })
      } catch (error: unknown) {
        return new Response(`handler failure: ${String(error)}`, { status: 500 })
      }
    },
  }
}

type DomainHandler = (request: RpcRequest<Record<string, unknown>>, signal?: AbortSignal) => Promise<RpcResponse<unknown>>

function resolveMethod(api: ApiProxy, method: string): DomainHandler | undefined {
  const { namespace, method: action } = dotMethodToTypert(method)
  const domainKey = namespace === 'session' ? 'sessions' : namespace
  const domain = (api as Record<string, unknown>)[domainKey]
  if (typeof domain !== 'object' || domain === null) return undefined
  const implementation = (domain as Record<string, unknown>)[action]
  if (typeof implementation !== 'function') return undefined
  return implementation.bind(domain) as DomainHandler
}
