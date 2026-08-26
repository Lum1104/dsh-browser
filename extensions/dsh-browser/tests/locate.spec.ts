// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { ElementIds } from '../src/content/ids.ts'
import { accessibleName } from '../src/content/extract.ts'
import {
  elementViewportBox,
  findElements,
  FindError,
  imageSourceFor,
  locateImageElement,
  renderFindResult,
  roleOf,
  imageUrlCandidates,
  isPlaceholderUrl,
  largestSrcsetCandidate,
  stableSelector,
} from '../src/content/locate.ts'

function setBody(html: string): void {
  document.body.innerHTML = html
}

describe('findElements', () => {
  it('matches interactive elements by visible text and hands back usable indices', () => {
    setBody(`
      <a href="https://example.com/in">Sign in</a>
      <button>Sign out</button>
      <p>Sign in below</p>
    `)
    const ids = new ElementIds()
    const result = findElements(ids, { text: 'sign in' })

    expect(result.matches).toHaveLength(1)
    const match = result.matches[0]!
    expect(match.role).toBe('link')
    expect(match.name).toBe('Sign in')
    expect(match.href).toBe('https://example.com/in')
    // The index must resolve back to the element, or a follow-up click cannot use it.
    expect(ids.elementByIndex(match.index)?.textContent).toBe('Sign in')
  })

  it('restricts matches by role', () => {
    setBody('<a href="/a">Open</a><button>Open</button>')
    const ids = new ElementIds()
    expect(findElements(ids, { text: 'open', role: 'button' }).matches.map((m) => m.role)).toEqual(['button'])
  })

  it('searches non-interactive text when interactiveOnly is disabled', () => {
    setBody('<h1>Quarterly report</h1><button>Export</button>')
    const ids = new ElementIds()
    const result = findElements(ids, { text: 'quarterly', interactiveOnly: false })
    expect(result.matches.map((match) => match.role)).toEqual(['h1'])
    // A non-interactive match still gets an index, without evicting the interactive ones.
    expect(ids.elementByIndex(result.matches[0]!.index)?.tagName).toBe('H1')
    expect(findElements(ids, { text: 'export' }).matches).toHaveLength(1)
  })

  it('caps results and reports the overflow', () => {
    setBody(Array.from({ length: 8 }, (_, index) => `<button>Row ${index}</button>`).join(''))
    const result = findElements(new ElementIds(), { text: 'row', limit: 3 })
    expect(result.matches).toHaveLength(3)
    expect(result.omitted).toBe(5)
    expect(renderFindResult(result, { text: 'row' })).toContain('5 further match(es) omitted')
  })

  it('masks a sensitive field value instead of returning it', () => {
    setBody('<input type="password" name="password" value="hunter2" aria-label="Password">')
    const result = findElements(new ElementIds(), { role: 'input' })
    expect(result.matches[0]?.value).toBe('••••')
    expect(JSON.stringify(result)).not.toContain('hunter2')
  })

  it('rejects an empty query and an invalid selector', () => {
    expect(() => findElements(new ElementIds(), {})).toThrow(FindError)
    setBody('<button>Go</button>')
    expect(() => findElements(new ElementIds(), { selector: 'a[' })).toThrow(FindError)
  })

  it('renders a miss as an actionable sentence', () => {
    setBody('<button>Go</button>')
    const rendered = renderFindResult(findElements(new ElementIds(), { text: 'absent' }), { text: 'absent' })
    expect(rendered).toContain('No element matched')
    expect(rendered).toContain('browser_snapshot')
  })
})

describe('roleOf', () => {
  it('prefers an explicit role and otherwise names the control', () => {
    setBody('<div role="tab">Tab</div><select></select><img alt="x" src="/x.png">')
    expect(roleOf(document.querySelector('[role="tab"]')!)).toBe('tab')
    expect(roleOf(document.querySelector('select')!)).toBe('select')
    expect(roleOf(document.querySelector('img')!)).toBe('image')
  })
})

describe('elementViewportBox', () => {
  it('measures a laid-out element in viewport coordinates', () => {
    setBody('<button>Go</button>')
    // tests/setup.ts stubs getBoundingClientRect at 200x40.
    const box = elementViewportBox(document.querySelector('button')!)
    expect(box).toMatchObject({ width: 200, height: 40 })
    expect(box?.dpr).toBeGreaterThan(0)
  })

  it('returns nothing for an element with no box', () => {
    setBody('<button>Go</button>')
    const el = document.querySelector('button')!
    el.getBoundingClientRect = () => ({ width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) })
    expect(elementViewportBox(el)).toBeUndefined()
  })
})

