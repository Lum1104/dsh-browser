import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { BridgeServer } from '../src/server.ts'
import {
  BROWSER_IMAGE_TOOL_NAMES,
  BROWSER_TOOL_NAMES,
  registerBrowserTools,
  type BrowserImageSeam,
} from '../src/tools.ts'
import { TOOL_IMAGE_MEDIA_TYPES } from '../src/protocol.ts'

/** A store that accepts anything, so tool wiring is tested without image codecs. */
function makeImageSeam(): BrowserImageSeam & { saved: { mediaType: string; bytes: number }[] } {
  const saved: { mediaType: string; bytes: number }[] = []
  return {
    saved,
    caps: { maxBytes: 1_000_000, maxDimension: 1_568, maxPerCall: 2, mediaTypes: TOOL_IMAGE_MEDIA_TYPES },
    store: {
      imageLimits: {
        maxImageBytes: 20_971_520,
        maxImagesPerMessage: 20,
        maxMessageImageBytes: 209_715_200,
        maxImagePixels: 64_000_000,
        maxImageDimension: 8_192,
        mediaTypes: TOOL_IMAGE_MEDIA_TYPES,
      },
      async saveImage(input) {
        saved.push({ mediaType: input.mediaType, bytes: input.data.byteLength })
        return {
          attachmentId: `attachment-${saved.length}`,
          mediaType: input.mediaType,
          bytes: input.data.byteLength,
          width: 4,
          height: 4,
        } as unknown as ImageAttachmentRef
      },
    } as unknown as BrowserImageSeam['store'],
  }
}

