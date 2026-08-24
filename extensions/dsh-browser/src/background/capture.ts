/**
 * Turn a resolved pixel source into a wire-ready image payload.
 *
 * Encoding happens in the service worker, not the page: the byte budget is a
 * property of the bridge, the page must not be handed the negotiated caps, and
 * `OffscreenCanvas` here can crop and downscale without touching the document.
 *
 * The budget is met by construction rather than by hope — the long edge is
 * scaled to the cap, and if PNG still exceeds the byte cap the image is
 * re-encoded as progressively lower-quality JPEG. A capture that cannot be
 * made to fit is reported as such instead of being sent and refused.
 *
 * @module
 */

import type { ImageResultCaps, ToolImagePayload, ToolImageMediaType } from '@yuxianglin/dsh-bridge-browser/src/protocol.ts'
import {
  DEFAULT_IMAGE_MAX_BYTES,
  DEFAULT_IMAGE_MAX_DIMENSION,
  DEFAULT_IMAGE_MAX_PER_CALL,
  DEFAULT_IMAGE_MAX_PIXELS,
} from '@yuxianglin/dsh-bridge-browser/src/protocol.ts'

/** A rectangle in top-level viewport CSS pixels. */
export interface CaptureBox {
  x: number
  y: number
  width: number
  height: number
  dpr: number
  /** The same rectangle in top-level DOCUMENT coordinates, when known. */
  pageX?: number
  pageY?: number
}

/** Caps applied when the bridge advertised none (an older or text-only host). */
export const FALLBACK_IMAGE_CAPS: ImageResultCaps = {
  maxBytes: DEFAULT_IMAGE_MAX_BYTES,
  maxDimension: DEFAULT_IMAGE_MAX_DIMENSION,
  maxPixels: DEFAULT_IMAGE_MAX_PIXELS,
  maxPerCall: DEFAULT_IMAGE_MAX_PER_CALL,
  mediaTypes: ['image/png', 'image/jpeg', 'image/webp'],
}

/** JPEG qualities tried, in order, when a lossless encode is over budget. */
const JPEG_QUALITY_LADDER = [0.85, 0.7, 0.55, 0.4]

/** Failure raised when pixels cannot be obtained or bounded. */
export class CaptureError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CaptureError'
  }
}

/**
 * Scale one image's dimensions to fit a long-edge cap and, when the host
 * declares one, a total-pixel cap — preserving aspect ratio and never
 * enlarging.
 *
 * Both bounds are needed because routes disagree about what "too big" means.
 * A long-edge cap suits a route that resamples by edge; DeepSeek's vision
 * models instead rescale to an EQUIVALENT PIXEL COUNT and charge a flat
 * per-image ceiling, so a 1200×1200 square passes a 1568 edge cap while
 * carrying 44% more pixels than a 1568×900 landscape shot. Whichever bound
 * binds harder wins.
 *
 * @param width - source width in pixels.
 * @param height - source height in pixels.
 * @param maxDimension - long-edge cap.
 * @param maxPixels - total-pixel cap; omitted applies the edge cap alone.
 * @returns the target dimensions, each at least 1px.
 */
export function fitWithin(
  width: number,
  height: number,
  maxDimension: number,
  maxPixels?: number,
): { width: number; height: number } {
  const longest = Math.max(width, height)
  const edgeScale = longest <= maxDimension ? 1 : maxDimension / longest
  const pixels = width * height
  // Area scales with the SQUARE of a linear factor, hence the square root.
  const areaScale = maxPixels === undefined || pixels <= maxPixels ? 1 : Math.sqrt(maxPixels / pixels)
  const scale = Math.min(edgeScale, areaScale)
  if (scale >= 1) return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) }
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

/**
 * Intersect a requested box with the captured image, in DEVICE pixels.
 *
 * A box can hang off the viewport (a partly scrolled element) or be stale by
 * the time the capture lands; clamping keeps the crop inside the bitmap
 * instead of producing a transparent strip.
 *
 * @param box - the requested region in CSS pixels, with its device ratio.
 * @param imageWidth - captured bitmap width in device pixels.
 * @param imageHeight - captured bitmap height in device pixels.
 * @returns the clamped device-pixel rectangle, or `undefined` when it is empty.
 */
