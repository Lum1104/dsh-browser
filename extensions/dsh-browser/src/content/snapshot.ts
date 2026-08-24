/**
 * Text-only page snapshot: the model's entire view of the page.
 *
 * DeepSeek models cannot see images, so the snapshot renders the page as
 * structured text under a hard character budget: URL/title, main content, a
 * numbered interactive inventory, and form fields (sensitive values masked).
 * `delta` mode returns only what changed since the last snapshot, and stable
 * element ids keep the model's addressing valid across snapshots.
 *
 * @module
 */

import { accessibleName, collectInteractive, isInViewport, isVisible, mainText, pageText, truncate } from './extract.ts'
import { imageUrlCandidates, isPlaceholderUrl } from './locate.ts'
import { ElementIds } from './ids.ts'
import { isSensitiveField, maskValue } from './privacy.ts'

/** Role label per element kind (model-facing vocabulary). */
function roleOf(el: Element): string {
  const role = el.getAttribute('role')
  if (role !== null && role !== '') return role
  if (el instanceof HTMLAnchorElement) return 'link'
  if (el instanceof HTMLButtonElement) return 'button'
  if (el instanceof HTMLInputElement) {
    switch (el.type) {
      case 'checkbox': return 'checkbox'
      case 'radio': return 'radio'
      default: return 'input'
    }
  }
  if (el instanceof HTMLSelectElement) return 'select'
  if (el instanceof HTMLTextAreaElement) return 'textarea'
  if (el instanceof HTMLElement && el.isContentEditable) return 'contenteditable'
  return el.tagName.toLowerCase()
}

/** One numbered interactive element. */
interface InventoryItem {
  index: number
  role: string
  name: string
  disabled?: boolean
  checked?: boolean
  selected?: boolean
  href?: string
  inViewport: boolean
}

/** One numbered form field with its (masked) value. */
interface FormFieldView {
  index: number
  label: string
  kind: string
  value: string
  masked: boolean
  checked?: boolean
  required?: boolean
}

/** One image on the page the model can ask to see. */
interface ImageView {
  index: number
  name: string
  /** Intrinsic size when loaded, else the rendered box. */
  width: number
  height: number
  /** True when the browser has not fetched it yet (a lazy image below the fold). */
  pending: boolean
  /** Host plus file name of the best candidate, so near-identical images differ. */
  source: string
}

/** One page snapshot. */
export interface SnapshotView {
  version: number
  url: string
  title: string
  ready: 'complete' | 'loading'
  main: string
  items: InventoryItem[]
  forms: FormFieldView[]
  images: ImageView[]
  /** ids that changed since the last snapshot (delta mode). */
  changed: number[]
  /** ids that disappeared since the last snapshot (delta mode). */
  removed: number[]
  /** true when the inventory was renumbered (model should re-read ids). */
  reindexed: boolean
  /** Budget accounting: characters cut from main text and items/forms/images dropped by count caps. */
  truncated: { mainChars: number; itemsDropped: number; formsDropped: number; imagesDropped: number }
  /** 总预算（渲染封顶用）。 */
  budgetChars: number
}

/** Snapshot budgets: negotiated with the plugin via hello caps. */
export interface SnapshotBudget {
  maxItems: number
  maxForms: number
  maxChars: number
  /** Images listed per snapshot. Absent falls back to {@link DEFAULT_MAX_IMAGES}. */
  maxImages?: number
}

/** Default cap on listed images. */
export const DEFAULT_MAX_IMAGES = 40

/**
 * Size floor for an image to be worth listing.
 *
 * Both a side minimum and an area minimum, because neither alone is right: a
 * per-side floor drops wide banners that are genuinely content, and an area
 * floor alone admits 4x600 divider rules. Below both an image is an icon, a
 * spacer, or a tracking pixel, and listing those buries the real pictures.
 */
const MIN_LISTED_IMAGE_SIDE = 32
const MIN_LISTED_IMAGE_AREA = 48 * 48

