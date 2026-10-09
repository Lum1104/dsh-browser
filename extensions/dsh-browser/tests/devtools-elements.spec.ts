// @vitest-environment jsdom
/**
 * Developer-tools element/CSS helpers: locator resolution, computed-style
 * filtering, matched-rule flattening, rule splicing, and attribute safety.
 */

import { describe, expect, it } from 'vitest'
import {
  FrameRegistry,
  attributePairs,
  canonicalizeDeclarations,
  attributeRisk,
  attributeValue,
  declarationsOf,
  frameIdAt,
  inspectElement,
  mergeDeclarations,
  resolveNodeId,
  setAttribute,
  setInlineStyle,
  setMatchedRuleStyle,
  shortIdentity,
  syncFrames,
} from '../src/background/devtools-elements.ts'
import type { CdpClient } from '../src/background/debugger-session.ts'

/** Scripted CDP client: each method returns its queued response, in order. */
function scripted(responses: Record<string, unknown[]>): { client: CdpClient; calls: [string, Record<string, unknown> | undefined][] } {
  const calls: [string, Record<string, unknown> | undefined][] = []
  const client: CdpClient = {
    send: async (method, params) => {
      calls.push([method, params])
      const queue = responses[method]
      if (queue === undefined || queue.length === 0) return {}
      const next = queue.length === 1 ? queue[0] : queue.shift()
      if (next instanceof Error) throw next
      return next
    },
  }
  return { client, calls }
}

const STYLE_PAYLOAD = {
  computedStyle: [
    { name: 'display', value: 'flex' },
    { name: 'color', value: 'rgb(1, 2, 3)' },
  ],
}

describe('locator resolution', () => {
  it('resolves a selector through the document root', async () => {
    const { client, calls } = scripted({
      'DOM.getDocument': [{ root: { nodeId: 7 } }],
      'DOM.querySelector': [{ nodeId: 11 }],
    })
    await expect(resolveNodeId(client, { selector: '#main' })).resolves.toBe(11)
    expect(calls[0]).toEqual(['DOM.getDocument', { depth: 0 }])
    expect(calls[1]).toEqual(['DOM.querySelector', { nodeId: 7, selector: '#main' }])
  })

  it('reports a selector that matches nothing', async () => {
    const { client } = scripted({
      'DOM.getDocument': [{ root: { nodeId: 7 } }],
      'DOM.querySelector': [{ nodeId: 0 }],
    })
    await expect(resolveNodeId(client, { selector: '.missing' })).rejects.toThrow(/No element matches/)
  })

  it('resolves a snapshot index through the data-dsh-el attribute', async () => {
    const { client, calls } = scripted({
      'Runtime.evaluate': [{ result: { objectId: 'obj-1' } }],
      'DOM.requestNode': [{ nodeId: 33 }],
      'Runtime.releaseObject': [{}],
    })
    await expect(resolveNodeId(client, { index: 5 })).resolves.toBe(33)
    expect(calls[0]![1]).toMatchObject({ expression: `document.querySelector('[data-dsh-el="5"]')` })
    expect(calls[1]).toEqual(['DOM.requestNode', { objectId: 'obj-1' }])
    expect(calls[2]).toEqual(['Runtime.releaseObject', { objectId: 'obj-1' }])
  })

  it('explains a stale index instead of failing silently', async () => {
    const { client } = scripted({ 'Runtime.evaluate': [{ result: { subtype: 'null' } }] })
    await expect(resolveNodeId(client, { index: 9 })).rejects.toThrow(/Call browser_snapshot again/)
  })

  it('uses the frame execution context for iframe indices', async () => {
    const frames = new FrameRegistry()
    frames.setTree(['top-1', 'child-1'])
    const { client } = scripted({
      'Runtime.evaluate': [{ result: { objectId: 'obj-2' } }],
      'DOM.requestNode': [{ nodeId: 44 }],
      'Runtime.releaseObject': [{}],
    })
    frames.observe('Runtime.executionContextCreated', {
      context: { id: 99, auxData: { frameId: 'child-1', isDefault: true } },
    })
    await expect(resolveNodeId(client, { index: 2, frame: 1 }, frames)).resolves.toBe(44)
    expect(frameIdAt(frames, 1)).toBe('child-1')
    expect(frames.defaultContext('child-1')).toBe(99)
  })

  it('rejects an incomplete locator and an unknown frame', async () => {
    const { client } = scripted({})
    await expect(resolveNodeId(client, {})).rejects.toThrow(/selector or index/)
    await expect(resolveNodeId(client, { index: 1, frame: 4 }, new FrameRegistry())).rejects.toThrow(/Frame 4 does not exist/)
  })
})

