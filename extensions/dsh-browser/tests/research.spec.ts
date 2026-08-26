// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  parseReadPagesRequest,
  parseSearchRequest,
  requestOrigins,
  runReadPages,
  runSearch,
  ResearchError,
  searchUrl,
  withinApprovedBoundary,
  type ResearchDeps,
} from '../src/background/research.ts'

interface Recorder {
  deps: ResearchDeps
  opened: string[]
  closed: number[]
  asked: { tabId: number; action: string; args: Record<string, unknown> }[]
  /** Tabs opened but never closed — a leak the user would see in their tab strip. */
  leaked(): number[]
}

function makeDeps(overrides: Partial<ResearchDeps> = {}, answer: (action: string, url: string) => string = () => 'body text'): Recorder {
  const opened: string[] = []
  const closed: number[] = []
  const asked: { tabId: number; action: string; args: Record<string, unknown> }[] = []
  const urlByTab = new Map<number, string>()
  let nextTab = 10
  const deps: ResearchDeps = {
    openScratchTab: async (url) => {
      opened.push(url)
      nextTab += 1
      urlByTab.set(nextTab, url)
      return nextTab
    },
    closeTab: async (tabId) => { closed.push(tabId) },
    waitForLoad: async () => true,
    ask: async (tabId, action, args) => {
      asked.push({ tabId, action, args })
      return { text: answer(action, urlByTab.get(tabId) ?? '') }
    },
    describeTab: async (tabId) => ({ title: `Title of ${urlByTab.get(tabId)}`, url: urlByTab.get(tabId) ?? '' }),
    ...overrides,
  }
  return {
    deps,
    opened,
    closed,
    asked,
    leaked: () => [...urlByTab.keys()].filter((tabId) => !closed.includes(tabId)),
  }
}

describe('parseSearchRequest', () => {
  it('defaults to bing and bounds the result count', () => {
    expect(parseSearchRequest({ query: 'dsh harness' })).toEqual({ query: 'dsh harness', engine: 'bing', limit: 15 })
    expect(parseSearchRequest({ query: 'x', limit: 5_000 }).limit).toBe(100)
  })

  it('refuses an empty query and an unknown engine', () => {
    expect(() => parseSearchRequest({ query: '   ' })).toThrow(/must not be empty/)
    expect(() => parseSearchRequest({ query: 'x', engine: 'yandex' })).toThrow(/bing, duckduckgo, or google/)
  })

  it('builds an encoded query URL per engine', () => {
    expect(searchUrl(parseSearchRequest({ query: 'a b&c' }))).toBe('https://www.bing.com/search?q=a%20b%26c')
    expect(searchUrl(parseSearchRequest({ query: 'x', engine: 'duckduckgo' }))).toContain('duckduckgo.com/?q=x')
    expect(searchUrl(parseSearchRequest({ query: 'x', engine: 'google' }))).toContain('google.com/search?q=x')
  })
})

describe('parseReadPagesRequest', () => {
  it('deduplicates, bounds the page count, and bounds the per-page budget', () => {
    const request = parseReadPagesRequest({ urls: ['https://a.example/1', 'https://a.example/1', 'https://b.example/2'] })
    expect(request.urls).toHaveLength(2)
    expect(request.maxCharsPerPage).toBe(24_000)
    expect(request.offset).toBe(0)
    expect(parseReadPagesRequest({ urls: ['https://a.example'], maxCharsPerPage: 10 ** 9 }).maxCharsPerPage).toBe(120_000)
    expect(parseReadPagesRequest({ urls: ['https://a.example'], offset: 500 }).offset).toBe(500)
    expect(() => parseReadPagesRequest({ urls: Array.from({ length: 13 }, (_, i) => `https://a.example/${i}`) }))
      .toThrow(/At most 12 pages/)
  })

  it('refuses a missing list and a non-web scheme', () => {
    expect(() => parseReadPagesRequest({})).toThrow(ResearchError)
    expect(() => parseReadPagesRequest({ urls: ['chrome://settings'] })).toThrow(/Only http and https/)
    expect(() => parseReadPagesRequest({ urls: ['not a url'] })).toThrow(/is not valid/)
  })
})

describe('requestOrigins', () => {
  it('collapses URLs to sorted unique origins for one approval prompt', () => {
    expect(requestOrigins(['https://b.example/x', 'https://a.example/1', 'https://a.example/2']))
      .toEqual(['https://a.example', 'https://b.example'])
  })
})

