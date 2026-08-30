/**
 * In-process replacement for the old `api.events.mux(...)` firehose: adapts
 * the raw cordis session event bus into the `AsyncIterable` shape
 * `BridgeServer` already consumes per connection.
 * @module @yuxianglin/dsh-bridge-browser/src/session-events
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session'

/** One relayed session event, shaped like the wire `event` frame's `frame` field. */
export interface SessionEventEnvelope {
  rpcId: string
  method: string
  payload: unknown
}

/**
 * Open an async iterable of every session lifecycle/append event, unfiltered,
 * for the lifetime of `signal`.
 * @param ctx - cordis context carrying the `sessions` service.
 * @param signal - closes the iterable when aborted.
 * @returns an async iterable yielding one envelope per session event.
 */
export function openSessionEvents(ctx: Context, signal: AbortSignal): AsyncIterable<SessionEventEnvelope> {
  const queue: SessionEventEnvelope[] = []
  let wake: (() => void) | undefined

  const push = (envelope: SessionEventEnvelope): void => {
    queue.push(envelope)
    wake?.()
    wake = undefined
  }

  const offCreated = ctx.on('session/created', (session) => {
    push({ rpcId: randomUUID(), method: 'session/created', payload: { sessionId: session.id } })
  })
  const offDisposed = ctx.on('session/disposed', (session) => {
    push({ rpcId: randomUUID(), method: 'session/disposed', payload: { sessionId: session.id } })
  })
  const offEvent = ctx.on('session/event', (session, event) => {
    push({ rpcId: randomUUID(), method: event.type, payload: { sessionId: session.id, event } })
  })

  const stop = (): void => {
    offCreated()
    offDisposed()
    offEvent()
    wake?.()
    wake = undefined
  }
  signal.addEventListener('abort', stop, { once: true })

  return {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<SessionEventEnvelope>> {
          while (queue.length === 0) {
            if (signal.aborted) return { done: true, value: undefined }
            await new Promise<void>((resolve) => { wake = resolve })
          }
          return { done: false, value: queue.shift()! }
        },
      }
    },
  }
}
