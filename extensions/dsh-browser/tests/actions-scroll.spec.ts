// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runAction } from '../src/content/actions.ts'
import { ElementIds } from '../src/content/ids.ts'

const BUDGET = { maxItems: 20, maxForms: 10, maxChars: 8_000 }
const SETTLE_MS = 200

let scrollBy: ReturnType<typeof vi.fn>
let scrollTo: ReturnType<typeof vi.fn>

/**
 * jsdom has no layout engine: an element's scroll geometry and its resolved
 * overflow are both fake here, which is exactly the two facts the container
 * lookup reads.
 */
function makeScrollable(el: HTMLElement, geometry: { top: number; scrollHeight: number; clientHeight: number }): void {
  let top = geometry.top
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (value: number) => { top = value },
  })
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => geometry.scrollHeight })
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => geometry.clientHeight })
  el.style.overflowY = 'auto'
  const real = window.getComputedStyle.bind(window)
  // Only the container is answered from the inline style; every other element
  // keeps the real cascade so snapshot rendering is unaffected.
  vi.spyOn(window, 'getComputedStyle').mockImplementation(((target: Element, pseudo?: string | null) =>
    target === el ? { overflowY: 'auto' } as CSSStyleDeclaration : real(target, pseudo)) as typeof window.getComputedStyle)
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(document, 'readyState', 'get').mockReturnValue('complete')
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    top: 0,
    left: 0,
    right: 100,
    bottom: 20,
    width: 100,
    height: 20,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect)
  scrollBy = vi.fn()
  scrollTo = vi.fn()
  Object.defineProperty(window, 'scrollBy', { configurable: true, writable: true, value: scrollBy })
  Object.defineProperty(window, 'scrollTo', { configurable: true, writable: true, value: scrollTo })
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

describe('browser_scroll targeting', () => {
  it('scrolls the nearest scrollable container of an element index, not the page', async () => {
    document.body.innerHTML = '<div id="pane" role="log"><button>Older</button></div>'
    const pane = document.querySelector<HTMLElement>('#pane')!
    const button = document.querySelector('button')!
    makeScrollable(pane, { top: 300, scrollHeight: 1_000, clientHeight: 300 })
    const wheels: WheelEvent[] = []
    pane.addEventListener('wheel', (event) => { wheels.push(event as WheelEvent) })

    const ids = new ElementIds()
    await runAction('browser_snapshot', {}, { ids, budget: BUDGET })

    const pending = runAction('browser_scroll', {
      direction: 'down',
      amount: 200,
      index: ids.indexOf(button),
    }, { ids, budget: BUDGET })
    await vi.advanceTimersByTimeAsync(SETTLE_MS)
    const result = await pending

    expect(pane.scrollTop).toBe(500)
    expect(scrollBy).not.toHaveBeenCalled()
    expect(result.text).toContain('inside div#pane')
    expect(result.text).toContain('(300 to 500)')
    expect(wheels).toHaveLength(1)
    expect(wheels[0]!.deltaY).toBe(200)
    expect(wheels[0]!.bubbles).toBe(true)
  })

  it('jumps a container to its own top and bottom edges', async () => {
    document.body.innerHTML = '<div id="pane"><button>Older</button></div>'
    const pane = document.querySelector<HTMLElement>('#pane')!
    const button = document.querySelector('button')!
    makeScrollable(pane, { top: 400, scrollHeight: 1_200, clientHeight: 300 })

    const ids = new ElementIds()
    await runAction('browser_snapshot', {}, { ids, budget: BUDGET })
    const index = ids.indexOf(button)

    const toTop = runAction('browser_scroll', { direction: 'top', index }, { ids, budget: BUDGET })
    await vi.advanceTimersByTimeAsync(SETTLE_MS)
    await toTop
    expect(pane.scrollTop).toBe(0)

    const toBottom = runAction('browser_scroll', { direction: 'bottom', index }, { ids, budget: BUDGET })
    await vi.advanceTimersByTimeAsync(SETTLE_MS)
    await toBottom
    expect(pane.scrollTop).toBe(1_200)
  })

  it('accepts a CSS selector as the container anchor', async () => {
    document.body.innerHTML = '<div id="pane"><span>Row</span></div>'
    const pane = document.querySelector<HTMLElement>('#pane')!
    makeScrollable(pane, { top: 100, scrollHeight: 900, clientHeight: 300 })

    const ids = new ElementIds()
    await runAction('browser_snapshot', {}, { ids, budget: BUDGET })

    const pending = runAction('browser_scroll', {
      direction: 'down',
      amount: 50,
      selector: '#pane',
    }, { ids, budget: BUDGET })
    await vi.advanceTimersByTimeAsync(SETTLE_MS)
    const result = await pending

    expect(pane.scrollTop).toBe(150)
    expect(result.text).toContain('div#pane')
  })

  it('rejects a call that names both an index and a selector', async () => {
    document.body.innerHTML = '<div id="pane"><button>Older</button></div>'
    const ids = new ElementIds()
    await runAction('browser_snapshot', {}, { ids, budget: BUDGET })

    await expect(runAction('browser_scroll', {
      direction: 'down',
      index: 0,
      selector: '#pane',
    }, { ids, budget: BUDGET })).rejects.toThrow(/either index or selector/)
  })

  it('falls back to the page when the target has no scrollable container', async () => {
    document.body.innerHTML = '<main><button>Loose</button></main>'
    const button = document.querySelector('button')!
    const ids = new ElementIds()
    await runAction('browser_snapshot', {}, { ids, budget: BUDGET })

    const pending = runAction('browser_scroll', {
      direction: 'down',
      amount: 120,
      index: ids.indexOf(button),
    }, { ids, budget: BUDGET })
    await vi.advanceTimersByTimeAsync(SETTLE_MS)
    const result = await pending

    expect(scrollBy).toHaveBeenCalledWith({ top: 120, behavior: 'instant' })
    expect(result.text).toContain('no scrollable container')
  })

  it('still scrolls the page when no target is given', async () => {
    const ids = new ElementIds()

    const pending = runAction('browser_scroll', { direction: 'down', amount: 400 }, { ids, budget: BUDGET })
    await vi.advanceTimersByTimeAsync(SETTLE_MS)
    const result = await pending

    expect(scrollBy).toHaveBeenCalledWith({ top: 400, behavior: 'instant' })
    expect(result.text).toBe('Scrolled down.')
  })
})
