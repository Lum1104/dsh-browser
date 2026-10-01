// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runAction } from '../src/content/actions.ts'
import { ElementIds } from '../src/content/ids.ts'

const BUDGET = { maxItems: 20, maxForms: 10, maxHiddenForms: 40, maxChars: 8_000 }

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
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

describe('automatic action deltas', () => {
  it('returns settled page changes after a click when sharing is enabled', async () => {
    document.body.innerHTML = '<main>Pending</main><button>Complete</button>'
    const button = document.querySelector('button')!
    button.scrollIntoView = vi.fn()
    button.addEventListener('click', () => {
      document.querySelector('main')!.textContent = 'Complete'
    })
    const ids = new ElementIds()
    await runAction('browser_snapshot', {}, { ids, budget: BUDGET })

    const pending = runAction('browser_click', { index: ids.indexOf(button) }, {
      ids,
      budget: BUDGET,
      includePageDelta: true,
    })
    await vi.advanceTimersByTimeAsync(100)

    await expect(pending).resolves.toMatchObject({
      text: expect.stringContaining('Clicked'),
      pageContent: expect.stringContaining('Complete'),
    })
  })

  it('masks sensitive values in the delta returned after typing', async () => {
    document.body.innerHTML = '<main>Sign in</main><input aria-label="Password" type="password">'
    const input = document.querySelector('input')!
    const ids = new ElementIds()
    await runAction('browser_snapshot', {}, { ids, budget: BUDGET })

    const pending = runAction('browser_type', {
      index: ids.indexOf(input),
      text: 'secret-value',
    }, {
      ids,
      budget: BUDGET,
      includePageDelta: true,
    })
    await vi.advanceTimersByTimeAsync(32)
    const result = await pending

    expect(result.pageContent).toContain('value="••••"')
    expect(result.pageContent).not.toContain('secret-value')
  })

  it('does not extract page changes when automatic sharing is disabled', async () => {
    document.body.innerHTML = '<main>Pending</main><button>Complete</button>'
    const button = document.querySelector('button')!
    button.scrollIntoView = vi.fn()
    button.addEventListener('click', () => {
      document.querySelector('main')!.textContent = 'Complete'
    })
    const ids = new ElementIds()
    await runAction('browser_snapshot', {}, { ids, budget: BUDGET })

    const pending = runAction('browser_click', { index: ids.indexOf(button) }, {
      ids,
      budget: BUDGET,
      includePageDelta: false,
    })
    await vi.advanceTimersByTimeAsync(100)

    await expect(pending).resolves.toEqual({ text: expect.stringContaining('Clicked') })
  })

  it('returns a delta immediately when a client-side router cancels navigation', async () => {
    document.body.innerHTML = '<main>Home</main><a href="/orders">Orders</a>'
    const link = document.querySelector('a')!
    link.scrollIntoView = vi.fn()
    link.addEventListener('click', (event) => {
      event.preventDefault()
      document.querySelector('main')!.textContent = 'Orders'
    })
    const ids = new ElementIds()
    await runAction('browser_snapshot', {}, { ids, budget: BUDGET })

    const pending = runAction('browser_click', { index: ids.indexOf(link) }, {
      ids,
      budget: BUDGET,
      includePageDelta: true,
    })
    await vi.advanceTimersByTimeAsync(100)
    const result = await pending

    expect(result.navigationPending).toBeUndefined()
    expect(result.pageContent).toContain('Orders')
  })

})
