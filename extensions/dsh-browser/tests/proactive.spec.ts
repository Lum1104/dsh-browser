// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { expandPage, isDisclosureControl, renderExpandResult, DEFAULT_EXPAND_OPTIONS } from '../src/content/expand.ts'
import { harvestLinks, renderLinks } from '../src/content/harvest.ts'
import { verificationTargets, renderVerificationTargets } from '../src/content/verify.ts'

function fixture(html: string): void {
  document.body.innerHTML = html
  for (const el of document.querySelectorAll('*')) {
    (el as HTMLElement).scrollIntoView = vi.fn()
  }
  window.scrollTo = vi.fn()
}

const settle = (): Promise<void> => Promise.resolve()

describe('isDisclosureControl', () => {
  it('accepts what a page marks as collapsed', () => {
    fixture(`
      <button aria-expanded="false">Details</button>
      <details><summary>More</summary><p>hidden</p></details>
      <button>Show more</button>
      <a href="#">查看更多</a>
    `)
    expect(isDisclosureControl(document.querySelector('[aria-expanded]')!)).toBe(true)
    expect(isDisclosureControl(document.querySelector('summary')!)).toBe(true)
    expect(isDisclosureControl(document.querySelectorAll('button')[1]!)).toBe(true)
    expect(isDisclosureControl(document.querySelector('a')!)).toBe(true)
  })

  it('refuses anything destructive or transactional, whatever it claims', () => {
    fixture(`
      <button>Delete more items</button>
      <button>Buy more</button>
      <button>删除更多</button>
      <button>Submit</button>
      <button>Download more</button>
    `)
    for (const button of document.querySelectorAll('button')) {
      expect(isDisclosureControl(button)).toBe(false)
    }
  })

  it('refuses a link that navigates and a form submit button', () => {
    fixture(`
      <a href="/next-page">Show more</a>
      <form><button type="submit">Show more</button></form>
      <button disabled>Show more</button>
    `)
    expect(isDisclosureControl(document.querySelector('a')!)).toBe(false)
    expect(isDisclosureControl(document.querySelector('button[type="submit"]')!)).toBe(false)
    expect(isDisclosureControl(document.querySelector('button[disabled]')!)).toBe(false)
  })

  it('refuses a plain button that says nothing about disclosure', () => {
    fixture('<button>Settings</button>')
    expect(isDisclosureControl(document.querySelector('button')!)).toBe(false)
  })
})

describe('expandPage', () => {
  it('clicks disclosure controls and reports what it revealed', async () => {
    fixture('<button aria-expanded="false" id="one">Details</button><button id="two">Show more</button>')
    const clicked: string[] = []
    for (const button of document.querySelectorAll('button')) {
      button.addEventListener('click', () => clicked.push(button.id))
    }
    const result = await expandPage({ ...DEFAULT_EXPAND_OPTIONS, scroll: false }, settle)
    expect(clicked.sort()).toEqual(['one', 'two'])
    expect(result.expanded).toBe(2)
    expect(renderExpandResult(result)).toContain('Expanded 2 control(s)')
  })

  it('never clicks the same control twice across rounds', async () => {
    fixture('<button aria-expanded="false">Details</button>')
    let clicks = 0
    document.querySelector('button')!.addEventListener('click', () => { clicks += 1 })
    await expandPage({ maxRounds: 4, scroll: false, maxPerRound: 25 }, settle)
    expect(clicks).toBe(1)
  })

  it('honors the per-round click cap', async () => {
    fixture(Array.from({ length: 10 }, (_, i) => `<button aria-expanded="false">Row ${i}</button>`).join(''))
    const result = await expandPage({ maxRounds: 1, scroll: false, maxPerRound: 3 }, settle)
    expect(result.expanded).toBe(3)
  })

  it('says plainly when there was nothing to expand', async () => {
    fixture('<p>plain page</p>')
    const result = await expandPage({ ...DEFAULT_EXPAND_OPTIONS, scroll: false }, settle)
    expect(result.expanded).toBe(0)
    expect(renderExpandResult(result)).toContain('Nothing was collapsed')
  })

  it('stops and reports when a click navigated the page', async () => {
    fixture('<button aria-expanded="false">Details</button>')
    document.querySelector('button')!.addEventListener('click', () => {
      // A router-driven control can change the URL without unloading.
      history.pushState({}, '', '/elsewhere')
    })
    const result = await expandPage({ maxRounds: 3, scroll: false, maxPerRound: 5 }, settle)
    expect(result.navigated).toBe(true)
    expect(renderExpandResult(result)).toContain('navigated away')
  })
})

