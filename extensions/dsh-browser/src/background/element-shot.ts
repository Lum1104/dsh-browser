/**
 * Full-resolution element capture via the Chrome DevTools Protocol.
 *
 * `chrome.tabs.captureVisibleTab` photographs the viewport at screen
 * resolution, so cropping an element out of it yields exactly the pixels the
 * user sees — and no more. `Page.captureScreenshot` takes a `clip` with its own
 * `scale` and re-rasterizes the region at that scale, which for an `<img>`
 * shown smaller than its natural size means the browser redraws it from the
 * DECODED ORIGINAL. A 1600px photo displayed in a 300px column comes back at
 * something close to 1600px without the original bytes ever being fetched,
 * which is the whole answer for a hotlink-protected host.
 *
 * `captureBeyondViewport` also lifts the requirement that the element be
 * on screen, so a partly scrolled picture no longer has to be scrolled to.
 *
 * The debugger is attached for one screenshot and detached immediately, exactly
 * as in `trusted-input` and `evaluate`. The permission is optional and is NEVER
 * requested from here: an image read must not turn into a permission prompt, so
 * an ungranted permission simply means the caller keeps its viewport-crop path.
 *
 * @module
 */

/** A region to photograph, in document CSS pixels. */
export interface ShotClip {
  x: number
  y: number
  width: number
  height: number
  /** Rasterization factor; >1 recovers detail beyond the on-screen rendering. */
  scale: number
}

/** Chrome seams, injected so the protocol conversation is testable. */
export interface ElementShotDeps {
  hasPermission(): Promise<boolean>
  attach(target: chrome.debugger.Debuggee, version: string): Promise<void>
  detach(target: chrome.debugger.Debuggee): Promise<void>
  send(target: chrome.debugger.Debuggee, method: string, params?: object): Promise<unknown>
}

/** The protocol version this module speaks (shared with the other debugger paths). */
const PROTOCOL_VERSION = '1.3'

/**
 * Largest rasterization factor requested.
 *
 * Beyond this the cost grows quadratically for detail the byte budget would
 * discard anyway, and a mis-measured box could ask for an enormous surface.
 */
export const MAX_SHOT_SCALE = 6

/** Refusal raised when the protocol screenshot cannot be produced. */
export class ElementShotError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ElementShotError'
  }
}

/**
 * Choose the rasterization factor for one element.
 *
 * The ideal is the factor that restores the source's own resolution
 * (`natural / rendered`). It is then bounded by what the host will actually
 * keep: both the long-edge cap and, when declared, the total-pixel cap, because
 * anything past those is downscaled away by `encodeBitmap` before the image is
 * sent — rasterizing a larger surface first would only cost time. Never below
 * 1: a shot smaller than the rendering would be worse than the crop it
 * replaces.
 *
 * @param clip - the rendered region in CSS pixels.
 * @param natural - the source's own pixel size, when the browser has decoded it.
 * @param caps - the host's image budget.
 * @returns the scale to request.
 */
export function shotScale(
  clip: { width: number; height: number },
  natural: { width: number; height: number } | undefined,
  caps: { maxDimension: number; maxPixels?: number },
): number {
  const longestCss = Math.max(clip.width, clip.height)
  if (longestCss <= 0) return 1
  const edgeBudget = caps.maxDimension / longestCss
  const cssPixels = clip.width * clip.height
  // Area grows with the square of a linear factor, hence the square root.
  const areaBudget = caps.maxPixels === undefined || cssPixels <= 0
    ? Infinity
    : Math.sqrt(caps.maxPixels / cssPixels)
  const budget = Math.min(edgeBudget, areaBudget)
  const desired = natural === undefined || natural.width <= 0 || clip.width <= 0
    ? budget
    : Math.max(natural.width / clip.width, natural.height / Math.max(clip.height, 1))
  return Math.min(Math.max(Math.min(desired, budget), 1), MAX_SHOT_SCALE)
}

/**
 * Photograph one region of a tab at the requested scale.
 *
 * @param tabId - the tab to capture.
 * @param clip - the region in document CSS pixels, with its scale.
 * @param deps - Chrome seams.
 * @returns a `data:image/png` URL of exactly that region.
 * @throws ElementShotError when the permission is absent, attaching fails, or the protocol returns no image.
 */
export async function captureElementShot(tabId: number, clip: ShotClip, deps: ElementShotDeps): Promise<string> {
  if (!await deps.hasPermission()) {
    throw new ElementShotError('the browser debugging permission is not granted, so a full-resolution element capture is unavailable')
  }
  const target: chrome.debugger.Debuggee = { tabId }
  try {
    await deps.attach(target, PROTOCOL_VERSION)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    throw new ElementShotError(
      /already attached|another debugger/i.test(message)
        ? 'the browser debugger is already attached to this tab (DevTools may be open)'
        : `the browser debugger could not attach to this tab: ${message}`,
    )
  }
  try {
    const response = await deps.send(target, 'Page.captureScreenshot', {
      format: 'png',
      clip: {
        x: clip.x,
        y: clip.y,
        width: clip.width,
        height: clip.height,
        scale: clip.scale,
      },
      // Reach a region the user has scrolled past, and photograph the real
      // compositor surface so transforms and video frames come out right.
      captureBeyondViewport: true,
      fromSurface: true,
    }) as { data?: unknown }
    if (typeof response.data !== 'string' || response.data === '') {
      throw new ElementShotError('the protocol screenshot returned no image data')
    }
    return `data:image/png;base64,${response.data}`
  } catch (error: unknown) {
    if (error instanceof ElementShotError) throw error
    throw new ElementShotError(`the protocol screenshot failed: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    // Detach on every path: a leaked attachment leaves Chrome's debugging
    // banner up and blocks DevTools on the user's tab.
    try {
      await deps.detach(target)
    } catch {
      // A tab that closed mid-capture has nothing left to detach from.
    }
  }
}

/** The live Chrome implementation of the seams above. */
export function chromeElementShotDeps(): ElementShotDeps {
  return {
    hasPermission: () => chrome.permissions.contains({ permissions: ['debugger'] }),
    attach: (target, version) => chrome.debugger.attach(target, version),
    detach: (target) => chrome.debugger.detach(target),
    send: (target, method, params) => chrome.debugger.sendCommand(target, method, params),
  }
}
