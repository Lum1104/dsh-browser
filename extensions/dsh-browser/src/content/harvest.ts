/**
 * Link harvesting for proactive, multi-page work.
 *
 * A search-results page is the one page the model never wants as prose: it
 * wants the outbound links with enough context to choose between them. Parsing
 * per-engine result markup would break on the next redesign, so this harvests
 * generically — every outbound link, its anchor text, and the text around it —
 * and lets the caller filter the engine's own navigation out by host.
 *
 * @module
 */

import { isVisible, truncate } from './extract.ts'

/** One harvested link. */
export interface HarvestedLink {
  url: string
  text: string
  /** Text of the surrounding block, which on a results page is the snippet. */
  context: string
}

/** What to harvest. */
export interface HarvestOptions {
  /** Only links whose host differs from these (the engine's own pages). */
  excludeHosts?: readonly string[]
  /** Restrict the scan to one region. */
  selector?: string
  limit?: number
}

const DEFAULT_LINK_LIMIT = 25
const MAX_LINK_LIMIT = 150
const CONTEXT_CHARS = 320
/** Hosts that never carry a result a reader wants. */
const NEVER_USEFUL = new Set([
  'accounts.google.com',
  'support.google.com',
  'policies.google.com',
  'go.microsoft.com',
  'login.live.com',
  'duckduckgo.com',
])

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function elementText(el: Element): string {
  return el instanceof HTMLElement && typeof el.innerText === 'string' ? el.innerText : el.textContent ?? ''
}

/** The block that carries a link's snippet on a results page. */
function contextFor(link: Element): string {
  const block = link.closest('li, article, .result, [data-testid], section, div') ?? link
  return truncate(normalizeText(elementText(block)), CONTEXT_CHARS).text
}

/**
 * Harvest outbound links in document order, deduplicated by URL.
 *
 * @param options - filtering and budget.
 * @returns the links, best-first in document order.
 */
export function harvestLinks(options: HarvestOptions = {}): HarvestedLink[] {
  const limit = Math.min(MAX_LINK_LIMIT, Math.max(1, options.limit ?? DEFAULT_LINK_LIMIT))
  const excluded = new Set([...(options.excludeHosts ?? []), ...NEVER_USEFUL].map((host) => host.toLowerCase()))
  const root = options.selector === undefined || options.selector === ''
    ? document
    : document.querySelector(options.selector) ?? document
  const seen = new Set<string>()
  const links: HarvestedLink[] = []

  for (const anchor of root.querySelectorAll('a[href]')) {
    if (!(anchor instanceof HTMLAnchorElement)) continue
    let url: URL
    try {
      url = new URL(anchor.href)
    } catch {
      continue
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue
    const host = url.hostname.toLowerCase()
    // A results page links to itself constantly (paging, settings, verticals);
    // the caller passes the engine host so those never reach the model.
    if (excluded.has(host) || [...excluded].some((entry) => host === entry || host.endsWith(`.${entry}`))) continue
    if (seen.has(url.href)) continue
    const text = normalizeText(elementText(anchor))
    if (text === '' || !isVisible(anchor)) continue
    seen.add(url.href)
    links.push({ url: url.href, text: truncate(text, 120).text, context: contextFor(anchor) })
    if (links.length >= limit) break
  }
  return links
}

/**
 * Render harvested links as the model-facing text.
 * @param links - harvested links.
 * @param heading - first line describing the source.
 * @returns model-facing text.
 */
export function renderLinks(links: readonly HarvestedLink[], heading: string): string {
  if (links.length === 0) return `${heading}\n(No outbound links were found. The page may still be loading, or it may require interaction.)`
  const lines = [heading]
  for (const [position, link] of links.entries()) {
    lines.push(`${position + 1}. ${link.text}`)
    lines.push(`   ${link.url}`)
    if (link.context !== '' && link.context !== link.text) lines.push(`   ${link.context}`)
  }
  return lines.join('\n')
}
