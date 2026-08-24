/**
 * Text extraction primitives for the text-only page snapshot: visibility,
 * accessible names, interactive inventory, main-content heuristic, and
 * truncation helpers.
 *
 * The snapshot is the model's entire view of the page (no screenshots), so
 * every helper is written to produce dense, model-usable text under a hard
 * character budget.
 *
 * @module
 */

/** Every element type the model may be asked to operate on. */
const INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  'input:not([type="hidden"])',
  'select',
  'textarea',
  '[role="button"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="tab"]',
  '[role="menuitem"]',
  'summary',
  '[contenteditable="true"]',
  '[contenteditable=""]',
].join(', ')

/** Default cap on one item's rendered name/state text. */
const MAX_ITEM_NAME_CHARS = 80

/**
 * Whether an element is visible to the user: not display/visibility/opacity
 * hidden and occupying layout space.
 * @param el - candidate element.
 * @returns true when the element renders.
 */
export function isVisible(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return false
  const style = getComputedStyle(el)
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false
  const rect = el.getBoundingClientRect()
  return rect.width > 0 && rect.height > 0
}

/**
 * Whether the element is inside the current viewport (used to order the
 * inventory: what the user sees comes first).
 * @param el - element.
 * @returns true when any part is within the viewport.
 */
export function isInViewport(el: Element): boolean {
  const rect = el.getBoundingClientRect()
  return rect.bottom >= 0 && rect.top <= window.innerHeight && rect.right >= 0 && rect.left <= window.innerWidth
}

/** Normalize whitespace and trim. */
function clean(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * Text of an element: innerText when available (browsers), textContent
 * otherwise (jsdom/edge cases).
 * @param el - element.
 * @returns the element's text.
 */
function elementText(el: Element): string {
  if (el instanceof HTMLElement && typeof el.innerText === 'string') return el.innerText
  return el.textContent ?? ''
}

/**
 * Truncate text at a character budget, marking the cut.
 * @param text - source text.
 * @param max - maximum characters.
 * @returns `{ text, truncated }` with `truncated` counting removed characters.
 */
export function truncate(text: string, max: number): { text: string; truncated: number } {
  if (text.length <= max) return { text, truncated: 0 }
  return { text: `${text.slice(0, max)}…`, truncated: text.length - max }
}

/**
 * The accessible name of an element, following the ARIA precedence chain
 * (aria-label → aria-labelledby → associated label → own text →
 * placeholder/alt).
 * @param el - element.
 * @returns a ≤80-char name, or the tag name as last resort.
 */
export function accessibleName(el: Element): string {
  const ariaLabel = el.getAttribute('aria-label')
  if (ariaLabel !== null && ariaLabel.trim() !== '') return truncate(clean(ariaLabel), MAX_ITEM_NAME_CHARS).text

  const labelledBy = el.getAttribute('aria-labelledby')
  if (labelledBy !== null) {
    const ref = document.getElementById(labelledBy.split(/\s+/)[0] ?? '')
    const refText = ref?.textContent
    if (refText !== undefined && refText.trim() !== '') return truncate(clean(refText), MAX_ITEM_NAME_CHARS).text
  }

  const labelable = el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement
  if (labelable) {
    if (el.id !== '') {
      const label = el.ownerDocument.querySelector<HTMLLabelElement>(`label[for="${cssEscape(el.id)}"]`)
      const labelText = label?.textContent
      if (labelText !== undefined && labelText.trim() !== '') return truncate(clean(labelText), MAX_ITEM_NAME_CHARS).text
    }
    const wrappingLabelText = el.closest('label')?.textContent
    if (wrappingLabelText !== undefined && wrappingLabelText.trim() !== '') {
      return truncate(clean(wrappingLabelText), MAX_ITEM_NAME_CHARS).text
    }
  }

  const ownText = el instanceof HTMLInputElement ? '' : el.textContent
  if (ownText !== undefined && ownText.trim() !== '') return truncate(clean(ownText), MAX_ITEM_NAME_CHARS).text

  if (el instanceof HTMLInputElement) {
    // Button-like inputs carry their label in `value`; other inputs never use
    // the current value as a name (it is data, not identity — and for
    // password/credit fields it would leak the secret into the snapshot).
    const buttonLike = el.type === 'submit' || el.type === 'button' || el.type === 'reset'
    if (buttonLike && el.value !== '') return truncate(clean(el.value), MAX_ITEM_NAME_CHARS).text
    if (el.placeholder !== '') return truncate(clean(el.placeholder), MAX_ITEM_NAME_CHARS).text
    if (el.alt !== '') return truncate(clean(el.alt), MAX_ITEM_NAME_CHARS).text
    return truncate(clean(el.type), MAX_ITEM_NAME_CHARS).text
  }

  // `alt` is an image's primary accessible name; without this an <img> named
  // itself "img" in every inventory, which told a reader nothing.
  const alt = el.getAttribute('alt')
  if (alt !== null && alt.trim() !== '') return truncate(clean(alt), MAX_ITEM_NAME_CHARS).text
  const title = el.getAttribute('title')
  if (title !== null && title.trim() !== '') return truncate(clean(title), MAX_ITEM_NAME_CHARS).text

  return el.tagName.toLowerCase()
}

/** CSS.escape with a fallback for environments that lack it (jsdom). */
function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value)
  return value.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`)
}

/**
 * Collect the page's interactive elements in document order, deduplicated and
 * visibility-filtered.
 * @param root - document or element to scan.
 * @returns the interactive inventory.
 */
export function collectInteractive(root: Document | Element): Element[] {
  const seen = new Set<Element>()
  const result: Element[] = []
  for (const el of root.querySelectorAll(INTERACTIVE_SELECTOR)) {
    if (seen.has(el)) continue
    seen.add(el)
    if (isVisible(el)) result.push(el)
  }
  return result
}

/**
 * Best-effort main-content extraction (readability-lite): prefer a main
 * landmark, then a single standalone article, else the largest block
 * containing at least two paragraphs. Multiple articles commonly represent
 * cards or feed entries, so selecting only the first would hide page content.
 * @param doc - the document.
 * @returns the cleaned main text (unbounded; callers apply budgets).
 */
export function mainText(doc: Document): string {
  const main = doc.querySelector('main, [role="main"]')
  if (main !== null) return clean(elementText(main))
  const articles = doc.querySelectorAll('article')
  if (articles.length === 1) return clean(elementText(articles[0]!))

  let best: Element | null = null
  let bestScore = 0
  for (const candidate of doc.querySelectorAll('section, div, [role="main"]')) {
    const paragraphs = candidate.querySelectorAll('p').length
    if (paragraphs < 2) continue
    const text = elementText(candidate)
    const score = text.length * Math.min(paragraphs, 5)
    if (score > bestScore) {
      bestScore = score
      best = candidate
    }
  }
  if (best !== null) return clean(elementText(best))
  return clean(elementText(doc.body))
}

/**
 * The full text of an element (or the whole document).
 * @param root - element to read; defaults to the document body.
 * @returns normalized text.
 */
export function pageText(root?: Element | null): string {
  const source = root ?? document.body
  if (source === null || source === undefined) return ''
  return clean(elementText(source))
}
