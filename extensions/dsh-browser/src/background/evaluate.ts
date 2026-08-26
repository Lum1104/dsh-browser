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

import { wrapDerivedReport } from '../security/untrusted.ts'

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

/** The one chrome.scripting seam the fallback needs, injected for testability. */
export interface ScriptingDeps {
  execute(details: { target: { tabId: number }; world: 'MAIN'; func: (code: string) => Promise<string>; args: [string] }): Promise<unknown[]>
}

/**
 * Fallback evaluation via `chrome.scripting.executeScript`.
 *
 * Newer Edge builds refuse `debugger` as an optional permission entirely, which
 * kills the CDP path there. This path needs only the static scripting +
 * host permissions the manifest already carries: the model-authored code rides
 * in as an argument and is evaluated in the page's MAIN world by a small
 * wrapper function.
 *
 * Two honest limitations, both surfaced to the caller's error text rather than
 * hidden: a page whose own CSP forbids `unsafe-eval` rejects this (the CDP path
 * is immune), and cross-origin restrictions apply as they would for any page
 * script.
 *
 * @param tabId - the tab to evaluate in.
 * @param expression - the code; its last expression's value is serialized in-page.
 * @param deps - the chrome.scripting seam.
 * @returns the serialized result text ('undefined' when there is no value).
 * @throws EvaluateError when the injection fails or the page blocks eval.
 */
export async function evaluateViaScripting(tabId: number, expression: string, deps: ScriptingDeps): Promise<string> {
  let results: unknown[]
  try {
    // The wrapper is async on purpose: executeScript awaits a returned promise,
    // so `awaitPromise` semantics survive without the CDP flag. Serializing
    // IN the page keeps values that die on the way out (functions, symbols)
    // from becoming opaque '{}'.
    results = await deps.execute({
      target: { tabId },
      world: 'MAIN',
      func: async (code: string) => {
        // eslint-disable-next-line no-eval -- this is the feature
        const value = await eval(code)
        return value === undefined ? 'undefined' : JSON.stringify(value)
      },
      args: [expression],
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    throw new EvaluateError(
      'evaluate-failed',
      /eval|csp|Content Security Policy/i.test(message)
        ? `This page's content-security policy blocks script evaluation (${message}); no fallback can override a page's own CSP.`
        : `The script could not be injected into this page: ${message}`,
    )
  }
  const first = results[0] as { result?: unknown } | undefined
  const value = first?.result
  return typeof value === 'string' ? value : 'undefined'
}

/** The live chrome.scripting implementation of the fallback seam. */
export function chromeScriptingDeps(): ScriptingDeps {
  return {
    execute: (details) => chrome.scripting.executeScript(details),
  }
}

/**
 * Compose the model-facing answer for one evaluation.
 *
 * The value is whatever the model's expression returned from the page's MAIN
 * world, which makes it the most page-controlled text any tool hands back — a
 * page can choose both the data and any prose inside it. It therefore rides in
 * the nonce-bound boundary, exactly as an inspection report does, while the
 * extension's own "where this ran" line stays outside so the model can still
 * trust that part.
 *
 * @param url - the evaluated page's URL, when known.
 * @param value - the serialized result from one of the evaluation paths.
 * @param via - which fallback path produced it, when not the default.
 * @returns model-facing text.
 */
export function renderEvaluation(url: string | undefined, value: string, via?: string): string {
  const where = `Evaluated on ${url === undefined || url === '' ? 'the page' : url}${via === undefined ? '' : ` (${via})`}:`
  return `${where}\n${wrapDerivedReport(value, MAX_EVALUATE_RESULT_CHARS)}`
}
