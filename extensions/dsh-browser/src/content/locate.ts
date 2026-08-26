/**
 * Targeted element lookup and image resolution for the page.
 *
 * `browser_find` exists because a full snapshot is the wrong price for a
 * question the model already knows the answer to ("where is the Sign in
 * button?"). It reuses the same stable id registry the snapshot uses, so an
 * index it returns is a valid target for click/type without a snapshot in
 * between.
 *
 * The image helpers answer a different question — "what does this actually
 * look like?" — by resolving one element to the best source of pixels the page
 * can offer: the image's own bytes when it has them, a rasterized frame when
 * it is a canvas or video, and otherwise its viewport box for the background
 * to crop out of a tab capture.
 *
 * @module
 */

import { accessibleName, collectInteractive, isInViewport, isVisible, truncate } from './extract.ts'
import type { ElementIds } from './ids.ts'
import { isSensitiveField, maskValue } from './privacy.ts'

/** What the model asked to find. */
export interface FindQuery {
  text?: string
  selector?: string
  role?: string
  interactiveOnly?: boolean
  limit?: number
}

/** One located element, addressable by the returned index. */
export interface FindMatch {
  index: number
  role: string
  name: string
  href?: string
  value?: string
  inViewport: boolean
  context: string
  /**
   * A CSS selector that resolves to this element alone, when one can be built
   * compactly. Indices are per-document, so they die on navigation and on a
   * re-render that restructures the inventory; a selector survives both and is
   * what lets an action retry itself instead of failing back to the model.
   */
  selector?: string
}

/** Result of one lookup. */
export interface FindResult {
  matches: FindMatch[]
  /** Matches beyond the limit, so the model knows to narrow the query. */
  omitted: number
}

/** Default and maximum number of matches returned. */
const DEFAULT_FIND_LIMIT = 30
const MAX_FIND_LIMIT = 150
/** Characters of surrounding text carried per match. */
const CONTEXT_CHARS = 240

/** Role label per element kind, mirroring the snapshot's vocabulary. */
export function roleOf(el: Element): string {
  const role = el.getAttribute('role')
  if (role !== null && role !== '') return role
  if (el instanceof HTMLAnchorElement) return 'link'
  if (el instanceof HTMLButtonElement) return 'button'
  if (el instanceof HTMLInputElement) {
    switch (el.type) {
      case 'checkbox': return 'checkbox'
      case 'radio': return 'radio'
      case 'submit': return 'button'
      default: return 'input'
    }
  }
  if (el instanceof HTMLSelectElement) return 'select'
  if (el instanceof HTMLTextAreaElement) return 'textarea'
  if (el instanceof HTMLImageElement) return 'image'
  if (el instanceof HTMLElement && el.isContentEditable) return 'contenteditable'
  return el.tagName.toLowerCase()
}

function normalize(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase()
}

/** Text a match is searched by: its accessible name plus its own visible text. */
function searchableText(el: Element): string {
  const own = el instanceof HTMLElement && typeof el.innerText === 'string' ? el.innerText : el.textContent ?? ''
  const attributes = [
    el.getAttribute('title'),
    el.getAttribute('alt'),
    el instanceof HTMLInputElement ? el.placeholder : null,
    el instanceof HTMLInputElement && (el.type === 'submit' || el.type === 'button') ? el.value : null,
  ].filter((value): value is string => value !== null && value !== '')
  return normalize(`${accessibleName(el)} ${own} ${attributes.join(' ')}`)
}

/** Short text around a match, so the model can tell near-identical controls apart. */
function contextFor(el: Element): string {
  const container = el.closest('li, tr, article, section, form, nav, header, footer, div') ?? el
  const source = container instanceof HTMLElement && typeof container.innerText === 'string'
    ? container.innerText
    : container.textContent ?? ''
  return truncate(source.replace(/\s+/g, ' ').trim(), CONTEXT_CHARS).text
}

/** Longest selector worth returning; past this a path is noise, not a handle. */
const MAX_SELECTOR_CHARS = 90
/** How far up the tree a positional path may walk before giving up. */
const MAX_SELECTOR_DEPTH = 5

/** CSS.escape with a fallback for environments that lack it (jsdom). */
function escapeCss(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value)
  return value.replace(/[^a-zA-Z0-9_-]/g, (character) => `\\${character}`)
}

