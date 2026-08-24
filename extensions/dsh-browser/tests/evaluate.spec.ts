// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  chromeEvaluateDeps,
  evaluateOnTab,
  EvaluateError,
  MAX_EVALUATE_RESULT_CHARS,
  type EvaluateDeps,
} from '../src/background/evaluate.ts'

/** A scripted debugger: records the conversation, answers with queued replies. */
function fakeDeps(responses: Record<string, unknown> = {}): EvaluateDeps & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    attach: async (target, version) => { calls.push(`attach ${JSON.stringify(target)} ${version}`) },
    detach: async () => { calls.push('detach') },
    send: async (_target, method, params) => {
      calls.push(`send ${method} ${JSON.stringify(params)}`)
      if (!(method in responses)) throw new Error(`no scripted reply for ${method}`)
      return responses[method]
    },
  }
}

describe('evaluateOnTab', () => {
  it('attaches once, evaluates in the page context, and always detaches', async () => {
    const deps = fakeDeps({
      'Runtime.evaluate': { result: { type: 'object', value: { videoWidth: 1280 } } },
    })
    const value = await evaluateOnTab(7, 'document.querySelector("video").videoWidth', deps)

    expect(JSON.parse(value)).toEqual({ videoWidth: 1280 })
    expect(deps.calls[0]).toContain('"tabId":7')
    expect(deps.calls.at(-1)).toBe('detach')
    const sent = JSON.parse(deps.calls[1]!.slice('send Runtime.evaluate '.length))
    expect(sent.expression).toContain('querySelector')
    // awaitPromise + returnByValue are what make async expressions usable.
    expect(sent.awaitPromise).toBe(true)
    expect(sent.returnByValue).toBe(true)
  })

  it('returns the literal undefined for an expression without a value', async () => {
    const deps = fakeDeps({ 'Runtime.evaluate': { result: { type: 'undefined' } } })
    await expect(evaluateOnTab(1, 'void 0', deps)).resolves.toBe('undefined')
  })

  it('reports a page exception as its description, not as a crash', async () => {
    const deps = fakeDeps({
      'Runtime.evaluate': {
        exceptionDetails: { text: 'Uncaught', exception: { description: 'TypeError: x is not a function' } },
      },
    })
    await expect(evaluateOnTab(1, 'x()', deps)).rejects.toThrow(EvaluateError)
    await expect(evaluateOnTab(1, 'x()', deps)).rejects.toThrow(/x is not a function/)
    // The failure must still release the debugger.
    expect(deps.calls).toContain('detach')
  })

  it('caps an oversized result and says so', async () => {
    const huge = { blob: 'x'.repeat(MAX_EVALUATE_RESULT_CHARS + 100) }
    const deps = fakeDeps({ 'Runtime.evaluate': { result: { type: 'object', value: huge } } })
    const value = await evaluateOnTab(1, '"huge"', deps)
    expect(value.length).toBeLessThan(MAX_EVALUATE_RESULT_CHARS + 200)
    expect(value).toContain('truncated')
  })

  it('translates an attach conflict into actionable advice', async () => {
    const deps = fakeDeps()
    deps.attach = async () => { throw new Error('Another debugger is already attached') }
    await expect(evaluateOnTab(1, '1', deps)).rejects.toThrow(/DevTools may be open/)
  })

  it('detaches even when the send itself throws', async () => {
    const deps = fakeDeps() // no scripted reply -> send throws
    await expect(evaluateOnTab(1, '1', deps)).rejects.toThrow(EvaluateError)
    expect(deps.calls.at(-1)).toBe('detach')
  })

  it('tolerates a detach on a tab that closed mid-evaluation', async () => {
    const deps = fakeDeps({
      'Runtime.evaluate': { result: { type: 'number', value: 42 } },
    })
    deps.detach = async () => { throw new Error('tab closed') }
    await expect(evaluateOnTab(3, 'answer = 42', deps)).resolves.toBe('42')
  })

  it('the live deps bind to real chrome seams', () => {
    const deps = chromeEvaluateDeps()
    expect(deps.send).toBeTypeOf('function')
    expect(deps.attach).toBeTypeOf('function')
    expect(deps.detach).toBeTypeOf('function')
  })
})
