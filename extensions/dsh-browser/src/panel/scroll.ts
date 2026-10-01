/**
 * Scroll helpers for the conversation pane.
 *
 * @module
 */

/** True when the scrollport is within `threshold` px of its bottom edge. */
export function isNearScrollBottom(
  element: Pick<HTMLElement, 'scrollTop' | 'scrollHeight' | 'clientHeight'>,
  threshold = 48,
): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= threshold
}
