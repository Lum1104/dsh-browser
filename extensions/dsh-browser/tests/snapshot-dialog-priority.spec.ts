// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { ElementIds } from '../src/content/ids.ts'
import { buildSnapshot, type SnapshotBudget } from '../src/content/snapshot.ts'

/**
 * An open modal owns interaction, but it is appended late in the DOM. On an
 * element-heavy page that pushed its controls past the inventory cap, so the
 * caller could see the page behind the dialog but not the dialog itself.
 */

const TIGHT: SnapshotBudget = { maxItems: 3, maxForms: 5, maxHiddenForms: 40, maxChars: 4_000 }

function filler(count: number): string {
  return Array.from({ length: count }, (_, i) => `<button>page-${i}</button>`).join('')
}

describe('open dialog prioritization', () => {
  it('keeps a late-in-DOM modal control inside the capped inventory', () => {
    document.body.innerHTML = `
      ${filler(20)}
      <div role="dialog" aria-modal="true">
        <button>modal-action</button>
      </div>
    `
    const view = buildSnapshot(new ElementIds(), { budget: TIGHT }, null)

    expect(view.items.map((item) => item.name)).toContain('modal-action')
  })

  it('ranks modal controls above the page they cover', () => {
    document.body.innerHTML = `
      ${filler(20)}
      <div role="dialog" aria-modal="true">
        <button>modal-action</button>
      </div>
    `
    const view = buildSnapshot(new ElementIds(), { budget: TIGHT }, null)

    expect(view.items[0]?.name).toBe('modal-action')
  })

  it('does not promote a hidden pre-rendered dialog', () => {
    document.body.innerHTML = `
      ${filler(20)}
      <div role="dialog" aria-modal="true" style="display: none">
        <button>stale-action</button>
      </div>
    `
    const view = buildSnapshot(new ElementIds(), { budget: TIGHT }, null)

    expect(view.items.map((item) => item.name)).not.toContain('stale-action')
  })

  it('recognizes a role=dialog wrapper without aria-modal', () => {
    document.body.innerHTML = `
      ${filler(20)}
      <div role="dialog">
        <button>dialog-action</button>
      </div>
    `
    const view = buildSnapshot(new ElementIds(), { budget: TIGHT }, null)

    expect(view.items[0]?.name).toBe('dialog-action')
  })

  it('does not promote a dialog faded out by an ancestor', () => {
    document.body.innerHTML = `
      ${filler(20)}
      <div style="opacity: 0">
        <div role="dialog" aria-modal="true">
          <button>faded-action</button>
        </div>
      </div>
    `
    const view = buildSnapshot(new ElementIds(), { budget: TIGHT }, null)

    expect(view.items.map((item) => item.name)).not.toContain('faded-action')
  })

  it('does not let a faded dialog evict the controls actually on screen', () => {
    document.body.innerHTML = `
      ${filler(20)}
      <div style="opacity: 0">
        <div role="dialog" aria-modal="true">
          <button>faded-action</button>
        </div>
      </div>
    `
    const view = buildSnapshot(new ElementIds(), { budget: TIGHT }, null)

    // Without the ancestor walk the faded control would be promoted and take
    // one of the three slots, displacing a real one.
    expect(view.items.map((item) => item.name)).toEqual(['page-0', 'page-1', 'page-2'])
  })

  it('still promotes a dialog whose sibling is faded', () => {
    document.body.innerHTML = `
      ${filler(20)}
      <div style="opacity: 0">
        <div role="dialog" aria-modal="true">
          <button>faded-action</button>
        </div>
      </div>
      <div role="dialog" aria-modal="true">
        <button>open-action</button>
      </div>
    `
    const view = buildSnapshot(new ElementIds(), { budget: TIGHT }, null)

    expect(view.items[0]?.name).toBe('open-action')
  })

  it('does not promote a dialog faded by an SVG ancestor', () => {
    document.body.innerHTML = filler(20)
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('style', 'opacity: 0')
    const foreign = document.createElementNS('http://www.w3.org/2000/svg', 'foreignObject')
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    dialog.setAttribute('aria-modal', 'true')
    dialog.innerHTML = '<button>svg-faded-action</button>'
    foreign.append(dialog)
    svg.append(foreign)
    document.body.append(svg)

    const view = buildSnapshot(new ElementIds(), { budget: TIGHT }, null)

    expect(view.items.map((item) => item.name)).not.toContain('svg-faded-action')
  })
})
