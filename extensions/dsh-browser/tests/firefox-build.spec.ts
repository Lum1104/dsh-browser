// @vitest-environment jsdom
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { composeManifest } from '../manifest.compose.ts'

interface ExtensionManifest {
  version: string
  permissions: string[]
  background: Record<string, unknown>
  content_security_policy: { extension_pages: string }
  browser_specific_settings?: {
    gecko?: {
      strict_min_version?: string
      data_collection_permissions?: { required?: string[] }
    }
  }
  sidebar_action?: { default_panel?: string; open_at_install?: boolean }
}

async function readJson<T>(relativePath: string): Promise<T> {
  return JSON.parse(await readFile(new URL(relativePath, import.meta.url), 'utf8')) as T
}

/** manifest.firefox.json is a delta now; the shipped manifest is composed. */
function shipped(target: 'chrome' | 'firefox'): ExtensionManifest {
  return composeManifest(target) as unknown as ExtensionManifest
}

describe('Firefox build contract', () => {
  it('keeps release metadata and shared capabilities aligned with Chrome', async () => {
    const chromeManifest = shipped('chrome')
    const firefoxManifest = shipped('firefox')
    const packageManifest = await readJson<{ version: string }>('../package.json')

    expect(firefoxManifest.version).toBe(packageManifest.version)
    expect(firefoxManifest.version).toBe(chromeManifest.version)
    expect(firefoxManifest.permissions).toContain('notifications')
    expect(firefoxManifest.content_security_policy.extension_pages).toContain('https://raw.githubusercontent.com')
  })

  it('uses a Firefox event page, sidebar, and AMO data-transmission declaration', async () => {
    const manifest = shipped('firefox')

    expect(manifest.background).toEqual({ scripts: ['background.js'] })
    expect(manifest.sidebar_action).toMatchObject({
      default_panel: 'panel/index.html',
      open_at_install: false,
    })
    expect(Number(manifest.browser_specific_settings?.gecko?.strict_min_version?.split('.')[0])).toBeGreaterThanOrEqual(140)
    expect(manifest.browser_specific_settings?.gecko?.data_collection_permissions?.required?.sort()).toEqual([
      'browsingActivity',
      'personalCommunications',
      'websiteActivity',
      'websiteContent',
    ])
  })
})
