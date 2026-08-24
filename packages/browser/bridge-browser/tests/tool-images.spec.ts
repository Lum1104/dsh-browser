import { describe, expect, it, vi } from 'vitest'
import type { ImageAttachmentLimits, ImageAttachmentRef, SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
import { commitToolImages, imageResultCaps, type ImageCommitStore } from '../src/tool-images.ts'
import {
  DEFAULT_IMAGE_MAX_BYTES,
  DEFAULT_IMAGE_MAX_DIMENSION,
  DEFAULT_IMAGE_MAX_PIXELS,
  isImageResultCaps,
  parseToolImagePayload,
  TOOL_IMAGE_MEDIA_TYPES,
  type ImageResultCaps,
} from '../src/protocol.ts'

const LIMITS: ImageAttachmentLimits = {
  maxImageBytes: 20 * 1024 * 1024,
  maxImagesPerMessage: 20,
  maxMessageImageBytes: 200 * 1024 * 1024,
  maxImagePixels: 64_000_000,
  maxImageDimension: 8_192,
  mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
}

const CAPS: ImageResultCaps = {
  maxBytes: 1_000,
  maxDimension: 1_568,
  maxPerCall: 2,
  mediaTypes: TOOL_IMAGE_MEDIA_TYPES,
}

function makeStore(): ImageCommitStore & { saved: SaveImageAttachment[] } {
  const saved: SaveImageAttachment[] = []
  return {
    saved,
    imageLimits: LIMITS,
    saveImage: vi.fn(async (input: SaveImageAttachment) => {
      saved.push(input)
      return {
        attachmentId: `attachment-${saved.length}`,
        mediaType: input.mediaType,
        bytes: input.data.byteLength,
        width: 10,
        height: 10,
        ...(input.name === undefined ? {} : { name: input.name }),
      } as unknown as ImageAttachmentRef
    }),
  } as unknown as ImageCommitStore & { saved: SaveImageAttachment[] }
}

function payload(text: string, overrides: Record<string, unknown> = {}) {
  return {
    data: Buffer.from(text).toString('base64'),
    mediaType: 'image/png' as const,
    width: 20,
    height: 10,
    ...overrides,
  }
}

describe('imageResultCaps', () => {
  it('derives a wire budget tighter than the store\'s own admission limits', () => {
    const caps = imageResultCaps(LIMITS)
    expect(caps).toEqual({
      maxBytes: DEFAULT_IMAGE_MAX_BYTES,
      maxDimension: DEFAULT_IMAGE_MAX_DIMENSION,
      // The area cap is what a DeepSeek-style route can actually use: it
      // rescales to ~800x800 equivalent pixels and charges a flat per-image
      // ceiling, so pixels past this are pure transport cost.
      maxPixels: DEFAULT_IMAGE_MAX_PIXELS,
      maxPerCall: 4,
      mediaTypes: ['image/png', 'image/jpeg', 'image/webp'],
    })
    expect(caps!.maxBytes).toBeLessThan(LIMITS.maxImageBytes)
    expect(caps!.maxDimension).toBeLessThan(LIMITS.maxImageDimension)
  })

  it('never exceeds a host that configured stricter limits', () => {
    const caps = imageResultCaps({ ...LIMITS, maxImageBytes: 50_000, maxImageDimension: 640, maxImagesPerMessage: 1 })
    // 640 squared bounds the area cap below the default: a square at the edge
    // cap already carries all the pixels that survive.
    expect(caps).toMatchObject({ maxBytes: 50_000, maxDimension: 640, maxPixels: 640 * 640, maxPerCall: 1 })
  })

  it('has no budget without a store, or when the store shares no usable format', () => {
    expect(imageResultCaps(undefined)).toBeUndefined()
    expect(imageResultCaps({ ...LIMITS, mediaTypes: ['image/gif'] })).toBeUndefined()
  })

  it('produces a budget the wire parser accepts', () => {
    expect(isImageResultCaps(imageResultCaps(LIMITS))).toBe(true)
  })
})

describe('commitToolImages', () => {
  it('stores decoded bytes and returns durable references in order', async () => {
    const store = makeStore()
    const result = await commitToolImages(store, [payload('one', { name: 'first.png' }), payload('two')], CAPS)

    expect(result.refs.map((ref) => ref.attachmentId)).toEqual(['attachment-1', 'attachment-2'])
    expect(result.notes).toEqual([])
    expect(store.saved[0]).toMatchObject({ mediaType: 'image/png', name: 'first.png' })
    expect(Buffer.from(store.saved[0]!.data).toString()).toBe('one')
  })

  it('drops images past the per-call cap and says how many', async () => {
    const store = makeStore()
    const result = await commitToolImages(store, [payload('a'), payload('b'), payload('c')], CAPS)
    expect(result.refs).toHaveLength(2)
    expect(result.notes[0]).toContain('1 extra captured image(s) were discarded')
  })

  it('refuses an oversized image without failing the call', async () => {
    const store = makeStore()
    const result = await commitToolImages(store, [payload('x'.repeat(2_000))], CAPS)
    expect(result.refs).toEqual([])
    expect(result.notes[0]).toMatch(/above the 1000-byte limit/)
    expect(store.saved).toEqual([])
  })

  it('refuses a media type the host did not advertise', async () => {
    const store = makeStore()
    const result = await commitToolImages(store, [payload('x', { mediaType: 'image/webp' })], {
      ...CAPS,
      mediaTypes: ['image/png'],
    })
    expect(result.refs).toEqual([])
    expect(result.notes[0]).toContain('unsupported type image/webp')
  })

  it('turns a storage failure into a note, not a thrown tool call', async () => {
    const store = makeStore()
    store.saveImage = vi.fn(async () => { throw new Error('disk full') })
    const result = await commitToolImages(store, [payload('x')], CAPS)
    expect(result.refs).toEqual([])
    expect(result.notes[0]).toContain('disk full')
  })

  it('rejects data that is not clean base64', async () => {
    const store = makeStore()
    const result = await commitToolImages(store, [{ ...payload('x'), data: 'not*base64!' }], CAPS)
    expect(result.refs).toEqual([])
    expect(result.notes[0]).toContain('could not be decoded')
  })
})

describe('parseToolImagePayload', () => {
  it('accepts a complete payload and normalizes an empty name away', () => {
    expect(parseToolImagePayload(payload('x'))).toMatchObject({ mediaType: 'image/png', width: 20, height: 10 })
    expect(parseToolImagePayload(payload('x', { name: '' }))).not.toHaveProperty('name')
  })

  it('rejects every incomplete or hostile shape', () => {
    expect(parseToolImagePayload(null)).toBeUndefined()
    expect(parseToolImagePayload([payload('x')])).toBeUndefined()
    expect(parseToolImagePayload(payload('x', { data: '' }))).toBeUndefined()
    expect(parseToolImagePayload(payload('x', { data: 'data:image/png;base64,AAAA' }))).toBeUndefined()
    expect(parseToolImagePayload(payload('x', { mediaType: 'image/svg+xml' }))).toBeUndefined()
    expect(parseToolImagePayload(payload('x', { width: 0 }))).toBeUndefined()
    expect(parseToolImagePayload(payload('x', { height: 1.5 }))).toBeUndefined()
    expect(parseToolImagePayload(payload('x', { name: 7 }))).toBeUndefined()
  })
})

describe('isImageResultCaps', () => {
  it('requires every bound and at least one media type', () => {
    expect(isImageResultCaps(CAPS)).toBe(true)
    expect(isImageResultCaps({ ...CAPS, mediaTypes: [] })).toBe(false)
    expect(isImageResultCaps({ ...CAPS, mediaTypes: ['image/gif'] })).toBe(false)
    expect(isImageResultCaps({ ...CAPS, maxBytes: 0 })).toBe(false)
    expect(isImageResultCaps({ ...CAPS, maxPerCall: 1.5 })).toBe(false)
    expect(isImageResultCaps(undefined)).toBe(false)
  })
})
