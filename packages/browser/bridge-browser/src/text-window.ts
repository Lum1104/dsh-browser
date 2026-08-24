/**
 * One text-window contract shared by both halves.
 *
 * Every tool that returns page text has to cut it somewhere, and a cut that
 * only says "truncated" loses information for good: the model has no way to ask
 * for the rest, so it either guesses or re-reads the same prefix. A window
 * fixes that — it reports the total, what slice it returned, and the exact call
 * that continues from there.
 *
 * The rule this module encodes: text is never silently dropped. It is either
 * returned, or its absence is stated with the way to get it.
 *
 * @module
 */

/** One returned slice of a larger text. */
export interface TextWindow {
  /** The slice itself. */
  text: string
  /** Character offset the slice starts at. */
  offset: number
  /** Characters in the slice. */
  returned: number
  /** Characters in the whole source. */
  total: number
}

/** Whether a window left anything unread after it. */
export function hasMore(window: TextWindow): boolean {
  return window.offset + window.returned < window.total
}

/**
 * Take a bounded slice of a text.
 *
 * An offset past the end returns an empty slice rather than failing: the model
 * paging forward should learn it reached the end, not lose the call.
 *
 * @param source - the whole text.
 * @param offset - character offset to start at (negative is clamped to 0).
 * @param limit - maximum characters to return (non-positive yields nothing).
 * @returns the window.
 */
export function windowText(source: string, offset: number, limit: number): TextWindow {
  const total = source.length
  const start = Math.min(Math.max(0, Math.floor(offset)), total)
  const size = Math.max(0, Math.floor(limit))
  const text = source.slice(start, start + size)
  return { text, offset: start, returned: text.length, total }
}

/**
 * The footer that makes a window honest: what was returned, what remains, and
 * the call that continues. Returns an empty string when the window is complete,
 * so a full read carries no noise.
 *
 * @param window - the returned window.
 * @param continuation - the exact call that reads the next slice, for example
 *   `browser_get_text({ offset: 40000 })`.
 * @returns the footer text, or `''` when nothing was left out.
 */
export function renderWindowFooter(window: TextWindow, continuation: string): string {
  if (!hasMore(window)) {
    return window.offset > 0
      ? `\n[end of text: characters ${window.offset}-${window.offset + window.returned} of ${window.total}]`
      : ''
  }
  const next = window.offset + window.returned
  return `\n[showing characters ${window.offset}-${next} of ${window.total}; ${window.total - next} remain — continue with ${continuation}]`
}

/**
 * Clamp a caller-supplied window size to a deployment bound.
 * @param requested - what the model asked for, if anything.
 * @param fallback - the default size.
 * @param maximum - the hard bound.
 * @returns the size to use.
 */
export function resolveLimit(requested: unknown, fallback: number, maximum: number): number {
  if (typeof requested !== 'number' || !Number.isFinite(requested) || requested <= 0) return fallback
  return Math.min(Math.floor(requested), maximum)
}

/**
 * Read a caller-supplied offset.
 * @param requested - what the model asked for, if anything.
 * @returns a non-negative integer offset.
 */
export function resolveOffset(requested: unknown): number {
  if (typeof requested !== 'number' || !Number.isFinite(requested) || requested <= 0) return 0
  return Math.floor(requested)
}
