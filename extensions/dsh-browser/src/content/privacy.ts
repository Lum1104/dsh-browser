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
]

/**
 * Whether an `autocomplete` attribute marks the field as payment-related.
 *
 * The HTML attribute is a case-insensitive space-separated token list, so
 * real checkout markup like `section-checkout billing cc-number` must be
 * tokenized before matching — a whole-string `startsWith('cc-')` check
 * silently misses every multi-token value.
 *
 * @param autocomplete - raw `autocomplete` attribute value.
 * @returns true when any token is `credit-card` or a `cc-*` detail token.
 */
function hasPaymentAutocompleteToken(autocomplete: string): boolean {
  const tokens = autocomplete.trim().toLowerCase().split(/\s+/)
  return tokens.includes('credit-card') || tokens.some((token) => token.startsWith('cc-'))
}

/**
 * Whether a form field must never be echoed back to the model.
 * @param el - the form element (input/select/textarea).
 * @returns true for password inputs, credit-card autocomplete fields, and
 *   fields whose id/name/aria-label matches a sensitive fragment.
 */
export function isSensitiveField(el: Element): boolean {
  if (el instanceof HTMLInputElement) {
    if (el.type === 'password') return true
    // Read the CONTENT attribute, not the IDL property: Chrome's
    // `autocomplete` getter is limited to known values and returns '' for
    // token lists it cannot parse ('cc-number foo', 'bogus cc-number'), so
    // the IDL would silently drop markup the mask must see.
    if (hasPaymentAutocompleteToken(el.getAttribute('autocomplete') ?? '')) return true
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
