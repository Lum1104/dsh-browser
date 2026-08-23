// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface ChromeStub {
  sidePanel?: {
    open?: (options: { windowId: number }) => Promise<void>
    setPanelBehavior?: (options: { openPanelOnActionClick: boolean }) => Promise<void>
  }
  sidebarAction?: { open?: () => Promise<void> | void }
  notifications: { create: (id: string, options: Record<string, unknown>) => Promise<string> }
  runtime: { getURL: (path: string) => string }
}

function stubChrome(overrides: Partial<ChromeStub> = {}): ChromeStub {
  const chromeStub: ChromeStub = {
    notifications: { create: vi.fn(async () => 'dsh-panel-unsupported') },
    runtime: { getURL: (path) => `chrome-extension://test-id/${path}` },
    ...overrides,
  }
  vi.stubGlobal('chrome', chromeStub)
  return chromeStub
}

async function loadPanelHost(): Promise<typeof import('../src/background/panel-host.ts')> {
  vi.resetModules()
  return import('../src/background/panel-host.ts')
}

describe('panel host selection', () => {
  beforeEach(() => { vi.unstubAllGlobals() })
  afterEach(() => { vi.unstubAllGlobals() })

  it('prefers the Chrome side panel when the API is present', async () => {
    const open = vi.fn(async () => {})
    const chromeStub = stubChrome({ sidePanel: { open } })
    const { openAssistantPanel } = await loadPanelHost()

    await openAssistantPanel(3)

    expect(open).toHaveBeenCalledWith({ windowId: 3 })
    expect(chromeStub.notifications.create).not.toHaveBeenCalled()
  })

  it('uses the legacy sidebar API when there is no Side Panel API', async () => {
    const open = vi.fn(async () => {})
    const chromeStub = stubChrome({ sidebarAction: { open } })
    const { openAssistantPanel } = await loadPanelHost()

    await openAssistantPanel()

    expect(open).toHaveBeenCalledOnce()
    expect(chromeStub.notifications.create).not.toHaveBeenCalled()
  })

  it('finds the sidebar API Opera exposes on opr', async () => {
    const open = vi.fn(async () => {})
    const chromeStub = stubChrome()
    vi.stubGlobal('opr', { sidebarAction: { open } })
    vi.stubGlobal('chrome', chromeStub)
    const { openAssistantPanel } = await loadPanelHost()

    await openAssistantPanel()

    expect(open).toHaveBeenCalledOnce()
    expect(chromeStub.notifications.create).not.toHaveBeenCalled()
  })

  it('never calls the side panel without a window to target it at', async () => {
    const open = vi.fn(async () => {})
    const chromeStub = stubChrome({ sidePanel: { open } })
    const { openAssistantPanel } = await loadPanelHost()

    await openAssistantPanel(undefined)

    expect(open).not.toHaveBeenCalled()
    // A side-panel browser is supported; a missing window is not a reason to
    // tell the user their browser cannot host the panel.
    expect(chromeStub.notifications.create).not.toHaveBeenCalled()
  })

  it('survives a side panel that rejects', async () => {
    const chromeStub = stubChrome({
      sidePanel: { open: vi.fn(async () => { throw new Error('user gesture required') }) },
    })
    const { openAssistantPanel } = await loadPanelHost()

    await expect(openAssistantPanel(1)).resolves.toBeUndefined()
    expect(chromeStub.notifications.create).not.toHaveBeenCalled()
  })

  it('tells the user when the browser hosts neither panel', async () => {
    const chromeStub = stubChrome()
    const { openAssistantPanel } = await loadPanelHost()

    await openAssistantPanel()

    expect(chromeStub.notifications.create).toHaveBeenCalledWith(
      'dsh-panel-unsupported',
      expect.objectContaining({ type: 'basic', message: expect.stringContaining('Chrome 116+') }),
    )
  })

  it('treats a sidebar namespace with no open() as no sidebar at all', async () => {
    const chromeStub = stubChrome({ sidebarAction: {} })
    const { openAssistantPanel } = await loadPanelHost()

    await openAssistantPanel()

    expect(chromeStub.notifications.create).toHaveBeenCalledOnce()
  })

  it('reports the browser when a declared sidebar refuses to open', async () => {
    const chromeStub = stubChrome({
      sidebarAction: { open: vi.fn(async () => { throw new Error('not supported') }) },
    })
    const { openAssistantPanel } = await loadPanelHost()

    await openAssistantPanel()

    expect(chromeStub.notifications.create).toHaveBeenCalledOnce()
  })

  it('never opens a window or a tab of its own', async () => {
    // Hosting the panel in an ordinary window would put a chrome-extension://
    // document where tab affinity expects the user's page.
    const source = readFileSync(`${process.cwd()}/src/background/panel-host.ts`, 'utf8')

    expect(source).not.toMatch(/chrome\.windows\.create/)
    expect(source).not.toMatch(/chrome\.tabs\.create/)
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
