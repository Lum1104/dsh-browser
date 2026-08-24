/**
 * Commit images captured by the extension into the host attachment store.
 *
 * A browser tool result is JSON, and the model-facing projection is a pure
 * function of it (`ToolOutputDefinition.render`), so the durable attachment
 * reference must already exist by the time `execute` returns. This module is
 * that boundary: wire payloads in, `ImageAttachmentRef`s out, with every
 * failure degraded to a sentence the model can act on instead of a failed tool
 * call — a screenshot that could not be stored still leaves the action's text
 * status useful.
 *
 * @module
 */

import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import {
  DEFAULT_IMAGE_MAX_BYTES,
  DEFAULT_IMAGE_MAX_DIMENSION,
  DEFAULT_IMAGE_MAX_PER_CALL,
  DEFAULT_IMAGE_MAX_PIXELS,
  TOOL_IMAGE_MEDIA_TYPES,
  type ImageResultCaps,
  type ToolImagePayload,
} from './protocol.ts'

/** The attachment-store surface this module needs (one method, for testability). */
export type ImageCommitStore = Pick<AttachmentStore, 'saveImage' | 'imageLimits'>

/** Outcome of committing one call's images. */
export interface CommittedImages {
  /** Durable references in payload order; empty when nothing could be stored. */
  refs: ImageAttachmentRef[]
  /** One sentence per dropped image, appended to the model-facing text. */
  notes: string[]
}

/**
 * Derive the image budget advertised to the extension from the host's own
 * attachment limits. The wire budget is deliberately tighter than the store's:
 * the store admits 20 MiB sources and normalizes them, while a capture that
 * large would spend the tool's whole timeout on base64 transport for pixels
 * the normalizer then discards.
 *
 * The pixel cap is the same reasoning taken one step further. A vision route
 * that rescales by AREA — DeepSeek resamples to roughly 800×800 equivalent
 * pixels and charges a flat per-image ceiling — sees a 4-megapixel capture and
 * a 2-megapixel one identically, so the larger only costs encode and transport
 * time. The store has no opinion about area, hence the constant rather than a
 * derived limit.
 *
 * @param limits - the attachment service's resolved image limits, when composed.
 * @returns the budget for `hello.ok`, or `undefined` when no store is present.
 */
export function imageResultCaps(limits: ImageCommitStore['imageLimits'] | undefined): ImageResultCaps | undefined {
  if (limits === undefined) return undefined
  const mediaTypes = TOOL_IMAGE_MEDIA_TYPES.filter((mediaType) => limits.mediaTypes.includes(mediaType))
  if (mediaTypes.length === 0) return undefined
  const maxDimension = Math.min(DEFAULT_IMAGE_MAX_DIMENSION, limits.maxImageDimension)
  return {
    maxBytes: Math.min(DEFAULT_IMAGE_MAX_BYTES, limits.maxImageBytes),
    maxDimension,
    // Never above what the edge cap already implies for a square image, so a
    // host that lowers maxImageDimension cannot be overridden upward here; and
    // never above what the store itself would accept.
    maxPixels: Math.min(DEFAULT_IMAGE_MAX_PIXELS, maxDimension * maxDimension, limits.maxImagePixels),
    maxPerCall: Math.min(DEFAULT_IMAGE_MAX_PER_CALL, limits.maxImagesPerMessage),
    mediaTypes,
  }
}

/**
 * Decode, bound, and durably store one tool call's images.
 *
 * @param store - the attachment service.
 * @param payloads - images exactly as the extension sent them.
 * @param caps - the budget the extension was told to honor.
 * @returns the stored references plus notes for anything refused.
 */
export async function commitToolImages(
  store: ImageCommitStore,
  payloads: readonly ToolImagePayload[],
  caps: ImageResultCaps,
): Promise<CommittedImages> {
  const refs: ImageAttachmentRef[] = []
  const notes: string[] = []
  const accepted = payloads.slice(0, caps.maxPerCall)
  if (payloads.length > accepted.length) {
    notes.push(`${payloads.length - accepted.length} extra captured image(s) were discarded: this tool returns at most ${caps.maxPerCall}.`)
  }
  for (const payload of accepted) {
    const data = decodeBase64(payload.data)
    if (data === undefined) {
      notes.push('One captured image could not be decoded and was not attached.')
      continue
    }
    if (data.byteLength > caps.maxBytes) {
      notes.push(`One captured image was ${data.byteLength} bytes, above the ${caps.maxBytes}-byte limit, and was not attached.`)
      continue
    }
    if (!caps.mediaTypes.includes(payload.mediaType)) {
      notes.push(`One captured image used the unsupported type ${payload.mediaType} and was not attached.`)
      continue
    }
    try {
      refs.push(await store.saveImage({
        data,
        mediaType: payload.mediaType,
        ...(payload.name === undefined ? {} : { name: payload.name }),
      }))
    } catch (error: unknown) {
      notes.push(`One captured image could not be stored: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { refs, notes }
}

/**
 * Decode base64 without throwing on malformed input.
 * @param data - base64 text without a `data:` prefix.
 * @returns the bytes, or `undefined` when the text is not valid base64.
 */
function decodeBase64(data: string): Uint8Array | undefined {
  const decoded = Buffer.from(data, 'base64')
  // Buffer.from ignores invalid characters instead of failing, so verify the
  // round trip: a payload that re-encodes differently was not clean base64.
  if (decoded.length === 0 || decoded.toString('base64').replace(/=+$/, '') !== data.replace(/=+$/, '')) {
    return undefined
  }
  return new Uint8Array(decoded)
}