/**
 * Whether an id is worth building a selector from.
 *
 * Frameworks mint ids like `:r3:` or `mui-1042` that change on every render, so
 * an id-based selector can be less durable than a positional one. Accepting
 * only conservative, human-looking ids keeps the selector's promise honest.
 */
function isStableId(id: string): boolean {
  return id !== ''
    && id.length <= 40
    && /^[A-Za-z][\w-]*$/.test(id)
    && !/^(?:mui|radix|headlessui|ember|ext-gen)[-_]?\d/i.test(id)
    && !/\d{5,}/.test(id)
}

function matchesUniquely(selector: string, el: Element): boolean {
  try {
    const found = el.ownerDocument.querySelectorAll(selector)
    return found.length === 1 && found[0] === el
  } catch {
    return false
  }
}

/** One element's own discriminating step, without its ancestors. */
function ownStep(el: Element): string {
  const tag = el.tagName.toLowerCase()
  const attributes: [string, string | null][] = [
    ['data-testid', el.getAttribute('data-testid')],
    ['data-test', el.getAttribute('data-test')],
    ['name', el.getAttribute('name')],
    ['aria-label', el.getAttribute('aria-label')],
    ['type', el instanceof HTMLInputElement ? el.getAttribute('type') : null],
  ]
  for (const [attribute, value] of attributes) {
    if (value !== null && value !== '' && value.length <= 40) {
      return `${tag}[${attribute}="${value.replace(/["\\]/g, '\\$&')}"]`
    }
  }
  const parent = el.parentElement
  if (parent === null) return tag
  const siblings = [...parent.children].filter((child) => child.tagName === el.tagName)
  if (siblings.length === 1) return tag
  return `${tag}:nth-of-type(${siblings.indexOf(el) + 1})`
}

/**
 * Build a selector that resolves to this element alone.
 *
 * The search is cheapest-first — a stable id, then the element's own
 * discriminating attribute, then a bounded path of such steps — and every
 * candidate is VERIFIED against the document before being returned. A selector
 * that cannot be proven unique is not returned at all: a handle that silently
 * matches the wrong element is worse than no handle.
 *
 * @param el - the element to describe.
 * @returns a unique selector, or `undefined` when none is compact and provable.
 */
export function stableSelector(el: Element): string | undefined {
  const id = el.getAttribute('id')
  if (id !== null && isStableId(id)) {
    const candidate = `#${escapeCss(id)}`
    if (matchesUniquely(candidate, el)) return candidate
  }

  const own = ownStep(el)
  if (!own.includes(':nth-of-type') && matchesUniquely(own, el)) return own

  let path = own
  let current: Element | null = el.parentElement
  for (let depth = 0; depth < MAX_SELECTOR_DEPTH && current !== null; depth += 1) {
    const parentId = current.getAttribute('id')
    const anchor = parentId !== null && isStableId(parentId) ? `#${escapeCss(parentId)}` : ownStep(current)
    path = `${anchor} > ${path}`
    if (path.length > MAX_SELECTOR_CHARS) return undefined
    if (matchesUniquely(path, el)) return path
    if (anchor.startsWith('#')) return undefined
    current = current.parentElement
  }
  return undefined
}

/**
 * Find elements matching the query, registering stable ids for every match so
 * the returned indices are immediately actionable.
 *
 * @param ids - the stable id registry shared with the snapshot.
 * @param query - the model's lookup.
 * @returns matches in document order, plus the count dropped by the limit.
 * @throws when the query is empty or the selector is invalid.
 */
