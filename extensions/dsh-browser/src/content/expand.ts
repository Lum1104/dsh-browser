/**
 * Reveal what a page is hiding: disclosure controls and lazily loaded content.
 *
 * Half the text on a modern page is behind "show more", a collapsed accordion,
 * or an infinite scroll that has not been reached yet. A model that only
 * snapshots sees the visible slice and concludes the rest does not exist, so
 * this expands the page first and reports how much appeared.
 *
 * Expansion CLICKS things, which is why it is deliberately conservative: only
 * controls that look like disclosure, never anything that reads as destructive
 * or transactional, never a link that leaves the page, and it stops the moment
 * the document starts navigating.
 *
 * @module
 */

import { isVisible } from './extract.ts'

/** What one expansion pass did. */
export interface ExpandResult {
  expanded: number
  rounds: number
  /** Pixels the document grew through lazy loading. */
  grewBy: number
  /** Characters of readable text gained. */
  textGained: number
  /** Set when expansion stopped early because the page began navigating. */
  navigated: boolean
}

export interface ExpandOptions {
  /** How many expand-then-rescan rounds to run. */
  maxRounds: number
  /** Also scroll to the bottom to trigger lazily loaded content. */
  scroll: boolean
  /** Cap on controls clicked per round. */
  maxPerRound: number
}

export const DEFAULT_EXPAND_OPTIONS: ExpandOptions = { maxRounds: 3, scroll: true, maxPerRound: 25 }

/** Text on a control that means "there is more of this". */
const DISCLOSURE_TEXT = /(show|see|view|read|load|expand)\s+(more|all|full|rest)|more\b.*\b(comments|replies|results|items)|展开|收起以外|查看更多|显示更多|加载更多|更多内容|全部展开|阅读全文/i

/**
 * Text that must never be auto-clicked. Expansion is a convenience; a
 * mis-click here is a purchase, a deletion, or a session change, so the filter
 * is broad on purpose and false negatives are the acceptable failure.
 */
const NEVER_CLICK = /\b(delete|remove|buy|purchase|pay|checkout|order|submit|send|post|publish|confirm|sign\s?(in|up|out)|log\s?(in|out)|subscribe|unsubscribe|cancel|apply|install|download)\b|删除|移除|购买|支付|结算|下单|提交|发送|发布|确认|登录|注册|退出|订阅|退订|取消|安装|下载/i

/** Selectors for controls that disclose more of the same page. */
const DISCLOSURE_SELECTOR = [
  'details:not([open]) > summary',
  '[aria-expanded="false"]',
  'button',
  '[role="button"]',
  'a[href="#"]',
  'a[href=""]',
  'a:not([href])',
].join(', ')

function textOf(el: Element): string {
  const own = el instanceof HTMLElement && typeof el.innerText === 'string' ? el.innerText : el.textContent ?? ''
  const labelled = el.getAttribute('aria-label') ?? el.getAttribute('title') ?? ''
  return `${own} ${labelled}`.replace(/\s+/g, ' ').trim()
}

function readableLength(): number {
  return (document.body instanceof HTMLElement && typeof document.body.innerText === 'string'
    ? document.body.innerText
    : document.body?.textContent ?? '').length
}

/**
 * Whether this element is a disclosure control worth clicking.
 *
 * `aria-expanded="false"` is authoritative — the page itself says it is
 * collapsed — so it passes on the attribute alone. Everything else has to look
 * like disclosure in its text AND not look dangerous.
 */
export function isDisclosureControl(el: Element): boolean {
  if (!isVisible(el)) return false
  if (el instanceof HTMLButtonElement && el.disabled) return false
  const text = textOf(el)
  if (NEVER_CLICK.test(text)) return false
  // A link that navigates is not disclosure, whatever its text says.
  if (el instanceof HTMLAnchorElement) {
    const href = el.getAttribute('href')
    if (href !== null && href !== '' && href !== '#') return false
  }
  // A submit button INSIDE a form posts it, and expanding must never do that.
  // The test has to include the form check: `button.type` defaults to
  // `submit`, so testing the property alone would reject every plain button.
  if (el instanceof HTMLButtonElement && el.type !== 'button' && el.closest('form') !== null) return false
  if (el.getAttribute('aria-expanded') === 'false') return true
  if (el.tagName === 'SUMMARY') return true
  return DISCLOSURE_TEXT.test(text)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/**
 * Expand the page in place.
 *
 * @param options - rounds, scrolling, and the per-round click cap.
 * @param settle - awaited after each round so the page can render what it revealed.
 * @returns what changed.
 */
export async function expandPage(
  options: ExpandOptions = DEFAULT_EXPAND_OPTIONS,
  settle: () => Promise<unknown> = () => sleep(120),
): Promise<ExpandResult> {
  const startUrl = location.href
  const startHeight = document.documentElement.scrollHeight
  const startText = readableLength()
  const clicked = new WeakSet<Element>()
  let expanded = 0
  let rounds = 0
  let navigated = false

  for (let round = 0; round < options.maxRounds; round += 1) {
    rounds = round + 1
    let clickedThisRound = 0
    for (const el of document.querySelectorAll(DISCLOSURE_SELECTOR)) {
      if (clickedThisRound >= options.maxPerRound) break
      if (clicked.has(el)) continue
      if (!isDisclosureControl(el)) continue
      clicked.add(el)
      try {
        (el as HTMLElement).click()
        expanded += 1
        clickedThisRound += 1
      } catch {
        // A control that throws on click is simply not expandable.
      }
    }

    if (options.scroll) {
      const before = document.documentElement.scrollHeight
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' })
      await settle()
      // A page that stopped growing has no more lazy content to give.
      if (document.documentElement.scrollHeight === before && clickedThisRound === 0) break
    } else {
      if (clickedThisRound === 0) break
      await settle()
    }

    if (location.href !== startUrl) {
      navigated = true
      break
    }
  }

  if (options.scroll) window.scrollTo({ top: 0, behavior: 'instant' })
  return {
    expanded,
    rounds,
    grewBy: Math.max(0, document.documentElement.scrollHeight - startHeight),
    textGained: Math.max(0, readableLength() - startText),
    navigated,
  }
}

/**
 * Render an expansion as the model-facing status line.
 * @param result - what the pass did.
 * @returns model-facing text.
 */
export function renderExpandResult(result: ExpandResult): string {
  if (result.navigated) {
    return `Expanded ${result.expanded} control(s), then the page navigated away. Take a browser_snapshot to see where it went.`
  }
  if (result.expanded === 0 && result.grewBy === 0) {
    return 'Nothing was collapsed or lazily loaded on this page; the current snapshot already has all of it.'
  }
  const parts = [`Expanded ${result.expanded} control(s) over ${result.rounds} round(s)`]
  if (result.grewBy > 0) parts.push(`the page grew by ${result.grewBy}px of lazily loaded content`)
  if (result.textGained > 0) parts.push(`${result.textGained} more characters of text are now readable`)
  return `${parts.join('; ')}. Read it with browser_snapshot or browser_get_text.`
}
