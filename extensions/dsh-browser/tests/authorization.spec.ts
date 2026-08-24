// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { approvalPromptForCall, originFromUrl } from '../src/background/authorization.ts'
import type { TabFrame } from '../src/background/frames.ts'
import type { ToolCall } from '../src/background/tools.ts'

const FRAMES: TabFrame[] = [
  { frameId: 0, parentFrameId: -1, documentId: 'top', url: 'https://app.example/page' },
  { frameId: 4, parentFrameId: 0, documentId: 'child', url: 'https://login.example.net/form' },
  { frameId: 5, parentFrameId: 4, documentId: 'about', url: 'about:blank' },
]

function call(name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id: 'call', name, args }
}

describe('approvalPromptForCall', () => {
  it('asks before reading and names every effective frame origin', () => {
    expect(approvalPromptForCall(call('browser_snapshot'), 'ask', FRAMES, 'zh')).toMatchObject({
      kind: 'read',
      origins: ['https://app.example', 'https://login.example.net'],
      canTrust: false,
    })
    expect(approvalPromptForCall(call('browser_snapshot'), 'auto', FRAMES, 'zh')).toBeUndefined()
  })

  it('scopes a frame-local action to the frame origin and redacts typed text', () => {
    const prompt = approvalPromptForCall(call('browser_type', {
      frame: 4,
      index: 7,
      text: 'my-password-must-not-appear',
    }), 'auto', FRAMES, 'zh')

    expect(prompt).toMatchObject({
      kind: 'action',
      origins: ['https://login.example.net'],
      canTrust: true,
    })
    expect(prompt?.summary).toContain('27 个字符')
    expect(prompt?.summary).not.toContain('my-password')
  })

  it('never offers persistent trust for cross-origin navigation', () => {
    const prompt = approvalPromptForCall(call('browser_navigate', {
      url: 'https://bank.example/transfer?token=secret#confirm',
    }), 'auto', FRAMES, 'zh')

    expect(prompt).toMatchObject({
      origins: ['https://app.example', 'https://bank.example'],
      canTrust: false,
      summary: '导航到 https://bank.example/transfer',
    })
    expect(prompt?.summary).not.toContain('secret')
  })

  it('does not offer trust for invalid navigation and keeps key summaries on one bounded line', () => {
    expect(approvalPromptForCall(call('browser_navigate', { url: 'javascript:alert(1)' }), 'auto', FRAMES, 'zh'))
      .toMatchObject({ canTrust: false })

    const prompt = approvalPromptForCall(call('browser_press', { key: `Enter\n${'x'.repeat(100)}` }), 'auto', FRAMES, 'zh')
    expect(prompt?.summary).not.toContain('\n')
    expect(prompt?.summary.length).toBeLessThan(70)
  })

  it('keeps read-only viewport tools outside the approval path', () => {
    expect(approvalPromptForCall(call('browser_scroll', { direction: 'down' }), 'auto', FRAMES, 'zh')).toBeUndefined()
    expect(approvalPromptForCall(call('browser_wait'), 'auto', FRAMES, 'zh')).toBeUndefined()
  })

  it('renders approval summaries in English for non-Chinese browsers', () => {
    expect(approvalPromptForCall(call('browser_type', {
      index: 3,
      text: 'secret',
    }), 'auto', FRAMES, 'en')?.summary).toBe(
      'Enter 6 characters in element [3] (the text is not shown in this dialog)',
    )
    expect(approvalPromptForCall(call('browser_snapshot'), 'ask', FRAMES, 'en')?.summary)
      .toBe('Read the current page and accessible iframes')
  })
})

describe('originFromUrl', () => {
  it('accepts web/blob origins and rejects browser-internal or invalid URLs', () => {
    expect(originFromUrl('https://example.com/path?q=1')).toBe('https://example.com')
    expect(originFromUrl('blob:https://example.com/id')).toBe('https://example.com')
    expect(originFromUrl('chrome://settings')).toBeUndefined()
    expect(originFromUrl('not a url')).toBeUndefined()
  })
})