describe('registerBrowserTools', () => {
  function makeHarness() {
    const registered: { name: string; definition: Record<string, unknown> }[] = []
    const ctx = {
      tools: {
        register: vi.fn((definition: { name: string }) => {
          registered.push({ name: definition.name, definition: definition as Record<string, unknown> })
          return () => {}
        }),
      },
    } as unknown as Context
    const requestTool = vi.fn(async (_name: string, _args: Record<string, unknown>, _signal: AbortSignal, _timeoutMs?: number): Promise<unknown> => {
      return { text: 'ok' }
    })
    const bridge = { requestTool } as unknown as BridgeServer
    return { ctx, bridge, requestTool, registered }
  }

  it('registers the full tool set when the host stores attachments', () => {
    const { ctx, bridge, registered } = makeHarness()
    const disposers = registerBrowserTools(ctx, bridge, {
      toolTimeoutMs: 1_000,
      snapshotMaxChars: 12_000,
      maxInteractiveItems: 60,
      maxBatchSteps: 8,
      images: makeImageSeam(),
    })
    expect(registered.map((r) => r.name).sort()).toEqual([...BROWSER_TOOL_NAMES].sort())
    expect(disposers.size).toBe(BROWSER_TOOL_NAMES.length)
    for (const dispose of disposers.values()) dispose()
  })

  it('omits the capture tools when no attachment store is composed', () => {
    const { ctx, bridge, registered } = makeHarness()
    const disposers = registerBrowserTools(ctx, bridge, { toolTimeoutMs: 1_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60, maxBatchSteps: 8 })
    const names = registered.map((r) => r.name)
    for (const name of BROWSER_IMAGE_TOOL_NAMES) expect(names).not.toContain(name)
    expect(names.sort()).toEqual(
      [...BROWSER_TOOL_NAMES].filter((name) => !(BROWSER_IMAGE_TOOL_NAMES as readonly string[]).includes(name)).sort(),
    )
    for (const dispose of disposers.values()) dispose()
  })

  it('executes browser_click with mapped args', async () => {
    const { ctx, bridge, requestTool, registered } = makeHarness()
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 1_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60, maxBatchSteps: 8 })
    const tool = registered.find((r) => r.name === 'browser_click')!
    const exec = { signal: new AbortController().signal }
    const result = await (tool.definition.execute as (args: unknown, e: { signal: AbortSignal }) => Promise<unknown>)({ index: 3, frame: 7 }, exec)
    expect(requestTool).toHaveBeenCalledWith('browser_click', { index: 3, frame: 7 }, exec.signal, 1_000)
    expect(result).toEqual({ text: 'ok' })
  })

  it('associates browser calls with the owning Agent session', async () => {
    const { ctx, bridge, requestTool, registered } = makeHarness()
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 1_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60, maxBatchSteps: 8 })
    const tool = registered.find((r) => r.name === 'browser_click')!
    const exec = {
      signal: new AbortController().signal,
      agent: { id: 'session-browser' },
    }

    await (tool.definition.execute as (args: unknown, e: typeof exec) => Promise<unknown>)({ index: 3 }, exec)

    expect(requestTool).toHaveBeenCalledWith(
      'browser_click',
      { index: 3 },
      exec.signal,
      1_000,
      'session-browser',
    )
  })

  it('normalizes snapshot args (delta/region omitted when absent)', async () => {
    const { ctx, bridge, requestTool, registered } = makeHarness()
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 1_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60, maxBatchSteps: 8 })
    const tool = registered.find((r) => r.name === 'browser_snapshot')!
    const exec = { signal: new AbortController().signal }
    await (tool.definition.execute as (args: unknown, e: { signal: AbortSignal }) => Promise<unknown>)({ delta: true }, exec)
    expect(requestTool).toHaveBeenLastCalledWith('browser_snapshot', { delta: true }, exec.signal, 1_000)
    await (tool.definition.execute as (args: unknown, e: { signal: AbortSignal }) => Promise<unknown>)({}, exec)
    expect(requestTool).toHaveBeenLastCalledWith('browser_snapshot', {}, exec.signal, 1_000)
    await (tool.definition.execute as (args: unknown, e: { signal: AbortSignal }) => Promise<unknown>)({ delta: true, region: 'main' }, exec)
    expect(requestTool).toHaveBeenLastCalledWith('browser_snapshot', { delta: true, region: 'main' }, exec.signal, 1_000)
  })

  it('executes every remaining tool with mapped args', async () => {
    const { ctx, bridge, requestTool, registered } = makeHarness()
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 1_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60, maxBatchSteps: 8 })
    const byName = new Map(registered.map((r) => [r.name, r.definition]))
    const exec = { signal: new AbortController().signal }
    const run = async (name: string, args: unknown): Promise<void> => {
      await (byName.get(name)!.execute as (a: unknown, e: { signal: AbortSignal }) => Promise<unknown>)(args, exec)
    }

    await run('browser_type', { index: 2, text: 'hello' })
    expect(requestTool).toHaveBeenLastCalledWith('browser_type', { index: 2, text: 'hello' }, exec.signal, 1_000)
    await run('browser_type', { index: 2, text: 'hello', replace: true })
    expect(requestTool).toHaveBeenLastCalledWith('browser_type', { index: 2, text: 'hello', replace: true }, exec.signal, 1_000)
    await run('browser_type', { index: 2, frame: 4, text: 'inside frame' })
    expect(requestTool).toHaveBeenLastCalledWith('browser_type', { index: 2, frame: 4, text: 'inside frame' }, exec.signal, 1_000)

    await run('browser_press', { key: 'Enter' })
    expect(requestTool).toHaveBeenLastCalledWith('browser_press', { key: 'Enter' }, exec.signal, 1_000)

    await run('browser_scroll', { direction: 'down', amount: 200 })
    expect(requestTool).toHaveBeenLastCalledWith('browser_scroll', { direction: 'down', amount: 200 }, exec.signal, 1_000)
    await run('browser_scroll', { direction: 'top' })
    expect(requestTool).toHaveBeenLastCalledWith('browser_scroll', { direction: 'top' }, exec.signal, 1_000)
    await run('browser_scroll', { direction: 'down', frame: 4 })
    expect(requestTool).toHaveBeenLastCalledWith('browser_scroll', { direction: 'down', frame: 4 }, exec.signal, 1_000)

    await run('browser_navigate', { url: 'https://example.com' })
    expect(requestTool).toHaveBeenLastCalledWith('browser_navigate', { url: 'https://example.com' }, exec.signal, 1_000)

    for (const name of ['browser_back', 'browser_forward', 'browser_reload'] as const) {
      await run(name, {})
      expect(requestTool).toHaveBeenLastCalledWith(name, {}, exec.signal, 1_000)
    }

    await run('browser_get_text', { selector: '#main' })
    expect(requestTool).toHaveBeenLastCalledWith('browser_get_text', { selector: '#main' }, exec.signal, 1_000)
    await run('browser_get_text', {})
    expect(requestTool).toHaveBeenLastCalledWith('browser_get_text', {}, exec.signal, 1_000)
    await run('browser_get_text', { selector: 'main', frame: 4 })
    expect(requestTool).toHaveBeenLastCalledWith('browser_get_text', { selector: 'main', frame: 4 }, exec.signal, 1_000)

    await run('browser_wait', { ms: 100 })
    expect(requestTool).toHaveBeenLastCalledWith('browser_wait', { ms: 100 }, exec.signal, 1_000)
    await run('browser_wait', {})
    expect(requestTool).toHaveBeenLastCalledWith('browser_wait', {}, exec.signal, 1_000)
    await run('browser_wait', { frame: 4 })
    expect(requestTool).toHaveBeenLastCalledWith('browser_wait', { frame: 4 }, exec.signal, 1_000)
  })

  it('normalizes every DSH parameter map to JSON Schema before registration', () => {
    const { ctx, bridge, registered } = makeHarness()
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 1_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60, maxBatchSteps: 8 })
    for (const { definition } of registered) {
      const params = definition.parameters as { type?: unknown; properties?: unknown }
      expect(params.type).toBe('object')
      expect(params.properties).toBeDefined()
    }
    const click = registered.find(({ name }) => name === 'browser_click')!.definition.parameters as {
      properties: Record<string, unknown>
      required?: string[]
    }
    expect(click.properties.index).toBeDefined()
    expect(click.properties.selector).toBeDefined()
    // Neither handle is schema-required: an index alone works, a selector alone
    // works, and both together is the durable form. "One of these two" is not
    // expressible in the enforced schema subset, so the content script enforces
    // it and answers `bad-args` when a call names no target at all.
    expect(click.required ?? []).not.toContain('index')
  })

  it('declares cooperative timeoutMs on every tool', () => {
    const { ctx, bridge, registered } = makeHarness()
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 5_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60, maxBatchSteps: 8 })
    for (const { definition } of registered) {
      expect(definition.timeoutMs).toBe(5_000)
    }
  })

  it('keeps model-facing tool schemas in English', () => {
    const { ctx, bridge, registered } = makeHarness()
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 5_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60, maxBatchSteps: 8 })
    const han = /\p{Script=Han}/u
    for (const { definition } of registered) {
      expect(String(definition.description)).not.toMatch(han)
      expect(JSON.stringify(definition.parameters)).not.toMatch(han)
    }
  })

  it('keeps model-facing tool descriptions concise', () => {
    const { ctx, bridge, registered } = makeHarness()
    registerBrowserTools(ctx, bridge, {
      toolTimeoutMs: 5_000,
      snapshotMaxChars: 12_000,
      maxInteractiveItems: 60,
      maxBatchSteps: 8,
      images: makeImageSeam(),
    })
    // A per-tool budget rather than a total, so the invariant survives the
    // surface growing: every new capability is spent on the contract, not on
    // prose the model re-reads every turn.
    const lengths = registered.map(({ definition }) => String(definition.description).length)
    const average = lengths.reduce((sum, length) => sum + length, 0) / lengths.length
    expect(average).toBeLessThan(190)
    expect(Math.max(...lengths)).toBeLessThan(320)
  })

  it('exposes optional frame routing on frame-local tools only', () => {
    const { ctx, bridge, registered } = makeHarness()
    registerBrowserTools(ctx, bridge, {
      toolTimeoutMs: 5_000,
      snapshotMaxChars: 12_000,
      maxInteractiveItems: 60,
      maxBatchSteps: 8,
      images: makeImageSeam(),
    })
    const byName = new Map(registered.map((entry) => [entry.name, entry.definition]))
    for (const name of [
      'browser_click', 'browser_type', 'browser_press', 'browser_scroll', 'browser_get_text', 'browser_wait',
      'browser_find', 'browser_act', 'browser_select_option', 'browser_hover', 'browser_screenshot', 'browser_read_image',
    ]) {
      const params = byName.get(name)!.parameters as { properties: { frame?: { type?: unknown } } }
      expect(params.properties.frame?.type).toBe('number')
    }
    // Tab management and whole-document navigation are not frame-scoped.
    for (const name of ['browser_snapshot', 'browser_navigate', 'browser_back', 'browser_forward', 'browser_reload', 'browser_tabs']) {
      const params = byName.get(name)!.parameters as { properties: { frame?: unknown } }
      expect(params.properties.frame).toBeUndefined()
    }
  })

  it('maps the advanced tool arguments onto the wire', async () => {
    const { ctx, bridge, requestTool, registered } = makeHarness()
    registerBrowserTools(ctx, bridge, {
      toolTimeoutMs: 1_000,
      snapshotMaxChars: 12_000,
      maxInteractiveItems: 60,
      maxBatchSteps: 8,
      images: makeImageSeam(),
    })
    const byName = new Map(registered.map((r) => [r.name, r.definition]))
    const exec = { signal: new AbortController().signal }
    const run = async (name: string, args: unknown): Promise<void> => {
      await (byName.get(name)!.execute as (a: unknown, e: { signal: AbortSignal }) => Promise<unknown>)(args, exec)
    }

    await run('browser_find', { text: 'Sign in', role: 'button', limit: 5 })
    expect(requestTool).toHaveBeenLastCalledWith('browser_find', { text: 'Sign in', role: 'button', limit: 5 }, exec.signal, 1_000)

    const steps = [{ action: 'type', index: 2, text: 'a' }, { action: 'click', index: 3 }]
    await run('browser_act', { steps, frame: 1 })
    expect(requestTool).toHaveBeenLastCalledWith('browser_act', { steps, frame: 1 }, exec.signal, 1_000)

    await run('browser_select_option', { index: 4, values: ['Blue'] })
    expect(requestTool).toHaveBeenLastCalledWith('browser_select_option', { index: 4, values: ['Blue'] }, exec.signal, 1_000)

    await run('browser_hover', { index: 5 })
    expect(requestTool).toHaveBeenLastCalledWith('browser_hover', { index: 5 }, exec.signal, 1_000)

    await run('browser_press', { key: 'a', modifiers: ['Control'], index: 6 })
    expect(requestTool).toHaveBeenLastCalledWith('browser_press', { key: 'a', modifiers: ['Control'], index: 6 }, exec.signal, 1_000)

    await run('browser_scroll', { index: 7 })
    expect(requestTool).toHaveBeenLastCalledWith('browser_scroll', { index: 7 }, exec.signal, 1_000)

    await run('browser_wait', { text: 'Done', timeoutMs: 3_000 })
    expect(requestTool).toHaveBeenLastCalledWith('browser_wait', { text: 'Done', timeoutMs: 3_000 }, exec.signal, 1_000)

    await run('browser_tabs', { action: 'open', url: 'https://example.com', control: true })
    expect(requestTool).toHaveBeenLastCalledWith('browser_tabs', { action: 'open', url: 'https://example.com', control: true }, exec.signal, 1_000)

    await run('browser_screenshot', { selector: '#chart' })
    expect(requestTool).toHaveBeenLastCalledWith('browser_screenshot', { selector: '#chart' }, exec.signal, 1_000)

    await run('browser_read_image', { alt: 'sales chart' })
    expect(requestTool).toHaveBeenLastCalledWith('browser_read_image', { alt: 'sales chart' }, exec.signal, 1_000)
  })

  it('commits captured images and renders them after the status text', async () => {
    const { ctx, bridge, requestTool, registered } = makeHarness()
    const images = makeImageSeam()
    requestTool.mockResolvedValueOnce({
      text: 'Captured the viewport.',
      images: [{ data: Buffer.from('binary-png').toString('base64'), mediaType: 'image/png', width: 800, height: 600, name: 'viewport.png' }],
    })
    registerBrowserTools(ctx, bridge, {
      toolTimeoutMs: 1_000,
      snapshotMaxChars: 12_000,
      maxInteractiveItems: 60,
      maxBatchSteps: 8,
      images,
    })
    const tool = registered.find((r) => r.name === 'browser_screenshot')!
    const exec = { signal: new AbortController().signal }
    const value = await (tool.definition.execute as (a: unknown, e: { signal: AbortSignal }) => Promise<unknown>)({}, exec)

    expect(images.saved).toEqual([{ mediaType: 'image/png', bytes: 10 }])
    expect(value).toEqual({
      text: 'Captured the viewport.',
      images: [expect.objectContaining({ attachmentId: 'attachment-1', mediaType: 'image/png' })],
    })
    const output = tool.definition.output as { render: (args: unknown, value: unknown) => unknown[] }
    const blocks = output.render({}, value)
    expect(blocks[0]).toEqual({ type: 'text', text: 'Captured the viewport.' })
    expect(blocks[1]).toEqual({ type: 'image', attachment: expect.objectContaining({ attachmentId: 'attachment-1' }) })
  })

  it('keeps the action status when an image cannot be stored', async () => {
    const { ctx, bridge, requestTool, registered } = makeHarness()
    const images = makeImageSeam()
    images.store.saveImage = async () => { throw new Error('disk full') }
    requestTool.mockResolvedValueOnce({
      text: 'Captured the viewport.',
      images: [{ data: Buffer.from('binary-png').toString('base64'), mediaType: 'image/png', width: 8, height: 8 }],
    })
    registerBrowserTools(ctx, bridge, {
      toolTimeoutMs: 1_000,
      snapshotMaxChars: 12_000,
      maxInteractiveItems: 60,
      maxBatchSteps: 8,
      images,
    })
    const tool = registered.find((r) => r.name === 'browser_screenshot')!
    const result = await (tool.definition.execute as (a: unknown, e: { signal: AbortSignal }) => Promise<{ text: string; images?: unknown }>)(
      {},
      { signal: new AbortController().signal },
    )
    expect(result.text).toContain('Captured the viewport.')
    expect(result.text).toContain('disk full')
    expect(result.images).toBeUndefined()
  })

  it('drops image payloads when the deployment stores no attachments', async () => {
    const { ctx, bridge, requestTool, registered } = makeHarness()
    requestTool.mockResolvedValueOnce({
      text: 'Clicked [3].',
      images: [{ data: Buffer.from('x').toString('base64'), mediaType: 'image/png', width: 1, height: 1 }],
    })
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 1_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60, maxBatchSteps: 8 })
    const tool = registered.find((r) => r.name === 'browser_click')!
    const result = await (tool.definition.execute as (a: unknown, e: { signal: AbortSignal }) => Promise<{ text: string; images?: unknown }>)(
      { index: 3 },
      { signal: new AbortController().signal },
    )
    expect(result.text).toContain('Clicked [3].')
    expect(result.text).toContain('stores no attachments')
    expect(result.images).toBeUndefined()
  })

  it('falls back to a no-text payload when the extension returns non-text', async () => {
    const { ctx, bridge, requestTool, registered } = makeHarness()
    requestTool.mockResolvedValueOnce(null)
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 1_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60, maxBatchSteps: 8 })
    const tool = registered.find((r) => r.name === 'browser_wait')!
    const exec = { signal: new AbortController().signal }
    const result = await (tool.definition.execute as (args: unknown, e: { signal: AbortSignal }) => Promise<unknown>)({}, exec)
    expect(result).toEqual({ text: expect.stringContaining('no text') })
  })

  it('renders the canonical result as one text block', () => {
    const { ctx, bridge, registered } = makeHarness()
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 1_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60, maxBatchSteps: 8 })
    const tool = registered.find((r) => r.name === 'browser_click')!
    const output = tool.definition.output as { render: (args: unknown, value: unknown) => unknown }
    expect(output.render({}, { text: 'hello' })).toEqual([{ type: 'text', text: 'hello' }])
  })
})