export function findElements(ids: ElementIds, query: FindQuery): FindResult {
  const wantedText = query.text === undefined ? undefined : normalize(query.text)
  const wantedRole = query.role === undefined ? undefined : normalize(query.role)
  if ((wantedText === undefined || wantedText === '')
    && query.selector === undefined
    && wantedRole === undefined) {
    throw new FindError('Provide at least one of text, selector, or role.')
  }
  const interactiveOnly = query.interactiveOnly !== false
  const limit = Math.min(
    MAX_FIND_LIMIT,
    Math.max(1, Number.isInteger(query.limit) && query.limit !== undefined && query.limit > 0 ? query.limit : DEFAULT_FIND_LIMIT),
  )

  const interactive = collectInteractive(document)
  let pool: Element[] = interactive
  if (query.selector !== undefined && query.selector !== '') {
    let selected: Element[]
    try {
      selected = [...document.querySelectorAll(query.selector)]
    } catch {
      throw new FindError(`selector is not a valid CSS selector: ${query.selector}`)
    }
    pool = interactiveOnly
      ? selected.filter((el) => interactive.includes(el))
      : selected.filter((el) => isVisible(el))
  } else if (!interactiveOnly) {
    // Without a selector, a non-interactive search still has to be bounded;
    // text-bearing structural elements are what a reader would point at.
    pool = [...document.querySelectorAll('a, button, input, select, textarea, h1, h2, h3, h4, p, li, td, th, label, img, [role]')]
      .filter((el) => isVisible(el))
  }

  const matched = pool.filter((el) => {
    if (wantedRole !== undefined && normalize(roleOf(el)) !== wantedRole) return false
    if (wantedText === undefined || wantedText === '') return true
    return searchableText(el).includes(wantedText)
  })

  const kept = matched.slice(0, limit)
  // Register every interactive element (so the registry stays snapshot-shaped)
  // plus any non-interactive element we are about to hand back an index for.
  const extras = kept.filter((el) => !interactive.includes(el))
  ids.assign([...interactive, ...extras])

  const matches: FindMatch[] = []
  for (const el of kept) {
    const index = ids.indexOf(el)
    if (index === undefined) continue
    const editable = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
    const masked = editable && isSensitiveField(el)
    const selector = stableSelector(el)
    matches.push({
      index,
      role: roleOf(el),
      name: accessibleName(el),
      inViewport: isInViewport(el),
      context: contextFor(el),
      ...(selector === undefined ? {} : { selector }),
      ...(el instanceof HTMLAnchorElement && el.href !== '' ? { href: el.href } : {}),
      ...(editable ? { value: masked ? maskValue(el.value) : truncate(el.value, 120).text } : {}),
    })
  }
  return { matches, omitted: matched.length - kept.length }
}

/** A malformed lookup, reported to the model as a bad-args failure. */
export class FindError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FindError'
  }
}

/**
 * Render matches as the model-facing text.
 * @param result - the lookup result.
 * @param query - the original query, echoed so the answer is self-describing.
 * @returns model-facing text.
 */
export function renderFindResult(result: FindResult, query: FindQuery): string {
  const criteria = [
    query.text === undefined ? undefined : `text "${query.text}"`,
    query.selector === undefined ? undefined : `selector "${query.selector}"`,
    query.role === undefined ? undefined : `role "${query.role}"`,
  ].filter((value) => value !== undefined).join(' and ')
  if (result.matches.length === 0) {
    return `No element matched ${criteria} on ${location.href}. Take a browser_snapshot to see what the page actually offers.`
  }
  const lines = [`${result.matches.length} match(es) for ${criteria} on ${location.href}:`]
  let anySelector = false
  for (const match of result.matches) {
    const state = match.inViewport ? '' : ' [outside viewport]'
    const href = match.href === undefined ? '' : ` → ${match.href}`
    const value = match.value === undefined ? '' : ` value="${match.value}"`
    lines.push(`  [${match.index}] ${match.role} "${match.name}"${state}${value}${href}`)
    if (match.selector !== undefined) {
      anySelector = true
      lines.push(`      selector: ${match.selector}`)
    }
    if (match.context !== '' && match.context !== match.name) lines.push(`      context: ${match.context}`)
  }
  if (anySelector) {
    lines.push('Pass selector together with index to any action: the index is faster, and the selector is used automatically if the page re-rendered.')
  }
  if (result.omitted > 0) lines.push(`  (${result.omitted} further match(es) omitted; narrow the query or raise limit.)`)
  return lines.join('\n')
}

/** One element's box in TOP-LEVEL viewport CSS pixels, ready to crop a tab capture. */
export interface ElementBox {
  x: number
  y: number
  width: number
  height: number
  /** Device pixel ratio the capture will be taken at. */
  dpr: number
  /**
   * The same box in top-level DOCUMENT coordinates, for a protocol screenshot
   * that can reach past the viewport. Absent when the top-level scroll offset
   * is unreadable from here.
   */
  pageX?: number
  pageY?: number
}

/**
 * The element's box in top-level viewport coordinates.
 *
 * A tab capture is one image of the top-level viewport, so a box measured
 * inside an iframe must be offset by that iframe's own position. The walk up
 * the frame chain works only while every ancestor is same-origin; a
 * cross-origin ancestor makes the offset unknowable from here, and the caller
 * falls back to capturing the whole viewport rather than cropping the wrong
 * region.
 *
 * @param el - the element to measure.
 * @returns the box, or `undefined` when it is empty or its offset is unknown.
 */
