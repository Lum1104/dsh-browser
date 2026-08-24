// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CaptureError, FALLBACK_IMAGE_CAPS, encodeBitmap, fetchImageBitmap } from '../src/background/capture.ts'
import { captureAnswer } from '../src/background/tools.ts'

vi.mock('../src/background/capture.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/background/capture.ts')>()
  return {
    ...actual,
    fetchImageBitmap: vi.fn(),
    encodeBitmap: vi.fn(),
    blobFromDataUrl: vi.fn(async () => new Blob(['x'])),
  }
})

const FULL = 'https://img.example/full.jpg'
const THUMB = 'https://img.example/thumb.jpg'
const BOX = { x: 10, y: 20, width: 100, height: 50, dpr: 1 }
const BITMAP = { width: 1600, height: 1200 } as ImageBitmap

function urlSource(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'url' as const,
    url: FULL,
    width: 1600,
    height: 1200,
    name: 'Holiday',
    fallbacks: [THUMB],
    box: BOX,
    ...overrides,
  }
}

function chromeMock() {
  return chrome as unknown as { tabs: { captureVisibleTab: ReturnType<typeof vi.fn> } }
}

beforeEach(() => {
  vi.mocked(fetchImageBitmap).mockReset()
  vi.mocked(encodeBitmap).mockReset()
  vi.mocked(encodeBitmap).mockImplementation(async (_bitmap, _caps, crop, name) => ({
    data: 'Zg==',
    mediaType: 'image/png' as const,
    width: crop?.width ?? 16,
    height: crop?.height ?? 16,
    ...(name === undefined ? {} : { name }),
  }))
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 800, height: 600 })))
  vi.stubGlobal('chrome', {
    tabs: { captureVisibleTab: vi.fn(async () => 'data:image/png;base64,AAAA') },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('captureAnswer URL sources', () => {
  it('reads the original from cache and never touches the tab capture', async () => {
    const attempts: Array<[string, RequestCache | undefined]> = []
    vi.mocked(fetchImageBitmap).mockImplementation(async (url, _bytes, cache) => {
      attempts.push([url, cache])
      if (url === FULL && cache === 'force-cache') return BITMAP
      throw new CaptureError(`unexpected ${url} ${cache}`)
    })

    const answer = await captureAnswer({ windowId: 1, active: true }, 'Reading 1 image.', [urlSource()], FALLBACK_IMAGE_CAPS)

    expect(answer.ok).toBe(true)
    expect((answer.result as { images?: { name?: string }[] }).images?.[0]?.name).toBe('Holiday')
    expect(attempts).toEqual([[FULL, 'force-cache']])
    expect(chromeMock().tabs.captureVisibleTab).not.toHaveBeenCalled()
  })

  it('tries the original on the network before any thumbnail, so a cached thumb cannot win', async () => {
    const attempts: Array<[string, RequestCache | undefined]> = []
    vi.mocked(fetchImageBitmap).mockImplementation(async (url, _bytes, cache) => {
      attempts.push([url, cache])
      if (url === FULL && cache === 'default') return BITMAP
      throw new CaptureError(`miss ${url} ${cache}`)
    })

    await captureAnswer({ windowId: 1, active: true }, 'Reading 1 image.', [urlSource()], FALLBACK_IMAGE_CAPS)

    expect(attempts).toEqual([
      [FULL, 'force-cache'],
      [FULL, 'default'],
    ])
    expect(chromeMock().tabs.captureVisibleTab).not.toHaveBeenCalled()
  })

  it('walks to the thumbnail only after the original fails both cache and network', async () => {
    const attempts: Array<[string, RequestCache | undefined]> = []
    vi.mocked(fetchImageBitmap).mockImplementation(async (url, _bytes, cache) => {
      attempts.push([url, cache])
      if (url === THUMB && cache === 'force-cache') return BITMAP
      throw new CaptureError(`miss ${url} ${cache}`)
    })

    await captureAnswer({ windowId: 1, active: true }, 'Reading 1 image.', [urlSource()], FALLBACK_IMAGE_CAPS)

    expect(attempts).toEqual([
      [FULL, 'force-cache'],
      [FULL, 'default'],
      [THUMB, 'force-cache'],
    ])
  })

  it('crops the rendered box when every URL is hotlink-protected', async () => {
    vi.mocked(fetchImageBitmap).mockRejectedValue(new CaptureError('the image request failed with status 404'))

    const answer = await captureAnswer({ windowId: 1, active: true }, 'Reading 1 image.', [urlSource()], FALLBACK_IMAGE_CAPS)

    expect(chromeMock().tabs.captureVisibleTab).toHaveBeenCalled()
    expect(encodeBitmap).toHaveBeenCalledWith(
      expect.objectContaining({ width: 800, height: 600 }),
      FALLBACK_IMAGE_CAPS,
      { x: 10, y: 20, width: 100, height: 50 },
      'Holiday',
    )
    expect((answer.result as { images?: unknown[] }).images).toHaveLength(1)
  })

  it('reports the fetch error when there is no box to crop', async () => {
    vi.mocked(fetchImageBitmap).mockRejectedValue(new CaptureError('the image request failed with status 404'))

    const answer = await captureAnswer(
      { windowId: 1, active: true },
      'Reading 1 image.',
      [urlSource({ box: undefined })],
      FALLBACK_IMAGE_CAPS,
    )

    expect(chromeMock().tabs.captureVisibleTab).not.toHaveBeenCalled()
    expect((answer.result as { images?: unknown[] }).images).toBeUndefined()
    expect((answer.result as { text: string }).text).toContain('status 404')
  })
})