describe('harvestLinks', () => {
  it('returns outbound links with their surrounding snippet', () => {
    fixture(`
      <li><a href="https://result.example/a">First result</a><p>A snippet about the first result.</p></li>
      <li><a href="https://result.example/b">Second result</a></li>
    `)
    const links = harvestLinks({})
    expect(links.map((link) => link.url)).toEqual(['https://result.example/a', 'https://result.example/b'])
    expect(links[0]?.context).toContain('snippet about the first')
  })

  it('drops the engine\'s own links, subdomains included', () => {
    fixture(`
      <a href="https://www.bing.com/search?q=next">Next page</a>
      <a href="https://bing.com/settings">Settings</a>
      <a href="https://real.example/page">Real result</a>
    `)
    const links = harvestLinks({ excludeHosts: ['bing.com'] })
    expect(links.map((link) => link.url)).toEqual(['https://real.example/page'])
  })

  it('drops non-web schemes, empty anchors, and duplicates', () => {
    fixture(`
      <a href="javascript:void(0)">JS</a>
      <a href="mailto:x@y.z">Mail</a>
      <a href="https://a.example/1">One</a>
      <a href="https://a.example/1">One again</a>
      <a href="https://a.example/2"></a>
    `)
    expect(harvestLinks({}).map((link) => link.url)).toEqual(['https://a.example/1'])
  })

  it('honors the limit and renders a readable list', () => {
    fixture(Array.from({ length: 5 }, (_, i) => `<a href="https://a.example/${i}">Item ${i}</a>`).join(''))
    const links = harvestLinks({ limit: 2 })
    expect(links).toHaveLength(2)
    const rendered = renderLinks(links, 'results:')
    expect(rendered).toContain('1. Item 0')
    expect(rendered).toContain('https://a.example/1')
  })

  it('explains an empty harvest instead of returning nothing', () => {
    fixture('<p>no links</p>')
    expect(renderLinks(harvestLinks({}), 'results:')).toContain('No outbound links')
  })
})

describe('verificationTargets', () => {
  it('locates a Turnstile widget and aims at its checkbox gutter', () => {
    fixture('<div class="cf-turnstile"><iframe src="https://challenges.cloudflare.com/cdn-cgi/challenge-platform/x"></iframe></div>')
    const [target] = verificationTargets()
    // tests/setup.ts stubs every rect at 200x40 anchored at 0,0.
    expect(target).toMatchObject({ kind: 'turnstile', x: 30, y: 20 })
    expect(renderVerificationTargets([target!])).toContain('Cloudflare Turnstile')
  })

  it('recognizes hCaptcha and reCAPTCHA anchors', () => {
    fixture(`
      <iframe src="https://newassets.hcaptcha.com/captcha/v1/x/static/hcaptcha-checkbox.html"></iframe>
      <iframe src="https://www.google.com/recaptcha/api2/anchor?k=x"></iframe>
    `)
    expect(verificationTargets().map((target) => target.kind)).toEqual(['hcaptcha', 'recaptcha'])
  })

  it('ignores an unrelated iframe', () => {
    fixture('<iframe src="https://player.example/embed"></iframe>')
    expect(verificationTargets()).toEqual([])
  })

  it('finds an inline challenge checkbox but not an ordinary one', () => {
    fixture(`
      <div id="challenge-stage"><input type="checkbox" aria-label="Verify you are human"></div>
      <label><input type="checkbox"> Remember me</label>
    `)
    const targets = verificationTargets()
    expect(targets).toHaveLength(1)
    expect(targets[0]).toMatchObject({ kind: 'checkbox', x: 100, y: 20 })
  })

  it('skips an inline checkbox that is already checked', () => {
    fixture('<div id="challenge-stage"><input type="checkbox" checked></div>')
    expect(verificationTargets()).toEqual([])
  })

  it('explains an absent widget in terms the model can act on', () => {
    fixture('<p>ordinary page</p>')
    const rendered = renderVerificationTargets(verificationTargets())
    expect(rendered).toContain('No human-verification widget')
    expect(rendered).toContain('puzzle')
  })
})
