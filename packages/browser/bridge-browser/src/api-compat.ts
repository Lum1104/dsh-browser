/** Compatibility adapter from the extension's dotted RPC surface to current Typert Remote. */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { LegacyEventEnvelope, LegacyRpc } from './legacy-rpc.ts'
import { LegacyRpcError } from './legacy-rpc.ts'

const REMOTE_EVENTS_ENDPOINT = '$events'
const REMOTE_EVENT_RESULT_ENDPOINT = '$events/result'
const ALL_HISTORY_MESSAGES = Number.MAX_SAFE_INTEGER

interface CurrentServerResponse {
  readonly type: 'server-response'
  readonly rpcId: string
  readonly result:
    | { readonly ok: true; readonly value?: unknown }
    | { readonly ok: false; readonly error: { readonly code: string; readonly message: string; readonly details?: unknown } }
}

interface RemoteReadyFrame {
  readonly type: 'ready'
  readonly clientId: string
}

interface RemoteWaterfallFrame {
  readonly type: 'waterfall'
  readonly event: string
  readonly eventId: string
  readonly agentId: string
  readonly request: Readonly<Record<string, unknown>>
}

interface RemoteCancelFrame {
  readonly type: 'cancel'
  readonly eventId: string
}

type RemoteEventFrame = RemoteReadyFrame | RemoteWaterfallFrame | RemoteCancelFrame | {
  readonly type: 'emit'
  readonly event: string
  readonly args: readonly unknown[]
}

interface PendingQuestion {
  readonly clientId: string
  readonly eventId: string
  readonly sessionId: string
}

/** Current Host surfaces exposed to the bridge server. */
export interface ApiCompatibility {
  readonly rpc: LegacyRpc
  readonly fetchHandler: { fetch(request: Request): Promise<Response> }
  readonly openEvents: (signal: AbortSignal) => AsyncIterable<LegacyEventEnvelope>
}

/**
 * Build the extension compatibility surface over the current Connection and Typert Gateway.
 * @param ctx - bridge plugin Context.
 * @param wrap - session workspace/deferral wrappers applied to unary calls.
 * @returns fetch and event adapters consumed by {@link BridgeServer}.
 */
export function createApiCompatibility(
  ctx: Context,
  wrap: (rpc: LegacyRpc) => LegacyRpc,
): ApiCompatibility {
  const current = ctx.connection.createSharedFetchHandler('/api')
  const pendingQuestions = new Map<string, PendingQuestion>()

  const callCurrent = async (endpoint: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> => {
    const rpcId = randomUUID()
    const request = new Request(new URL(`/api/${endpoint}`, 'http://dsh.internal'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId,
        method: endpoint,
        payload: { args },
      }),
      ...(signal === undefined ? {} : { signal }),
    })
    const response = await current.fetch(request)
    const text = await response.text()
    if (!response.ok) throw new LegacyRpcError('http', text)
    let envelope: CurrentServerResponse
    try {
      envelope = JSON.parse(text) as CurrentServerResponse
    } catch (error: unknown) {
      throw new LegacyRpcError('invalid-response', 'current dsh API returned non-JSON', { cause: String(error) })
    }
    if (envelope.type !== 'server-response' || envelope.rpcId !== rpcId) {
      throw new LegacyRpcError('invalid-response', 'current dsh API returned a mismatched response envelope')
    }
    if (!envelope.result.ok) {
      throw new LegacyRpcError(
        envelope.result.error.code,
        envelope.result.error.message,
        envelope.result.error.details ?? {},
      )
    }
    return envelope.result.value
  }

  const openFirst = async (endpoint: string, args: Record<string, unknown>): Promise<unknown> => {
    const abort = new AbortController()
    const stream = await ctx.typertGateway.wireStream.open(endpoint, { args }, abort.signal)
    const iterator = stream[Symbol.asyncIterator]()
    try {
      const first = await iterator.next()
      if (first.done) throw new LegacyRpcError('stream-ended', `${endpoint} ended before its opening snapshot`)
      return first.value
    } finally {
      abort.abort()
      await iterator.return?.()
    }
  }

  const baseRpc: LegacyRpc = async (method, payload, signal) => {
    const request = record(payload, `${method} payload`)
    if (method === 'session.history') {
      const sessionId = nonEmptyString(request.sessionId, 'session.history sessionId')
      const opening = record(await openFirst('session/follow', {
        request: {
          address: { kind: 'session', sessionId },
          maxMessages: ALL_HISTORY_MESSAGES,
        },
      }), 'session.follow opening frame')
      if (opening.type !== 'snapshot' || !Array.isArray(opening.records)) {
        throw new LegacyRpcError('invalid-response', 'session.follow did not open with a snapshot')
      }
      return {
        events: opening.records.map((entry) => {
          const value = record(entry, 'session history record')
          return { event: value.event }
        }),
        hasMore: opening.hasMore === true,
        projections: opening.projections,
      }
    }
    if (method === 'workspace.list') {
      const opening = record(await openFirst('workspace/follow', {}), 'workspace.follow opening frame')
      if (opening.type !== 'baseline') {
        throw new LegacyRpcError('invalid-response', 'workspace.follow did not open with a baseline')
      }
      return opening.value
    }
    if (method === 'credentials.describe') {
      const credentials = await callCurrent('credentials/describe', request, signal)
      return { credentials }
    }
    if (method === 'llm.discoverModels') {
      const settingsNs = nonEmptyString(request.settingsNs, 'llm.discoverModels settingsNs')
      const { settingsNs: _settingsNs, ...discoveryRequest } = request
      const models = await callCurrent('llm/discoverModels', {
        settingsNs,
        request: discoveryRequest,
      }, signal)
      return { models }
    }

    const endpoint = currentEndpoint(method)
    return callCurrent(endpoint, currentArgs(method, request), signal)
  }

  const rpc = wrap(baseRpc)

  const respond = async (rpcId: string, result: unknown): Promise<unknown> => {
    const pending = pendingQuestions.get(rpcId)
    if (pending === undefined) return { accepted: false, reason: 'not-pending' }
    const wire = record(result, 'interaction response')
    const outcome = wire.ok === true
      ? {
          kind: 'result',
          value: questionAnswer(wire.value),
        }
      : {
          kind: 'rejected',
          error: questionRejection(wire.error),
        }
    await callCurrent(REMOTE_EVENT_RESULT_ENDPOINT, {
      clientId: pending.clientId,
      eventId: pending.eventId,
      outcome,
    })
    pendingQuestions.delete(rpcId)
    return { accepted: true }
  }

  return {
    rpc,
    fetchHandler: legacyFetchHandler(rpc, respond),
    openEvents: signal => bridgeEvents(ctx, callCurrent, pendingQuestions, signal),
  }
}

