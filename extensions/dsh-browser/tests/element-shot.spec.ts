// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  captureElementShot,
  chromeElementShotDeps,
  ElementShotError,
  MAX_SHOT_SCALE,
  shotScale,
  type ElementShotDeps,
} from '../src/background/element-shot.ts'

const CAPS = { maxDimension: 1_568, maxPixels: 2_000_000 }

/** A scripted debugger: records the conversation, answers with a queued reply. */
function fakeDeps(reply: unknown = { data: 'AAAA' }, granted = true): ElementShotDeps & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    hasPermission: async () => granted,
    attach: async (target, version) => { calls.push(`attach ${JSON.stringify(target)} ${version}`) },
    detach: async () => { calls.push('detach') },
    send: async (_target, method, params) => {
      calls.push(`send ${method} ${JSON.stringify(params)}`)
      if (reply instanceof Error) throw reply
      return reply
    },
  }
}

describe('shotScale', () => {
  it('restores the source resolution behind a downscaled thumbnail', () => {
    // A 1200px photo shown in a 300px column: 4x recovers the original, and
    // both budgets have room for it (edge allows 5.23x, area 5.44x).
    expect(shotScale({ width: 300, height: 225 }, { width: 1_200, height: 900 }, CAPS)).toBe(4)
  })

  it('clamps restoration to the long-edge cap when the original overshoots it', () => {
    // 400px rendered, 1600px natural: full restoration would need 4x, but
    // 400x3.92 is exactly the 1568 cap, so that is all encodeBitmap would keep.
    expect(shotScale({ width: 400, height: 300 }, { width: 1_600, height: 1_200 }, CAPS)).toBeCloseTo(3.92, 5)
  })

  it('never rasterizes below the on-screen rendering', () => {
    // Natural smaller than rendered (an upscaled icon) must not shrink the shot.
    expect(shotScale({ width: 400, height: 400 }, { width: 100, height: 100 }, CAPS)).toBe(1)
  })

  it('stops at the pixel budget instead of producing pixels encodeBitmap discards', () => {
    // 1000x1000 CSS = 1M px; a 2M px budget allows only sqrt(2) linear.
    expect(shotScale({ width: 1_000, height: 1_000 }, { width: 8_000, height: 8_000 }, CAPS))
      .toBeCloseTo(Math.SQRT2, 5)
  })

  it('stops at the long-edge budget for a wide strip', () => {
    // A 1568-wide cap over a 784 CSS strip allows exactly 2x, even though the
    // area budget would permit far more.
    expect(shotScale({ width: 784, height: 100 }, { width: 6_000, height: 800 }, CAPS)).toBe(2)
  })

  it('is bounded above, so a mis-measured box cannot ask for an enormous surface', () => {
    const scale = shotScale({ width: 2, height: 2 }, { width: 9_000, height: 9_000 }, { maxDimension: 100_000, maxPixels: undefined })
    expect(scale).toBe(MAX_SHOT_SCALE)
  })

  it('falls back to the budget when the natural size is unknown', () => {
    // A lazy image the browser never decoded reports 0x0; use the full budget.
    expect(shotScale({ width: 784, height: 100 }, undefined, CAPS)).toBe(2)
    expect(shotScale({ width: 0, height: 0 }, undefined, CAPS)).toBe(1)
  })
})

describe('captureElementShot', () => {
  it('clips at document coordinates, reaches past the viewport, and detaches', async () => {
    const deps = fakeDeps()
    const dataUrl = await captureElementShot(5, { x: 10, y: 2_400, width: 300, height: 200, scale: 3 }, deps)

    expect(dataUrl).toBe('data:image/png;base64,AAAA')
    expect(deps.calls[0]).toContain('"tabId":5')
    const sent = JSON.parse(deps.calls[1]!.slice('send Page.captureScreenshot '.length))
    expect(sent.clip).toEqual({ x: 10, y: 2_400, width: 300, height: 200, scale: 3 })
    // Without these the element would have to be scrolled into view first.
    expect(sent.captureBeyondViewport).toBe(true)
    expect(sent.fromSurface).toBe(true)
    expect(deps.calls.at(-1)).toBe('detach')
  })

  it('refuses without the optional permission, and never attaches', async () => {
    const deps = fakeDeps({ data: 'AAAA' }, false)
    await expect(captureElementShot(1, { x: 0, y: 0, width: 10, height: 10, scale: 1 }, deps))
      .rejects.toThrow(/permission is not granted/)
    expect(deps.calls).toHaveLength(0)
  })

  it('explains an attach conflict in terms the user can act on', async () => {
    const deps = fakeDeps()
    deps.attach = async () => { throw new Error('Another debugger is already attached') }
    await expect(captureElementShot(1, { x: 0, y: 0, width: 10, height: 10, scale: 1 }, deps))
      .rejects.toThrow(/DevTools may be open/)
  })

  it('treats an empty protocol response as a failure, and still detaches', async () => {
    const deps = fakeDeps({ data: '' })
    await expect(captureElementShot(1, { x: 0, y: 0, width: 10, height: 10, scale: 1 }, deps))
      .rejects.toThrow(ElementShotError)
    expect(deps.calls.at(-1)).toBe('detach')
  })

  it('detaches even when the protocol call throws', async () => {
    const deps = fakeDeps(new Error('target closed'))
    await expect(captureElementShot(1, { x: 0, y: 0, width: 10, height: 10, scale: 1 }, deps))
      .rejects.toThrow(/target closed/)
    expect(deps.calls.at(-1)).toBe('detach')
  })

  it('tolerates a detach on a tab that closed mid-capture', async () => {
    const deps = fakeDeps()
    deps.detach = async () => { throw new Error('tab closed') }
    await expect(captureElementShot(1, { x: 0, y: 0, width: 10, height: 10, scale: 1 }, deps))
      .resolves.toContain('data:image/png;base64,')
  })

  it('the live deps bind to real chrome seams', () => {
    const deps = chromeElementShotDeps()
    expect(deps.hasPermission).toBeTypeOf('function')
    expect(deps.send).toBeTypeOf('function')
  })
})
