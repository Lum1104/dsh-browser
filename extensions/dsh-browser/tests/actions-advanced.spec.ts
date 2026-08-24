// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { runAction } from '../src/content/actions.ts'
import { ElementIds } from '../src/content/ids.ts'
import type { SnapshotBudget } from '../src/content/snapshot.ts'

const budget: SnapshotBudget = { maxItems: 60, maxForms: 30, maxChars: 12_000 }

/**
 * Set the page and stub scrollIntoView, which jsdom does not implement — the
 * suite's convention (see actions-delta.spec.ts) is to stub it per element
 * rather than to patch the prototype globally.
 */
function fixture(html: string): void {
  document.body.innerHTML = html
  for (const el of document.querySelectorAll('*')) {
    (el as HTMLElement).scrollIntoView = vi.fn()
  }
}

function ctxFor(elements: Element[]): { ids: ElementIds; budget: SnapshotBudget } {
  const ids = new ElementIds()
  ids.assign(elements)
  return { ids, budget }
}

function indexOf(ids: ElementIds, el: Element): number {
  const index = ids.indexOf(el)
  if (index === undefined) throw new Error('element was not registered')
  return index
}

describe('browser_select_option', () => {
  it('selects by label, by value, and reports what it chose', async () => {
    fixture(`
      <select id="color">
        <option value="r">Red</option>
        <option value="b">Blue</option>
      </select>`)
    const select = document.querySelector<HTMLSelectElement>('#color')!
    const ctx = ctxFor([select])
    const changes: string[] = []
    select.addEventListener('change', () => changes.push(select.value))

    const byLabel = await runAction('browser_select_option', { index: indexOf(ctx.ids, select), values: ['Blue'] }, ctx)
    expect(select.value).toBe('b')
    expect(byLabel.text).toContain('"Blue"')
    expect(changes).toEqual(['b'])

    await runAction('browser_select_option', { index: indexOf(ctx.ids, select), values: ['r'] }, ctx)
    expect(select.value).toBe('r')
  })

  it('lists the real options when nothing matches', async () => {
    fixture('<select id="s"><option value="a">Alpha</option></select>')
    const select = document.querySelector<HTMLSelectElement>('#s')!
    const ctx = ctxFor([select])
    await expect(runAction('browser_select_option', { index: indexOf(ctx.ids, select), values: ['Zeta'] }, ctx))
      .rejects.toThrow(/no option matching "Zeta".*Alpha/s)
  })

  it('refuses a non-select element and a multi-value single select', async () => {
    fixture('<button id="b">Go</button><select id="s"><option>A</option><option>B</option></select>')
    const button = document.querySelector('#b')!
    const select = document.querySelector<HTMLSelectElement>('#s')!
    const ctx = ctxFor([button, select])
    await expect(runAction('browser_select_option', { index: indexOf(ctx.ids, button), values: ['A'] }, ctx))
      .rejects.toThrow(/not a select/)
    await expect(runAction('browser_select_option', { index: indexOf(ctx.ids, select), values: ['A', 'B'] }, ctx))
      .rejects.toThrow(/accepts one option/)
  })

  it('selects several options in a multi-select', async () => {
    fixture('<select id="s" multiple><option>A</option><option>B</option><option>C</option></select>')
    const select = document.querySelector<HTMLSelectElement>('#s')!
    const ctx = ctxFor([select])
    await runAction('browser_select_option', { index: indexOf(ctx.ids, select), values: ['A', 'C'] }, ctx)
    expect([...select.selectedOptions].map((option) => option.textContent)).toEqual(['A', 'C'])
  })
})

describe('browser_hover', () => {
  it('sends the pointer and mouse sequence a menu listens for', async () => {
    fixture('<div id="menu">Menu</div>')
    const el = document.querySelector('#menu')!
    const ctx = ctxFor([el])
    const seen: string[] = []
    for (const type of ['pointerover', 'mouseover', 'mouseenter', 'mousemove']) {
      el.addEventListener(type, () => seen.push(type))
    }
    const result = await runAction('browser_hover', { index: indexOf(ctx.ids, el) }, ctx)
    expect(seen).toContain('mouseover')
    expect(seen).toContain('mousemove')
    expect(result.text).toContain('Hovered')
  })
})