/** Options for one snapshot build. */
export interface SnapshotOptions {
  delta?: boolean
  region?: string
  /**
   * Read the whole document body instead of the main-content heuristic.
   *
   * The heuristic picks ONE container, so a page whose content is spread across
   * siblings loses the rest silently — which is exactly the failure a model
   * cannot detect. `full` trades density for completeness.
   */
  full?: boolean
  budget: SnapshotBudget
}

/** Headline for a link: same-origin relative path, else host + path. */
function hrefHeadline(href: string): string {
  try {
    const url = new URL(href, document.baseURI)
    return url.origin === location.origin ? `${url.pathname}${url.search}` : `${url.host}${url.pathname}`
  } catch {
    return href
  }
}

/**
 * Build a snapshot of the current page.
 *
 * Reconciles the stable id registry, collects the inventory (viewport-first,
 * capped), extracts main content (budgeted), and — in delta mode — diffs
 * against the previous snapshot.
 *
 * @param ids - the stable id registry (one per content-script lifetime).
 * @param options - delta flag, region selector, and negotiated budgets.
 * @param last - previous snapshot view, or null for the first snapshot.
 * @returns the snapshot view.
 */
export function buildSnapshot(ids: ElementIds, options: SnapshotOptions, last: SnapshotView | null): SnapshotView {
  const elements = collectInteractive(document)
  const { added, removed } = ids.assign(elements)
  // A renumbering is only meaningful relative to a previous snapshot: the
  // first snapshot on a fresh document always adds everything.
  const reindexed = last !== null && added + removed > elements.length * 0.5

  // Measure viewport membership once. Calling getBoundingClientRect from a
  // sort comparator forces repeated layout reads on large pages.
  const elementViews = elements.map((element) => ({ element, inViewport: isInViewport(element) }))
  const ordered = [...elementViews].sort((a, b) => Number(b.inViewport) - Number(a.inViewport))
  const names = new Map<Element, string>()
  const nameOf = (element: Element): string => {
    let name = names.get(element)
    if (name === undefined) {
      name = accessibleName(element)
      names.set(element, name)
    }
    return name
  }

  const items: InventoryItem[] = []
  for (const { element: el, inViewport } of ordered.slice(0, options.budget.maxItems)) {
    const index = ids.indexOf(el)
    if (index === undefined) continue
    const item: InventoryItem = {
      index,
      role: roleOf(el),
      name: nameOf(el),
      inViewport,
    }
    if (el instanceof HTMLButtonElement && el.disabled) item.disabled = true
    if (el instanceof HTMLInputElement) {
      if (el.disabled) item.disabled = true
      if (el.type === 'checkbox' || el.type === 'radio') item.checked = el.checked
    }
    const ariaChecked = el.getAttribute('aria-checked')
    if (ariaChecked === 'true' || ariaChecked === 'false') item.checked = ariaChecked === 'true'
    if (el instanceof HTMLOptionElement && el.selected) item.selected = true
    if (el instanceof HTMLAnchorElement && el.href !== '') item.href = hrefHeadline(el.href)
    items.push(item)
  }

  // Images are not interactive, so they are absent from the inventory above —
  // which meant the model could not tell a page HAD pictures, let alone ask to
  // see one. They get their own numbered section, sharing the id registry so a
  // listed index is directly usable with browser_read_image.
  const imageElements = collectImages(document, options.budget.maxImages ?? DEFAULT_MAX_IMAGES)
  if (imageElements.kept.length > 0) ids.assign([...elements, ...imageElements.kept])
  const images: ImageView[] = []
  for (const el of imageElements.kept) {
    const index = ids.indexOf(el)
    if (index === undefined) continue
    images.push(imageView(index, el, nameOf(el)))
  }

  // Form controls are already part of the visible interactive inventory, so
  // reuse that scan instead of querying, styling, and measuring them again.
  const formElements = elements.filter((el) => el instanceof HTMLInputElement
    || el instanceof HTMLSelectElement
    || el instanceof HTMLTextAreaElement)
  const forms: FormFieldView[] = []
  for (const el of formElements.slice(0, options.budget.maxForms)) {
    const index = ids.indexOf(el)
    if (index === undefined) continue
    const masked = isSensitiveField(el)
    const checkable = el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')
    const value = checkable
      ? ''
      : el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
      ? el.value
      : el instanceof HTMLSelectElement
        ? selectedText(el)
        : ''
    forms.push({
      index,
      label: nameOf(el),
      kind: el instanceof HTMLInputElement ? el.type : el.tagName.toLowerCase(),
      value: masked ? maskValue(value) : value.slice(0, 120),
      masked,
      ...checkable ? { checked: el.checked } : {},
      ...el instanceof HTMLInputElement && el.required ? { required: true } : {},
    })
  }

  const regionEl = options.region !== undefined && options.region !== ''
    ? document.querySelector(options.region)
    : null
  const mainSource = regionEl !== null
    ? pageText(regionEl)
    : options.full === true ? pageText(document.body) : mainText(document)
  // A full read is the caller asking for everything, so it gets most of the
  // budget; the balanced split exists to keep the numbered inventory visible
  // on a text-heavy page, not to ration the page itself.
  const mainBudget = Math.floor(options.budget.maxChars * (options.full === true ? 0.8 : 0.6))
  const main = truncate(mainSource, mainBudget)

  const lastItems = last === null ? new Map<number, InventoryItem>() : new Map(last.items.map((item) => [item.index, item]))
  const lastForms = last === null ? new Map<number, FormFieldView>() : new Map(last.forms.map((form) => [form.index, form]))

  const changed = new Set<number>()
  const removedIds: number[] = []
  if (options.delta === true && last !== null) {
    if (last.main !== main.text || last.url !== location.href || last.title !== document.title) {
      changed.add(-1) // -1 = 正文/标题/URL 变化（渲染时说明）
    }
    for (const item of items) {
      const before = lastItems.get(item.index)
      if (before === undefined || !sameItem(before, item)) changed.add(item.index)
    }
    const currentItemIds = new Set(items.map((item) => item.index))
    for (const index of lastItems.keys()) {
      if (!currentItemIds.has(index)) removedIds.push(index)
    }
    for (const form of forms) {
      const before = lastForms.get(form.index)
      if (before === undefined || !sameForm(before, form)) changed.add(form.index)
    }
    const lastImages = new Map(last.images.map((image) => [image.index, image]))
    for (const image of images) {
      const before = lastImages.get(image.index)
      if (before === undefined || !sameImage(before, image)) changed.add(image.index)
    }
  }

  return {
    version: (last?.version ?? 0) + 1,
    url: location.href,
    title: document.title,
    ready: document.readyState === 'complete' ? 'complete' : 'loading',
    main: main.text,
    items,
    forms,
    images,
    changed: options.delta === true ? [...changed] : [],
    removed: options.delta === true ? removedIds : [],
    reindexed,
    truncated: {
      mainChars: main.truncated,
      itemsDropped: Math.max(0, elements.length - options.budget.maxItems),
      formsDropped: Math.max(0, formElements.length - options.budget.maxForms),
      imagesDropped: imageElements.dropped,
    },
    budgetChars: options.budget.maxChars,
  }
}