export function elementViewportBox(el: Element): ElementBox | undefined {
  const rect = el.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return undefined
  const offset = frameOffset()
  if (offset === undefined) return undefined
  const x = rect.left + offset.x
  const y = rect.top + offset.y
  const scroll = topScrollOffset()
  return {
    x,
    y,
    width: rect.width,
    height: rect.height,
    dpr: window.devicePixelRatio || 1,
    ...(scroll === undefined ? {} : { pageX: x + scroll.x, pageY: y + scroll.y }),
  }
}

/**
 * Scroll offset of the top-level document.
 *
 * Reached only when every ancestor is same-origin (which `frameOffset` has
 * already established for its own walk); a cross-origin top makes document
 * coordinates unknowable, and the caller then stays with viewport coordinates.
 */
function topScrollOffset(): { x: number; y: number } | undefined {
  try {
    const top = window.top
    if (top === null) return undefined
    return { x: top.scrollX, y: top.scrollY }
  } catch {
    return undefined
  }
}

/** Accumulated offset of this frame inside the top-level viewport. */
function frameOffset(): { x: number; y: number } | undefined {
  let win: Window = window
  let x = 0
  let y = 0
  for (let depth = 0; depth < 16; depth += 1) {
    if (win === win.parent) return { x, y }
    let frame: Element | null
    try {
      frame = win.frameElement
    } catch {
      return undefined // cross-origin ancestor
    }
    if (frame === null) return undefined
    const rect = frame.getBoundingClientRect()
    const style = frame.ownerDocument.defaultView?.getComputedStyle(frame)
    x += rect.left + parseFloat(style?.borderLeftWidth ?? '0') + parseFloat(style?.paddingLeft ?? '0')
    y += rect.top + parseFloat(style?.borderTopWidth ?? '0') + parseFloat(style?.paddingTop ?? '0')
    win = win.parent
  }
  return undefined
}

/**
 * Where the pixels of one element can be obtained.
 *
 * A `url` source also carries the element's rendered `box` whenever it has one.
 * That is the universal last resort: an image host with hotlink protection
 * answers 404 to any request without a `Referer`, and an extension cannot send
 * one — but the browser already painted the picture, so cropping it out of a
 * tab capture needs no network, no cookies, and no CORS.
 */
export type ImageSource =
  | { kind: 'url'; url: string; width: number; height: number; name?: string; fallbacks?: string[]; box?: ElementBox }
  | { kind: 'data'; dataUrl: string; width: number; height: number; name?: string }
  | { kind: 'box'; box: ElementBox; name?: string }

/**
 * Attributes lazy loaders park the real URL in while `src` holds a placeholder.
 * Ordered by how commonly they carry the FULL-size image.
 */
const LAZY_URL_ATTRIBUTES = [
  'data-original',
  'data-src',
  'data-lazy-src',
  'data-lazysrc',
  'data-actualsrc',
  'data-original-src',
  'data-full-src',
  'data-large',
  'data-large-file',
  'data-echo',
  'data-url',
  'zoomfile',
  'file',
]

/** Attributes holding a candidate list, in `srcset` syntax. */
const LAZY_SRCSET_ATTRIBUTES = ['srcset', 'data-srcset', 'data-lazy-srcset']

/**
 * Whether a URL is a placeholder rather than the picture.
 *
 * Used to tell the model that an image it can see listed is still a stand-in,
 * so a read may need a scroll first rather than returning a grey rectangle.
 */
export function isPlaceholderUrl(url: string): boolean {
  if (url === '') return true
  if (url.startsWith('data:')) return true
  return /(?:^|[/_-])(?:blank|spacer|placeholder|loading|lazy|grey|gray|transparent|pixel|1x1|px\.gif)(?:[._-]|$)/i.test(url)
}

/** Absolute URL, or `undefined` when the value is not a usable web URL. */
function absoluteUrl(value: string | null): string | undefined {
  if (value === null) return undefined
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.startsWith('data:') || trimmed.startsWith('blob:')) return undefined
  try {
    const url = new URL(trimmed, document.baseURI)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined
  } catch {
    return undefined
  }
}

/** Whether a URL looks like it addresses an image file. */
export function looksLikeImageUrl(url: string): boolean {
  try {
    const path = new URL(url, document.baseURI).pathname.toLowerCase()
    return /\.(?:png|jpe?g|gif|webp|avif|bmp|svgz?|tiff?)$/.test(path)
  } catch {
    return false
  }
}

