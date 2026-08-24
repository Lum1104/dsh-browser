/**
 * Trusted input via the Chrome DevTools Protocol.
 *
 * A human-verification widget ignores `element.click()`, and correctly so: the
 * event carries `isTrusted: false`, which is precisely the signal the widget
 * exists to check. No amount of DOM work changes that — a synthetic event is
 * synthetic. The only interface that produces a real one is
 * `chrome.debugger` + `Input.dispatchMouseEvent`, which injects at the browser
 * level exactly as a mouse would.
 *
 * That capability is deliberately expensive to hold:
 *
 * - the `debugger` permission is OPTIONAL, so it is absent until the user
 *   grants it from the side panel;
 * - the debugger is attached for the duration of one gesture and detached
 *   immediately, so Chrome's "is being debugged" banner is a brief, visible
 *   receipt rather than a permanent state;
 * - it cannot attach while DevTools is open on the same tab, which is reported
 *   as such instead of retried.
 *
 * @module
 */

/** Where to click, in top-level viewport CSS pixels. */
export interface TrustedClickPoint {
  x: number
  y: number
}

/** Chrome seams, injected so the protocol conversation is testable. */
export interface TrustedInputDeps {
  hasPermission(): Promise<boolean>
  attach(target: chrome.debugger.Debuggee, version: string): Promise<void>
  detach(target: chrome.debugger.Debuggee): Promise<void>
  send(target: chrome.debugger.Debuggee, method: string, params?: object): Promise<unknown>
  /** Awaited between protocol steps so the page can react. */
  delay(ms: number): Promise<void>
}

/** A refusal the model should read and act on. */
export class TrustedInputError extends Error {
  constructor(
    readonly code: 'permission-missing' | 'attach-failed' | 'dispatch-failed',
    message: string,
  ) {
    super(message)
    this.name = 'TrustedInputError'
  }
}

/** The protocol version this module speaks. */
const PROTOCOL_VERSION = '1.3'
/** Pause between press and release, so the widget sees a human-length click. */
const CLICK_HOLD_MS = 60
/** Pause after the move, letting hover-driven widgets arm themselves. */
const HOVER_SETTLE_MS = 40

/**
 * Click one point in a tab with a trusted mouse event.
 *
 * The sequence is the one a real click produces — move, press, release —
 * because a widget that watches for `isTrusted` also tends to watch for a
 * pointer that arrived from somewhere.
 *
 * @param tabId - the tab to click in.
 * @param point - top-level viewport coordinates.
 * @param deps - Chrome seams.
 * @throws TrustedInputError when the permission is absent or attaching fails.
 */
export async function trustedClick(tabId: number, point: TrustedClickPoint, deps: TrustedInputDeps): Promise<void> {
  if (!await deps.hasPermission()) {
    throw new TrustedInputError(
      'permission-missing',
      'Trusted clicking needs the browser debugging permission, which is not granted. Ask the user to enable "human verification help" in the dsh side panel settings.',
    )
  }
  const target: chrome.debugger.Debuggee = { tabId }
  try {
    await deps.attach(target, PROTOCOL_VERSION)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    throw new TrustedInputError(
      'attach-failed',
      /already attached|another debugger/i.test(message)
        ? 'The browser debugger is already attached to this tab (DevTools may be open). Close DevTools and try again.'
        : `The browser debugger could not attach to this tab: ${message}`,
    )
  }
  try {
    const common = { x: Math.round(point.x), y: Math.round(point.y), button: 'left' as const }
    await deps.send(target, 'Input.dispatchMouseEvent', { ...common, type: 'mouseMoved' })
    await deps.delay(HOVER_SETTLE_MS)
    await deps.send(target, 'Input.dispatchMouseEvent', { ...common, type: 'mousePressed', clickCount: 1, buttons: 1 })
    await deps.delay(CLICK_HOLD_MS)
    await deps.send(target, 'Input.dispatchMouseEvent', { ...common, type: 'mouseReleased', clickCount: 1, buttons: 0 })
  } catch (error: unknown) {
    throw new TrustedInputError('dispatch-failed', `The trusted click could not be delivered: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    // Detach in every outcome: leaving the debugger attached would leave
    // Chrome's banner up and block DevTools on the tab.
    try {
      await deps.detach(target)
    } catch {
      // A tab that closed mid-click has nothing left to detach from.
    }
  }
}

/** The live Chrome implementation of the seams above. */
export function chromeTrustedInputDeps(): TrustedInputDeps {
  return {
    hasPermission: () => chrome.permissions.contains({ permissions: ['debugger'] }),
    attach: (target, version) => chrome.debugger.attach(target, version),
    detach: (target) => chrome.debugger.detach(target),
    send: (target, method, params) => chrome.debugger.sendCommand(target, method, params),
    delay: (ms) => new Promise((resolve) => { setTimeout(resolve, ms) }),
  }
}
