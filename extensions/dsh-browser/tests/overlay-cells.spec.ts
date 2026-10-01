// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { runAction } from '../src/content/actions.ts'
import { collectInteractive, findOverlayRoots } from '../src/content/extract.ts'
import { ElementIds } from '../src/content/ids.ts'
import { buildSnapshot, renderSnapshot, type SnapshotBudget } from '../src/content/snapshot.ts'

const BUDGET: SnapshotBudget = { maxItems: 80, maxForms: 20, maxHiddenForms: 40, maxChars: 12_000 }

function layout(el: Element, width = 40, height = 24): void {
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

describe('overlay panel cells', () => {
  it('collects short-text leaves inside a floating panel without cursor:pointer', () => {
    document.body.innerHTML = `
      <div class="picker-panel" style="position:absolute;z-index:100">
        <div id="y2024">2024</div>
        <div id="m01">01</div>
        <div id="noise">这是一段很长的说明文字不应该被当成单元格</div>
      </div>
    `
    for (const el of document.querySelectorAll('.picker-panel, #y2024, #m01, #noise')) layout(el, 48, 24)
    layout(document.querySelector('.picker-panel')!, 200, 120)

    const roots = findOverlayRoots(document)
    expect(roots.length).toBeGreaterThan(0)

    const collected = collectInteractive(document)
    const overlay = collected.filter((entry) => entry.source === 'overlay')
    expect(overlay.map((entry) => (entry.element as HTMLElement).id).sort()).toEqual(['m01', 'y2024'])
  })

  it('clicks a year cell by text after the panel opens', async () => {
    document.body.innerHTML = `
      <form id="apply">
        <input id="focus-trap" />
        <div id="trigger" style="cursor:pointer" aria-haspopup="dialog">YYYY-MM</div>
        <div class="date-panel" id="panel" style="display:none;position:absolute;z-index:200">
          <div id="cell-2024">2024</div>
          <div id="cell-01">01</div>
        </div>
      </form>
    `
    for (const el of document.querySelectorAll('#trigger, #panel, #cell-2024, #cell-01, #focus-trap')) {
      layout(el)
    }
    layout(document.getElementById('panel')!, 200, 160)

    const panel = document.getElementById('panel')!
    const trigger = document.getElementById('trigger')!
    trigger.addEventListener('mousedown', () => { panel.style.display = 'block' })
    let yearClicked = false
    document.getElementById('cell-2024')!.addEventListener('click', () => { yearClicked = true })

    const ids = new ElementIds()
    buildSnapshot(ids, { budget: BUDGET }, null)
    const open = await runAction('browser_click', { text: 'YYYY-MM' }, { ids, budget: BUDGET })
    expect(open.text).toContain('Clicked')
    expect(panel.style.display).toBe('block')

    const afterOpen = buildSnapshot(ids, { budget: BUDGET }, null)
    const rendered = renderSnapshot(afterOpen, false)
    expect(rendered).toMatch(/option "2024".*\[overlay\]/)

    await runAction('browser_click', { text: '2024' }, { ids, budget: BUDGET })
    expect(yearClicked).toBe(true)
  })

  it('does not synthesize form submit on Enter while an overlay is open', async () => {
    document.body.innerHTML = `
      <form id="apply">
        <input id="field" />
        <div class="picker-panel" style="position:absolute;z-index:100"><div>2024</div></div>
      </form>
    `
    for (const el of document.querySelectorAll('#field, .picker-panel, .picker-panel div')) layout(el)
    layout(document.querySelector('.picker-panel')!, 200, 100)
    const form = document.getElementById('apply') as HTMLFormElement
    const field = document.getElementById('field') as HTMLInputElement
    field.focus()
    let submitted = false
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      submitted = true
    })

    const ids = new ElementIds()
    await runAction('browser_press', { key: 'Enter' }, { ids, budget: BUDGET })
    expect(submitted).toBe(false)
  })

  it('does not treat a persistent in-flow panel as an open overlay for Enter', async () => {
    document.body.innerHTML = `
      <aside class="side-panel" style="position:relative">
        <div>导航</div>
      </aside>
      <form id="apply">
        <input id="field" />
      </form>
    `
    for (const el of document.querySelectorAll('#field, .side-panel, .side-panel div')) layout(el)
    layout(document.querySelector('.side-panel')!, 200, 400)
    expect(findOverlayRoots(document)).toHaveLength(0)

    const form = document.getElementById('apply') as HTMLFormElement
    const field = document.getElementById('field') as HTMLInputElement
    field.focus()
    let submitted = false
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      submitted = true
    })

    const ids = new ElementIds()
    await runAction('browser_press', { key: 'Enter' }, { ids, budget: BUDGET })
    expect(submitted).toBe(true)
  })
})