/**
 * Pictures worth listing, in document order.
 *
 * Filtered by rendered size rather than by attribute, because a lazy image has
 * no natural size yet but does occupy its box — and a tracking pixel occupies
 * almost none however it is marked up.
 */
function collectImages(doc: Document, limit: number): { kept: Element[]; dropped: number } {
  const kept: Element[] = []
  let dropped = 0
  for (const el of doc.querySelectorAll('img, canvas')) {
    if (!isVisible(el)) continue
    const rect = el.getBoundingClientRect()
    if (rect.width < MIN_LISTED_IMAGE_SIDE || rect.height < MIN_LISTED_IMAGE_SIDE) continue
    if (rect.width * rect.height < MIN_LISTED_IMAGE_AREA) continue
    if (kept.length >= limit) {
      dropped += 1
      continue
    }
    kept.push(el)
  }
  return { kept, dropped }
}

/** Host and file name of the best candidate URL, for telling images apart. */
function imageSourceLabel(el: Element): string {
  const [best] = imageUrlCandidates(el)
  if (best === undefined) return el.tagName.toLowerCase()
  try {
    const url = new URL(best)
    const file = url.pathname.split('/').filter((part) => part !== '').pop() ?? ''
    return truncate(`${url.host}/${decodeURIComponent(file)}`, 70).text
  } catch {
    return truncate(best, 70).text
  }
}