describe('browser_press', () => {
  it('applies modifiers and focuses a named element first', async () => {
    fixture('<input id="field">')
    const input = document.querySelector<HTMLInputElement>('#field')!
    const ctx = ctxFor([input])
    const events: KeyboardEvent[] = []
    input.addEventListener('keydown', (event) => events.push(event))

    const result = await runAction('browser_press', { key: 'a', modifiers: ['Control'], index: indexOf(ctx.ids, input) }, ctx)
    expect(document.activeElement).toBe(input)
    expect(events[0]?.ctrlKey).toBe(true)
    expect(result.text).toContain('Control+a')
  })

  it('rejects an unknown modifier rather than silently dropping it', async () => {
    fixture('<input id="field">')
    const ctx = ctxFor([document.querySelector('#field')!])
    await expect(runAction('browser_press', { key: 'a', modifiers: ['Hyper'] }, ctx)).rejects.toThrow(/Control, Shift, Alt, or Meta/)
  })
})

describe('browser_scroll', () => {
  it('scrolls a named element into view instead of by direction', async () => {
    fixture('<div id="target">x</div>')
    const el = document.querySelector('#target')!
    const scrollIntoView = vi.fn()
    el.scrollIntoView = scrollIntoView
    const ctx = ctxFor([el])
    const result = await runAction('browser_scroll', { index: indexOf(ctx.ids, el) }, ctx)
    expect(scrollIntoView).toHaveBeenCalled()
    expect(result.text).toContain('into view')
  })

  it('still requires a direction when no target is named', async () => {
    fixture('<div>x</div>')
    await expect(runAction('browser_scroll', {}, ctxFor([]))).rejects.toThrow(/direction must be/)
  })
})

describe('browser_wait', () => {
  it('returns as soon as an already-true condition holds', async () => {
    fixture('<div id="done">Loaded</div>')
    const result = await runAction('browser_wait', { selector: '#done', text: 'Loaded' }, ctxFor([]))
    expect(result.text).toContain('Condition met')
  })

  it('waits for a condition that becomes true', async () => {
    fixture('<div id="host"></div>')
    setTimeout(() => {
      document.querySelector('#host')!.innerHTML = '<span class="ready">ok</span>'
    }, 150)
    const result = await runAction('browser_wait', { selector: '.ready', timeoutMs: 3_000 }, ctxFor([]))
    expect(result.text).toContain('Condition met')
  })

  it('reports a timeout as an actionable failure', async () => {
    fixture('<div></div>')
    await expect(runAction('browser_wait', { text: 'never', timeoutMs: 150 }, ctxFor([])))
      .rejects.toThrow(/Timed out after 150ms.*browser_snapshot/s)
  })

  it('supports waiting for something to disappear', async () => {
    fixture('<div class="spinner">loading</div>')
    setTimeout(() => { document.querySelector('.spinner')!.remove() }, 120)
    const result = await runAction('browser_wait', { selector: '.spinner', gone: true, timeoutMs: 3_000 }, ctxFor([]))
    expect(result.text).toContain('disappear')
  })
})

