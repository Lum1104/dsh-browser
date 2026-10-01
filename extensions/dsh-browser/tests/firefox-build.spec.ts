// @vitest-environment jsdom
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { appendConnectSrc } from '../src/connect-src.ts'

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

describe('Firefox build contract', () => {
  it('keeps release metadata and shared capabilities aligned with Chrome', async () => {
    const [chromeManifest, firefoxManifest, packageManifest] = await Promise.all([
      readJson<ExtensionManifest>('../manifest.json'),
      readJson<ExtensionManifest>('../manifest.firefox.json'),
      readJson<{ version: string }>('../package.json'),
    ])

    expect(firefoxManifest.version).toBe(packageManifest.version)
    expect(firefoxManifest.version).toBe(chromeManifest.version)
    expect(firefoxManifest.permissions).toContain('notifications')
    expect(firefoxManifest.content_security_policy.extension_pages).toMatch(/\bhttps:/)
  })

  it('uses a Firefox event page, sidebar, and AMO data-transmission declaration', async () => {
    const manifest = await readJson<ExtensionManifest>('../manifest.firefox.json')

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

  it('allows any ws/http(s) host via scheme sources so panel settings can target a LAN bridge', async () => {
    const chromeManifest = await readJson<ExtensionManifest>('../manifest.json')
    const base = chromeManifest.content_security_policy.extension_pages
    expect(base).toContain('ws:')
    expect(base).toContain('wss:')
    expect(base).toContain('http:')
    expect(base).toContain('https:')
    expect(base).not.toContain('192.168.2.185')

    const patched = appendConnectSrc(base, 'ws://192.168.2.185:* http://192.168.2.185:*')
    expect(patched).toContain('ws:')
    expect(patched).toContain('ws://192.168.2.185:*')
    expect(patched).toContain('http://192.168.2.185:*')
    expect(appendConnectSrc(patched, 'ws://192.168.2.185:*')).toBe(patched)
  })
})
