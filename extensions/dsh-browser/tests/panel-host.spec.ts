// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface ChromeStub {
  sidePanel?: {
    open?: (options: { windowId: number }) => Promise<void>
    setPanelBehavior?: (options: { openPanelOnActionClick: boolean }) => Promise<void>
  }
  sidebarAction?: { open?: () => Promise<void> | void }
  runtime: { getURL: (path: string) => string }
  windows: {
    create: (options: Record<string, unknown>) => Promise<{ id?: number }>
    update: (windowId: number, options: Record<string, unknown>) => Promise<unknown>
  }
}

function stubChrome(overrides: Partial<ChromeStub> = {}): ChromeStub {
  const chromeStub: ChromeStub = {
    runtime: { getURL: (path) => `chrome-extension://test-id/${path}` },
    windows: {
      create: vi.fn(async () => ({ id: 7 })),
      update: vi.fn(async () => ({})),
    },
    ...overrides,
  }
  vi.stubGlobal('chrome', chromeStub)
  return chromeStub
}

/** The module keeps the remembered window in module state, so reload it per test. */
async function loadPanelHost(): Promise<typeof import('../src/background/panel-host.ts')> {
  vi.resetModules()
  return import('../src/background/panel-host.ts')
}

describe('panel host selection', () => {
  beforeEach(() => { vi.unstubAllGlobals() })
  afterEach(() => { vi.unstubAllGlobals() })

  it('prefers the Chrome side panel when the API is present', async () => {
    const open = vi.fn(async () => {})
    stubChrome({ sidePanel: { open } })
    const { resolvePanelHost, openAssistantPanel } = await loadPanelHost()

    expect(resolvePanelHost()).toBe('side-panel')
    await openAssistantPanel(3)
    expect(open).toHaveBeenCalledWith({ windowId: 3 })
  })

  it('uses the legacy sidebar API when there is no Side Panel API', async () => {
    const open = vi.fn(async () => {})
    stubChrome({ sidebarAction: { open } })
    const { resolvePanelHost, openAssistantPanel } = await loadPanelHost()

    expect(resolvePanelHost()).toBe('sidebar-action')
    await openAssistantPanel()
    expect(open).toHaveBeenCalledOnce()
  })

  it('finds the sidebar API Opera exposes on opr', async () => {
    const open = vi.fn(async () => {})
    const chromeStub = stubChrome()
    vi.stubGlobal('opr', { sidebarAction: { open } })
    // Re-stub chrome: stubGlobal('opr') does not disturb it, but make the order explicit.
    vi.stubGlobal('chrome', chromeStub)
    const { resolvePanelHost, openAssistantPanel } = await loadPanelHost()

    expect(resolvePanelHost()).toBe('sidebar-action')
    await openAssistantPanel()
    expect(open).toHaveBeenCalledOnce()
  })

  it('ignores a sidebar namespace that exposes no open()', async () => {
    stubChrome({ sidebarAction: {} })
    const { resolvePanelHost } = await loadPanelHost()

    expect(resolvePanelHost()).toBe('window')
  })

  it('opens a popup window when the browser has neither sidebar API', async () => {
    const chromeStub = stubChrome()
    const { resolvePanelHost, openAssistantPanel } = await loadPanelHost()

    expect(resolvePanelHost()).toBe('window')
    await openAssistantPanel()
    expect(chromeStub.windows.create).toHaveBeenCalledWith(expect.objectContaining({
      url: 'chrome-extension://test-id/panel/index.html',
      type: 'popup',
    }))
  })

  it('focuses the existing panel window instead of stacking duplicates', async () => {
    const chromeStub = stubChrome()
    const { openAssistantPanel } = await loadPanelHost()

    await openAssistantPanel()
    await openAssistantPanel()

    expect(chromeStub.windows.create).toHaveBeenCalledOnce()
    expect(chromeStub.windows.update).toHaveBeenCalledWith(7, { focused: true })
  })

  it('opens one window for overlapping clicks', async () => {
    // Two toolbar clicks land before windows.create resolves; without
    // serializing, both see no window id yet and each opens a popup.
    let resolveCreate: (value: { id: number }) => void = () => {}
    const chromeStub = stubChrome({
      windows: {
        create: vi.fn(() => new Promise<{ id: number }>((resolve) => { resolveCreate = resolve })),
        update: vi.fn(async () => ({})),
      },
    })
    const { openAssistantPanel } = await loadPanelHost()

    const first = openAssistantPanel()
    const second = openAssistantPanel()
    resolveCreate({ id: 7 })
    await Promise.all([first, second])

    expect(chromeStub.windows.create).toHaveBeenCalledOnce()
  })

  it('reopens a panel window the user closed', async () => {
    const chromeStub = stubChrome({
      windows: {
        create: vi.fn(async () => ({ id: 7 })),
        update: vi.fn(async () => { throw new Error('No window with id: 7.') }),
      },
    })
    const { openAssistantPanel } = await loadPanelHost()

    await openAssistantPanel()
    await openAssistantPanel()

    expect(chromeStub.windows.create).toHaveBeenCalledTimes(2)
  })

  it('identifies its own window and document so tab affinity can skip them', async () => {
    stubChrome()
    const { openAssistantPanel, hasPanelWindow, isPanelWindow, isPanelDocument } = await loadPanelHost()

    expect(hasPanelWindow()).toBe(false)
    expect(isPanelWindow(7)).toBe(false)

    await openAssistantPanel()

    expect(hasPanelWindow()).toBe(true)
    expect(isPanelWindow(7)).toBe(true)
    expect(isPanelWindow(8)).toBe(false)
    expect(isPanelDocument('chrome-extension://test-id/panel/index.html')).toBe(true)
    expect(isPanelDocument('chrome-extension://test-id/panel/index.html#settings')).toBe(true)
    expect(isPanelDocument('https://example.com/')).toBe(false)
    expect(isPanelDocument(undefined)).toBe(false)
    expect(isPanelDocument('')).toBe(false)
  })

  it('claims the panel window before windows.create resolves', async () => {
    // The browser focuses the new window before create() resolves, so a
    // window-id check alone would miss the very first focus event.
    let resolveCreate: (value: { id: number }) => void = () => {}
    stubChrome({
      windows: {
        create: vi.fn(() => new Promise<{ id: number }>((resolve) => { resolveCreate = resolve })),
        update: vi.fn(async () => ({})),
      },
    })
    const { openAssistantPanel, hasPanelWindow } = await loadPanelHost()

    const opening = openAssistantPanel()
    expect(hasPanelWindow()).toBe(true)

    resolveCreate({ id: 7 })
    await opening
    expect(hasPanelWindow()).toBe(true)
  })

  it('reports no panel window on browsers that never open one', async () => {
    stubChrome({ sidePanel: { open: vi.fn(async () => {}) } })
    const { openAssistantPanel, hasPanelWindow, isPanelWindow } = await loadPanelHost()

    await openAssistantPanel(1)
    expect(hasPanelWindow()).toBe(false)
    expect(isPanelWindow(1)).toBe(false)
  })

  it('forgets a closed window so the next open does not probe a dead id', async () => {
    const chromeStub = stubChrome()
    const { openAssistantPanel, forgetPanelWindow } = await loadPanelHost()

    await openAssistantPanel()
    forgetPanelWindow(7)
    await openAssistantPanel()

    expect(chromeStub.windows.update).not.toHaveBeenCalled()
    expect(chromeStub.windows.create).toHaveBeenCalledTimes(2)
  })

  it('stops claiming a panel window once the user closes it', async () => {
    stubChrome()
    const { openAssistantPanel, forgetPanelWindow, hasPanelWindow, isPanelWindow } = await loadPanelHost()

    await openAssistantPanel()
    forgetPanelWindow(7)

    expect(hasPanelWindow()).toBe(false)
    expect(isPanelWindow(7)).toBe(false)
  })

  it('falls back to a window when a declared sidebar refuses to open', async () => {
    const chromeStub = stubChrome({
      sidebarAction: { open: vi.fn(async () => { throw new Error('not supported') }) },
    })
    const { openAssistantPanel } = await loadPanelHost()

    await openAssistantPanel()
    expect(chromeStub.windows.create).toHaveBeenCalledOnce()
  })

  it('never calls the side panel without a window to target it at', async () => {
    const open = vi.fn(async () => {})
    const chromeStub = stubChrome({ sidePanel: { open } })
    const { openAssistantPanel } = await loadPanelHost()

    await openAssistantPanel(undefined)
    expect(open).not.toHaveBeenCalled()
    expect(chromeStub.windows.create).not.toHaveBeenCalled()
  })

  it('survives a side panel that rejects, without falling through to a window', async () => {
    const chromeStub = stubChrome({
      sidePanel: { open: vi.fn(async () => { throw new Error('user gesture required') }) },
    })
    const { openAssistantPanel } = await loadPanelHost()

    await expect(openAssistantPanel(1)).resolves.toBeUndefined()
    expect(chromeStub.windows.create).not.toHaveBeenCalled()
  })

  it('requests Chrome open-on-click only where the API exists', async () => {
    const setPanelBehavior = vi.fn(async () => {})
    stubChrome({ sidePanel: { open: vi.fn(async () => {}), setPanelBehavior } })
    const { preferPanelOnActionClick } = await loadPanelHost()

    preferPanelOnActionClick()
    expect(setPanelBehavior).toHaveBeenCalledWith({ openPanelOnActionClick: true })
  })

  it('is a no-op on browsers with no Side Panel API', async () => {
    stubChrome({ sidebarAction: { open: vi.fn(async () => {}) } })
    const { preferPanelOnActionClick } = await loadPanelHost()

    expect(() => { preferPanelOnActionClick() }).not.toThrow()
  })

  it('tolerates setPanelBehavior rejecting', async () => {
    stubChrome({
      sidePanel: {
        open: vi.fn(async () => {}),
        setPanelBehavior: vi.fn(async () => { throw new Error('unsupported') }),
      },
    })
    const { preferPanelOnActionClick } = await loadPanelHost()

    expect(() => { preferPanelOnActionClick() }).not.toThrow()
  })
})

describe('Chrome manifest panel hosts', () => {
  it('declares both panel keys so Opera docks the panel natively', () => {
    const manifest = JSON.parse(
      readFileSync(`${process.cwd()}/manifest.json`, 'utf8'),
    ) as {
      side_panel?: { default_path?: string }
      sidebar_action?: { default_panel?: string; default_icon?: Record<string, string> }
    }

    // Chrome reads side_panel and ignores sidebar_action; Opera does the
    // reverse, and both point at the same panel document.
    expect(manifest.side_panel?.default_path).toBe('panel/index.html')
    expect(manifest.sidebar_action?.default_panel).toBe('panel/index.html')
    expect(manifest.sidebar_action?.default_icon).toBeDefined()
  })

  it('needs no extra permission for the legacy sidebar', () => {
    const manifest = JSON.parse(
      readFileSync(`${process.cwd()}/manifest.json`, 'utf8'),
    ) as { permissions: string[] }

    // Opera-store extensions declare sidebar_action without a "sidebar"
    // permission; requesting one would add an install-time prompt for nothing.
    expect(manifest.permissions).not.toContain('sidebar')
  })
})
