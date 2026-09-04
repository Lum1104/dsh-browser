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

  it('scopes new-tab approval to its destination and redacts URL secrets', () => {
    const prompt = approvalPromptForCall(call('browser_open_tab', {
      url: 'https://docs.example/guide?token=secret#private',
    }), 'auto', FRAMES, 'zh')

    expect(prompt).toMatchObject({
      origins: ['https://docs.example'],
      canTrust: true,
      summary: '新建标签页访问 https://docs.example/guide 并跟随操作',
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