describe('FrameRegistry', () => {
  it('tracks default page contexts and drops them when cleared', () => {
    const frames = new FrameRegistry()
    frames.observe('Runtime.executionContextCreated', { context: { id: 1, auxData: { frameId: 'top', isDefault: true } } })
    // Isolated worlds are not the page's own context.
    frames.observe('Runtime.executionContextCreated', { context: { id: 2, auxData: { frameId: 'top', isDefault: false } } })
    expect(frames.defaultContext('top')).toBe(1)
    frames.observe('Runtime.executionContextsCleared', {})
    expect(frames.defaultContext('top')).toBeUndefined()
  })

  it('rebuilds the frame order from a top-level navigation and frame tree', async () => {
    const frames = new FrameRegistry()
    frames.observe('Page.frameNavigated', { frame: { id: 'top' } })
    frames.observe('Page.frameNavigated', { frame: { id: 'child', parentId: 'top' } })
    expect([...frames.order()]).toEqual(['top', 'child'])
    // A new top-level document invalidates previous children.
    frames.observe('Page.frameNavigated', { frame: { id: 'top-2' } })
    expect([...frames.order()]).toEqual(['top-2'])
    frames.observe('Page.frameDetached', { frameId: 'top-2' })
    expect([...frames.order()]).toEqual([])

    const tree = {
      frameTree: { frame: { id: 'A' }, childFrames: [{ frame: { id: 'B' } }, { frameTree: {} }] },
    }
    const { client } = scripted({ 'Page.getFrameTree': [tree] })
    await syncFrames(client, frames)
    expect([...frames.order()]).toEqual(['A', 'B'])
  })
})

describe('inspection rendering helpers', () => {
  it('flattens attribute pairs and builds a short identity', () => {
    expect(attributePairs(['id', 'main', 'class', 'a b'])).toEqual([
      { name: 'id', value: 'main' },
      { name: 'class', value: 'a b' },
    ])
    expect(shortIdentity({ localName: 'DIV' }, [{ name: 'id', value: 'main' }])).toBe('div#main')
    expect(shortIdentity({ localName: 'SPAN' }, [{ name: 'class', value: 'chip wide' }])).toBe('span.chip')
    expect(shortIdentity({ nodeName: 'BODY' }, [])).toBe('body')
    expect(attributePairs(undefined)).toEqual([])
  })

  it('skips disabled declarations', () => {
    expect(declarationsOf({ cssProperties: [
      { name: 'color', value: 'red', important: true },
      { name: 'display', value: 'none', disabled: true },
    ] })).toEqual(['color: red !important'])
    expect(declarationsOf(undefined)).toEqual([])
  })

  it('keeps theme variables and shorthand expansions out of the report', () => {
    const declarations = declarationsOf({ cssProperties: [
      // Theme plumbing: 200+ lines of a single element's report.
      { name: '--dsw-alias-label-primary', value: '#0f0f0f' },
      { name: '--ds-font-size-m', value: '14px' },
      // A shorthand and every longhand CDP expands it into.
      { name: 'padding', value: '32px 40px' },
      { name: 'padding-top', value: '32px' },
      { name: 'padding-right', value: '40px' },
      { name: 'padding-bottom', value: '32px' },
      { name: 'padding-left', value: '40px' },
      { name: 'row-gap', value: '32px' },
      { name: 'column-gap', value: '32px' },
      // A single-edge declaration is a longhand, not a shorthand.
      { name: 'border-top', value: '1px solid red' },
      { name: 'color', value: 'red' },
      { name: 'color', value: 'blue' },
    ] })
    expect(declarations).toEqual([
      'padding: 32px 40px',
      'row-gap: 32px',
      'column-gap: 32px',
      'border-top: 1px solid red',
      'color: red',
    ])
  })

  it('drops longhands a shorthand covers, in declaration order', () => {
    // `margin: 0` is a single-value shorthand; the earlier filter required two
    // values and therefore kept all four expansions.
    expect(declarationsOf({ cssProperties: [
      { name: 'margin', value: '0' },
      { name: 'margin-top', value: '0px' },
      { name: 'margin-right', value: '0px' },
      { name: 'margin-bottom', value: '0px' },
      { name: 'margin-left', value: '0px' },
    ] })).toEqual(['margin: 0'])

    // Without the shorthand nothing is dropped.
    expect(declarationsOf({ cssProperties: [
      { name: 'padding-top', value: '4px' },
      { name: 'padding-left', value: '6px' },
    ] })).toEqual(['padding-top: 4px', 'padding-left: 6px'])
  })

  it('does not repeat a requested computed property', async () => {
    const { client } = scripted({
      'DOM.describeNode': [{ node: { localName: 'div', attributes: [] } }],
      'CSS.getComputedStyleForNode': [{ computedStyle: [{ name: 'display', value: 'flex' }] }],
      'CSS.getMatchedStylesForNode': [{ matchedCSSRules: [] }],
      'DOM.getBoxModel': [new Error('no box')],
    })
    const view = await inspectElement(client, 5, ['display', 'display'])
    expect(Object.keys(view.computed)).toEqual(['display'])
  })

  it('inspects an element with filtered computed styles, rules, and box model', async () => {
    const { client } = scripted({
      'DOM.describeNode': [
        { node: { localName: 'div', attributes: ['id', 'main', 'data-dsh-el', '3'], childNodeCount: 2, parentId: 0 } },
      ],
      'CSS.getComputedStyleForNode': [STYLE_PAYLOAD],
      'CSS.getMatchedStylesForNode': [{
        inlineStyle: { cssProperties: [{ name: 'color', value: 'blue' }] },
        matchedCSSRules: [{
          rule: { selectorList: { text: '.a, .b' }, origin: 'regular', style: { cssProperties: [{ name: 'margin', value: '0' }] } },
          matchingSelectors: [1],
        }],
        inherited: [],
      }],
      'DOM.getBoxModel': [{ model: { content: [10, 20, 110, 20, 110, 60, 10, 60], padding: [], border: [], margin: [] } }],
    })
    const view = await inspectElement(client, 5, ['display', 'font-family'])
    expect(view.identity).toBe('div#main')
    expect(view.inventoryIndex).toBe(3)
    expect(view.domPath).toBe('div#main')
    expect(view.computed).toEqual({ display: 'flex', 'font-family': '(not set)' })
    expect(view.inlineStyle).toEqual(['color: blue'])
    expect(view.matchedRules).toEqual([{ selector: '.b', origin: 'regular', declarations: ['margin: 0'] }])
    expect(view.box).toEqual({ x: 10, y: 20, width: 100, height: 40 })
    expect(view.childNodeCount).toBe(2)
  })

  it('reports an element without a layout box', async () => {
    const { client } = scripted({
      'DOM.describeNode': [{ node: { localName: 'i', attributes: [] } }],
      'CSS.getComputedStyleForNode': [{ computedStyle: [] }],
      'CSS.getMatchedStylesForNode': [{ matchedCSSRules: [] }],
      'DOM.getBoxModel': [new Error('no box model')],
    })
    const view = await inspectElement(client, 5)
    expect(view.box).toBeUndefined()
    expect(view.boxModel).toBeUndefined()
  })
})

