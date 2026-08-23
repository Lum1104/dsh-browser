// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  composeManifest,
  EXTENSION_TARGETS,
  TARGET_OUT_DIR,
  type ExtensionTarget,
} from '../manifest.compose.ts'

interface ComposedManifest {
  version: string
  name: string
  permissions: string[]
  background: Record<string, unknown>
  content_security_policy: { extension_pages: string }
  icons: Record<string, string>
  side_panel?: unknown
  sidebar_action?: { default_panel?: string }
  minimum_chrome_version?: string
  browser_specific_settings?: Record<string, unknown>
}

function compose(target: ExtensionTarget): ComposedManifest {
  return composeManifest(target) as unknown as ComposedManifest
}

describe('composed per-browser manifests', () => {
  it('gives every target its own output directory', () => {
    expect(new Set(Object.values(TARGET_OUT_DIR)).size).toBe(EXTENSION_TARGETS.length)
  })

  it('ships each browser only the panel key it understands', () => {
    // Chrome warns "Unrecognized manifest key 'sidebar_action'" on every
    // unpacked install, and this project is only ever loaded unpacked, so a
    // foreign key here is visible to every single user.
    const chrome = compose('chrome')
    expect(chrome.side_panel).toBeDefined()
    expect(chrome.sidebar_action).toBeUndefined()

    for (const target of ['firefox', 'opera'] as const) {
      const manifest = compose(target)
      expect(manifest.sidebar_action?.default_panel).toBe('panel/index.html')
      expect(manifest.side_panel).toBeUndefined()
    }
  })

  it('asks for the sidePanel permission only where the API exists', () => {
    expect(compose('chrome').permissions).toContain('sidePanel')
    expect(compose('firefox').permissions).not.toContain('sidePanel')
    expect(compose('opera').permissions).not.toContain('sidePanel')
  })

  it('keeps shared metadata identical across targets by construction', () => {
    const packageVersion = (JSON.parse(
      readFileSync(`${process.cwd()}/package.json`, 'utf8'),
    ) as { version: string }).version
    const composed = EXTENSION_TARGETS.map((target) => compose(target))

    for (const manifest of composed) {
      expect(manifest.version).toBe(packageVersion)
      expect(manifest.name).toBe(composed[0].name)
      expect(manifest.icons).toEqual(composed[0].icons)
      expect(manifest.content_security_policy).toEqual(composed[0].content_security_policy)
      expect(manifest.permissions).toContain('notifications')
    }
  })

  it('gives each engine the background form it accepts', () => {
    // A recursive merge produced service_worker, type and scripts together,
    // which is not a manifest either engine accepts.
    expect(compose('chrome').background).toEqual({ service_worker: 'background.js', type: 'module' })
    expect(compose('opera').background).toEqual({ service_worker: 'background.js', type: 'module' })
    expect(compose('firefox').background).toEqual({ scripts: ['background.js'] })
  })

  it('keeps Chrome-only keys out of Firefox', () => {
    const firefox = compose('firefox')
    expect(firefox.minimum_chrome_version).toBeUndefined()
    expect(firefox.browser_specific_settings).toBeDefined()
    expect(compose('chrome').browser_specific_settings).toBeUndefined()
  })

  it('keeps the committed Chrome manifest as the composed base', () => {
    // The in-panel update check fetches this exact path from main to read the
    // published version, so it has to stay a real manifest, not a delta.
    const committed = JSON.parse(readFileSync(`${process.cwd()}/manifest.json`, 'utf8')) as ComposedManifest
    expect(committed).toEqual(compose('chrome'))
  })
})
