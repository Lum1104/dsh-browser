/**
 * Locate human-verification widgets and the point that must be clicked.
 *
 * The checkbox of a Cloudflare Turnstile, hCaptcha, or reCAPTCHA widget lives
 * inside a cross-origin iframe, so it cannot be queried — and even where it
 * can, a synthetic `click()` carries `isTrusted: false` and the widget ignores
 * it. What CAN be computed from the page is the iframe's own rectangle in
 * top-level viewport coordinates, which is exactly what a trusted CCP-level
 * mouse event needs.
 *
 * So this module answers a geometry question, not an interaction one: where is
 * the widget, and where inside it is the box a person would click? The click
 * itself belongs to the background service worker.
 *
 * @module
 */

import { elementViewportBox, type ElementBox } from './locate.ts'

/** Which verification widget was recognized. */
export type VerificationKind = 'turnstile' | 'hcaptcha' | 'recaptcha' | 'checkbox'

/** One widget and the point to click, in top-level viewport CSS pixels. */
export interface VerificationTarget {
  kind: VerificationKind
  x: number
  y: number
  box: ElementBox
  /** What the widget says, when it says anything readable. */
  label?: string
}

/** Widget iframes, recognized by the URL each vendor loads them from. */
const IFRAME_PATTERNS: { kind: VerificationKind; match: RegExp }[] = [
  { kind: 'turnstile', match: /challenges\.cloudflare\.com/i },
  { kind: 'hcaptcha', match: /hcaptcha\.com\/captcha/i },
  { kind: 'recaptcha', match: /google\.com\/recaptcha\/api2\/anchor/i },
  { kind: 'recaptcha', match: /recaptcha\.net\/recaptcha\/api2\/anchor/i },
]

/** Containers a page uses for an inline (non-iframe) challenge checkbox. */
const CHECKBOX_CONTAINERS = '.cf-turnstile, #challenge-stage, #turnstile-wrapper, #challenge-form, .cf-im-under-attack'

/**
 * Distance from a widget's left edge to the middle of its checkbox.
 *
 * Every one of these vendors renders the same layout: a checkbox in a fixed
 * left gutter, then the label text. The gutter is ~30px at default scale, and
 * a widget narrower than that is a compact badge whose center is the target.
 */
const CHECKBOX_INSET = 30
/** Below this width the widget is a compact badge, so aim at its center. */
const COMPACT_WIDTH = 80

function labelOf(el: Element): string | undefined {
  const container = el.closest(CHECKBOX_CONTAINERS) ?? el.parentElement ?? el
  const text = (container instanceof HTMLElement && typeof container.innerText === 'string'
    ? container.innerText
    : container.textContent ?? '').replace(/\s+/g, ' ').trim()
  return text === '' ? undefined : text.slice(0, 80)
}

/**
 * Every verification widget visible in this document.
 *
 * @returns targets in document order; empty when the page shows none.
 */
export function verificationTargets(): VerificationTarget[] {
  const targets: VerificationTarget[] = []

  for (const frame of document.querySelectorAll('iframe[src]')) {
    const src = frame.getAttribute('src') ?? ''
    const pattern = IFRAME_PATTERNS.find((candidate) => candidate.match.test(src))
    if (pattern === undefined) continue
    const box = elementViewportBox(frame)
    if (box === undefined) continue
    const inset = box.width < COMPACT_WIDTH ? box.width / 2 : CHECKBOX_INSET
    targets.push({
      kind: pattern.kind,
      x: box.x + inset,
      y: box.y + box.height / 2,
      box,
      ...(labelOf(frame) === undefined ? {} : { label: labelOf(frame)! }),
    })
  }

  // Some interstitials render the checkbox in the page itself rather than in a
  // vendor iframe; it is still isTrusted-gated, so it takes the same path.
  for (const input of document.querySelectorAll('input[type="checkbox"]')) {
    if (input.closest(CHECKBOX_CONTAINERS) === null) continue
    if (input instanceof HTMLInputElement && input.checked) continue
    const box = elementViewportBox(input)
    if (box === undefined) continue
    targets.push({
      kind: 'checkbox',
      x: box.x + box.width / 2,
      y: box.y + box.height / 2,
      box,
      ...(labelOf(input) === undefined ? {} : { label: labelOf(input)! }),
    })
  }

  return targets
}

/** The vendor name shown to the user and the model. */
function kindLabel(kind: VerificationKind): string {
  switch (kind) {
    case 'turnstile': return 'Cloudflare Turnstile'
    case 'hcaptcha': return 'hCaptcha'
    case 'recaptcha': return 'reCAPTCHA'
    case 'checkbox': return 'verification checkbox'
  }
}

/**
 * Render located widgets as the model-facing text, used when the click cannot
 * be performed and the model needs to know what is on the page.
 * @param targets - located widgets.
 * @returns model-facing text.
 */
export function renderVerificationTargets(targets: readonly VerificationTarget[]): string {
  if (targets.length === 0) {
    return `No human-verification widget is present on ${location.href}. If the page still refuses to load, it may be a full interstitial that has to finish on its own, or one that needs a puzzle a click cannot solve.`
  }
  const lines = [`${targets.length} verification widget(s) on ${location.href}:`]
  for (const target of targets) {
    lines.push(`  ${kindLabel(target.kind)} at ${Math.round(target.box.width)}x${Math.round(target.box.height)}${target.label === undefined ? '' : ` — "${target.label}"`}`)
  }
  return lines.join('\n')
}

export { kindLabel as verificationKindLabel }
