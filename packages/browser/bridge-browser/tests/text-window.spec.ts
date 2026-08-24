import { describe, expect, it } from 'vitest'
import {
  hasMore,
  renderWindowFooter,
  resolveLimit,
  resolveOffset,
  windowText,
} from '../src/text-window.ts'

const SOURCE = 'abcdefghij' // 10 characters

describe('windowText', () => {
  it('returns the whole source when it fits', () => {
    expect(windowText(SOURCE, 0, 50)).toEqual({ text: SOURCE, offset: 0, returned: 10, total: 10 })
    expect(hasMore(windowText(SOURCE, 0, 50))).toBe(false)
  })

  it('returns a bounded slice and reports the total', () => {
    const view = windowText(SOURCE, 0, 4)
    expect(view).toEqual({ text: 'abcd', offset: 0, returned: 4, total: 10 })
    expect(hasMore(view)).toBe(true)
  })

  it('continues exactly where the previous window stopped, losing nothing', () => {
    const first = windowText(SOURCE, 0, 4)
    const second = windowText(SOURCE, first.offset + first.returned, 4)
    const third = windowText(SOURCE, second.offset + second.returned, 4)
    expect(first.text + second.text + third.text).toBe(SOURCE)
    expect(hasMore(third)).toBe(false)
  })

  it('clamps an offset past the end to an empty window rather than failing', () => {
    expect(windowText(SOURCE, 99, 4)).toEqual({ text: '', offset: 10, returned: 0, total: 10 })
  })

  it('treats a negative offset as the start and a non-positive limit as nothing', () => {
    expect(windowText(SOURCE, -5, 3)).toMatchObject({ offset: 0, text: 'abc' })
    expect(windowText(SOURCE, 0, 0)).toMatchObject({ returned: 0, total: 10 })
  })

  it('handles an empty source', () => {
    expect(windowText('', 0, 10)).toEqual({ text: '', offset: 0, returned: 0, total: 0 })
    expect(hasMore(windowText('', 0, 10))).toBe(false)
  })
})

describe('renderWindowFooter', () => {
  it('says nothing when a complete text was returned from the start', () => {
    expect(renderWindowFooter(windowText(SOURCE, 0, 50), 'call')).toBe('')
  })

  it('states what remains and the exact continuing call', () => {
    const footer = renderWindowFooter(windowText(SOURCE, 0, 4), 'browser_get_text({ offset: 4 })')
    expect(footer).toContain('characters 0-4 of 10')
    expect(footer).toContain('6 remain')
    expect(footer).toContain('browser_get_text({ offset: 4 })')
  })

  it('marks the end of a continued read, so the model knows to stop paging', () => {
    const footer = renderWindowFooter(windowText(SOURCE, 8, 4), 'call')
    expect(footer).toContain('end of text')
    expect(footer).toContain('8-10 of 10')
    expect(footer).not.toContain('remain')
  })
})

describe('resolveLimit and resolveOffset', () => {
  it('falls back for anything unusable and clamps to the maximum', () => {
    expect(resolveLimit(undefined, 100, 500)).toBe(100)
    expect(resolveLimit('big', 100, 500)).toBe(100)
    expect(resolveLimit(0, 100, 500)).toBe(100)
    expect(resolveLimit(-7, 100, 500)).toBe(100)
    expect(resolveLimit(Number.NaN, 100, 500)).toBe(100)
    expect(resolveLimit(250, 100, 500)).toBe(250)
    expect(resolveLimit(9_000, 100, 500)).toBe(500)
    expect(resolveLimit(250.7, 100, 500)).toBe(250)
  })

  it('reads an offset defensively', () => {
    expect(resolveOffset(undefined)).toBe(0)
    expect(resolveOffset(-3)).toBe(0)
    expect(resolveOffset('12')).toBe(0)
    expect(resolveOffset(12.9)).toBe(12)
    expect(resolveOffset(Number.POSITIVE_INFINITY)).toBe(0)
  })
})