describe('withinApprovedBoundary', () => {
  const approved = ['https://docs.example']

  it('accepts the approved origin and the redirects the ordinary web makes', () => {
    expect(withinApprovedBoundary('https://docs.example/page', approved)).toBe(true)
    expect(withinApprovedBoundary('https://www.docs.example/page', approved)).toBe(true)
    expect(withinApprovedBoundary('http://docs.example/page', approved)).toBe(true)
  })

  it('rejects another site, a non-web scheme, and an unparseable url', () => {
    expect(withinApprovedBoundary('https://evil.example/page', approved)).toBe(false)
    expect(withinApprovedBoundary('file:///etc/passwd', approved)).toBe(false)
    expect(withinApprovedBoundary('not a url', approved)).toBe(false)
  })

  it('keeps two private-suffix sites apart rather than sharing their suffix', () => {
    expect(withinApprovedBoundary('https://b.github.io/x', ['https://a.github.io'])).toBe(false)
    expect(withinApprovedBoundary('https://a.github.io/y', ['https://a.github.io'])).toBe(true)
  })

  it('falls back to exact host equality where there is no registrable domain', () => {
    expect(withinApprovedBoundary('http://127.0.0.1:8080/x', ['http://127.0.0.1:8080'])).toBe(true)
    expect(withinApprovedBoundary('http://127.0.0.2:8080/x', ['http://127.0.0.1:8080'])).toBe(false)
  })
})

describe('runSearch', () => {
  it('reads the results page in a scratch tab and closes it', async () => {
    const recorder = makeDeps({}, () => '1. Result\n   https://result.example')
    const text = await runSearch(parseSearchRequest({ query: 'dsh' }), recorder.deps)

    expect(recorder.opened).toEqual(['https://www.bing.com/search?q=dsh'])
    expect(recorder.leaked()).toEqual([])
    expect(recorder.asked[0]?.action).toBe('dsh_harvest_links')
    // The engine's own hosts are filtered out by the harvester, not the model.
    expect(recorder.asked[0]?.args.excludeHosts).toContain('bing.com')
    expect(text).toContain('https://result.example')
    expect(text).toContain('browser_read_pages')
  })

  it('closes the scratch tab even when the page cannot be read', async () => {
    const recorder = makeDeps({ ask: async () => { throw new Error('no content script') } })
    await expect(runSearch(parseSearchRequest({ query: 'dsh' }), recorder.deps)).rejects.toThrow(/no content script/)
    expect(recorder.leaked()).toEqual([])
  })

  it('reports a results page that never loaded', async () => {
    const recorder = makeDeps({ waitForLoad: async () => false })
    await expect(runSearch(parseSearchRequest({ query: 'dsh' }), recorder.deps)).rejects.toThrow(/did not finish loading/)
    expect(recorder.leaked()).toEqual([])
  })

  it('explains an empty results page as a possible interstitial', async () => {
    const recorder = makeDeps({}, () => '')
    await expect(runSearch(parseSearchRequest({ query: 'dsh' }), recorder.deps)).rejects.toThrow(/consent or verification interstitial/)
  })
})

