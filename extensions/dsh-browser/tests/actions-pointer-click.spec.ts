// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { runAction } from '../src/content/actions.ts'
import { ElementIds } from '../src/content/ids.ts'
import { buildSnapshot, renderSnapshot, type SnapshotBudget } from '../src/content/snapshot.ts'

const BUDGET: SnapshotBudget = { maxItems: 40, maxForms: 20, maxHiddenForms: 40, maxChars: 8_000 }

function layout(el: Element, width = 80, height = 24): void {
  Object.defineProperty(el, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      width,
      height,
      top: 0,
      left: 0,
      bottom: height,
      right: width,
      x: 0,
      y: 0,
      toJSON() { return {} },
    }),
  })
}

describe('pointer-sequence click for design-system pickers', () => {
  it('opens a mousedown/focus-only picker and focuses the nested input', async () => {
    document.body.innerHTML = `
      <div id="wrap" style="cursor:pointer" aria-label="起止时间YYYY-MM">
        <span id="trigger" style="cursor:pointer">YYYY-MM</span>
        <input id="hidden" style="opacity:0" readonly value="" />
      </div>
      <div id="panel" style="display:none">open</div>
    `
    for (const el of document.querySelectorAll('#wrap, #trigger, #hidden, #panel')) layout(el)
    const trigger = document.getElementById('trigger')!
    const hidden = document.getElementById('hidden') as HTMLInputElement
    const panel = document.getElementById('panel')!
    const events: string[] = []
    trigger.addEventListener('mousedown', () => {
      events.push('mousedown')
      panel.style.display = 'block'
    })
    // click alone must not open the panel (Arco-like).
    trigger.addEventListener('click', () => events.push('click'))
    hidden.addEventListener('focus', () => {
      events.push('focus')
      panel.style.display = 'block'
    })

    const ids = new ElementIds()
    const view = buildSnapshot(ids, { budget: BUDGET }, null)
    const rendered = renderSnapshot(view, false)
    expect(rendered).toMatch(/heuristic\/depth=2/)

    const inner = view.items.find((item) => item.name === 'YYYY-MM' || item.depth === 2)
    expect(inner).toBeDefined()

    await runAction('browser_click', { index: inner!.index }, { ids, budget: BUDGET })
    expect(events).toEqual(expect.arrayContaining(['mousedown', 'click']))
    expect(panel.style.display).toBe('block')

    // Clicking the outer wrap focuses the nested readonly input (picker pattern).
    panel.style.display = 'none'
    events.length = 0
    const outer = view.items.find((item) => item.depth === 1)
    expect(outer).toBeDefined()
    await runAction('browser_click', { index: outer!.index }, { ids, budget: BUDGET })
    expect(panel.style.display).toBe('block')
    expect(document.activeElement).toBe(hidden)
  })

  it('still activates onClick-only add buttons', async () => {
    document.body.innerHTML = `<div id="add" style="cursor:pointer" aria-label="添加">添加</div>`
    layout(document.getElementById('add')!)
    let clicked = false
    document.getElementById('add')!.addEventListener('click', () => { clicked = true })
    const ids = new ElementIds()
    const view = buildSnapshot(ids, { budget: BUDGET }, null)
    const item = view.items.find((entry) => entry.name === '添加')!
    await runAction('browser_click', { index: item.index }, { ids, budget: BUDGET })
    expect(clicked).toBe(true)
  })
})

describe('hidden form labels', () => {
  it('uses the nearest field title when aria/placeholder are empty', () => {
    document.body.innerHTML = `
      <div>
        <div>起止时间</div>
        <input id="start" style="opacity:0" value="" />
      </div>
    `
    layout(document.getElementById('start')!)
    // opacity:0 → hidden form
    const ids = new ElementIds()
    const view = buildSnapshot(ids, { budget: BUDGET }, null)
    const hidden = view.forms.find((form) => form.hidden === true)
    expect(hidden?.label).toContain('起止时间')
  })
})