describe('imageSourceFor', () => {
  it('prefers an image element\'s own source and carries the rendered box', () => {
    setBody('<img src="https://cdn.example.com/a.png" alt="A chart">')
    const source = imageSourceFor(document.querySelector('img')!)
    expect(source).toMatchObject({
      kind: 'url',
      url: 'https://cdn.example.com/a.png',
      name: 'A chart',
      box: { width: 200, height: 40 },
    })
  })

  it('carries the rendered box on a CSS background image', () => {
    setBody('<div id="hero" style="background-image: url(https://img.example/bg.jpg)">hero</div>')
    expect(imageSourceFor(document.querySelector('#hero')!)).toMatchObject({
      kind: 'url',
      url: 'https://img.example/bg.jpg',
      box: { width: 200, height: 40 },
    })
  })

  it('falls back to the element box when there are no readable bytes', () => {
    setBody('<div id="widget">rendered</div>')
    expect(imageSourceFor(document.querySelector('#widget')!)?.kind).toBe('box')
  })
})

describe('locateImageElement', () => {
  it('resolves by index, selector, and alt text, reporting which one hit', () => {
    setBody('<img id="one" src="/one.png" alt="First chart"><img id="two" src="/two.png" alt="Second chart">')
    const ids = new ElementIds()
    const first = document.querySelector('#one')!
    ids.assign([first])

    expect(locateImageElement(ids, { index: ids.indexOf(first)! }))
      .toEqual({ element: first, via: 'index' })
    expect(locateImageElement(ids, { selector: '#two' })?.element.id).toBe('two')
    expect(locateImageElement(ids, { selector: '#two' })?.via).toBe('selector')
    expect(locateImageElement(ids, { alt: 'second' })?.element.id).toBe('two')
    expect(locateImageElement(ids, { alt: 'second' })?.via).toBe('alt')
    expect(locateImageElement(ids, { alt: 'nothing here' })).toBeUndefined()
  })

  it('refuses a detached node behind a stale index and falls through to the selector', () => {
    setBody('<img id="one" src="/one.png" alt="First chart">')
    const ids = new ElementIds()
    ids.assign([document.querySelector('#one')!])
    const staleIndex = ids.indexOf(document.querySelector('#one')!)!
    // What a re-render does: the registered node leaves the document, but the
    // registry still holds a strong reference to it.
    setBody('<img id="one" src="/two.png" alt="First chart">')

    expect(ids.elementByIndex(staleIndex)?.isConnected).toBe(false)
    // Without the isConnected check this returned the OLD node, and its /one.png
    // would have been read back as a picture of the current page.
    expect(locateImageElement(ids, { index: staleIndex })).toBeUndefined()
    expect(locateImageElement(ids, { index: staleIndex, selector: '#one' }))
      .toEqual({ element: document.querySelector('#one'), via: 'selector' })
  })

  it('falls through a selector that matches nothing to the alt text', () => {
    setBody('<img id="one" src="/one.png" alt="First chart">')

    expect(locateImageElement(new ElementIds(), { selector: '#gone', alt: 'first' })?.via).toBe('alt')
  })

  it('rejects an invalid selector', () => {
    setBody('<img src="/one.png">')
    expect(() => locateImageElement(new ElementIds(), { selector: 'img[' })).toThrow(FindError)
  })
})

describe('stableSelector', () => {
  it('prefers a human-looking id', () => {
    setBody('<div><button id="submit-order">Go</button></div>')
    expect(stableSelector(document.querySelector('button')!)).toBe('#submit-order')
  })

  it('refuses framework-generated ids that change every render', () => {
    setBody('<button id="mui-10428">A</button>')
    // Falls through to something positional rather than promising a volatile id.
    expect(stableSelector(document.querySelector('button')!)).not.toContain('mui-10428')
    setBody('<button id="r-9182736455">A</button>')
    expect(stableSelector(document.querySelector('button')!)).not.toContain('9182736455')
  })

  it('uses a discriminating attribute when there is no id', () => {
    setBody('<form><input name="email"><input name="password"></form>')
    expect(stableSelector(document.querySelector('[name="email"]')!)).toBe('input[name="email"]')
  })

  it('builds a bounded path when the element alone is ambiguous', () => {
    setBody('<div id="list"><span>one</span><span>two</span></div>')
    const second = document.querySelectorAll('span')[1]!
    const selector = stableSelector(second)
    expect(selector).toBeDefined()
    expect(document.querySelectorAll(selector!)).toHaveLength(1)
    expect(document.querySelector(selector!)).toBe(second)
  })

  it('never returns a selector it cannot prove unique', () => {
    // Every candidate here matches both cells, so no handle is offered.
    setBody('<div><i></i><i></i></div>'.repeat(0) + '<table><tr><td></td><td></td></tr></table>')
    for (const cell of document.querySelectorAll('td')) {
      const selector = stableSelector(cell)
      if (selector !== undefined) {
        expect(document.querySelector(selector)).toBe(cell)
      }
    }
  })

  it('escapes an id that needs it', () => {
    setBody('<button id="a.b">x</button>')
    const selector = stableSelector(document.querySelector('button')!)
    expect(selector).toBeDefined()
    expect(document.querySelector(selector!)).toBe(document.querySelector('button'))
  })
})