/** The largest candidate in a `srcset`-syntax attribute value. */
export function largestSrcsetCandidate(value: string): string | undefined {
  let best: { url: string; weight: number } | undefined
  for (const part of value.split(',')) {
    const [rawUrl, ...descriptors] = part.trim().split(/\s+/)
    if (rawUrl === undefined || rawUrl === '') continue
    const descriptor = descriptors[0] ?? ''
    const width = /^(\d+(?:\.\d+)?)w$/.exec(descriptor)
    const density = /^(\d+(?:\.\d+)?)x$/.exec(descriptor)
    const weight = width !== null ? Number(width[1]) : density !== null ? Number(density[1]) * 1000 : 1
    if (best === undefined || weight > best.weight) best = { url: rawUrl, weight }
  }
  return best?.url
}

/**
 * Every URL worth trying for one image element, best first.
 *
 * Forums and image hosts almost never put the real picture in `src`: it is
 * behind a lazy-load attribute, or in a `srcset`, or — most often — the `<img>`
 * is a thumbnail wrapped in an `<a>` pointing at the full-size original. That
 * last case is exactly the manual "find the link, then fetch it" step, so the
 * anchor comes FIRST when it addresses an image.
 *
 * Every candidate is kept rather than just the winner: the background tries
 * them in order, so a full-size original that is too large or 403s still falls
 * back to the thumbnail instead of failing the read.
 *
 * @param el - the image element.
 * @returns candidate URLs, best first, deduplicated.
 */
export function imageUrlCandidates(el: Element): string[] {
  const candidates: (string | undefined)[] = []

  // The enclosing link, when it points at an image file: the full-size original.
  const anchor = el.closest('a[href]')
  if (anchor instanceof HTMLAnchorElement) {
    const href = absoluteUrl(anchor.getAttribute('href'))
    if (href !== undefined && looksLikeImageUrl(href)) candidates.push(href)
  }

  for (const attribute of LAZY_SRCSET_ATTRIBUTES) {
    const value = el.getAttribute(attribute)
    if (value !== null && value !== '') candidates.push(absoluteUrl(largestSrcsetCandidate(value) ?? null))
  }
  for (const attribute of LAZY_URL_ATTRIBUTES) {
    candidates.push(absoluteUrl(el.getAttribute(attribute)))
  }

  if (el instanceof HTMLImageElement) {
    // `src` goes LAST unconditionally. Everything above it is by construction
    // the same picture at full size or better, and the background falls back
    // down this list, so the thumbnail stays available as the safe resort.
    candidates.push(absoluteUrl(el.currentSrc !== '' ? el.currentSrc : el.src))
  }

  const seen = new Set<string>()
  const ordered: string[] = []
  for (const candidate of candidates) {
    if (candidate === undefined || seen.has(candidate)) continue
    seen.add(candidate)
    ordered.push(candidate)
  }
  return ordered
}

/**
 * Resolve one element to the best available source of pixels.
 * @param el - the element to read.
 * @returns the source, or `undefined` when the element has no visible pixels.
 */
export function imageSourceFor(el: Element): ImageSource | undefined {
  const name = imageName(el)
  const named = name === undefined ? {} : { name }

  if (el instanceof HTMLImageElement || el.hasAttribute('data-src') || el.hasAttribute('data-original')) {
    const candidates = imageUrlCandidates(el)
    const [best, ...fallbacks] = candidates
    if (best !== undefined) {
      const rect = el.getBoundingClientRect()
      const box = elementViewportBox(el)
      return {
        kind: 'url',
        url: best,
        ...(box === undefined ? {} : { box }),
        // Natural size is 0 until the browser actually loaded it, which is the
        // normal state for a lazy image the user never scrolled to. The rendered
        // box is the honest answer then; the real size arrives with the bytes.
        width: el instanceof HTMLImageElement && el.naturalWidth > 0 ? el.naturalWidth : Math.round(rect.width),
        height: el instanceof HTMLImageElement && el.naturalHeight > 0 ? el.naturalHeight : Math.round(rect.height),
        ...named,
        ...(fallbacks.length === 0 ? {} : { fallbacks }),
      }
    }
  }
  if (el instanceof HTMLCanvasElement) {
    const drawn = canvasDataUrl(el)
    if (drawn !== undefined) return { kind: 'data', dataUrl: drawn, width: el.width, height: el.height, ...named }
  }
  if (el instanceof HTMLVideoElement && el.videoWidth > 0) {
    const frame = videoFrameDataUrl(el)
    if (frame !== undefined) {
      return { kind: 'data', dataUrl: frame, width: el.videoWidth, height: el.videoHeight, ...named }
    }
  }
  const background = backgroundImageUrl(el)
  if (background !== undefined) {
    const rect = el.getBoundingClientRect()
    const box = elementViewportBox(el)
    return {
      kind: 'url',
      url: background,
      ...(box === undefined ? {} : { box }),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      ...named,
    }
  }
  const box = elementViewportBox(el)
  return box === undefined ? undefined : { kind: 'box', box, ...named }
}