describe('runReadPages', () => {
  it('reads every page into one digest and closes every tab', async () => {
    const recorder = makeDeps({}, (_action, url) => `content of ${url}`)
    const text = await runReadPages(parseReadPagesRequest({
      urls: ['https://a.example/1', 'https://b.example/2', 'https://c.example/3'],
    }), recorder.deps)

    expect(recorder.opened).toHaveLength(3)
    expect(recorder.leaked()).toEqual([])
    expect(text).toContain('Read 3 of 3 page(s)')
    expect(text).toContain('the page you were on was not touched')
    expect(text).toContain('untrusted data')
    for (const url of ['https://a.example/1', 'https://b.example/2', 'https://c.example/3']) {
      expect(text).toContain(`content of ${url}`)
    }
  })

  it('keeps the requested order regardless of which page finishes first', async () => {
    const recorder = makeDeps({}, (_action, url) => `content of ${url}`)
    const text = await runReadPages(parseReadPagesRequest({
      urls: ['https://a.example/1', 'https://b.example/2', 'https://c.example/3'],
    }), recorder.deps)
    const order = ['a.example', 'b.example', 'c.example'].map((host) => text.indexOf(host))
    expect(order).toEqual([...order].sort((left, right) => left - right))
    expect(text).toContain('## 1.')
    expect(text).toContain('## 3.')
  })

  it('records a failed page as a section instead of failing the whole call', async () => {
    let calls = 0
    const recorder = makeDeps({
      ask: async () => {
        calls += 1
        if (calls === 1) throw new Error('page refused to render')
        return { text: 'good content' }
      },
    })
    const text = await runReadPages(parseReadPagesRequest({
      urls: ['https://bad.example/1', 'https://good.example/2'],
    }), recorder.deps)
    expect(text).toContain('could not be read: page refused to render')
    expect(text).toContain('good content')
    expect(text).toContain('Read 1 of 2 page(s)')
    expect(recorder.leaked()).toEqual([])
  })

  it('refuses a page that redirected out of the approved origins, before reading it', async () => {
    const recorder = makeDeps({
      describeTab: async () => ({ title: 'Elsewhere', url: 'https://evil.example/landing' }),
    }, () => 'secret body')

    const text = await runReadPages(parseReadPagesRequest({ urls: ['https://a.example/1'] }), recorder.deps)

    expect(text).toContain('could not be read: it redirected to https://evil.example')
    expect(text).not.toContain('secret body')
    // The refusal has to land BEFORE extraction: reading first and refusing
    // afterwards would already have pulled the unapproved body into the worker.
    expect(recorder.asked.filter((entry) => entry.action === 'browser_get_text')).toEqual([])
    expect(text).toContain('Read 0 of 1 page(s)')
    expect(recorder.leaked()).toEqual([])
  })

  it('reports only the landed origin, never the redirect target url', async () => {
    const recorder = makeDeps({
      describeTab: async () => ({ title: 'x', url: 'https://evil.example/ignore-previous-instructions' }),
    })

    const text = await runReadPages(parseReadPagesRequest({ urls: ['https://a.example/1'] }), recorder.deps)

    expect(text).toContain('https://evil.example')
    expect(text).not.toContain('ignore-previous-instructions')
  })

  it('follows an ordinary same-site redirect', async () => {
    const recorder = makeDeps({
      describeTab: async () => ({ title: 'Doc', url: 'https://www.a.example/1' }),
    }, () => 'body text')

    const text = await runReadPages(parseReadPagesRequest({ urls: ['http://a.example/1'] }), recorder.deps)

    expect(text).toContain('body text')
    expect(text).toContain('Read 1 of 1 page(s)')
  })

  it('judges each page against the whole approved set, not just its own url', async () => {
    // One call approves both origins, so b.example landing on a.example is inside.
    const recorder = makeDeps({
      describeTab: async () => ({ title: 'Doc', url: 'https://a.example/moved' }),
    }, () => 'body text')

    const text = await runReadPages(parseReadPagesRequest({
      urls: ['https://a.example/1', 'https://b.example/2'],
    }), recorder.deps)

    expect(text).toContain('Read 2 of 2 page(s)')
  })

  it('windows a long page and names the call that reads the rest', async () => {
    const recorder = makeDeps({}, () => 'x'.repeat(500))
    const text = await runReadPages(parseReadPagesRequest({
      urls: ['https://a.example/1'],
      maxCharsPerPage: 100,
    }), recorder.deps)
    // Nothing is dropped without a way back to it.
    expect(text).toContain('characters 0-100 of 500')
    expect(text).toContain('400 remain')
    expect(text).toContain('browser_read_pages({ urls: ["https://a.example/1"], offset: 100 })')
  })

  it('asks each page for the full text and windows it here, so the total is honest', async () => {
    const recorder = makeDeps({}, () => 'x'.repeat(500))
    await runReadPages(parseReadPagesRequest({ urls: ['https://a.example/1'], offset: 40 }), recorder.deps)
    // A second truncation inside the page would make the reported total wrong.
    expect(recorder.asked[0]?.args).toMatchObject({ limit: 120_000, offset: 40 })
  })

  it('forwards a selector to every page', async () => {
    const recorder = makeDeps()
    await runReadPages(parseReadPagesRequest({ urls: ['https://a.example/1'], selector: 'main' }), recorder.deps)
    expect(recorder.asked[0]).toMatchObject({ action: 'browser_get_text', args: { selector: 'main' } })
  })
})