function imageView(index: number, el: Element, name: string): ImageView {
  const rect = el.getBoundingClientRect()
  const loaded = el instanceof HTMLImageElement && el.naturalWidth > 0
  const [best] = imageUrlCandidates(el)
  return {
    index,
    name,
    width: loaded ? (el as HTMLImageElement).naturalWidth : Math.round(rect.width),
    height: loaded ? (el as HTMLImageElement).naturalHeight : Math.round(rect.height),
    // Either the browser has not fetched it, or the only candidate IS a
    // placeholder — both mean what is on screen is not the picture.
    pending: (el instanceof HTMLImageElement && !loaded) || (best !== undefined && isPlaceholderUrl(best)),
    source: imageSourceLabel(el),
  }
}

function selectedText(select: HTMLSelectElement): string {
  return [...select.selectedOptions].map((option) => option.textContent ?? '').join(', ')
}

function sameItem(a: InventoryItem, b: InventoryItem): boolean {
  return a.role === b.role && a.name === b.name && a.href === b.href
    && a.disabled === b.disabled && a.checked === b.checked && a.inViewport === b.inViewport
}

function sameImage(a: ImageView, b: ImageView): boolean {
  return a.name === b.name && a.width === b.width && a.height === b.height
    && a.pending === b.pending && a.source === b.source
}

function sameForm(a: FormFieldView, b: FormFieldView): boolean {
  return a.label === b.label && a.kind === b.kind && a.value === b.value && a.masked === b.masked
    && a.checked === b.checked && a.required === b.required
}

/**
 * Render a snapshot as the model-facing text (the whole snapshot is one text
 * block; no images anywhere).
 * @param view - snapshot to render.
 * @param delta - whether this is a delta render (changes only).
 * @param maxChars - optional render cap for compact derivative responses.
 * @returns the text payload.
 */
/** 渲染结果的整体预算：主文/清单之外的部分（标题、URL、包装行）也计入。 */
function capRendered(text: string, budgetChars: number): string {
  if (text.length <= budgetChars) return text
  return `${text.slice(0, budgetChars)}…(truncated to the snapshot character budget)`
}

function renderItem(item: InventoryItem): string {
  const state = [
    item.disabled === true ? 'disabled' : undefined,
    item.checked === undefined ? undefined : item.checked ? 'checked' : 'unchecked',
    item.inViewport ? undefined : 'outside viewport',
  ].filter((value) => value !== undefined).join('/')
  const stateText = state === '' ? '' : ` [${state}]`
  const hrefText = item.href !== undefined ? ` → ${item.href}` : ''
  return `  [${item.index}] ${item.role} "${item.name}"${stateText}${hrefText}`
}

function renderForm(form: FormFieldView, includeIdentity: boolean): string {
  const identity = includeIdentity ? `${form.label} (${form.kind}) ` : ''
  const state = form.checked === undefined
    ? `value="${form.masked ? '••••' : form.value}"`
    : `checked=${String(form.checked)}`
  return `  [${form.index}] ${identity}${state}${form.required === true ? ' required' : ''}`
}

function renderImage(image: ImageView): string {
  const size = `${image.width}x${image.height}`
  const state = image.pending ? ' [not loaded yet — a placeholder is on screen]' : ''
  return `  [${image.index}] image "${image.name}" ${size}${state} — ${image.source}`
}