describe('browser_act', () => {
  it('runs every step in order and numbers the statuses', async () => {
    fixture('<input id="user"><input id="pass"><button id="go">Go</button>')
    const user = document.querySelector<HTMLInputElement>('#user')!
    const pass = document.querySelector<HTMLInputElement>('#pass')!
    const go = document.querySelector<HTMLButtonElement>('#go')!
    const ctx = ctxFor([user, pass, go])
    const clicks: string[] = []
    go.addEventListener('click', () => clicks.push('go'))

    const result = await runAction('browser_act', {
      steps: [
        { action: 'type', index: indexOf(ctx.ids, user), text: 'alice' },
        { action: 'type', index: indexOf(ctx.ids, pass), text: 'secret' },
        { action: 'click', index: indexOf(ctx.ids, go) },
      ],
    }, ctx)

    expect(user.value).toBe('alice')
    expect(pass.value).toBe('secret')
    expect(clicks).toEqual(['go'])
    expect(result.text.split('\n').map((line) => line.slice(0, 2))).toEqual(['1.', '2.', '3.'])
  })

  it('stops at the first failure and says what was skipped', async () => {
    fixture('<input id="user"><button id="go">Go</button>')
    const user = document.querySelector<HTMLInputElement>('#user')!
    const ctx = ctxFor([user, document.querySelector('#go')!])
    const result = await runAction('browser_act', {
      steps: [
        { action: 'type', index: indexOf(ctx.ids, user), text: 'alice' },
        { action: 'click', index: 999 },
        { action: 'type', index: indexOf(ctx.ids, user), text: 'more' },
      ],
    }, ctx)
    expect(result.text).toContain('FAILED')
    expect(result.text).toContain('1 later step(s) were skipped')
    expect(user.value).toBe('alice')
  })

  it('keeps going after a failure when asked to', async () => {
    fixture('<input id="user">')
    const user = document.querySelector<HTMLInputElement>('#user')!
    const ctx = ctxFor([user])
    const result = await runAction('browser_act', {
      continueOnError: true,
      steps: [
        { action: 'click', index: 999 },
        { action: 'type', index: indexOf(ctx.ids, user), text: 'alice' },
      ],
    }, ctx)
    expect(result.text).toContain('FAILED')
    expect(user.value).toBe('alice')
  })

  it('rejects an empty batch, an over-long batch, and an unknown step', async () => {
    const ctx = ctxFor([])
    await expect(runAction('browser_act', { steps: [] }, ctx)).rejects.toThrow(/non-empty array/)
    await expect(runAction('browser_act', {
      steps: Array.from({ length: 13 }, () => ({ action: 'wait' })),
    }, ctx)).rejects.toThrow(/at most 12 entries/)
    await expect(runAction('browser_act', { steps: [{ action: 'teleport' }] }, ctx)).rejects.toThrow(/action must be one of/)
  })

  it('ends the sequence when a step navigates', async () => {
    fixture('<a id="link" href="https://example.com/next">Next</a><input id="after">')
    const link = document.querySelector('#link')!
    const after = document.querySelector('#after')!
    const ctx = ctxFor([link, after])
    const result = await runAction('browser_act', {
      steps: [
        { action: 'click', index: indexOf(ctx.ids, link) },
        { action: 'type', index: indexOf(ctx.ids, after), text: 'unreachable' },
      ],
    }, ctx)
    expect(result.navigationPending).toBe(true)
    expect(result.text).toContain('Navigation started')
  })
})

describe('browser_screenshot and browser_read_image', () => {
  it('describes a viewport capture without resolving an element', async () => {
    fixture('<p>page</p>')
    const result = await runAction('browser_screenshot', {}, ctxFor([]))
    expect(result.text).toContain('visible viewport')
    expect(result.imageSources).toBeUndefined()
  })

  it('resolves an element box for a targeted capture', async () => {
    fixture('<div id="chart">chart</div>')
    const result = await runAction('browser_screenshot', { selector: '#chart' }, ctxFor([]))
    expect(result.imageSources).toMatchObject([{ kind: 'box' }])
  })

  it('resolves an image element to its own source', async () => {
    fixture('<img id="pic" src="https://cdn.example.com/p.png" alt="Sales chart">')
    const result = await runAction('browser_read_image', { selector: '#pic' }, ctxFor([]))
    expect(result.imageSources).toMatchObject([{
      kind: 'url',
      url: 'https://cdn.example.com/p.png',
      box: { width: 200, height: 40 },
    }])
    expect(result.text).toContain('Sales chart')
  })

  it('requires an identifier and reports an unmatched image', async () => {
    fixture('<p>no images</p>')
    await expect(runAction('browser_read_image', {}, ctxFor([]))).rejects.toThrow(/Provide index, indices, selector, or alt/)
    await expect(runAction('browser_read_image', { selector: '#missing' }, ctxFor([]))).rejects.toThrow(/no image matched/)
  })
})

