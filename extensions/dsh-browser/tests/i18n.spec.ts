// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getUiLocale, localeFromLanguage } from '../src/i18n.ts'
import { PANEL_COPY } from '../src/panel/strings.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('browser locale selection', () => {
  it('uses Chinese for every zh locale variant', () => {
    expect(localeFromLanguage('zh')).toBe('zh')
    expect(localeFromLanguage('zh-CN')).toBe('zh')
    expect(localeFromLanguage('zh-TW')).toBe('zh')
    expect(localeFromLanguage('ZH-hant-HK')).toBe('zh')
  })

  it('defaults every non-Chinese or missing locale to English', () => {
    expect(localeFromLanguage('en-US')).toBe('en')
    expect(localeFromLanguage('ja-JP')).toBe('en')
    expect(localeFromLanguage('fr')).toBe('en')
    expect(localeFromLanguage(undefined)).toBe('en')
  })

  it('uses the browser\'s first preferred language', () => {
    vi.stubGlobal('navigator', { languages: ['zh-Hant', 'en-US'], language: 'en-US' })
    expect(getUiLocale()).toBe('zh')

    vi.stubGlobal('navigator', { languages: ['de-DE', 'zh-CN'], language: 'de-DE' })
    expect(getUiLocale()).toBe('en')
  })

  it('provides localized panel and prompt copy in both languages', () => {
    expect(PANEL_COPY.en.app.newSession).toBe('New chat')
    expect(PANEL_COPY.en.app.overviewPage).toBe('Give me an overview')
    expect(PANEL_COPY.en.approval.allowOnce).toBe('Allow once')
    expect(PANEL_COPY.en.settings.unrestrictedBrowserAccess).toBe('Allow unrestricted browser control')
    expect(PANEL_COPY.en.app.overviewPrompt).toMatch(/^First give me an overview/)
    expect(PANEL_COPY.zh.app.newSession).toBe('新对话')
    expect(PANEL_COPY.zh.app.overviewPage).toBe('先概览这个页面')
    expect(PANEL_COPY.zh.approval.allowOnce).toBe('仅允许这一次')
    expect(PANEL_COPY.zh.settings.unrestrictedBrowserAccess).toBe('允许模型完全控制浏览器')
  })
})