export function clampBoxToImage(
  box: CaptureBox,
  imageWidth: number,
  imageHeight: number,
): { x: number; y: number; width: number; height: number } | undefined {
  const ratio = box.dpr > 0 ? box.dpr : 1
  const left = Math.max(0, Math.round(box.x * ratio))
  const top = Math.max(0, Math.round(box.y * ratio))
  const right = Math.min(imageWidth, Math.round((box.x + box.width) * ratio))
  const bottom = Math.min(imageHeight, Math.round((box.y + box.height) * ratio))
  if (right <= left || bottom <= top) return undefined
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/** Base64-encode bytes without blowing the argument limit on large buffers. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk))
  }
  return btoa(binary)
}

/** Decode a `data:` URL into a blob, so image bytes take one path from here on. */
export async function blobFromDataUrl(dataUrl: string): Promise<Blob> {
  const response = await fetch(dataUrl)
  return response.blob()
}

/**
 * Encode one bitmap (optionally cropped) into a payload inside the caps.
 *
 * @param bitmap - the decoded source image.
 * @param caps - the host's negotiated image budget.
 * @param crop - device-pixel region to keep; omitted keeps the whole bitmap.
 * @param name - display name carried into the transcript.
 * @returns the wire payload.
 * @throws CaptureError when no encoding fits the byte cap.
 */
export async function encodeBitmap(
  bitmap: ImageBitmap,
  caps: ImageResultCaps,
  crop?: { x: number; y: number; width: number; height: number },
  name?: string,
): Promise<ToolImagePayload> {
  const region = crop ?? { x: 0, y: 0, width: bitmap.width, height: bitmap.height }
  const target = fitWithin(region.width, region.height, caps.maxDimension, caps.maxPixels)
  const canvas = new OffscreenCanvas(target.width, target.height)
  const context = canvas.getContext('2d')
  if (context === null) throw new CaptureError('the browser could not open a drawing surface for the capture')
  context.drawImage(bitmap, region.x, region.y, region.width, region.height, 0, 0, target.width, target.height)

  for (const attempt of encodeAttempts(caps)) {
    const blob = await canvas.convertToBlob(attempt)
    if (blob.size > caps.maxBytes) continue
    const mediaType = attempt.type as ToolImageMediaType
    return {
      data: bytesToBase64(new Uint8Array(await blob.arrayBuffer())),
      mediaType,
      width: target.width,
      height: target.height,
      ...(name === undefined || name === '' ? {} : { name }),
    }
  }
  throw new CaptureError(
    `the capture could not be compressed under ${caps.maxBytes} bytes; capture a smaller region with index or selector`,
  )
}

/** Encoding attempts in preference order: lossless first, then lossy. */
function encodeAttempts(caps: ImageResultCaps): { type: string; quality?: number }[] {
  const attempts: { type: string; quality?: number }[] = []
  if (caps.mediaTypes.includes('image/png')) attempts.push({ type: 'image/png' })
  for (const quality of JPEG_QUALITY_LADDER) {
    if (caps.mediaTypes.includes('image/jpeg')) attempts.push({ type: 'image/jpeg', quality })
    else if (caps.mediaTypes.includes('image/webp')) attempts.push({ type: 'image/webp', quality })
  }
  if (attempts.length === 0) attempts.push({ type: caps.mediaTypes[0] ?? 'image/png' })
  return attempts
}

/**
 * Fetch an image the page pointed at and decode it.
 *
 * The service worker fetches rather than the page: it carries the extension's
 * host permissions, so a cross-origin image the page could not read back
 * through a canvas is still readable here.
 *
 * What it CANNOT do is send a `Referer`: that header is forbidden to `fetch`,
 * and an image host with hotlink protection answers 404 without it. Hence the
 * cache-first attempt — the browser already fetched this image WITH the right
 * referer and cookies, so the bytes may be one cache read away and never touch
 * the network. When both attempts fail the caller falls back to cropping the
 * rendered element, which needs no network at all.
 *
 * @param url - absolute http(s) or data URL.
 * @param maxBytes - refuse a response larger than this before decoding.
 * @param cache - request cache mode; `force-cache` reads what the page already got.
 * @returns the decoded bitmap.
 * @throws CaptureError when the fetch, media type, or decode fails.
 */
export async function fetchImageBitmap(
  url: string,
  maxBytes: number,
  cache: RequestCache = 'default',
): Promise<ImageBitmap> {
  let blob: Blob
  try {
    const response = await fetch(url, { credentials: 'include', cache })
    if (!response.ok) throw new CaptureError(`the image request failed with status ${response.status}`)
    blob = await response.blob()
  } catch (error: unknown) {
    if (error instanceof CaptureError) throw error
    throw new CaptureError(`the image could not be fetched: ${error instanceof Error ? error.message : String(error)}`)
  }
  // A source above the cap is still decodable and gets downscaled; refuse only
  // sizes that would cost more to decode than the answer is worth.
  if (blob.size > maxBytes * 8) {
    throw new CaptureError(`the source image is ${blob.size} bytes, too large to read; screenshot the element instead`)
  }
  try {
    return await createImageBitmap(blob)
  } catch {
    throw new CaptureError('the image format could not be decoded (SVG and some codecs are unreadable here); screenshot the element instead')
  }
}