describe('mutations', () => {
  it('merges declarations and clears a property with an empty value', () => {
    const merged = mergeDeclarations(
      { cssProperties: [{ name: 'color', value: 'red' }, { name: 'display', value: 'block' }] },
      [{ name: 'color', value: 'blue', important: true }, { name: 'display', value: '' }, { name: 'gap', value: '4px' }],
    )
    expect(merged).toEqual(['color: blue !important', 'gap: 4px'])
  })

  it('keeps a longhand the user explicitly edits instead of folding it away', () => {
    // Editing `margin-top` while the block carries the `margin` shorthand must
    // emit the longhand and drop the shorthand: silently discarding the edit
    // would be worse than a slightly longer style attribute.
    // This is the shape CDP actually reports: the shorthand plus every
    // expansion. Editing one longhand must drop the shorthand, otherwise the
    // shorthand would win the cascade and the edit would do nothing.
    expect(mergeDeclarations(
      { cssProperties: [
        { name: 'margin', value: '0' },
        { name: 'margin-top', value: '0px' },
        { name: 'margin-right', value: '0px' },
        { name: 'margin-bottom', value: '0px' },
        { name: 'margin-left', value: '0px' },
      ] },
      [{ name: 'margin-top', value: '12px' }],
    )).toEqual(['margin-top: 12px'])
  })

  it('never emits a longhand that is unreachable behind its shorthand', () => {
    // Both forms in one block is exactly what the report used to show; the
    // canonical form keeps one of them.
    expect(canonicalizeDeclarations(['margin: 0', 'margin-top: 8px'])).toEqual(['margin: 0'])
    expect(canonicalizeDeclarations(['margin-top: 8px', 'margin: 0'])).toEqual(['margin: 0'])
    expect(canonicalizeDeclarations(['padding-top: 4px', 'padding-left: 6px']))
      .toEqual(['padding-top: 4px', 'padding-left: 6px'])
  })

  it('writes inline declarations through CSS.setStyleTexts when a range is exposed', async () => {
    const { client, calls } = scripted({
      'CSS.getMatchedStylesForNode': [{
        inlineStyle: {
          styleSheetId: 'inline-sheet',
          range: { startLine: 0, startColumn: 0, endLine: 0, endColumn: 0 },
          cssProperties: [{ name: 'color', value: 'red' }],
        },
      }],
      'CSS.setStyleTexts': [{}],
    })
    const applied = await setInlineStyle(client, 4, [{ name: 'color', value: 'green' }, { name: 'opacity', value: '0.5' }])
    expect(applied).toEqual(['color: green', 'opacity: 0.5'])
    expect(calls[1]![0]).toBe('CSS.setStyleTexts')
    const edit = (calls[1]![1] as { edits: { styleSheetId: string; range: unknown; text: string }[] }).edits[0]!
    expect(edit.styleSheetId).toBe('inline-sheet')
    expect(edit.range).toEqual({ startLine: 0, startColumn: 0, endLine: 0, endColumn: 0 })
    expect(edit.text).toContain('color: green;')
  })

  it('falls back to the style attribute when no editable range is exposed', async () => {
    const { client, calls } = scripted({
      'CSS.getMatchedStylesForNode': [{ inlineStyle: { cssProperties: [{ name: 'color', value: 'red' }] } }],
      'DOM.setAttributeValue': [{}],
    })
    const applied = await setInlineStyle(client, 4, [{ name: 'outline', value: '3px solid red' }])
    expect(applied).toEqual(['color: red', 'outline: 3px solid red'])
    expect(calls.some((call) => call[0] === 'CSS.setStyleTexts')).toBe(false)
    expect(calls[1]).toEqual(['DOM.setAttributeValue', {
      nodeId: 4,
      name: 'style',
      value: 'color: red; outline: 3px solid red;',
    }])
  })

  it('splices the matched rule inside its stylesheet instead of rewriting the sheet', async () => {
    const source = '.a { color: red; }\n.b { margin: 0; }\n'
    const { client, calls } = scripted({
      'CSS.getMatchedStylesForNode': [{
        matchedCSSRules: [{
          rule: {
            selectorList: { text: '.b' },
            origin: 'regular',
            styleSheetId: 'sheet-1',
            style: { cssProperties: [{ name: 'margin', value: '0' }], range: { startLine: 1, startColumn: 5, endLine: 1, endColumn: 14 } },
          },
          matchingSelectors: [0],
        }],
      }],
      'CSS.getStyleSheetText': [{ text: source }],
      'CSS.setStyleSheetText': [{}],
    })
    const edited = await setMatchedRuleStyle(client, 6, [{ name: 'margin', value: '8px' }])
    expect(edited).toEqual({ selector: '.b', declarations: ['margin: 8px'] })
    const written = calls.find((call) => call[0] === 'CSS.setStyleSheetText')![1] as { text: string; styleSheetId: string }
    expect(written.styleSheetId).toBe('sheet-1')
    expect(written.text).toContain('.a { color: red; }')
    expect(written.text).toContain('{ margin: 8px; }')
    expect(written.text).not.toContain('margin: 0')
  })

  it('explains when no author rule can be edited', async () => {
    const { client } = scripted({ 'CSS.getMatchedStylesForNode': [{ matchedCSSRules: [] }] })
    await expect(setMatchedRuleStyle(client, 1, [{ name: 'color', value: 'red' }])).rejects.toThrow(/mode "inline"/)
  })

  it('classifies attribute risk and refuses dangerous writes', async () => {
    expect(attributeRisk('data-x')).toBe('normal')
    expect(attributeRisk('onclick')).toBe('script')
    expect(attributeRisk('src')).toBe('script')
    expect(attributeRisk('srcdoc')).toBe('forbidden')
    expect(attributeRisk('bad name')).toBe('forbidden')
    expect(attributeRisk('')).toBe('forbidden')
  })

  it('sets and removes attributes through the DOM domain', async () => {
    const { client, calls } = scripted({ 'DOM.setAttributeValue': [{}], 'DOM.removeAttribute': [{}] })
    await setAttribute(client, 2, 'data-x', '1', false)
    await setAttribute(client, 2, 'data-x', undefined, true)
    expect(calls).toEqual([
      ['DOM.setAttributeValue', { nodeId: 2, name: 'data-x', value: '1' }],
      ['DOM.removeAttribute', { nodeId: 2, name: 'data-x' }],
    ])
  })

  it('reads an attribute value case-insensitively', async () => {
    const { client } = scripted({ 'DOM.getAttributes': [{ attributes: ['data-x', '1', 'Id', 'main'] }] })
    await expect(attributeValue(client, 2, 'id')).resolves.toBe('main')
    await expect(attributeValue(client, 2, 'missing')).resolves.toBeUndefined()
  })
})