describe('findElements selectors', () => {
  it('hands out a durable selector next to the index', () => {
    setBody('<button id="pay-now">Pay now</button>')
    const result = findElements(new ElementIds(), { text: 'pay' })
    expect(result.matches[0]?.selector).toBe('#pay-now')
    expect(renderFindResult(result, { text: 'pay' })).toContain('selector: #pay-now')
    expect(renderFindResult(result, { text: 'pay' })).toContain('used automatically if the page re-rendered')
  })
})

describe('image URL candidates', () => {
  it('puts the full-size link first and the thumbnail last', () => {
    setBody('<a href="https://img.example/full/p.jpg"><img src="https://img.example/thumb/p.jpg"></a>')
    expect(imageUrlCandidates(document.querySelector('img')!)).toEqual([
      'https://img.example/full/p.jpg',
      'https://img.example/thumb/p.jpg',
    ])
  })

  it('ignores a wrapping link that is not an image', () => {
    setBody('<a href="https://forum.example/post/9"><img src="https://img.example/a.jpg"></a>')
    expect(imageUrlCandidates(document.querySelector('img')!)).toEqual(['https://img.example/a.jpg'])
  })

  it('collects every lazy-load attribute forums use', () => {
    setBody('<img src="https://i.example/blank.gif" data-original="https://i.example/real.jpg" data-src="https://i.example/alt.jpg">')
    expect(imageUrlCandidates(document.querySelector('img')!)).toEqual([
      'https://i.example/real.jpg',
      'https://i.example/alt.jpg',
      'https://i.example/blank.gif',
    ])
  })

  it('drops data and blob URLs, which the background cannot fetch', () => {
    setBody('<img src="data:image/gif;base64,R0lGOD" data-src="blob:https://x/y">')
    expect(imageUrlCandidates(document.querySelector('img')!)).toEqual([])
  })

  it('deduplicates candidates that resolve to the same URL', () => {
    setBody('<img src="https://i.example/a.jpg" data-src="https://i.example/a.jpg">')
    expect(imageUrlCandidates(document.querySelector('img')!)).toEqual(['https://i.example/a.jpg'])
  })
})

describe('largestSrcsetCandidate', () => {
  it('picks the widest width descriptor', () => {
    expect(largestSrcsetCandidate('a.jpg 400w, b.jpg 1600w, c.jpg 800w')).toBe('b.jpg')
  })

  it('picks the highest density when there are no widths', () => {
    expect(largestSrcsetCandidate('a.jpg 1x, b.jpg 3x, c.jpg 2x')).toBe('b.jpg')
  })

  it('handles a bare single candidate and empty input', () => {
    expect(largestSrcsetCandidate('only.jpg')).toBe('only.jpg')
    expect(largestSrcsetCandidate('')).toBeUndefined()
  })
})

describe('isPlaceholderUrl', () => {
  it('recognizes the stand-ins lazy loaders park in src', () => {
    expect(isPlaceholderUrl('https://i.example/blank.gif')).toBe(true)
    expect(isPlaceholderUrl('https://i.example/img/loading.svg')).toBe(true)
    expect(isPlaceholderUrl('https://i.example/1x1.png')).toBe(true)
    expect(isPlaceholderUrl('data:image/gif;base64,R0lGOD')).toBe(true)
    expect(isPlaceholderUrl('')).toBe(true)
  })

  it('does not mistake a real picture for one', () => {
    expect(isPlaceholderUrl('https://i.example/photo-2026.jpg')).toBe(false)
    expect(isPlaceholderUrl('https://i.example/uploads/holiday.png')).toBe(false)
  })
})

describe('accessibleName for images', () => {
  it('uses alt text, so an image is not just called "img"', () => {
    setBody('<img src="/a.png" alt="Holiday photo">')
    expect(accessibleName(document.querySelector('img')!)).toBe('Holiday photo')
  })

  it('falls back to title, then to the tag name', () => {
    setBody('<img src="/a.png" title="Chart"><img src="/b.png">')
    const [titled, bare] = [...document.querySelectorAll('img')]
    expect(accessibleName(titled!)).toBe('Chart')
    expect(accessibleName(bare!)).toBe('img')
  })
})
