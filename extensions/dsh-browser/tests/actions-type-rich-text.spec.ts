// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runAction } from '../src/content/actions.ts'
import type { ElementIds } from '../src/content/ids.ts'

/**
 * Rich-text hosts (Lexical, Draft.js, ProseMirror) keep their own document
 * model and reconcile away foreign `textContent` writes, so typing must go
 * through the browser editing pipeline instead of a direct DOM assignment.
 */

const BUDGET = { maxItems: 20, maxForms: 10, maxHiddenForms: 40, maxChars: 2_000 }

function idsFor(element: Element): ElementIds {
  return { elementByIndex: vi.fn(() => element) } as unknown as ElementIds
}

function host(html = ''): HTMLElement {
  const el = document.createElement('div')
  el.setAttribute('contenteditable', 'true')
  el.innerHTML = html
  document.body.append(el)
  return el
}

/**
 * Model the editing pipeline rather than only its return value.
 *
 * A stub that just returns `true` cannot distinguish "the command ran" from
 * "the editor accepted the input", which is the exact failure this fix exists
 * to correct. This one replaces the current selection and emits the
 * `beforeinput`/`input` sequence, so the resulting DOM is the observable proof.
 *
 * @param accept - when false, simulates a host that refuses the command.
 * @returns the `execCommand` spy.
 */
function stubEditingPipeline(accept = true): ReturnType<typeof vi.fn> {
  const spy = vi.fn((command: string, _ui: boolean, value: string) => {
    if (command !== 'insertText' || !accept) return false
    const selection = document.getSelection()
    if (selection === null || selection.rangeCount === 0) return false
    const range = selection.getRangeAt(0)
    const container = range.commonAncestorContainer
    const node = container instanceof HTMLElement ? container : container.parentElement
    const editable = node?.closest('[contenteditable]:not([contenteditable="false"])')
    if (!(editable instanceof HTMLElement)) return false
    editable.dispatchEvent(new Event('beforeinput', { bubbles: true, cancelable: true }))
    range.deleteContents()
    range.insertNode(document.createTextNode(value))
    editable.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })
  Object.defineProperty(document, 'execCommand', { configurable: true, writable: true, value: spy })
  return spy
}

afterEach(() => {
  document.body.innerHTML = ''
  Reflect.deleteProperty(document, 'execCommand')
  vi.restoreAllMocks()
})

describe('typing into rich-text editors', () => {
  it('lands the text in the host through the pipeline, without a second direct write', async () => {
    const el = host()
    const spy = stubEditingPipeline()

    await runAction('browser_type', { index: 3, text: 'hello world' }, { ids: idsFor(el), budget: BUDGET })

    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith('insertText', false, 'hello world')
    // The observable outcome, not just the invocation.
    expect(el.textContent).toBe('hello world')
  })

  it('emits the beforeinput/input sequence editors listen for', async () => {
    const el = host()
    const seen: string[] = []
    el.addEventListener('beforeinput', () => seen.push('beforeinput'))
    el.addEventListener('input', () => seen.push('input'))
    stubEditingPipeline()

    await runAction('browser_type', { index: 3, text: 'hi' }, { ids: idsFor(el), budget: BUDGET })

    expect(seen).toEqual(['beforeinput', 'input'])
  })

  it('places the selection inside the editing host before inserting', async () => {
    const el = host()
    let anchorInside = false
    const spy = vi.fn((_command: string, _ui: boolean, _value: string) => {
      const selection = document.getSelection()
      anchorInside = selection !== null
        && selection.rangeCount > 0
        && el.contains(selection.getRangeAt(0).startContainer)
      return true
    })
    Object.defineProperty(document, 'execCommand', { configurable: true, writable: true, value: spy })

    await runAction('browser_type', { index: 3, text: 'hi' }, { ids: idsFor(el), budget: BUDGET })

    expect(anchorInside).toBe(true)
  })

  it('selects existing contents when replace is set, so insertText overwrites them', async () => {
    const el = host('previous draft')
    let selectedText = ''
    const spy = vi.fn((_command: string, _ui: boolean, _value: string) => {
      selectedText = document.getSelection()?.toString() ?? ''
      return true
    })
    Object.defineProperty(document, 'execCommand', { configurable: true, writable: true, value: spy })

    await runAction('browser_type', { index: 3, text: 'fresh', replace: true }, { ids: idsFor(el), budget: BUDGET })

    expect(selectedText).toBe('previous draft')
  })

  it('appends rather than selects when replace is not set', async () => {
    const el = host('draft')
    let selectedText = ''
    const spy = vi.fn((_command: string, _ui: boolean, _value: string) => {
      selectedText = document.getSelection()?.toString() ?? ''
      return true
    })
    Object.defineProperty(document, 'execCommand', { configurable: true, writable: true, value: spy })

    await runAction('browser_type', { index: 3, text: ' more' }, { ids: idsFor(el), budget: BUDGET })

    expect(selectedText).toBe('')
  })

  it('resolves the editable host when the addressed element is a nested child', async () => {
    const el = host('<span id="inner">x</span>')
    const inner = el.querySelector('#inner')
    expect(inner).not.toBeNull()
    stubEditingPipeline()

    await runAction('browser_type', { index: 5, text: 'y' }, { ids: idsFor(inner!), budget: BUDGET })

    // The text belongs to the outer host, not to the addressed span.
    expect(el.textContent).toBe('xy')
  })

  it('refuses an element inside a contenteditable=false island', async () => {
    const el = host('<div contenteditable="false"><span id="chip">@mention</span></div>')
    const chip = el.querySelector('#chip')
    expect(chip).not.toBeNull()
    const spy = stubEditingPipeline()

    await expect(
      runAction('browser_type', { index: 9, text: 'x' }, { ids: idsFor(chip!), budget: BUDGET }),
    ).rejects.toMatchObject({ message: 'Element [9] is not editable (span).' })

    // The island is not editable, and the surrounding composer must not be used.
    expect(spy).not.toHaveBeenCalled()
    expect(el.textContent).toBe('@mention')
  })

  it('falls back to the direct write when the host lacks execCommand', async () => {
    const el = host()
    Reflect.deleteProperty(document, 'execCommand')

    await runAction('browser_type', { index: 3, text: 'plain' }, { ids: idsFor(el), budget: BUDGET })

    expect(el.textContent).toBe('plain')
  })

  it('falls back to the direct write when execCommand reports failure', async () => {
    const el = host()
    stubEditingPipeline(false)

    await runAction('browser_type', { index: 3, text: 'plain' }, { ids: idsFor(el), budget: BUDGET })

    expect(el.textContent).toBe('plain')
  })
})

describe('typing into plain inputs is unchanged', () => {
  it('still sets value through the native setter', async () => {
    const input = document.createElement('input')
    document.body.append(input)
    const spy = stubEditingPipeline()

    await runAction('browser_type', { index: 1, text: 'search term' }, { ids: idsFor(input), budget: BUDGET })

    expect(input.value).toBe('search term')
    expect(spy).not.toHaveBeenCalled()
  })

  it('still replaces an existing value', async () => {
    const input = document.createElement('input')
    input.value = 'old'
    document.body.append(input)

    await runAction('browser_type', { index: 1, text: 'new', replace: true }, { ids: idsFor(input), budget: BUDGET })

    expect(input.value).toBe('new')
  })
})
