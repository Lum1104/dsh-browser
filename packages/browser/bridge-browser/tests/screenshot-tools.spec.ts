import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { BridgeServer } from '../src/server.ts'
import { registerScreenshotTool } from '../src/screenshot-tools.ts'

interface StoredImage { data: Uint8Array; mediaType: string }

/** 1x1 transparent PNG bytes. */
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const JPEG_BASE64 = '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwcJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAQAAAAAAAAAAAAAAAAAAAAv/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AmgA//9k='

function makeHarness(options: {
  attachments?: { saveImages: (inputs: ReadonlyArray<StoredImage>) => Promise<unknown[]> } | null
  capture?: (args: Record<string, unknown>) => { image: { data: string; mediaType: string; width?: number; height?: number } }
} = {}) {
  const registered: { name: string; definition: Record<string, unknown> }[] = []
  const saved: StoredImage[] = []
  const attachments = options.attachments === null
    ? undefined
    : options.attachments ?? {
      saveImages: vi.fn(async (inputs: ReadonlyArray<StoredImage>) => {
        saved.push(...inputs)
        const bytes = inputs.map((input) => input.data.byteLength)
        return inputs.map((input, index) => ({
          attachmentId: `att-${index + 1}`,
          mediaType: input.mediaType,
          bytes: bytes[index]!,
          width: 1,
          height: 1,
        }))
      }),
    }
  const ctx = {
    tools: {
      register: vi.fn((definition: { name: string }) => {
        registered.push({ name: definition.name, definition: definition as Record<string, unknown> })
        return () => {}
      }),
    },
    get: vi.fn((name: string) => (name === 'attachments' ? attachments : undefined)),
  } as unknown as Context
  const requestTool = vi.fn(async (_name: string, args: Record<string, unknown>) => {
    const capture = options.capture ?? (() => ({ image: { data: PNG_BASE64, mediaType: 'image/png' } }))
    return capture(args)
  })
  const bridge = { requestTool } as unknown as BridgeServer
  const dispose = registerScreenshotTool(ctx, bridge, { toolTimeoutMs: 1_000 })
  const tool = registered.find((r) => r.name === 'browser_screenshot')?.definition
  if (tool === undefined) throw new Error('screenshot tool was not registered')
  return { ctx, requestTool, saved, tool, dispose }
}

const exec = () => ({ signal: new AbortController().signal })

describe('registerScreenshotTool', () => {
  it('registers browser_screenshot and disposes', () => {
    const { tool, dispose } = makeHarness()
    expect(tool.name).toBe('browser_screenshot')
    expect(typeof tool.execute).toBe('function')
    expect(typeof tool.projectContent).toBe('function')
    dispose()
  })

  it('stores the captured pixels once and returns metadata only', async () => {
    const { tool, saved, requestTool } = makeHarness()
    const result = await (tool.execute as (args: unknown, e: unknown) => Promise<unknown>)({}, exec()) as {
      text: string
      image: { attachmentId: string; mediaType: string; bytes: number; width: number; height: number; data?: string }
    }
    expect(requestTool).toHaveBeenCalledWith('browser_screenshot', { format: 'png' }, expect.anything(), 1_000)
    expect(saved).toHaveLength(1)
    expect(saved[0]!.mediaType).toBe('image/png')
    expect(Buffer.from(saved[0]!.data).toString('base64')).toBe(PNG_BASE64)
    expect(result.image.attachmentId).toBe('att-1')
    expect(result.image.mediaType).toBe('image/png')
    // The durable value must not carry the pixels.
    expect(JSON.stringify(result)).not.toContain(PNG_BASE64)
    expect(typeof result.text).toBe('string')
  })

  it('projects an image content block for the executing call', async () => {
    const { tool } = makeHarness()
    const run = exec()
    await (tool.execute as (args: unknown, e: unknown) => Promise<unknown>)({}, run)
    const blocks = (tool.projectContent as (e: unknown) => unknown)(run) as Array<{ type: string }>
    expect(blocks).toHaveLength(2)
    expect(blocks[0]!.type).toBe('image')
    expect(blocks[0]).toHaveProperty('attachment.attachmentId', 'att-1')
    expect(blocks[1]!.type).toBe('text')
    // Other executions have no projection.
    expect((tool.projectContent as (e: unknown) => unknown)(exec())).toBeUndefined()
  })

  it('forwards jpeg format and quality to the extension', async () => {
    const { tool, requestTool } = makeHarness()
    await (tool.execute as (args: unknown, e: unknown) => Promise<unknown>)({ format: 'jpeg', quality: 70 }, exec())
    expect(requestTool).toHaveBeenCalledWith('browser_screenshot', { format: 'jpeg', quality: 70 }, expect.anything(), 1_000)
  })

  it('retries once as jpeg when png admission hits the byte limit', async () => {
    const formats: string[] = []
    const saved: StoredImage[] = []
    const attachments = {
      saveImages: vi.fn(async (inputs: ReadonlyArray<StoredImage>) => {
        if (inputs[0]!.mediaType === 'image/png') {
          const error = Error('Image exceeds the configured image-byte limit.') as Error & { code?: string }
          error.code = 'IMAGE_TOO_LARGE'
          throw error
        }
        saved.push(...inputs)
        return [{ attachmentId: 'att-jpeg', mediaType: 'image/jpeg', bytes: 631, width: 1, height: 1 }]
      }),
    }
    const { tool } = makeHarness({
      attachments,
      capture: (args) => {
        formats.push(String(args.format))
        return args.format === 'jpeg'
          ? { image: { data: JPEG_BASE64, mediaType: 'image/jpeg' } }
          : { image: { data: PNG_BASE64, mediaType: 'image/png' } }
      },
    })
    const result = await (tool.execute as (args: unknown, e: unknown) => Promise<unknown>)({}, exec()) as { image: { attachmentId: string } }
    expect(formats).toEqual(['png', 'jpeg'])
    expect(result.image.attachmentId).toBe('att-jpeg')
    expect(saved[0]!.mediaType).toBe('image/jpeg')
  })

  it('fails when no attachment store is mounted', async () => {
    const { tool } = makeHarness({ attachments: null })
    await expect((tool.execute as (args: unknown, e: unknown) => Promise<unknown>)({}, exec()))
      .rejects.toThrow(/attachment store/i)
  })

  it('fails on an unsupported media type from the extension', async () => {
    const { tool } = makeHarness({
      capture: () => ({ image: { data: 'AAAA', mediaType: 'image/webp' } }),
    })
    await expect((tool.execute as (args: unknown, e: unknown) => Promise<unknown>)({}, exec()))
      .rejects.toThrow(/unsupported screenshot media type/)
  })
})
