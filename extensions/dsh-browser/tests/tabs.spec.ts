// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { parseTabsRequest, runTabsAction, TabsError, type TabsDeps } from '../src/background/tabs.ts'
import type { AffinityTab } from '../src/background/tab-affinity.ts'

function tab(id: number, url: string, extra: Partial<chrome.tabs.Tab> = {}): chrome.tabs.Tab {
  return { id, windowId: 1, title: `Tab ${id}`, url, active: false, ...extra } as chrome.tabs.Tab
}

function makeDeps(tabs: chrome.tabs.Tab[], controlled?: number) {
  const bound: AffinityTab[] = []
  const closed: number[] = []
  const activated: number[] = []
  let controlledId = controlled
  const deps: TabsDeps = {
    listTabs: async () => tabs,
    getTab: async (tabId) => {
      const found = tabs.find((candidate) => candidate.id === tabId)
      if (found === undefined) throw new Error('no such tab')
      return found
    },
    createTab: async (url, active) => {
      const created = tab(99, url, { active })
      tabs.push(created)
      return created
    },
    closeTab: async (tabId) => { closed.push(tabId) },
    activateTab: async (tabId) => { activated.push(tabId) },
    bindControl: (summary) => { bound.push(summary); controlledId = summary.tabId },
    controlledTabId: () => controlledId,
  }
  return { deps, bound, closed, activated }
}

describe('parseTabsRequest', () => {
  it('accepts the four actions and their required arguments', () => {
    expect(parseTabsRequest({ action: 'list' })).toEqual({ action: 'list' })
    expect(parseTabsRequest({ action: 'open', url: 'https://example.com' }))
      .toEqual({ action: 'open', url: 'https://example.com/' })
    expect(parseTabsRequest({ action: 'switch', tabId: 4 })).toEqual({ action: 'switch', tabId: 4 })
    expect(parseTabsRequest({ action: 'close', tabId: 4 })).toEqual({ action: 'close', tabId: 4 })
  })

  it('refuses an unknown action, a missing argument, and a non-web URL', () => {
    expect(() => parseTabsRequest({ action: 'explode' })).toThrow(TabsError)
    expect(() => parseTabsRequest({ action: 'open' })).toThrow(/requires a url/)
    expect(() => parseTabsRequest({ action: 'switch' })).toThrow(/requires the numeric tabId/)
    expect(() => parseTabsRequest({ action: 'open', url: 'javascript:alert(1)' })).toThrow(/Only http and https/)
    expect(() => parseTabsRequest({ action: 'open', url: 'file:///etc/passwd' })).toThrow(/Only http and https/)
  })
})

describe('runTabsAction', () => {
  it('lists tabs with their ids and marks the controlled one', async () => {
    const { deps } = makeDeps([tab(1, 'https://a.example', { active: true }), tab(2, 'https://b.example')], 2)
    const text = await runTabsAction({ action: 'list' }, deps)
    expect(text).toContain('[tabId 1]')
    expect(text).toContain('(active)')
    expect(text).toContain('[tabId 2] (controlled)')
  })

  it('opens a tab and takes control by default', async () => {
    const { deps, bound } = makeDeps([tab(1, 'https://a.example')], 1)
    const text = await runTabsAction({ action: 'open', url: 'https://new.example/' }, deps)
    expect(bound.map((entry) => entry.tabId)).toEqual([99])
    expect(text).toContain('moved browser control')
  })

  it('leaves control alone when asked to open in the background', async () => {
    const { deps, bound } = makeDeps([tab(1, 'https://a.example')], 1)
    const text = await runTabsAction({ action: 'open', url: 'https://new.example/', control: false }, deps)
    expect(bound).toEqual([])
    expect(text).toContain('control stayed on the previous page')
  })

  it('moves control on switch and can foreground the tab', async () => {
    const { deps, bound, activated } = makeDeps([tab(1, 'https://a.example'), tab(2, 'https://b.example')], 1)
    await runTabsAction({ action: 'switch', tabId: 2, activate: true }, deps)
    expect(bound.map((entry) => entry.tabId)).toEqual([2])
    expect(activated).toEqual([2])
  })

  it('refuses to control a page browser tools cannot operate on', async () => {
    const { deps, bound } = makeDeps([tab(1, 'https://a.example'), tab(2, 'chrome://settings')], 1)
    await expect(runTabsAction({ action: 'switch', tabId: 2 }, deps)).rejects.toThrow(/not a standard http or https page/)
    expect(bound).toEqual([])
  })

  it('reports an unknown tab id instead of failing opaquely', async () => {
    const { deps } = makeDeps([tab(1, 'https://a.example')], 1)
    await expect(runTabsAction({ action: 'switch', tabId: 42 }, deps)).rejects.toThrow(/No tab with id 42/)
    await expect(runTabsAction({ action: 'close', tabId: 42 }, deps)).rejects.toThrow(/No tab with id 42/)
  })

  it('closes a tab and says whether control was lost with it', async () => {
    const { deps, closed } = makeDeps([tab(1, 'https://a.example'), tab(2, 'https://b.example')], 2)
    const text = await runTabsAction({ action: 'close', tabId: 2 }, deps)
    expect(closed).toEqual([2])
    expect(text).toContain('was the controlled tab')
  })

  it('never closes the last remaining tab', async () => {
    const { deps, closed } = makeDeps([tab(1, 'https://a.example')], 1)
    await expect(runTabsAction({ action: 'close', tabId: 1 }, deps)).rejects.toThrow(/last open tab/)
    expect(closed).toEqual([])
  })

  it('caps a very long tab list and says so', async () => {
    const many = Array.from({ length: 45 }, (_, index) => tab(index + 1, `https://site${index}.example`))
    const { deps } = makeDeps(many, 1)
    const text = await runTabsAction({ action: 'list' }, deps)
    expect(text).toContain('45 open tab(s)')
    expect(text).toContain('5 more omitted')
  })

  it('does not touch Chrome when only listing', async () => {
    const { deps } = makeDeps([tab(1, 'https://a.example')], 1)
    const closeTab = vi.spyOn(deps, 'closeTab')
    await runTabsAction({ action: 'list' }, deps)
    expect(closeTab).not.toHaveBeenCalled()
  })
})
