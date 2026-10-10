// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { dispatchToolCall, type ToolCall } from '../src/background/tools.ts'

/** 1x1 transparent PNG. */
const PNG_PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

function stubChrome(tab: Partial<chrome.tabs.Tab>, capture?: (options: unknown) => string) {
  const full: chrome.tabs.Tab = {
    id: 7,
    windowId: 3,
    index: 0,
    active: true,
    highlighted: false,
    pinned: false,
    incognito: false,
    selected: false,
    discarded: false,
    autoDiscardable: true,
    groupId: -1,
    url: 'https://example.com/',
    title: 'Example',
    ...tab,
  }
  const captureVisibleTab = vi.fn(async (_windowId: number, options: unknown) => {
    if (capture !== undefined) return capture(options)
    return `data:image/png;base64,${PNG_PIXEL}`
  })
  vi.stubGlobal('chrome', {
    tabs: {
      query: vi.fn(async () => [full]),
      get: vi.fn(async () => ({ ...full })),
      captureVisibleTab,
      remove: vi.fn(async () => undefined),
    },
    webNavigation: {
      getAllFrames: vi.fn(async () => [{ frameId: 0, parentFrameId: -1, documentId: 'document-7', url: full.url ?? '' }]),
    },
  })
  return { captureVisibleTab }
}

const call = (args: Record<string, unknown> = {}): ToolCall => ({ id: 'tool-1', name: 'browser_screenshot', args })
const approve = vi.fn(async (_prompt: { kind: string; action: string }) => 'approved' as const)

describe('browser_screenshot dispatch', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    approve.mockClear()
  })

  it('captures the active http tab and returns base64 image metadata', async () => {
    stubChrome({ id: 7, windowId: 3, active: true })
    const answer = await dispatchToolCall(call(), 'auto', undefined, approve)
    expect(answer.ok).toBe(true)
    if (!answer.ok) return
    const image = (answer.result as { image: { data: string; mediaType: string } }).image
    expect(image.data).toBe(PNG_PIXEL)
    expect(image.mediaType).toBe('image/png')
  })

  it('passes format and quality through to captureVisibleTab', async () => {
    const { captureVisibleTab } = stubChrome({ active: true })
    await dispatchToolCall(call({ format: 'jpeg', quality: 60 }), 'auto', undefined, approve)
    expect(captureVisibleTab).toHaveBeenCalledWith(3, { format: 'jpeg', quality: 60 })
  })

  it('defaults to png without a quality option', async () => {
    const { captureVisibleTab } = stubChrome({ active: true })
    await dispatchToolCall(call(), 'auto', undefined, approve)
    expect(captureVisibleTab).toHaveBeenCalledWith(3, { format: 'png' })
  })

  it('rejects an invalid format', async () => {
    stubChrome({ active: true })
    const answer = await dispatchToolCall(call({ format: 'webp' }), 'auto', undefined, approve)
    expect(answer.ok).toBe(false)
    expect(answer.error?.message).toContain('format')
  })

  it('rejects an out-of-range quality', async () => {
    stubChrome({ active: true })
    const answer = await dispatchToolCall(call({ format: 'jpeg', quality: 0 }), 'auto', undefined, approve)
    expect(answer.ok).toBe(false)
    expect(answer.error?.message).toContain('quality')
  })

  it('refuses a controlled tab that is not active', async () => {
    stubChrome({ active: false })
    const answer = await dispatchToolCall(call(), 'auto', undefined, approve)
    expect(answer.ok).toBe(false)
    expect(answer.error?.message).toContain('not the active tab')
  })

  it('refuses protected browser pages with a screenshot-specific message', async () => {
    stubChrome({ url: 'chrome://settings/', active: true })
    const answer = await dispatchToolCall(call(), 'auto', undefined, approve)
    expect(answer.ok).toBe(false)
    expect(answer.error?.message).toContain('screenshot')
  })

  it('surfaces capture failures from the browser', async () => {
    stubChrome({ active: true }, () => { throw new Error('cannot access contents of the page') })
    const answer = await dispatchToolCall(call(), 'auto', undefined, approve)
    expect(answer.ok).toBe(false)
    expect(answer.error?.message).toContain('cannot access contents')
  })

  it('is blocked when page content sharing is off', async () => {
    stubChrome({ active: true })
    const answer = await dispatchToolCall(call(), 'off', undefined, approve)
    expect(answer.ok).toBe(false)
    expect(answer.error?.message).toContain('sharing is disabled')
  })

  it('prompts for approval even when sharing is auto', async () => {
    stubChrome({ active: true })
    await dispatchToolCall(call(), 'auto', undefined, approve)
    expect(approve).toHaveBeenCalledTimes(1)
    const prompt = approve.mock.calls[0]![0]!
    expect(prompt.kind).toBe('read')
    expect(prompt.action).toBe('browser_screenshot')
  })

  it('prompts for approval when sharing is ask', async () => {
    stubChrome({ active: true })
    await dispatchToolCall(call(), 'ask', undefined, approve)
    expect(approve).toHaveBeenCalledTimes(1)
  })

  it('skips the prompt under unrestricted access', async () => {
    stubChrome({ active: true })
    const answer = await dispatchToolCall(call(), 'auto', undefined, undefined, undefined, undefined, undefined, { unrestrictedAccess: true })
    expect(answer.ok).toBe(true)
    expect(approve).not.toHaveBeenCalled()
  })

  it('fails closed when approval is denied', async () => {
    stubChrome({ active: true })
    const deny = vi.fn(async () => 'denied' as const)
    const answer = await dispatchToolCall(call(), 'auto', undefined, deny)
    expect(answer.ok).toBe(false)
    expect(answer.error?.message).toContain('denied')
  })
})
