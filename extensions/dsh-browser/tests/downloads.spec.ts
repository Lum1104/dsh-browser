// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import {
  basenameFromUrl,
  parseDownloadRequest,
  parseDownloadsRequest,
  runDownload,
  runDownloadsAction,
  DownloadError,
  type DownloadsDeps,
} from '../src/background/downloads.ts'

function item(overrides: Partial<chrome.downloads.DownloadItem> = {}): chrome.downloads.DownloadItem {
  return {
    id: 1,
    url: 'https://files.example/report.pdf',
    filename: 'C:\\Users\\me\\Downloads\\report.pdf',
    state: 'complete',
    paused: false,
    bytesReceived: 2048,
    totalBytes: 2048,
    ...overrides,
  } as chrome.downloads.DownloadItem
}

function makeDeps(items: chrome.downloads.DownloadItem[] = []) {
  const started: chrome.downloads.DownloadOptions[] = []
  const calls: string[] = []
  let nextId = 100
  const deps: DownloadsDeps = {
    start: async (options) => {
      started.push(options)
      nextId += 1
      return nextId
    },
    search: async (query) => {
      calls.push(`search:${JSON.stringify(query)}`)
      if (query.id !== undefined) return items.filter((entry) => entry.id === query.id)
      return items.slice(0, query.limit ?? items.length)
    },
    cancel: async (id) => { calls.push(`cancel:${id}`) },
    pause: async (id) => { calls.push(`pause:${id}`) },
    resume: async (id) => { calls.push(`resume:${id}`) },
    show: (id) => { calls.push(`show:${id}`) },
  }
  return { deps, started, calls }
}

describe('parseDownloadRequest', () => {
  it('accepts one url and a batch, normalizing both', () => {
    expect(parseDownloadRequest({ url: 'https://files.example/a.pdf' }).urls).toEqual(['https://files.example/a.pdf'])
    expect(parseDownloadRequest({ urls: ['https://a.example/1', 'https://a.example/2'] }).urls).toHaveLength(2)
  })

  it('defaults the conflict action to uniquify so a batch never overwrites silently', () => {
    expect(parseDownloadRequest({ url: 'https://a.example/f' }).conflict).toBe('uniquify')
    expect(parseDownloadRequest({ url: 'https://a.example/f', conflict: 'overwrite' }).conflict).toBe('overwrite')
  })

  it('refuses a path that would escape the download folder', () => {
    expect(() => parseDownloadRequest({ url: 'https://a.example/f', filename: '/etc/passwd' })).toThrow(/relative path/)
    expect(() => parseDownloadRequest({ url: 'https://a.example/f', filename: 'C:\\Windows\\evil.exe' })).toThrow(/relative path/)
    expect(() => parseDownloadRequest({ url: 'https://a.example/f', subdirectory: '../../secrets' })).toThrow(/must not contain/)
  })

  it('refuses a non-web scheme, a missing url, and an oversized batch', () => {
    expect(() => parseDownloadRequest({})).toThrow(/Provide url/)
    expect(() => parseDownloadRequest({ url: 'file:///etc/passwd' })).toThrow(/Only http and https/)
    expect(() => parseDownloadRequest({ urls: Array.from({ length: 21 }, (_, i) => `https://a.example/${i}`) }))
      .toThrow(/At most 20/)
  })

  it('refuses saveAs for a batch, because it asks for one location', () => {
    expect(() => parseDownloadRequest({ urls: ['https://a.example/1', 'https://a.example/2'], saveAs: true }))
      .toThrow(/cannot be combined with a batch/)
  })
})

