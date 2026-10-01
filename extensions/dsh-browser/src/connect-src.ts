/**
 * Manifest CSP helpers used by the extension build and its unit tests.
 * Kept free of Vite imports so vitest can load it under jsdom.
 */

/**
 * Append space/comma-separated tokens to a CSP `connect-src` directive.
 * Duplicates are skipped so rebuilds with the same EXT_CONNECT_SRC stay stable.
 */
export function appendConnectSrc(csp: string, extras: string): string {
  const tokens = extras.split(/[\s,]+/).map((token) => token.trim()).filter((token) => token !== '')
  if (tokens.length === 0) return csp
  const match = /connect-src\s+([^;]+)/.exec(csp)
  if (match === null) return csp
  const existing = match[1]!.trim().split(/\s+/).filter((token) => token !== '')
  const merged = [...existing]
  for (const token of tokens) {
    if (!merged.includes(token)) merged.push(token)
  }
  return csp.replace(/connect-src\s+[^;]+/, `connect-src ${merged.join(' ')}`)
}