function currentEndpoint(method: string): string {
  const index = method.indexOf('.')
  if (index <= 0 || index === method.length - 1 || method.indexOf('.', index + 1) !== -1) {
    throw new LegacyRpcError('bad-request', `unsupported legacy RPC method ${JSON.stringify(method)}`)
  }
  return `${method.slice(0, index)}/${method.slice(index + 1)}`
}

function currentArgs(method: string, payload: Record<string, unknown>): Record<string, unknown> {
  if (method === 'settings.describe') return {}
  if (method.startsWith('settings.') || method.startsWith('credentials.')) return payload
  if (method === 'session.list') return { _request: payload }
  if (method === 'session.prompt') {
    return { request: { ...payload, requestId: payload.requestId ?? randomUUID() } }
  }
  if (method.startsWith('session.') || method.startsWith('workspace.')) return { request: payload }
  throw new LegacyRpcError('bad-request', `unsupported legacy RPC method ${JSON.stringify(method)}`)
}

function legacyFetchHandler(
  rpc: LegacyRpc,
  respond: (rpcId: string, result: unknown) => Promise<unknown>,
): { fetch(request: Request): Promise<Response> } {
  return {
    async fetch(request) {
      if (request.method !== 'POST') return new Response('not found', { status: 404 })
      let body: Record<string, unknown>
      try {
        body = record(await request.json(), 'legacy request')
      } catch (error: unknown) {
        return new Response(error instanceof Error ? error.message : String(error), { status: 400 })
      }
      if (new URL(request.url).pathname === '/api/respond') {
        if (body.type !== 'client-response' || typeof body.rpcId !== 'string') {
          return new Response('invalid client-response envelope', { status: 400 })
        }
        try {
          return Response.json(await respond(body.rpcId, body.result))
        } catch (error: unknown) {
          return legacyFailureResponse(error)
        }
      }
      if (body.type !== 'client-request' || typeof body.rpcId !== 'string' || typeof body.method !== 'string') {
        return new Response('invalid client-request envelope', { status: 400 })
      }
      try {
        const value = await rpc(body.method, body.payload, request.signal)
        return Response.json({
          type: 'server-response',
          rpcId: body.rpcId,
          result: { ok: true, ...(value === undefined ? {} : { value }) },
        })
      } catch (error: unknown) {
        const failure = legacyFailure(error)
        return Response.json({ type: 'server-response', rpcId: body.rpcId, result: { ok: false, error: failure } })
      }
    },
  }
}