describe('browser_get_text as a window', () => {
  it('returns the whole text with no footer when it fits', async () => {
    fixture('<p>short page text</p>')
    const result = await runAction('browser_get_text', {}, ctxFor([]))
    expect(result.text).toBe('short page text')
  })

  it('states the total and the exact continuing call when it does not fit', async () => {
    fixture(`<p>${'x'.repeat(500)}</p>`)
    const result = await runAction('browser_get_text', { limit: 100 }, ctxFor([]))
    expect(result.text.startsWith('x'.repeat(100))).toBe(true)
    expect(result.text).toContain('characters 0-100 of 500')
    expect(result.text).toContain('400 remain')
    expect(result.text).toContain('browser_get_text({ offset: 100 })')
  })

  it('continues from an offset and marks the end, so no text is unreachable', async () => {
    fixture(`<p>${'ab'.repeat(150)}</p>`)
    const first = await runAction('browser_get_text', { limit: 200 }, ctxFor([]))
    const second = await runAction('browser_get_text', { offset: 200, limit: 200 }, ctxFor([]))
    const firstBody = first.text.split('\n[')[0]!
    const secondBody = second.text.split('\n[')[0]!
    expect(firstBody + secondBody).toBe('ab'.repeat(150))
    expect(second.text).toContain('end of text')
  })

  it('reports an offset past the end instead of returning a bare empty result', async () => {
    fixture('<p>tiny</p>')
    const result = await runAction('browser_get_text', { offset: 9_000 }, ctxFor([]))
    expect(result.text).toContain('past the end')
    expect(result.text).toContain('4 characters long')
  })

  it('windows a selector read and echoes the selector in the continuation', async () => {
    fixture(`<div id="body">${'y'.repeat(300)}</div><p>other</p>`)
    const result = await runAction('browser_get_text', { selector: '#body', limit: 50 }, ctxFor([]))
    expect(result.text).toContain('browser_get_text({ selector: "#body", offset: 50 })')
  })

  it('fails loudly on an unmatched or invalid selector rather than returning prose', async () => {
    fixture('<p>page</p>')
    await expect(runAction('browser_get_text', { selector: '#missing' }, ctxFor([])))
      .rejects.toThrow(/No element matched selector/)
    await expect(runAction('browser_get_text', { selector: 'div[' }, ctxFor([])))
      .rejects.toThrow(/not a valid CSS selector/)
  })

  it('says so when there is no text at all', async () => {
    fixture('')
    const result = await runAction('browser_get_text', {}, ctxFor([]))
    expect(result.text).toContain('no text')
  })
})

describe('browser_snapshot full mode', () => {
  it('reads content the main-content heuristic would have skipped', async () => {
    // Two sibling sections: mainText() picks one container, so a default
    // snapshot can miss the other entirely.
    fixture(`
      <main><p>${'main section text. '.repeat(5)}</p></main>
      <aside><p>ORPHANED_SIDEBAR_CONTENT</p></aside>
    `)
    const normal = await runAction('browser_snapshot', {}, ctxFor([]))
    const full = await runAction('browser_snapshot', { full: true }, ctxFor([]))

    expect(normal.text).toContain('main section text')
    expect(normal.text).not.toContain('ORPHANED_SIDEBAR_CONTENT')
    expect(full.text).toContain('ORPHANED_SIDEBAR_CONTENT')
    expect(full.text).toContain('main section text')
  })

  it('tells the model how to recover anything the budget cut', async () => {
    fixture(`<main><p>${'z'.repeat(4_000)}</p></main>`)
    const ctx = { ...ctxFor([]), budget: { maxItems: 60, maxForms: 30, maxChars: 1_000 } }
    const result = await runAction('browser_snapshot', {}, ctx)
    expect(result.text).toContain('browser_get_text({ offset })')
  })
})

