// @vitest-environment jsdom
/**
 * Developer-tools authorization: per-call prompts, the group's exclusion from
 * the origin allowlist and unrestricted access, and the session grant.
 */

import { describe, expect, it } from 'vitest'
import {
  DEVTOOLS_TOOLS,
  devToolsApprovalForCall,
  isDevToolsTool,
  resolveApprovalGate,
} from '../src/background/authorization.ts'
import type { ApprovalPrompt } from '../src/security/approval.ts'
import type { ToolCall } from '../src/background/tools.ts'
import type { TabFrame } from '../src/background/frames.ts'

function call(name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id: 'call-1', name, args }
}

const FRAMES: TabFrame[] = [
  { frameId: 0, parentFrameId: -1, url: 'https://example.com/page' },
  { frameId: 3, parentFrameId: 0, url: 'https://iframe.example.net/widget' },
]

describe('developer-tools tool group', () => {
  it('lists exactly the registered wire names', () => {
    expect([...DEVTOOLS_TOOLS].sort()).toEqual([
      'browser_console_eval',
      'browser_console_logs',
      'browser_devtools_elements',
      'browser_devtools_get_request',
      'browser_devtools_list_requests',
      'browser_devtools_network',
      'browser_devtools_request_body',
      'browser_devtools_set_element_attribute',
      'browser_devtools_set_element_style',
    ])
    expect(isDevToolsTool('browser_console_eval')).toBe(true)
    expect(isDevToolsTool('browser_snapshot')).toBe(false)
  })

  it('always marks the prompt as devtools and never as origin-trustable', () => {
    for (const name of DEVTOOLS_TOOLS) {
      const prompt = devToolsApprovalForCall(call(name), FRAMES, 'en')
      expect(prompt.devTools).toBe(true)
      expect(prompt.canTrust).toBe(false)
      expect(prompt.action).toBe(name)
      expect(prompt.summary.length).toBeGreaterThan(0)
      expect(prompt.origins).toEqual(['https://example.com'])
    }
  })

  it('treats mutations and code execution as actions and reads as reads', () => {
    const kindOf = (name: string): string => devToolsApprovalForCall(call(name), FRAMES, 'en').kind
    expect(kindOf('browser_devtools_elements')).toBe('read')
    expect(kindOf('browser_console_logs')).toBe('read')
    expect(kindOf('browser_devtools_list_requests')).toBe('read')
    expect(kindOf('browser_devtools_get_request')).toBe('read')
    expect(kindOf('browser_devtools_set_element_style')).toBe('action')
    expect(kindOf('browser_devtools_set_element_attribute')).toBe('action')
    expect(kindOf('browser_console_eval')).toBe('action')
  })

  it('summarizes the target without leaking a typed expression', () => {
    expect(devToolsApprovalForCall(call('browser_devtools_elements', { selector: '#submit' }), FRAMES, 'en').summary)
      .toContain('#submit')
    expect(devToolsApprovalForCall(call('browser_devtools_elements', { index: 7, frame: 3 }), FRAMES, 'en').summary)
      .toContain('snapshot index 7, frame 3')
    const consolePrompt = devToolsApprovalForCall(call('browser_console_eval', { expression: 'document.cookie' }), FRAMES, 'en')
    expect(consolePrompt.summary).not.toContain('cookie')
    expect(consolePrompt.summary).toContain('15 characters')
  })

  it('localizes summaries for the Chinese UI', () => {
    const prompt = devToolsApprovalForCall(call('browser_devtools_network', { action: 'start' }), FRAMES, 'zh')
    expect(prompt.summary).toContain('抓包')
    expect(prompt.summary).toContain('start')
  })

  it('reports an unknown origin when no frame is available', () => {
    expect(devToolsApprovalForCall(call('browser_console_logs'), [], 'en').origins).toEqual([])
  })
})

describe('approval gate policy', () => {
  const ordinary = (): ApprovalPrompt => ({
    kind: 'action',
    action: 'browser_click',
    summary: 'Click element [1]',
    origins: ['https://example.com'],
    canTrust: true,
  })

  it('never satisfies the developer-tools prompt from unrestricted access', () => {
    expect(resolveApprovalGate({
      prompt: devToolsApprovalForCall(call('browser_console_eval', { expression: '1' }), FRAMES, 'en'),
      devToolsAllowed: false,
      devToolsSessionGrant: false,
      unrestrictedAccess: true,
      coveredByTrustedOrigins: true,
    })).toBe('prompt')
  })

  it('approves devtools without a prompt only for the setting or a session grant', () => {
    const prompt = devToolsApprovalForCall(call('browser_devtools_elements', { selector: 'body' }), FRAMES, 'en')
    const base = { prompt, unrestrictedAccess: false, coveredByTrustedOrigins: false, devToolsSessionGrant: false }
    expect(resolveApprovalGate({ ...base, devToolsAllowed: true })).toBe('approved')
    expect(resolveApprovalGate({ ...base, devToolsAllowed: false, devToolsSessionGrant: true })).toBe('approved')
    expect(resolveApprovalGate({ ...base, devToolsAllowed: false })).toBe('prompt')
  })

  it('keeps the existing shortcuts for ordinary actions', () => {
    const base = { prompt: ordinary(), devToolsAllowed: false, devToolsSessionGrant: false }
    expect(resolveApprovalGate({ ...base, unrestrictedAccess: true, coveredByTrustedOrigins: false })).toBe('approved')
    expect(resolveApprovalGate({ ...base, unrestrictedAccess: false, coveredByTrustedOrigins: true })).toBe('approved')
    expect(resolveApprovalGate({ ...base, unrestrictedAccess: false, coveredByTrustedOrigins: false })).toBe('prompt')
  })
})
