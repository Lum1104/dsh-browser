/**
 * Trusted extension identity for the bridge's zero-config loopback mode.
 *
 * Chromium derives an unpacked extension's id from the manifest `key`
 * (base64 DER SubjectPublicKeyInfo): the first 16 bytes of SHA-256 mapped
 * onto `a`–`p`. Without a `key` the id is derived from the install path and
 * differs on every machine — useless as an identity. The shipped extension
 * therefore pins a stable `key` in `extensions/dsh-browser/manifest.json`,
 * and the bridge pins the matching origin here. Forks and custom builds
 * override the list through the `trustedExtensionOrigins` plugin config.
 *
 * @module @yuxianglin/dsh-bridge-browser/src/extension-origins
 */

import { createHash } from 'node:crypto'

/**
 * Stable Chromium extension id of the shipped dsh-browser extension
 * (SHA-256 over the manifest key's DER SPKI, first 16 bytes, hex→a-p).
 */
export const STABLE_CHROME_EXTENSION_ID = 'ampcoeplakeelcoengijbfbhjnlbdign'

/** Default loopback token exemption: exactly the shipped extension. */
export const DEFAULT_TRUSTED_EXTENSION_ORIGINS: readonly string[] = [
  `chrome-extension://${STABLE_CHROME_EXTENSION_ID}`,
]

/**
 * Derive the Chromium extension id from a manifest `key` value.
 * @param key - base64 DER SubjectPublicKeyInfo from the manifest.
 * @returns the 32-char a-p extension id, or undefined when the key is empty
 *   or does not decode to a DER SEQUENCE (lenient base64 decoding would
 *   otherwise mint a plausible-but-wrong id from truncated garbage).
 */
export function chromeExtensionIdFromKey(key: string): string | undefined {
  const der = Buffer.from(key, 'base64')
  // 0x30 = DER SEQUENCE tag; every SPKI starts with it.
  if (der.length === 0 || der[0] !== 0x30) return undefined
  const hex = createHash('sha256').update(der).digest('hex').slice(0, 32)
  return [...hex].map((nibble) => 'abcdefghijklmnop'[Number.parseInt(nibble, 16)]).join('')
}