describe('stale index recovery', () => {
  it('clicks via the selector when the index no longer resolves', async () => {
    fixture('<button id="pay">Pay</button>')
    const button = document.querySelector<HTMLButtonElement>('#pay')!
    const ctx = ctxFor([button])
    const index = indexOf(ctx.ids, button)
    const clicks: string[] = []
    button.addEventListener('click', () => clicks.push('pay'))

    // Simulate the re-render that kills indices: same page, new element objects.
    fixture('<button id="pay">Pay</button>')
    const rebuilt = document.querySelector<HTMLButtonElement>('#pay')!
    rebuilt.addEventListener('click', () => clicks.push('pay-after-rerender'))

    const result = await runAction('browser_click', { index, selector: '#pay' }, ctx)
    expect(clicks).toEqual(['pay-after-rerender'])
    expect(result.text).toContain('the index was stale, so the selector was used')
  })

  it('still fails loudly when neither handle resolves', async () => {
    fixture('<button id="pay">Pay</button>')
    const ctx = ctxFor([document.querySelector('#pay')!])
    await expect(runAction('browser_click', { index: 999, selector: '#gone' }, ctx))
      .rejects.toThrow(/No element matched selector: #gone/)
    await expect(runAction('browser_click', { index: 999 }, ctx))
      .rejects.toThrow(/browser_find \(it returns a selector/)
  })

  it('treats a detached element as stale, instead of clicking into nothing', async () => {
    // The id registry holds a strong reference, so after a re-render the index
    // still resolves — to a node that is no longer in the document. Acting on
    // it would report success while doing nothing.
    fixture('<button id="pay">Pay</button>')
    const original = document.querySelector<HTMLButtonElement>('#pay')!
    const ctx = ctxFor([original])
    const index = indexOf(ctx.ids, original)
    let detachedClicks = 0
    original.addEventListener('click', () => { detachedClicks += 1 })

    fixture('<button id="pay">Pay</button>')
    expect(ctx.ids.elementByIndex(index)).toBe(original)
    expect(original.isConnected).toBe(false)

    await expect(runAction('browser_click', { index }, ctx)).rejects.toThrow(/removed from the page by a re-render/)
    expect(detachedClicks).toBe(0)
  })

  it('accepts a selector with no index at all', async () => {
    fixture('<input id="email">')
    const ctx = ctxFor([])
    await runAction('browser_type', { selector: '#email', text: 'a@b.c' }, ctx)
    expect(document.querySelector<HTMLInputElement>('#email')!.value).toBe('a@b.c')
  })

  it('reports a missing handle as bad args, not as a stale element', async () => {
    fixture('<input id="email">')
    await expect(runAction('browser_type', { text: 'x' }, ctxFor([])))
      .rejects.toThrow(/Provide index, or selector/)
  })

  it('recovers inside a batch, so one stale step does not abort the flow', async () => {
    fixture('<input id="user"><button id="go">Go</button>')
    const ctx = ctxFor([document.querySelector('#user')!, document.querySelector('#go')!])
    const staleIndex = 987
    const clicks: string[] = []

    fixture('<input id="user"><button id="go">Go</button>')
    document.querySelector('#go')!.addEventListener('click', () => clicks.push('go'))

    const result = await runAction('browser_act', {
      steps: [
        { action: 'type', index: staleIndex, selector: '#user', text: 'alice' },
        { action: 'click', index: staleIndex, selector: '#go' },
      ],
    }, ctx)
    expect(document.querySelector<HTMLInputElement>('#user')!.value).toBe('alice')
    expect(clicks).toEqual(['go'])
    expect(result.text).not.toContain('FAILED')
  })
})

describe('forum and image-host pictures', () => {
  it('prefers the full-size link a thumbnail is wrapped in', async () => {
    // The forum pattern: a thumbnail linked to the original. Reading the
    // thumbnail is what made the model "only see a placeholder".
    fixture('<a href="https://img.example/full/photo.jpg"><img id="t" src="https://img.example/thumb/photo.jpg"></a>')
    const result = await runAction('browser_read_image', { selector: '#t' }, ctxFor([]))
    expect(result.imageSources).toMatchObject([{
      kind: 'url',
      url: 'https://img.example/full/photo.jpg',
      fallbacks: ['https://img.example/thumb/photo.jpg'],
      box: { width: 200, height: 40 },
    }])
    expect(result.text).toContain('full-size source')
  })

  it('resolves a lazy-loaded image instead of its placeholder', async () => {
    fixture('<img id="p" src="https://img.example/loading.gif" data-original="https://img.example/real.jpg">')
    const result = await runAction('browser_read_image', { selector: '#p' }, ctxFor([]))
    expect(result.imageSources?.[0]).toMatchObject({ kind: 'url', url: 'https://img.example/real.jpg' })
  })

  it('picks the largest srcset candidate', async () => {
    fixture('<img id="s" src="https://img.example/small.jpg" srcset="https://img.example/m.jpg 600w, https://img.example/l.jpg 1600w">')
    const result = await runAction('browser_read_image', { selector: '#s' }, ctxFor([]))
    expect(result.imageSources?.[0]).toMatchObject({ url: 'https://img.example/l.jpg' })
  })

  it('reads several images in one call', async () => {
    fixture(`
      <img id="a" src="https://img.example/1.jpg">
      <img id="b" src="https://img.example/2.jpg">
    `)
    const first = document.querySelector('#a')!
    const second = document.querySelector('#b')!
    const ctx = ctxFor([first, second])
    const result = await runAction('browser_read_image', {
      indices: [indexOf(ctx.ids, first), indexOf(ctx.ids, second)],
    }, ctx)
    expect(result.imageSources?.map((source) => source.kind === 'url' ? source.url : '')).toEqual([
      'https://img.example/1.jpg',
      'https://img.example/2.jpg',
    ])
    expect(result.text).toContain('Reading 2 image(s)')
  })

  it('returns what it could read when one of several images is unusable', async () => {
    fixture('<img id="a" src="https://img.example/1.jpg">')
    const only = document.querySelector('#a')!
    const ctx = ctxFor([only])
    const result = await runAction('browser_read_image', { indices: [indexOf(ctx.ids, only), 4242] }, ctx)
    expect(result.imageSources).toHaveLength(1)
    expect(result.text).toContain('[4242]: no image matched')
  })
})

describe('snapshot image inventory', () => {
  it('lists page images with an index the model can read directly', async () => {
    fixture(`
      <p>post body</p>
      <img id="big" src="https://img.example/photo.jpg" alt="Holiday photo">
      <img id="icon" src="https://img.example/i.png" alt="icon">
    `)
    // tests/setup.ts renders every element at 200x40, so shrink the icon below
    // the listing threshold the way a real icon would be.
    const icon = document.querySelector('#icon')!
    icon.getBoundingClientRect = () => ({ width: 16, height: 16, top: 0, left: 0, right: 16, bottom: 16, x: 0, y: 0, toJSON: () => ({}) })

    const result = await runAction('browser_snapshot', {}, ctxFor([]))
    expect(result.text).toContain('Images (read one with browser_read_image')
    expect(result.text).toContain('"Holiday photo"')
    expect(result.text).toContain('img.example/photo.jpg')
    // Icons and tracking pixels stay out, or they bury the real pictures.
    expect(result.text).not.toContain('"icon"')
  })

  it('marks an image the browser has not fetched', async () => {
    // jsdom never loads images, so naturalWidth stays 0 — the same signal a
    // real lazy image below the fold gives. The placeholder-URL half of this
    // rule is unit-tested directly in locate.spec.ts.
    fixture('<img id="lazy" src="https://img.example/chart.png" alt="Chart">')
    const result = await runAction('browser_snapshot', {}, ctxFor([]))
    expect(result.text).toContain('not loaded yet')
  })

  it('says nothing about images on a page that has none', async () => {
    fixture('<p>text only</p>')
    const result = await runAction('browser_snapshot', {}, ctxFor([]))
    expect(result.text).not.toContain('Images (')
  })
})
