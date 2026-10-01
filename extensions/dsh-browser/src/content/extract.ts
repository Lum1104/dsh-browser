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

/** How an inventory element was discovered. */
export type InteractiveSource = 'selector' | 'heuristic' | 'overlay'

/** One element discovered for the interactive inventory. */
export interface CollectedInteractive {
  element: Element
  source: InteractiveSource
  /**
   * Nesting depth among heuristic pointer ancestors (1 = outermost kept peer).
   * Selector/overlay hits omit this unless nested heuristics apply.
   */
  depth?: number
}

/** Cap on heuristic clickables so they cannot crowd out selector-matched controls. */
export const DEFAULT_MAX_HEURISTIC_ITEMS = 20

/** Cap on short-text leaves collected inside floating picker/dropdown panels. */
export const DEFAULT_MAX_OVERLAY_ITEMS = 40

/** Selector-matched interactive tags/roles (CSS whitelist). */
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
  '[role="menuitemcheckbox"]',
  '[role="combobox"]',
  '[role="listbox"]',
  '[role="listitem"]',
  '[role="option"]',
  '[role="grid"]',
  '[role="gridcell"]',
  '[role="switch"]',
  '[role="spinbutton"]',
  '[role="dialog"]',
  '[tabindex]',
  '[aria-haspopup]',
  '[aria-expanded]',
  '[aria-controls]',
  'summary',
  '[contenteditable="true"]',
  '[contenteditable=""]',
].join(', ')

/** Default cap on one item's rendered name/state text. */
const MAX_ITEM_NAME_CHARS = 80

/** Heuristic clickable labels longer than this are treated as containers. */
const MAX_HEURISTIC_NAME_CHARS = 24

/** Predicate used by heuristic discovery; injectable for jsdom fixtures. */
export type PointerCursorPredicate = (el: Element) => boolean

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

/** CSS.escape with a fallback for environments that lack it (jsdom). */
function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value)
  return value.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`)
}

/**
 * Root that owns tree-scoped ID references for `el` (document or shadow root).
 * Attribute ID refs and HTML label/control associations do not cross this boundary.
 */
function treeRoot(el: Element): Document | ShadowRoot {
  const root = el.getRootNode()
  return root instanceof ShadowRoot || root instanceof Document ? root : el.ownerDocument
}

/** Resolve one id inside `root` only — never borrow from another tree. */
function getElementByIdInTree(root: Document | ShadowRoot, id: string): Element | null {
  if (id === '') return null
  if (root instanceof Document) return root.getElementById(id)
  return root.querySelector(`#${cssEscape(id)}`)
}

/**
 * Resolve `aria-labelledby` IDs in reference order within the control's own tree.
 * Duplicate IDs after their first occurrence are ignored. No cross-shadow fallback.
 */
function labelledByText(el: Element): string | undefined {
  const labelledBy = el.getAttribute('aria-labelledby')
  if (labelledBy === null) return undefined
  const root = treeRoot(el)
  const seen = new Set<string>()
  const parts: string[] = []
  for (const rawId of labelledBy.trim().split(/\s+/)) {
    if (rawId === '' || seen.has(rawId)) continue
    seen.add(rawId)
    const ref = getElementByIdInTree(root, rawId)
    const refText = ref?.textContent
    if (refText !== undefined && refText.trim() !== '') parts.push(clean(refText))
  }
  if (parts.length === 0) return undefined
  return parts.join(' ')
}

/**
 * Resolve an associated `<label for>` in the control's own tree (not the outer document).
 */
