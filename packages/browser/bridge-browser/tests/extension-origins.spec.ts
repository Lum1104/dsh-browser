/**
 * Trusted-extension identity drift guard: the manifest `key` must keep
 * hashing to the origin the bridge pins by default. Without this check a
 * regenerated key would silently break zero-config loopback for every
 * shipped install (the extension id would change and fall off the
 * allowlist, forcing token pairing).
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  chromeExtensionIdFromKey,
  DEFAULT_TRUSTED_EXTENSION_ORIGINS,
  STABLE_CHROME_EXTENSION_ID,
} from '../src/extension-origins.ts'

const manifestPath = resolve(import.meta.dirname, '../../../../extensions/dsh-browser/manifest.json')

describe('trusted extension origins', () => {
  it('pins a well-formed 32-char a-p extension id as the sole default', () => {
    expect(STABLE_CHROME_EXTENSION_ID).toMatch(/^[a-p]{32}$/)
    expect(DEFAULT_TRUSTED_EXTENSION_ORIGINS).toEqual([`chrome-extension://${STABLE_CHROME_EXTENSION_ID}`])
  })

  it('derives the pinned id from the extension manifest key (drift guard)', () => {
    // The packed npm package ships without the monorepo's extensions/ tree;
    // the guard only applies where the manifest exists.
    if (!existsSync(manifestPath)) {
      console.warn(`[skip] manifest not found outside the monorepo: ${manifestPath}`)
      return
    }
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { key?: string }
    expect(manifest.key, 'extensions/dsh-browser/manifest.json must carry the key pinned in extension-origins.ts').toBeDefined()
    expect(chromeExtensionIdFromKey(manifest.key as string)).toBe(STABLE_CHROME_EXTENSION_ID)
  })

  it('refuses empty or non-SPKI keys instead of deriving a bogus id', () => {
    expect(chromeExtensionIdFromKey('')).toBeUndefined()
    // Decodes to non-empty bytes that do not start with a DER SEQUENCE tag.
    expect(chromeExtensionIdFromKey('AAAA')).toBeUndefined()
  })
})