describe('approvalPromptForCall: the advanced tool surface', () => {
  it('treats a capture as a page read, honoring the sharing preference', () => {
    expect(approvalPromptForCall(call('browser_screenshot'), 'auto', FRAMES, 'en')).toBeUndefined()
    const prompt = approvalPromptForCall(call('browser_screenshot'), 'ask', FRAMES, 'en')
    expect(prompt).toMatchObject({ kind: 'read', canTrust: false })
    expect(prompt?.summary).toContain('picture')
    // A viewport capture spans every frame, exactly like a snapshot.
    expect(prompt?.origins).toEqual(['https://app.example', 'https://login.example.net'])
  })

  it('scopes an element capture and an image read to their own frame', () => {
    expect(approvalPromptForCall(call('browser_screenshot', { frame: 4, index: 3 }), 'ask', FRAMES, 'en')?.origins)
      .toEqual(['https://login.example.net'])
    expect(approvalPromptForCall(call('browser_read_image', { frame: 4, index: 3 }), 'ask', FRAMES, 'en'))
      .toMatchObject({ kind: 'read', origins: ['https://login.example.net'] })
  })

  it('treats a lookup as a read and echoes what is being searched for', () => {
    const prompt = approvalPromptForCall(call('browser_find', { text: 'Sign in' }), 'ask', FRAMES, 'en')
    expect(prompt).toMatchObject({ kind: 'read' })
    expect(prompt?.summary).toContain('Sign in')
  })

  it('requires approval for the new page actions regardless of sharing', () => {
    for (const name of ['browser_hover', 'browser_select_option', 'browser_act']) {
      expect(approvalPromptForCall(call(name, { index: 3 }), 'auto', FRAMES, 'en')).toMatchObject({ kind: 'action' })
    }
  })

  it('names every batch step in the one dialog that covers them', () => {
    const prompt = approvalPromptForCall(call('browser_act', {
      steps: [
        { action: 'type', index: 2, text: 'secret-value' },
        { action: 'click', index: 3 },
      ],
    }), 'auto', FRAMES, 'en')
    expect(prompt?.summary).toContain('1. type [2]')
    expect(prompt?.summary).toContain('2. click [3]')
    // Typed text is counted, never shown, exactly as for a single browser_type.
    expect(prompt?.summary).toContain('12 characters')
    expect(prompt?.summary).not.toContain('secret-value')
  })

  it('summarizes a long batch without dumping every step', () => {
    const prompt = approvalPromptForCall(call('browser_act', {
      steps: Array.from({ length: 11 }, (_, index) => ({ action: 'click', index })),
    }), 'auto', FRAMES, 'en')
    expect(prompt?.summary).toContain('and 3 more')
  })

  it('names the chosen option for a dropdown', () => {
    const prompt = approvalPromptForCall(call('browser_select_option', { index: 5, values: ['Blue'] }), 'auto', FRAMES, 'en')
    expect(prompt?.summary).toContain('Blue')
  })

  it('authorizes tab management on its own terms', () => {
    // Listing tabs is a read of the user's browsing, not of one page.
    expect(approvalPromptForCall(call('browser_tabs', { action: 'list' }), 'auto', FRAMES, 'en')).toBeUndefined()
    expect(approvalPromptForCall(call('browser_tabs', { action: 'list' }), 'ask', FRAMES, 'en'))
      .toMatchObject({ kind: 'read', origins: [] })

    const open = approvalPromptForCall(call('browser_tabs', { action: 'open', url: 'https://new.example/x' }), 'auto', FRAMES, 'en')
    expect(open).toMatchObject({ kind: 'action', origins: ['https://new.example'], canTrust: false })
    expect(open?.summary).toContain('new.example')

    expect(approvalPromptForCall(call('browser_tabs', { action: 'close', tabId: 7 }), 'auto', FRAMES, 'en')?.summary)
      .toContain('Close tab 7')
    // Rearranging tabs must never become a persistent per-origin allowance.
    expect(approvalPromptForCall(call('browser_tabs', { action: 'switch', tabId: 7 }), 'auto', FRAMES, 'en')?.canTrust).toBe(false)
  })
})
