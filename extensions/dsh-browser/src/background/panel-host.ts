/**
 * Where the assistant panel opens, which is a per-browser decision.
 *
 * Chrome 116+ exposes `chrome.sidePanel`. Firefox and Opera do not: both
 * render the legacy `sidebar_action` manifest key natively and expose it as
 * `chrome.sidebarAction`, which Opera additionally mirrors on
 * `opr.sidebarAction`. A browser with neither API falls back to a narrow popup
 * window, the one host that always works.
 *
 * The choice is made at runtime rather than from the build target because a
 * single Chrome build is loaded by browsers with different capabilities:
 * Opera runs the Chrome build but has no Side Panel API.
 *
 * @module
 */

/** Panel window geometry, sized to mirror a docked browser sidebar. */
const PANEL_WINDOW_WIDTH = 420
const PANEL_WINDOW_HEIGHT = 760

/** The pre-`sidePanel` sidebar API, as exposed by Firefox and Opera. */
interface LegacySidebarAction {
  open?: () => Promise<void> | void
}

interface SidePanelApi {
  open: (options: { windowId: number }) => Promise<void>
}

/** Panel hosts, ordered most native first. */
export type PanelHost = 'side-panel' | 'sidebar-action' | 'window'

/** The remembered fallback window, so a second click focuses it rather than stacking a duplicate. */
let panelWindowId: number | undefined

function sidePanelApi(): SidePanelApi | undefined {
  const api = (chrome as { sidePanel?: SidePanelApi }).sidePanel
  return typeof api?.open === 'function' ? api : undefined
}

function legacySidebarApi(): LegacySidebarAction | undefined {
  const scope = globalThis as { opr?: { sidebarAction?: LegacySidebarAction } }
  const api = (chrome as { sidebarAction?: LegacySidebarAction }).sidebarAction ?? scope.opr?.sidebarAction
  return typeof api?.open === 'function' ? api : undefined
}

/** The most native panel host this browser supports. */
export function resolvePanelHost(): PanelHost {
  if (sidePanelApi() !== undefined) return 'side-panel'
  if (legacySidebarApi() !== undefined) return 'sidebar-action'
  return 'window'
}

/**
 * Chrome opens the side panel itself on toolbar clicks. Browsers without the
 * API deliver `action.onClicked` instead, which {@link openAssistantPanel}
 * handles, so this is a no-op there rather than a failure.
 */
export function preferPanelOnActionClick(): void {
  const behavior = (chrome as {
    sidePanel?: { setPanelBehavior?: (options: { openPanelOnActionClick: boolean }) => Promise<void> }
  }).sidePanel?.setPanelBehavior
  if (typeof behavior !== 'function') return
  void behavior.call(chrome.sidePanel, { openPanelOnActionClick: true }).catch(() => {})
}

/**
 * Focus the remembered panel window, or open one. Reusing it matters because a
 * browser without a sidebar has no other way to show a panel is already up.
 */
async function openPanelWindow(): Promise<void> {
  if (panelWindowId !== undefined) {
    const focused = await chrome.windows.update(panelWindowId, { focused: true })
      .then(() => true)
      .catch(() => false)
    if (focused) return
    // The user closed it; fall through and open a replacement.
    panelWindowId = undefined
  }
  const created = await chrome.windows.create({
    url: chrome.runtime.getURL('panel/index.html'),
    type: 'popup',
    width: PANEL_WINDOW_WIDTH,
    height: PANEL_WINDOW_HEIGHT,
  }).catch(() => undefined)
  panelWindowId = created?.id
}

/**
 * Open the panel wherever this browser can host it.
 *
 * Both sidebar APIs require the call to stay inside the user gesture that
 * triggered it, so the API lookup and the `open()` call are synchronous;
 * only the window fallback awaits. `windowId` targets the Chrome side panel —
 * the other hosts are scoped by the browser itself.
 */
export async function openAssistantPanel(windowId?: number): Promise<void> {
  const sidePanel = sidePanelApi()
  if (sidePanel !== undefined) {
    if (windowId === undefined) return
    await sidePanel.open({ windowId }).catch(() => {})
    return
  }

  const sidebar = legacySidebarApi()
  if (sidebar?.open !== undefined) {
    try {
      await sidebar.open()
      return
    } catch {
      // A declared-but-unusable sidebar is still better served by a window.
    }
  }
  await openPanelWindow()
}

/** Forget the remembered window so the next open creates a fresh one. */
export function forgetPanelWindow(windowId: number): void {
  if (panelWindowId === windowId) panelWindowId = undefined
}
