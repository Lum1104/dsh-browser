// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { runAction, ActionError } from '../src/content/actions.ts'
import { ElementIds } from '../src/content/ids.ts'
import { buildSnapshot, type SnapshotBudget } from '../src/content/snapshot.ts'

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
  ;(el as HTMLElement).scrollIntoView = vi.fn()
}

describe('selector and text addressing', () => {
  it('clicks by selector and reports no-match / ambiguous-match', async () => {
    document.body.innerHTML = `
      <button id="one">One</button>
      <button class="dup">A</button>
      <button class="dup">B</button>
    `
    for (const el of document.querySelectorAll('button')) layout(el)
    const ids = new ElementIds()
    buildSnapshot(ids, { budget: BUDGET }, null)

    await expect(runAction('browser_click', { selector: '#missing' }, { ids, budget: BUDGET }))
      .rejects.toMatchObject({ code: 'no-match' })

    await expect(runAction('browser_click', { selector: 'button.dup' }, { ids, budget: BUDGET }))
      .rejects.toMatchObject({ code: 'ambiguous-match' })

    const ok = await runAction('browser_click', { selector: '#one' }, { ids, budget: BUDGET })
    expect(ok.text).toContain('selector "#one"')
  })

  it('reports malformed selectors as bad-args, not no-match', async () => {
    const ids = new ElementIds()
    await expect(runAction('browser_click', { selector: '###' }, { ids, budget: BUDGET }))
      .rejects.toMatchObject({ code: 'bad-args', message: expect.stringMatching(/Invalid CSS selector/) })
  })

  it('clicks by text and lifts to a pointer ancestor', async () => {
    document.body.innerHTML = `
      <div id="host" style="cursor:pointer" role="button"><span>添加</span></div>
    `
    layout(document.getElementById('host')!)
    layout(document.querySelector('#host span')!)
    const ids = new ElementIds()
    buildSnapshot(ids, { budget: BUDGET }, null)
    const clicked: string[] = []
    document.getElementById('host')!.addEventListener('click', () => clicked.push('host'))

    const result = await runAction('browser_click', { text: '添加' }, { ids, budget: BUDGET })
    expect(result.text).toContain('text "添加"')
    expect(clicked).toEqual(['host'])
  })

  it('types into a hidden form field without scrolling', async () => {
    document.body.innerHTML = `<input id="month" style="opacity:0" value="2019-07" />`
    const input = document.getElementById('month') as HTMLInputElement
    layout(input)
    const ids = new ElementIds()
    const view = buildSnapshot(ids, { budget: BUDGET }, null)
    const field = view.forms.find((form) => form.hidden === true)
    expect(field).toBeDefined()

    const events: string[] = []
    input.addEventListener('input', () => events.push('input'))
    input.addEventListener('change', () => events.push('change'))

    await runAction('browser_type', {
      index: field!.index,
      text: '2022-04',
      replace: true,
    }, { ids, budget: BUDGET })

    expect(input.value).toBe('2022-04')
    expect(events).toEqual(expect.arrayContaining(['input', 'change']))
    expect(input.scrollIntoView).not.toHaveBeenCalled()
  })

  it('focuses by selector', async () => {
    document.body.innerHTML = `<input id="name" />`
    const input = document.getElementById('name') as HTMLInputElement
    layout(input)
    const ids = new ElementIds()
    buildSnapshot(ids, { budget: BUDGET }, null)
    const focus = vi.spyOn(input, 'focus')
    const result = await runAction('browser_focus', { selector: '#name' }, { ids, budget: BUDGET })
    expect(result.text).toContain('Focused')
    expect(focus).toHaveBeenCalled()
  })

  it('uploads via DataTransfer onto a hidden file input', async () => {
    document.body.innerHTML = `<input id="file" type="file" style="display:none" />`
    const input = document.getElementById('file') as HTMLInputElement
    const ids = new ElementIds()
    // display:none → not in interactive inventory; address by selector + allowHidden.
    const events: string[] = []
    input.addEventListener('change', () => events.push('change'))
    input.addEventListener('input', () => events.push('input'))

    const dataBase64 = Buffer.from('hello-resume').toString('base64')
    const result = await runAction('browser_upload', {
      selector: '#file',
      allowHidden: true,
      name: 'resume.txt',
      mimeType: 'text/plain',
      dataBase64,
    }, { ids, budget: BUDGET })

    expect(result.text).toContain('resume.txt')
    expect(input.files).toHaveLength(1)
    expect(input.files?.[0]?.name).toBe('resume.txt')
    expect(events).toEqual(expect.arrayContaining(['input', 'change']))
  })

  it('rejects mutually exclusive addressing', async () => {
    const ids = new ElementIds()
    await expect(runAction('browser_click', { index: 1, selector: '#x' }, { ids, budget: BUDGET }))
      .rejects.toBeInstanceOf(ActionError)
  })
})

describe('region-scoped snapshot', () => {
  it('scopes inventory to the region and errors when missing', () => {
    document.body.innerHTML = `
      <div id="side"><button id="side-btn">Side</button></div>
      <div id="main"><button id="main-btn">Main</button></div>
    `
    for (const el of document.querySelectorAll('button')) layout(el)
    const ids = new ElementIds()
    const view = buildSnapshot(ids, { region: '#main', budget: BUDGET }, null)
    expect(view.items.some((item) => item.name === 'Main')).toBe(true)
    expect(view.items.some((item) => item.name === 'Side')).toBe(false)

    expect(() => buildSnapshot(ids, { region: '#missing', budget: BUDGET }, null))
      .toThrow(/No element matched selector: #missing/)
  })

  it('preserves full-document indexes across a region snapshot', async () => {
    document.body.innerHTML = `
      <div id="side"><button id="side-btn">Side</button></div>
      <div id="main"><button id="main-btn">Main</button></div>
    `
    for (const el of document.querySelectorAll('button')) layout(el)
    const ids = new ElementIds()
    const full = buildSnapshot(ids, { budget: BUDGET }, null)
    const side = full.items.find((item) => item.name === 'Side')
    expect(side).toBeDefined()

    const regional = buildSnapshot(ids, { region: '#main', budget: BUDGET }, null)
    expect(regional.items.some((item) => item.name === 'Side')).toBe(false)
    expect(ids.elementByIndex(side!.index)).toBe(document.getElementById('side-btn'))

    const clicked = await runAction('browser_click', { index: side!.index }, { ids, budget: BUDGET })
    expect(clicked.text).toContain(`[${side!.index}]`)
  })

  it('reports invalid region selectors as bad-args', async () => {
    const ids = new ElementIds()
    await expect(runAction('browser_snapshot', { region: '###' }, { ids, budget: BUDGET }))
      .rejects.toMatchObject({ code: 'bad-args', message: expect.stringMatching(/Invalid CSS selector/) })
  })
})