async function* bridgeEvents(
  ctx: Context,
  callCurrent: (endpoint: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>,
  pendingQuestions: Map<string, PendingQuestion>,
  signal: AbortSignal,
): AsyncGenerator<LegacyEventEnvelope> {
  const queue = new EventQueue()
  const generation = new AbortController()
  const combined = AbortSignal.any([signal, generation.signal])
  const disposeSession = ctx.on('session/event', (session, event: SessionEvent) => {
    queue.push({
      rpcId: randomUUID(),
      payload: { type: 'session/event', sessionId: session.id, event },
    })
  }, { global: true })
  const onAbort = (): void => { queue.end() }
  combined.addEventListener('abort', onAbort, { once: true })

  const remoteTask = consumeRemoteEvents(ctx, callCurrent, pendingQuestions, queue, combined)
    .then(() => {
      if (!combined.aborted) queue.fail(new Error('current dsh Remote event stream ended'))
    }, (error: unknown) => {
      if (!combined.aborted) queue.fail(error)
    })

  try {
    for await (const event of queue.iterate()) yield event
  } finally {
    generation.abort()
    combined.removeEventListener('abort', onAbort)
    disposeSession()
    await remoteTask
  }
}

async function consumeRemoteEvents(
  ctx: Context,
  callCurrent: (endpoint: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>,
  pendingQuestions: Map<string, PendingQuestion>,
  queue: EventQueue,
  signal: AbortSignal,
): Promise<void> {
  const stream = await ctx.typertGateway.wireStream.open(REMOTE_EVENTS_ENDPOINT, { args: {} }, signal)
  let clientId: string | undefined
  try {
    for await (const raw of stream) {
      const frame = raw as RemoteEventFrame
      if (frame.type === 'ready') {
        clientId = frame.clientId
        continue
      }
      if (frame.type === 'waterfall') {
        if (clientId === undefined) throw new Error('Remote event arrived before the ready frame')
        if (frame.event === 'user-questions/request') {
          pendingQuestions.set(frame.eventId, {
            clientId,
            eventId: frame.eventId,
            sessionId: frame.agentId,
          })
          queue.push({
            rpcId: frame.eventId,
            payload: {
              type: 'question/requested',
              sessionId: frame.agentId,
              ...frame.request,
            },
          })
        } else {
          await callCurrent(REMOTE_EVENT_RESULT_ENDPOINT, {
            clientId,
            eventId: frame.eventId,
            outcome: { kind: 'next' },
          }, signal)
        }
        continue
      }
      if (frame.type === 'cancel') {
        const pending = pendingQuestions.get(frame.eventId)
        if (pending === undefined || pending.clientId !== clientId) continue
        pendingQuestions.delete(frame.eventId)
        queue.push({
          rpcId: randomUUID(),
          payload: {
            type: 'question/resolved',
            sessionId: pending.sessionId,
            questionRpcId: pending.eventId,
          },
        })
      }
    }
  } finally {
    if (clientId !== undefined) {
      for (const [eventId, pending] of pendingQuestions) {
        if (pending.clientId === clientId) pendingQuestions.delete(eventId)
      }
    }
  }
}

class EventQueue {
  private readonly values: LegacyEventEnvelope[] = []
  private wake: (() => void) | undefined
  private done = false
  private error: unknown

  push(value: LegacyEventEnvelope): void {
    if (this.done) return
    this.values.push(value)
    this.wake?.()
  }

  end(): void {
    if (this.done) return
    this.done = true
    this.wake?.()
  }

  fail(error: unknown): void {
    this.error = error
    this.end()
  }

  async *iterate(): AsyncGenerator<LegacyEventEnvelope> {
    while (true) {
      while (this.values.length > 0) yield this.values.shift() as LegacyEventEnvelope
      if (this.done) {
        if (this.error !== undefined) throw this.error
        return
      }
      await new Promise<void>((resolve) => { this.wake = resolve })
      this.wake = undefined
    }
  }
}

function questionAnswer(value: unknown): unknown {
  const response = record(value, 'question answer')
  const answer = response.answer
  return answer === undefined ? response : answer
}

function questionRejection(value: unknown): Record<string, unknown> {
  const error = record(value, 'question rejection')
  return {
    name: 'UserQuestionError',
    message: typeof error.message === 'string' ? error.message : 'the user dismissed this question request',
    code: 'ASK_CANCELLED',
    details: recordOrEmpty(error.details),
  }
}

function legacyFailureResponse(error: unknown): Response {
  const failure = legacyFailure(error)
  return new Response(failure.message, { status: failure.code === 'http' ? 502 : 409 })
}

function legacyFailure(error: unknown): { code: string; message: string; details: unknown } {
  if (error instanceof LegacyRpcError) {
    return { code: error.code, message: error.message, details: error.details }
  }
  return {
    code: 'internal',
    message: error instanceof Error ? error.message : String(error),
    details: {},
  }
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new LegacyRpcError('bad-request', `${name} must be an object`)
  }
  return value as Record<string, unknown>
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function nonEmptyString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new LegacyRpcError('bad-request', `${name} must be a non-empty string`)
  }
  return value
}