function labelForText(el: Element): string | undefined {
  if (!(el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement)) {
    return undefined
  }
  if (el.id === '') return undefined
  const label = treeRoot(el).querySelector<HTMLLabelElement>(`label[for="${cssEscape(el.id)}"]`)
  const labelText = label?.textContent
  if (labelText === undefined || labelText.trim() === '') return undefined
  return clean(labelText)
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

  const fromLabelledBy = labelledByText(el)
  if (fromLabelledBy !== undefined) return truncate(fromLabelledBy, MAX_ITEM_NAME_CHARS).text

  const labelable = el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement
  if (labelable) {
    const fromLabelFor = labelForText(el)
    if (fromLabelFor !== undefined) return truncate(fromLabelFor, MAX_ITEM_NAME_CHARS).text
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

  return el.tagName.toLowerCase()
}

/** Default pointer-cursor check (inline styles work in jsdom; cascade may not). */
export function hasPointerCursor(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return false
  return getComputedStyle(el).cursor === 'pointer'
}

/**
 * Label used only by heuristic discovery: aria-label or own text, never the
 * tag-name fallback (that would admit empty pointer wrappers).
 */
function heuristicLabel(el: Element): string | undefined {
  const ariaLabel = el.getAttribute('aria-label')
  if (ariaLabel !== null && ariaLabel.trim() !== '') {
    return truncate(clean(ariaLabel), MAX_ITEM_NAME_CHARS).text
  }
  const own = clean(elementText(el))
  if (own === '') return undefined
  return truncate(own, MAX_ITEM_NAME_CHARS).text
}

/**
 * Walk open shadow roots depth-first and invoke `visit` for every element.
 * Closed shadow roots are unreachable from content scripts.
 */
function walkDeep(root: Document | Element | ShadowRoot, visit: (el: Element) => void): void {
  const nodes = root instanceof Document
    ? root.querySelectorAll('*')
    : root.querySelectorAll('*')
  for (const el of nodes) {
    visit(el)
    if (el.shadowRoot !== null) walkDeep(el.shadowRoot, visit)
  }
}

/** Thrown when a CSS selector is syntactically invalid. */
export class InvalidSelectorError extends Error {
  constructor(readonly selector: string) {
    super(`Invalid CSS selector: ${selector}`)
    this.name = 'InvalidSelectorError'
  }
}

/**
 * Query matching elements under `root`, including open shadow trees.
 * @param root - document or element to scan.
 * @param selector - CSS selector.
 * @returns matches in document order (flattened across shadow trees).
 * @throws {InvalidSelectorError} when `selector` is not valid CSS.
 */
export function querySelectorAllDeep(root: Document | Element, selector: string): Element[] {
  const matches: Element[] = []
  const seen = new Set<Element>()
  const scope: Document | Element | ShadowRoot = root instanceof Document ? root : root
  let light: NodeListOf<Element>
  try {
    light = scope.querySelectorAll(selector)
  } catch {
    throw new InvalidSelectorError(selector)
  }
  for (const el of light) {
    if (seen.has(el)) continue
    seen.add(el)
    matches.push(el)
  }
  walkDeep(root, (el) => {
    if (el.shadowRoot === null) return
    // Selector already validated against the light tree; shadow queries use the same string.
    for (const nested of el.shadowRoot.querySelectorAll(selector)) {
      if (seen.has(nested)) continue
      seen.add(nested)
      matches.push(nested)
    }
  })
  return matches
}

/** Whether `el` matches the interactive CSS whitelist (own attributes only). */
export function matchesInteractiveSelector(el: Element): boolean {
  try {
    return el.matches(INTERACTIVE_SELECTOR)
  } catch {
    return false
  }
}

/** Tags/roles considered clickable when lifting a text match to an ancestor. */
export function isClickableTarget(el: Element, hasPointer: PointerCursorPredicate = hasPointerCursor): boolean {
  if (matchesInteractiveSelector(el)) return true
  if (hasPointer(el)) return true
  const role = el.getAttribute('role')
  return role === 'button' || role === 'link' || role === 'tab' || role === 'menuitem'
}

/**
 * Collect the page's interactive elements in document order, deduplicated and
 * visibility-filtered. Includes selector matches, pointer-cursor heuristics,
 * and short-text leaves inside floating picker/dropdown panels.
 * Open shadow roots are traversed; closed shadow roots remain unreachable.
 *
 * @param root - document or element to scan.
 * @param options - optional predicates and caps for tests.
 * @returns the interactive inventory with discovery source.
 */
export function collectInteractive(
  root: Document | Element,
  options: {
    hasPointerCursor?: PointerCursorPredicate
    maxHeuristicItems?: number
    maxOverlayItems?: number
  } = {},
): CollectedInteractive[] {
  const hasPointer = options.hasPointerCursor ?? hasPointerCursor
  const maxHeuristic = options.maxHeuristicItems ?? DEFAULT_MAX_HEURISTIC_ITEMS
  const maxOverlay = options.maxOverlayItems ?? DEFAULT_MAX_OVERLAY_ITEMS
  const seen = new Set<Element>()
  const selectorHits = new Set<Element>()
  const result: CollectedInteractive[] = []

  for (const el of querySelectorAllDeep(root, INTERACTIVE_SELECTOR)) {
    if (seen.has(el)) continue
    seen.add(el)
    if (!isVisible(el)) continue
    selectorHits.add(el)
    result.push({ element: el, source: 'selector' })
  }

  const heuristicCandidates: Element[] = []
  walkDeep(root, (el) => {
    if (seen.has(el) || selectorHits.has(el)) return
    if (!isVisible(el) || !hasPointer(el)) return
    const name = heuristicLabel(el)
    if (name === undefined || name.length > MAX_HEURISTIC_NAME_CHARS) return
    if (containsSelectorHit(el, selectorHits)) return
    if (looksLikeFormLabel(el, name, selectorHits)) return
    heuristicCandidates.push(el)
  })

  const candidateSet = new Set(heuristicCandidates)
  const withDepth = heuristicCandidates.map((el) => ({
    element: el,
    depth: heuristicDepth(el, candidateSet),
    inViewport: isInViewport(el),
  }))
  withDepth.sort((a, b) => Number(b.inViewport) - Number(a.inViewport) || b.depth - a.depth)

  let heuristicKept = 0
  for (const entry of withDepth) {
    if (seen.has(entry.element)) continue
    if (heuristicKept >= maxHeuristic) break
    seen.add(entry.element)
    heuristicKept += 1
    result.push({ element: entry.element, source: 'heuristic', depth: entry.depth })
  }

  for (const entry of collectOverlayLeaves(root, seen, maxOverlay)) {
    seen.add(entry.element)
    result.push(entry)
  }

  return result
}

/** Class-name signal for design-system floating layers (panel/picker/dropdown…). */
const OVERLAY_CLASS_RE = /panel|popup|popover|dropdown|popper|overlay|picker|cascader|calendar|date-panel|time-panel|select-dropdown/i

/**
 * Collect short-text leaf cells inside visible floating overlays.
 * Caps at `maxOverlay` with viewport-first ordering.
 */
export function collectOverlayLeaves(
  root: Document | Element,
  seen: Set<Element>,
  maxOverlay: number = DEFAULT_MAX_OVERLAY_ITEMS,
): CollectedInteractive[] {
  const overlayRoots = findOverlayRoots(root)
  const candidates: Element[] = []
  for (const overlay of overlayRoots) {
    walkDeep(overlay, (el) => {
      if (seen.has(el)) return
      if (!isOverlayLeaf(el)) return
      candidates.push(el)
    })
  }
  candidates.sort((a, b) => Number(isInViewport(b)) - Number(isInViewport(a)))
  const out: CollectedInteractive[] = []
  for (const el of candidates) {
    if (out.length >= maxOverlay) break
    if (seen.has(el) || out.some((entry) => entry.element === el)) continue
    out.push({ element: el, source: 'overlay' })
  }
  return out
}

/** Outermost visible overlay containers under `root`. */
export function findOverlayRoots(root: Document | Element): Element[] {
  const matches: Element[] = []
  walkDeep(root, (el) => {
    if (isOverlayRoot(el)) matches.push(el)
  })
  return matches.filter((el) => !matches.some((other) => other !== el && other.contains(el)))
}

/**
 * Whether `el` is positioned as a floating layer (absolute/fixed), not ordinary
 * page chrome such as a persistent side panel in normal flow.
 */
function isFloatingLayer(el: HTMLElement): boolean {
  const style = getComputedStyle(el)
  return style.position === 'fixed' || style.position === 'absolute'
}

/**
 * Open transient overlay (picker/dropdown/modal), not persistent page chrome.
 * Class-name hits and listbox/menu roles require floating positioning evidence;
 * dialog / aria-modal alone count as transient.
 */
function isOverlayRoot(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return false
  if (!isVisible(el)) return false
  const role = el.getAttribute('role')
  const ariaModal = el.getAttribute('aria-modal') === 'true'
  if (ariaModal || role === 'dialog') return true
  if ((role === 'listbox' || role === 'menu') && isFloatingLayer(el)) return true
  const cls = classNameOf(el)
  if (cls !== '' && OVERLAY_CLASS_RE.test(cls) && isFloatingLayer(el)) return true
  if (isFloatingLayer(el)) {
    const style = getComputedStyle(el)
    const z = Number.parseInt(style.zIndex, 10)
    const rect = el.getBoundingClientRect()
    if (Number.isFinite(z) && z >= 50 && rect.width >= 80 && rect.height >= 40) return true
  }
  return false
}

function isOverlayLeaf(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return false
  if (!isVisible(el)) return false
  const text = clean(elementText(el))
  if (text.length < 1 || text.length > 8) return false
  try {
    if (el.querySelector(INTERACTIVE_SELECTOR) !== null) return false
  } catch {
    return false
  }
  for (const child of el.children) {
    if (isVisible(child) && clean(elementText(child)) === text) return false
  }
  const rect = el.getBoundingClientRect()
  if (rect.width > 160 || rect.height > 64) return false
  return true
}

function classNameOf(el: Element): string {
  if (typeof el.className === 'string') return el.className
  return el.getAttribute('class') ?? ''
}

/** Whether the document currently shows a floating overlay (picker/dropdown). */
export function documentHasOpenOverlay(): boolean {
  return findOverlayRoots(document).length > 0
}

/** True when `el` contains any whitelist interactive descendant. */
function containsSelectorHit(el: Element, selectorHits: Set<Element>): boolean {
  for (const hit of selectorHits) {
    if (el.contains(hit) && hit !== el) return true
  }
  return false
}

/**
 * Nesting depth among heuristic candidates on the ancestor chain (1 = no
 * heuristic ancestor in the candidate set).
 */
function heuristicDepth(el: Element, candidates: Set<Element>): number {
  let depth = 0
  let node: Element | null = el
  while (node !== null) {
    if (candidates.has(node)) depth += 1
    node = node.parentElement
  }
  return Math.max(1, depth)
}

/** Action verbs that should stay discoverable even next to form controls. */
const ACTION_LABEL_RE = /^(添加|新增|删除|提交|确认|取消|保存|上传|搜索|下一步|上一步|\+|×|✕|…)$/

/** Common form-item titles that steal inventory when marked cursor:pointer. */
const FIELD_TITLE_RE = /^(项目名称|项目角色|项目链接|项目描述|公司|职位|描述|起止时间|学历|学校|专业|手机|邮箱|姓名|城市|工作经历|教育经历|自我评价|社交账号)$/

/**
 * Whether a pointer element is just a form label next to a real control.
 * Those steal inventory budget without being actionable.
 */
function looksLikeFormLabel(el: Element, name: string, selectorHits: Set<Element>): boolean {
  if (el instanceof HTMLLabelElement) return true
  if (el.closest('label') !== null && !el.querySelector(INTERACTIVE_SELECTOR)) return true

  const parent = el.parentElement
  if (parent === null) return false
  for (const sibling of parent.children) {
    if (sibling === el) continue
    const isControl = selectorHits.has(sibling)
      || sibling instanceof HTMLInputElement
      || sibling instanceof HTMLSelectElement
      || sibling instanceof HTMLTextAreaElement
      || sibling.matches?.(INTERACTIVE_SELECTOR) === true
    if (!isControl) continue
    const siblingName = accessibleName(sibling)
    if (siblingName === name) return true
    if (sibling instanceof HTMLInputElement || sibling instanceof HTMLTextAreaElement) {
      if (clean(sibling.placeholder) === name) return true
    }
  }

  // Known field titles (项目名称 / 起止时间 / …) next to inputs, without button signals.
  const hasSignal = el.hasAttribute('aria-label')
    || el.hasAttribute('aria-haspopup')
    || el.hasAttribute('tabindex')
    || (el.getAttribute('role') !== null && el.getAttribute('role') !== 'presentation')
  if (!hasSignal && !ACTION_LABEL_RE.test(name) && FIELD_TITLE_RE.test(name)) {
    let ancestor: Element | null = parent
    for (let i = 0; i < 3 && ancestor !== null; i += 1) {
      if (ancestor.querySelector('input, select, textarea') !== null) return true
      ancestor = ancestor.parentElement
    }
  }
  return false
}

/**
 * Prefer a human-readable name for form controls, especially visually hidden
 * date/select inputs that otherwise fall back to their `type`.
 */
export function formControlLabel(el: Element): string {
  const ariaLabel = el.getAttribute('aria-label')
  if (ariaLabel !== null && ariaLabel.trim() !== '') {
    return truncate(clean(ariaLabel), MAX_ITEM_NAME_CHARS).text
  }
  const fromLabelledBy = labelledByText(el)
  if (fromLabelledBy !== undefined) {
    return truncate(fromLabelledBy, MAX_ITEM_NAME_CHARS).text
  }
  if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) {
    const fromLabelFor = labelForText(el)
    if (fromLabelFor !== undefined) {
      return truncate(fromLabelFor, MAX_ITEM_NAME_CHARS).text
    }
    const wrapping = el.closest('label')?.textContent
    if (wrapping !== undefined && wrapping.trim() !== '') {
      return truncate(clean(wrapping), MAX_ITEM_NAME_CHARS).text
    }
    if ((el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && el.placeholder !== '') {
      return truncate(clean(el.placeholder), MAX_ITEM_NAME_CHARS).text
    }
  }
  const nearby = nearestFieldTitle(el)
  if (nearby !== undefined) return truncate(nearby, MAX_ITEM_NAME_CHARS).text
  return accessibleName(el)
}

/** Walk a few ancestors for a short sibling title (form-item label pattern). */
function nearestFieldTitle(el: Element): string | undefined {
  let node: Element | null = el
  for (let i = 0; i < 4 && node !== null; i += 1) {
    const parent: Element | null = node.parentElement
    if (parent === null) break
    for (const child of Array.from(parent.children)) {
      if (child === node || child === el || child.contains(el)) continue
      if (child.matches('input, select, textarea, button, a[href]')) continue
      if (child.querySelector('input, select, textarea') !== null) continue
      const text = clean(elementText(child))
      if (text !== '' && text.length <= MAX_HEURISTIC_NAME_CHARS) return text
    }
    node = parent
  }
  return undefined
}

/**
 * Collect visually hidden but attached form controls (opacity:0, 0×0,
 * visibility:hidden). These remain addressable via browser_type; snapshot
 * values are always masked so OTP/token-like contents are not echoed.
 * @param root - document or element to scan.
 * @returns hidden form controls in document order.
 */
export function collectHiddenForms(root: Document | Element): Element[] {
  const result: Element[] = []
  const seen = new Set<Element>()
  for (const el of querySelectorAllDeep(root, 'input, select, textarea')) {
    if (seen.has(el)) continue
    seen.add(el)
    if (!(el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement)) continue
    if (!el.isConnected || el.disabled) continue
    if (el instanceof HTMLInputElement && el.type === 'hidden') continue
    if (isVisible(el)) continue
    result.push(el)
  }
  return result
}

/**
 * Best-effort main-content extraction (readability-lite): prefer a main
 * landmark, then a single standalone article, else the largest block
 * containing at least two paragraphs. Multiple articles commonly represent
 * cards or feed entries, so selecting only the first would hide page content.
 * Open shadow roots contribute text via deep walk of landmarks when present.
 * @param doc - the document.
 * @returns the cleaned main text (unbounded; callers apply budgets).
 */
export function mainText(doc: Document): string {
  const main = doc.querySelector('main, [role="main"]')
  if (main !== null) return clean(deepElementText(main))
  const articles = doc.querySelectorAll('article')
  if (articles.length === 1) return clean(deepElementText(articles[0]!))

  let best: Element | null = null
  let bestScore = 0
  for (const candidate of doc.querySelectorAll('section, div, [role="main"]')) {
    const paragraphs = candidate.querySelectorAll('p').length
    if (paragraphs < 2) continue
    const text = deepElementText(candidate)
    const score = text.length * Math.min(paragraphs, 5)
    if (score > bestScore) {
      bestScore = score
      best = candidate
    }
  }
  if (best !== null) return clean(deepElementText(best))
  return clean(deepElementText(doc.body))
}

/** Element text including open shadow-root text. */
function deepElementText(el: Element | null): string {
  if (el === null) return ''
  const parts: string[] = [elementText(el)]
  walkDeep(el, (node) => {
    if (node.shadowRoot !== null) parts.push(node.shadowRoot.textContent ?? '')
  })
  return parts.join(' ')
}

/**
 * The full text of an element (or the whole document), including open shadow roots.
 * @param root - element to read; defaults to the document body.
 * @returns normalized text.
 */
export function pageText(root?: Element | null): string {
  const source = root ?? document.body
  if (source === null || source === undefined) return ''
  return clean(deepElementText(source))
}