function imageName(el: Element): string | undefined {
  const alt = el.getAttribute('alt') ?? el.getAttribute('aria-label') ?? el.getAttribute('title')
  const cleaned = alt === null ? '' : alt.replace(/\s+/g, ' ').trim()
  return cleaned === '' ? undefined : truncate(cleaned, 60).text
}

/** Read back a canvas, tolerating the security error a tainted canvas throws. */
function canvasDataUrl(canvas: HTMLCanvasElement): string | undefined {
  try {
    const url = canvas.toDataURL('image/png')
    return url.startsWith('data:image/') ? url : undefined
  } catch {
    return undefined
  }
}

/** Grab the current video frame; cross-origin media taints the canvas and fails. */
function videoFrameDataUrl(video: HTMLVideoElement): string | undefined {
  try {
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const context = canvas.getContext('2d')
    if (context === null) return undefined
    context.drawImage(video, 0, 0)
    return canvasDataUrl(canvas)
  } catch {
    return undefined
  }
}

/** The single URL of a CSS background image, when the element has exactly one. */
function backgroundImageUrl(el: Element): string | undefined {
  if (!(el instanceof HTMLElement)) return undefined
  const value = getComputedStyle(el).backgroundImage
  if (value === '' || value === 'none') return undefined
  const match = /url\((['"]?)([^'")]+)\1\)/.exec(value)
  const url = match?.[2]
  if (url === undefined || url === '' || url.startsWith('blob:')) return undefined
  try {
    return new URL(url, document.baseURI).href
  } catch {
    return undefined
  }
}

/** An image element and the locator that actually resolved it. */
export interface LocatedImage {
  element: Element
  /** Which of the query's locators found it, so a stale index can be reported. */
  via: 'index' | 'selector' | 'alt'
}

/**
 * Resolve the image element the model asked for.
 *
 * The locators are tried in the order they are trustworthy — index, then
 * selector, then alt text — and a locator that fails falls through to the next
 * rather than failing the read. That is the contract `renderFindResult`
 * advertises ("the selector is used automatically if the page re-rendered") and
 * the one page actions already honour, so an index invalidated by a re-render
 * costs nothing when the model passed both.
 *
 * `isConnected` is checked rather than registry membership alone, for the same
 * reason page actions check it: the registry holds a strong reference, so after
 * a re-render an index still resolves — to a DETACHED node, whose old `src`
 * would be returned as a picture of the current page.
 *
 * @param ids - the stable id registry.
 * @param query - index, selector, or alt-text match.
 * @returns the element and how it was found, or `undefined` when nothing matched.
 */
export function locateImageElement(
  ids: ElementIds,
  query: { index?: number; selector?: string; alt?: string },
): LocatedImage | undefined {
  if (query.index !== undefined) {
    const byIndex = ids.elementByIndex(query.index)
    if (byIndex !== undefined && byIndex.isConnected) return { element: byIndex, via: 'index' }
  }
  if (query.selector !== undefined && query.selector !== '') {
    let found: Element | null
    try {
      found = document.querySelector(query.selector)
    } catch {
      throw new FindError(`selector is not a valid CSS selector: ${query.selector}`)
    }
    if (found !== null) return { element: found, via: 'selector' }
  }
  if (query.alt !== undefined && query.alt !== '') {
    const wanted = normalize(query.alt)
    const candidates = [...document.querySelectorAll('img, canvas, svg, video, picture, [style*="background-image"]')]
    const found = candidates.find((el) => isVisible(el) && searchableText(el).includes(wanted))
    if (found !== undefined) return { element: found, via: 'alt' }
  }
  return undefined
}
