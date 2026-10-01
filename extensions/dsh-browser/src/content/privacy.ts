/**
 * Privacy boundary for page snapshots: sensitive form fields are never echoed.
 *
 * The browser page channel uses text snapshots, so the
 * snapshot is the ONLY representation of a form field's value that reaches the
 * model. Password/credit-card fields are masked to a constant placeholder; the
 * real value never leaves the page.
 *
 * @module
 */

/** Name/id/aria-label fragments that mark a field as sensitive. */
const SENSITIVE_PATTERNS = [
  /password/i,
  /passwd/i,
  /credit/i,
  /card/i,
  /cvv/i,
  /cvc/i,
  /secret/i,
  /pwd/i,
  /otp/i,
  /token/i,
  /api[_-]?key/i,
  /access[_-]?key/i,
  /bearer/i,
  /auth[_-]?code/i,
]

/**
 * Whether a form field must never be echoed back to the model.
 * @param el - the form element (input/select/textarea).
 * @returns true for password inputs, credit-card autocomplete fields, and
 *   fields whose id/name/aria-label matches a sensitive fragment.
 */
export function isSensitiveField(el: Element): boolean {
  if (el instanceof HTMLInputElement) {
    if (el.type === 'password') return true
    const autocomplete = String(el.autocomplete)
    if (autocomplete === 'credit-card' || autocomplete.startsWith('cc-')) return true
  }
  const name = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement
    ? el.name
    : ''
  const haystack = [el.id, name, el.getAttribute('aria-label')].filter(Boolean).join(' ')
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(haystack))
}

/**
 * Mask a sensitive value for snapshots. Non-empty values become a fixed
 * placeholder so the model knows a value is present without learning it.
 * @param value - the field's current value.
 * @returns the masked representation.
 */
export function maskValue(value: string): string {
  return value.length === 0 ? '' : '••••'
}
