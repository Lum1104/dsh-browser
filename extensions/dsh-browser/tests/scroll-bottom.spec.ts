// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { isNearScrollBottom } from '../src/panel/scroll.ts'

describe('isNearScrollBottom', () => {
  it('treats a fully scrolled viewport as near the bottom', () => {
    expect(isNearScrollBottom({ scrollTop: 200, scrollHeight: 500, clientHeight: 300 })).toBe(true)
  })

  it('allows a small slack threshold above the true bottom', () => {
    expect(isNearScrollBottom({ scrollTop: 160, scrollHeight: 500, clientHeight: 300 }, 48)).toBe(true)
    expect(isNearScrollBottom({ scrollTop: 140, scrollHeight: 500, clientHeight: 300 }, 48)).toBe(false)
  })

  it('treats short unscrollable content as near the bottom', () => {
    expect(isNearScrollBottom({ scrollTop: 0, scrollHeight: 200, clientHeight: 300 })).toBe(true)
  })
})