describe('runDownload', () => {
  it('starts every download and reports its id', async () => {
    const { deps, started } = makeDeps()
    const text = await runDownload(parseDownloadRequest({ urls: ['https://a.example/1.pdf', 'https://a.example/2.pdf'] }), deps)
    expect(started).toHaveLength(2)
    expect(text).toContain('Started 2 download(s)')
    expect(text).toContain('[id 101]')
    expect(text).toContain('[id 102]')
    // The reason this exists at all: no page-level multi-download prompt.
    expect(text).toContain('multiple-download prompt does not apply')
  })

  it('numbers a batch that shares one filename', async () => {
    const { deps, started } = makeDeps()
    await runDownload(parseDownloadRequest({
      urls: ['https://a.example/1', 'https://a.example/2'],
      filename: 'report.pdf',
      subdirectory: 'dsh',
    }), deps)
    expect(started.map((options) => options.filename)).toEqual(['dsh/report-1.pdf', 'dsh/report-2.pdf'])
  })

  it('keeps each source name when only a subdirectory is given', async () => {
    const { deps, started } = makeDeps()
    await runDownload(parseDownloadRequest({
      urls: ['https://a.example/deck.pdf', 'https://a.example/sheet.xlsx'],
      subdirectory: 'dsh',
    }), deps)
    expect(started.map((options) => options.filename)).toEqual(['dsh/deck.pdf', 'dsh/sheet.xlsx'])
  })

  it('reports partial failure without discarding what started', async () => {
    const { deps, started } = makeDeps()
    let first = true
    deps.start = async (options) => {
      if (first) {
        first = false
        throw new Error('network unreachable')
      }
      started.push(options)
      return 7
    }
    const text = await runDownload(parseDownloadRequest({ urls: ['https://a.example/1', 'https://a.example/2'] }), deps)
    expect(text).toContain('Started 1 of 2')
    expect(text).toContain('network unreachable')
  })

  it('fails the call only when nothing could start', async () => {
    const { deps } = makeDeps()
    deps.start = async () => { throw new Error('blocked') }
    await expect(runDownload(parseDownloadRequest({ url: 'https://a.example/1' }), deps))
      .rejects.toThrow(/No download could be started/)
  })
})

describe('parseDownloadsRequest and runDownloadsAction', () => {
  it('requires an id for everything but list', () => {
    expect(parseDownloadsRequest({ action: 'list' })).toEqual({ action: 'list', limit: 10 })
    expect(() => parseDownloadsRequest({ action: 'cancel' })).toThrow(/requires the numeric id/)
    expect(() => parseDownloadsRequest({ action: 'explode' })).toThrow(DownloadError)
  })

  it('lists recent downloads with progress', async () => {
    const { deps } = makeDeps([item({ id: 4, state: 'in_progress', bytesReceived: 1024, totalBytes: 4096 })])
    const text = await runDownloadsAction({ action: 'list', limit: 10 }, deps)
    expect(text).toContain('[id 4] in_progress')
    expect(text).toContain('1.0 KB/4.0 KB')
  })

  it('says so when nothing has been downloaded', async () => {
    const { deps } = makeDeps([])
    expect(await runDownloadsAction({ action: 'list', limit: 10 }, deps)).toContain('No downloads')
  })

  it('refuses an operation the item\'s state does not allow', async () => {
    const { deps } = makeDeps([item({ id: 4, state: 'complete' })])
    await expect(runDownloadsAction({ action: 'cancel', id: 4 }, deps)).rejects.toThrow(/already complete/)
    await expect(runDownloadsAction({ action: 'resume', id: 4 }, deps)).rejects.toThrow(/not paused/)
    await expect(runDownloadsAction({ action: 'cancel', id: 99 }, deps)).rejects.toThrow(/No download with id 99/)
  })

  it('performs the allowed operations', async () => {
    const { deps, calls } = makeDeps([item({ id: 4, state: 'in_progress' }), item({ id: 5, state: 'in_progress', paused: true })])
    await runDownloadsAction({ action: 'cancel', id: 4 }, deps)
    await runDownloadsAction({ action: 'pause', id: 4 }, deps)
    await runDownloadsAction({ action: 'resume', id: 5 }, deps)
    await runDownloadsAction({ action: 'show', id: 4 }, deps)
    expect(calls.filter((entry) => !entry.startsWith('search'))).toEqual(['cancel:4', 'pause:4', 'resume:5', 'show:4'])
  })

  it('surfaces an interrupted item\'s reason', async () => {
    const { deps } = makeDeps([item({ id: 6, state: 'interrupted', error: 'NETWORK_FAILED' })])
    expect(await runDownloadsAction({ action: 'list', limit: 10 }, deps)).toContain('interrupted (NETWORK_FAILED)')
  })
})

describe('basenameFromUrl', () => {
  it('takes the last path segment, decoded', () => {
    expect(basenameFromUrl('https://a.example/dir/report%20final.pdf')).toBe('report final.pdf')
    expect(basenameFromUrl('https://a.example/')).toBe('download')
    expect(basenameFromUrl('not a url')).toBe('download')
  })
})

describe('download seams', () => {
  it('never searches Chrome for a list it was not asked for', async () => {
    const { deps } = makeDeps([item()])
    const search = vi.spyOn(deps, 'search')
    await runDownload(parseDownloadRequest({ url: 'https://a.example/1' }), deps)
    expect(search).not.toHaveBeenCalled()
  })
})