function appendTruncationNotes(lines: string[], view: SnapshotView): void {
  const notes: string[] = []
  if (view.truncated.mainChars > 0) notes.push(`Main content truncated by ${view.truncated.mainChars} characters`)
  if (view.truncated.itemsDropped > 0) notes.push(`${view.truncated.itemsDropped} additional elements omitted`)
  if (view.truncated.formsDropped > 0) notes.push(`${view.truncated.formsDropped} additional form fields omitted`)
  if (view.truncated.imagesDropped > 0) notes.push(`${view.truncated.imagesDropped} additional images omitted`)
  if (notes.length > 0) {
    lines.push(`\n(${notes.join('; ')}. Nothing is lost: browser_get_text({ offset }) pages through the full text, `
      + `region narrows the read, and browser_snapshot({ full: true }) bypasses the main-content heuristic.)`)
  }
}

export function renderSnapshot(view: SnapshotView, delta: boolean, maxChars: number = view.budgetChars): string {
  const lines: string[] = []
  if (delta) {
    lines.push(`Page change v${view.version} (${view.url})`)
    const elementChanges = view.changed.filter((id) => id !== -1)
    const changedIds = new Set(elementChanges)
    const changedItems = view.items.filter((item) => changedIds.has(item.index))
    const changedForms = view.forms.filter((form) => changedIds.has(form.index))

    lines.push(`Status: ${view.ready}${view.reindexed ? ' (element indices were reassigned; use the indices in this snapshot)' : ''}`)
    if (view.changed.includes(-1)) {
      lines.push(`Title: ${view.title || '(untitled)'}`)
      if (view.main.length > 0) {
        lines.push('')
        lines.push('Changed main content:')
        lines.push(view.main)
      }
    }
    if (changedItems.length > 0) {
      lines.push('')
      lines.push('Changed interactive elements:')
      for (const item of changedItems) lines.push(renderItem(item))
    }
    if (changedForms.length > 0) {
      lines.push('')
      lines.push('Changed form fields:')
      const renderedItems = new Set(changedItems.map((item) => item.index))
      for (const form of changedForms) lines.push(renderForm(form, !renderedItems.has(form.index)))
    }
    const changedImages = view.images.filter((image) => changedIds.has(image.index))
    if (changedImages.length > 0) {
      lines.push('')
      lines.push('Changed images:')
      for (const image of changedImages) lines.push(renderImage(image))
    }
    if (view.removed.length > 0) lines.push(`Removed elements: ${view.removed.join(', ')}`)
    if (view.changed.length === 0 && view.removed.length === 0) lines.push('(No visible changes.)')
    appendTruncationNotes(lines, view)
    return capRendered(lines.join('\n'), maxChars)
  }
  lines.push(`Title: ${view.title || '(untitled)'}`)
  lines.push(`URL: ${view.url}`)
  lines.push(`Status: ${view.ready}${view.reindexed ? ' (element indices were reassigned; use the indices in this snapshot)' : ''}`)
  if (view.main.length > 0) {
    lines.push('')
    lines.push('Main content:')
    lines.push(view.main)
  }
  if (view.items.length > 0) {
    lines.push('')
    lines.push('Interactive elements:')
    for (const item of view.items) lines.push(renderItem(item))
  }
  if (view.forms.length > 0) {
    lines.push('')
    lines.push('Form fields:')
    const renderedItems = new Set(view.items.map((item) => item.index))
    for (const form of view.forms) {
      lines.push(renderForm(form, !renderedItems.has(form.index)))
    }
  }
  if (view.images.length > 0) {
    lines.push('')
    lines.push('Images (read one with browser_read_image({ index }), or several with { indices: [...] }):')
    for (const image of view.images) lines.push(renderImage(image))
  }
  appendTruncationNotes(lines, view)
  return capRendered(lines.join('\n'), maxChars)
}
