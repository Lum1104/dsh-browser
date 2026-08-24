// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { bytesToBase64, clampBoxToImage, fitWithin } from '../src/background/capture.ts'

describe('fitWithin', () => {
  it('leaves an image inside the cap untouched', () => {
    expect(fitWithin(800, 600, 1_568)).toEqual({ width: 800, height: 600 })
  })

  it('scales the long edge to the cap and keeps the aspect ratio', () => {
    expect(fitWithin(3_200, 1_600, 1_600)).toEqual({ width: 1_600, height: 800 })
    expect(fitWithin(1_000, 4_000, 1_000)).toEqual({ width: 250, height: 1_000 })
  })

  it('never collapses a dimension to zero', () => {
    expect(fitWithin(4_000, 3, 100)).toEqual({ width: 100, height: 1 })
  })

  it('applies the pixel cap a long-edge cap alone would miss', () => {
    // 1200x1200 passes a 1568 edge cap but carries 1.44M pixels; capped at 1M
    // the linear factor is sqrt(1M/1.44M) = 0.833.
    expect(fitWithin(1_200, 1_200, 1_568, 1_000_000)).toEqual({ width: 1_000, height: 1_000 })
  })

  it('honors whichever of the two caps binds harder', () => {
    // Edge binds: a wide strip is well under the area budget.
    expect(fitWithin(3_200, 400, 1_600, 4_000_000)).toEqual({ width: 1_600, height: 200 })
    // Area binds: a square is under the edge cap but over the pixel budget.
    expect(fitWithin(1_500, 1_500, 1_600, 1_000_000)).toEqual({ width: 1_000, height: 1_000 })
  })

  it('leaves an image under both caps alone, and never enlarges to reach one', () => {
    expect(fitWithin(800, 600, 1_568, 2_000_000)).toEqual({ width: 800, height: 600 })
    expect(fitWithin(100, 100, 1_568, 2_000_000)).toEqual({ width: 100, height: 100 })
  })
})

describe('clampBoxToImage', () => {
  it('converts CSS pixels to device pixels', () => {
    expect(clampBoxToImage({ x: 10, y: 20, width: 100, height: 50, dpr: 2 }, 800, 600))
      .toEqual({ x: 20, y: 40, width: 200, height: 100 })
  })

  it('clips a box that hangs off the captured image', () => {
    expect(clampBoxToImage({ x: 700, y: 0, width: 300, height: 100, dpr: 1 }, 800, 600))
      .toEqual({ x: 700, y: 0, width: 100, height: 100 })
  })

  it('rejects a box entirely outside the image', () => {
    expect(clampBoxToImage({ x: 900, y: 0, width: 100, height: 100, dpr: 1 }, 800, 600)).toBeUndefined()
    expect(clampBoxToImage({ x: 0, y: -50, width: 100, height: 40, dpr: 1 }, 800, 600)).toBeUndefined()
  })

  it('treats a missing device ratio as 1', () => {
    expect(clampBoxToImage({ x: 0, y: 0, width: 10, height: 10, dpr: 0 }, 100, 100))
      .toEqual({ x: 0, y: 0, width: 10, height: 10 })
  })
})

describe('bytesToBase64', () => {
  it('round-trips bytes, including a buffer past one chunk', () => {
    const bytes = new Uint8Array(0x8000 + 17)
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 256
    const decoded = Uint8Array.from(atob(bytesToBase64(bytes)), (ch) => ch.charCodeAt(0))
    expect(decoded).toEqual(bytes)
  })
})
