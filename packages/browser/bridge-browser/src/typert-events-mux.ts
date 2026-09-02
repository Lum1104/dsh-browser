// @ts-nocheck
/**
 * Host-side event mux for Typert compositions: session events and pending
 * questions forwarded to the extension in ApiProxy MuxFrame shape.
 * @module @yuxianglin/dsh-bridge-browser/src/typert-events-mux
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'
import type { MuxFrame, RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { shouldBridgeOwnQuestion, type ExtensionSessionRegistry } from './extension-sessions.ts'

interface PendingQuestion {
  rpcId: ReturnType<typeof RpcId>
  sessionId: SessionId
  questions: AskUserQuestionItem[]
  resolve: (answers: unknown) => void
  reject: (error: unknown) => void
  signal?: AbortSignal
  onAbort?: () => void
}

/** Async queue consumed by one bridge connection's event pump. */
class FrameQueue {
  private buffer: RpcRequest<MuxFrame>[] = []
  private waiter: (() => void) | undefined
  private done = false

  push(frame: RpcRequest<MuxFrame>): void {
    if (this.done) return
    this.buffer.push(frame)
    this.waiter?.()
  }

  end(): void {
    this.done = true
    this.waiter?.()
  }

  async *iterate(signal: AbortSignal, cleanup: () => void): AsyncIterable<RpcRequest<MuxFrame>> {
    const abort = (): void => { this.end() }
    signal.addEventListener('abort', abort, { once: true })
    try {
      while (!this.done && !signal.aborted) {
        while (this.buffer.length > 0) {
          const next = this.buffer.shift()
          if (next !== undefined) yield next
        }
        await new Promise<void>((resolve) => { this.waiter = resolve })
        this.waiter = undefined
      }
    } finally {
      signal.removeEventListener('abort', abort)
      this.end()
      cleanup()
    }
  }
}

/**
 * Install a mux stream factory and optional userQuestions interception.
 *
 * Desktop-native sessions always keep the host waterfall so the Desktop UI can
 * render ask_user_question. Only sessions the extension has driven through the
 * bridge are answered over `/ext/bridge`.
 */
export function createTypertEventsMux(
  ctx: Context,
  connection: { hasConnection(): boolean },
  extensionSessions: ExtensionSessionRegistry,
): {
  openEvents: (signal: AbortSignal) => AsyncIterable<RpcRequest<MuxFrame>>
  answerQuestion: (questionRpcId: string, answers: unknown) => boolean
  cancelQuestion: (questionRpcId: string) => boolean
} {
  const muxQueues = new Set<FrameQueue>()
  const pendingQuestions = new Map<string, PendingQuestion>()

  function broadcast(payload: MuxFrame, rpcId?: ReturnType<typeof RpcId>): void {
    const envelope: RpcRequest<MuxFrame> = {
      rpcId: rpcId ?? RpcId(randomUUID()),
      payload,
    }
    for (const queue of muxQueues) queue.push(envelope)
  }

  function settleQuestion(pending: PendingQuestion, outcome: 'answered' | 'cancelled'): void {
    pendingQuestions.delete(String(pending.rpcId))
    if (pending.onAbort !== undefined && pending.signal !== undefined) {
      pending.signal.removeEventListener('abort', pending.onAbort)
    }
    broadcast({
      type: 'question/resolved',
      sessionId: pending.sessionId,
      questionRpcId: pending.rpcId,
      outcome,
    })
  }

  const disposers: Array<() => void> = [
    ctx.on('session/event', (session, event) => {
      broadcast({
        type: 'session/event',
        sessionId: session.id,
        event,
      })
    }),
  ]

  const userQuestions = ctx.get('userQuestions')
  if (userQuestions !== undefined) {
    const originalAsk = userQuestions.ask.bind(userQuestions) as typeof userQuestions.ask
    userQuestions.ask = async (request: Parameters<typeof originalAsk>[0]) => {
      const sessionId = request.agent?.id === undefined ? undefined : String(request.agent.id)
      if (!shouldBridgeOwnQuestion({
        hasExtensionConnection: connection.hasConnection(),
        sessionId,
        extensionSessions,
      })) {
        return originalAsk(request)
      }
      return new Promise((resolve, reject) => {
        const rpcId = RpcId(randomUUID())
        const pending: PendingQuestion = {
          rpcId,
          sessionId: sessionId as SessionId,
          questions: request.questions,
          resolve,
          reject,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        }
        const onAbort = (): void => {
          settleQuestion(pending, 'cancelled')
          reject(new Error('ask_user_question was aborted before the user answered'))
        }
        pending.onAbort = onAbort
        pendingQuestions.set(String(rpcId), pending)
        request.signal?.addEventListener('abort', onAbort, { once: true })
        broadcast({
          type: 'question/requested',
          sessionId: pending.sessionId,
          questions: request.questions,
        }, rpcId)
      })
    }
    disposers.push(() => { userQuestions.ask = originalAsk })
  }

  ctx.effect(() => () => {
    for (const dispose of disposers) dispose()
    for (const pending of pendingQuestions.values()) {
      settleQuestion(pending, 'cancelled')
      pending.reject(new Error('bridge-browser: host disposed while a question was pending'))
    }
  }, 'bridge-browser: typert event mux teardown')

  const finishQuestion = (
    questionRpcId: string,
    outcome: 'answered' | 'cancelled',
    settle: (pending: PendingQuestion) => void,
  ): boolean => {
    const pending = pendingQuestions.get(questionRpcId)
    if (pending === undefined) return false
    pendingQuestions.delete(questionRpcId)
    if (pending.onAbort !== undefined && pending.signal !== undefined) {
      pending.signal.removeEventListener('abort', pending.onAbort)
    }
    broadcast({
      type: 'question/resolved',
      sessionId: pending.sessionId,
      questionRpcId: pending.rpcId,
      outcome,
    })
    settle(pending)
    return true
  }

  return {
    openEvents: (signal) => {
      const queue = new FrameQueue()
      muxQueues.add(queue)
      for (const pending of pendingQuestions.values()) {
        queue.push({
          rpcId: pending.rpcId,
          payload: {
            type: 'question/requested',
            sessionId: pending.sessionId,
            questions: pending.questions,
          },
        })
      }
      return queue.iterate(signal, () => { muxQueues.delete(queue) })
    },
    answerQuestion: (questionRpcId, answers) => finishQuestion(
      questionRpcId,
      'answered',
      (pending) => { pending.resolve(answers) },
    ),
    cancelQuestion: (questionRpcId) => finishQuestion(
      questionRpcId,
      'cancelled',
      (pending) => {
        pending.reject(new Error('ask_user_question was aborted before the user answered'))
      },
    ),
  }
}
