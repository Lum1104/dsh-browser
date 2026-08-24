/**
 * Model-authored page evaluation via the Chrome DevTools Protocol.
 *
 * The content script runs in the ISOLATED world and MV3 forbids `eval`
 * everywhere in extension contexts, so neither can run arbitrary code against
 * the page's own globals. The debugger is the one sanctioned path:
 * `Runtime.evaluate` executes in the MAIN world, where the page's variables,
 * players, and signed-URL logic actually live — the things a snapshot's DOM
 * view cannot reach.
 *
 * The capability is held as briefly as a trusted click: the debugger attaches
 * for one evaluation and detaches immediately, and it shares the same optional
 * permission (and DevTools-conflict behavior) as `trusted-input`.
 *
 * @module
 */

/** Chrome seams, injected so the protocol conversation is testable. */
export interface EvaluateDeps {
  attach(target: chrome.debugger.Debuggee, version: string): Promise<void>
  detach(target: chrome.debugger.Debuggee): Promise<void>
  send(target: chrome.debugger.Debuggee, method: string, params?: object): Promise<unknown>
}

/** A refusal the model should read and act on. */
export class EvaluateError extends Error {
  constructor(
    readonly code: 'attach-failed' | 'evaluate-failed',
    message: string,
  ) {
    super(message)
    this.name = 'EvaluateError'
  }
}

/** The protocol version this module speaks (shared with trusted-input). */
const PROTOCOL_VERSION = '1.3'

/** Longest serialized result returned to the model; beyond this it must re-query narrowly. */
export const MAX_EVALUATE_RESULT_CHARS = 24_000

interface RemoteObject {
  type?: string
  value?: unknown
  description?: string
}

interface EvaluateResponse {
  result?: RemoteObject
  exceptionDetails?: {
    text?: string
    exception?: { description?: string; value?: unknown }
  }
}

/**
 * Run model-authored JavaScript in the page's MAIN world and return its value.
 *
 * @param tabId - the tab to evaluate in.
 * @param expression - the code to run; the value of its last expression is the answer. Async code works: the returned promise is awaited before reporting.
 * @param deps - Chrome seams.
 * @returns the serialized result text ('undefined' when the expression has no value), capped at {@link MAX_EVALUATE_RESULT_CHARS}.
 * @throws EvaluateError when attaching or the evaluation itself fails.
 */
export async function evaluateOnTab(tabId: number, expression: string, deps: EvaluateDeps): Promise<string> {
  const target: chrome.debugger.Debuggee = { tabId }
  try {
    await deps.attach(target, PROTOCOL_VERSION)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    throw new EvaluateError(
      'attach-failed',
      /already attached|another debugger/i.test(message)
        ? 'The browser debugger is already attached to this tab (DevTools may be open). Close DevTools and try again.'
        : `The browser debugger could not attach to this tab: ${message}`,
    )
  }
  try {
    // userGesture lets the code do what a user-initiated script could (play
    // media, trigger downloads); returnByValue keeps the answer JSON-shaped;
    // awaitPromise makes async expressions usable without ceremony.
    const response = await deps.send(target, 'Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    }) as EvaluateResponse
    if (response.exceptionDetails !== undefined) {
      const detail = response.exceptionDetails.exception?.description
        ?? response.exceptionDetails.exception?.value
        ?? response.exceptionDetails.text
        ?? 'unknown error'
      throw new EvaluateError('evaluate-failed', `The page threw an error: ${detail}`)
    }
    const remote = response.result ?? {}
    if (remote.type === 'undefined') return 'undefined'
    const serialized = JSON.stringify(remote.value) ?? String(remote.description ?? '')
    if (serialized.length > MAX_EVALUATE_RESULT_CHARS) {
      return `${serialized.slice(0, MAX_EVALUATE_RESULT_CHARS)}…\n(result truncated at ${MAX_EVALUATE_RESULT_CHARS} characters; re-run with a narrower query)`
    }
    return serialized
  } catch (error: unknown) {
    if (error instanceof EvaluateError) throw error
    throw new EvaluateError('evaluate-failed', `The evaluation could not be delivered: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    // Detach in every outcome, mirroring trusted-input: the banner must go away
    // and DevTools must not stay blocked on the tab.
    try {
      await deps.detach(target)
    } catch {
      // A tab that closed mid-evaluation has nothing left to detach from.
    }
  }
}

/** The live Chrome implementation of the seams above. */
export function chromeEvaluateDeps(): EvaluateDeps {
  return {
    attach: (target, version) => chrome.debugger.attach(target, version),
    detach: (target) => chrome.debugger.detach(target),
    send: (target, method, params) => chrome.debugger.sendCommand(target, method, params),
  }
}
