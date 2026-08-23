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

/** The remembered fallback window, so a second click focuses it rather than stacking a duplicate. */
let panelWindowId: number | undefined
/**
 * The in-flight open, held for two reasons: overlapping clicks must share one
 * window rather than each creating its own, and the browser focuses the new
 * window before `windows.create` resolves, so the panel has to be claimed
 * before there is an id to claim it by.
 */
let panelWindowOpening: Promise<void> | null = null

function sidePanelApi(): SidePanelApi | undefined {
  const api = (chrome as { sidePanel?: SidePanelApi }).sidePanel
  return typeof api?.open === 'function' ? api : undefined
}

function legacySidebarApi(): LegacySidebarAction | undefined {
  const scope = globalThis as { opr?: { sidebarAction?: LegacySidebarAction } }
  const api = (chrome as { sidebarAction?: LegacySidebarAction }).sidebarAction ?? scope.opr?.sidebarAction
  return typeof api?.open === 'function' ? api : undefined
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
  // Join an open already in flight instead of racing it to a second window.
  if (panelWindowOpening !== null) return panelWindowOpening
  panelWindowOpening = focusOrCreatePanelWindow()
  try {
    await panelWindowOpening
  } finally {
    panelWindowOpening = null
  }
}

async function focusOrCreatePanelWindow(): Promise<void> {
  if (panelWindowId !== undefined) {
    const focused = await chrome.windows.update(panelWindowId, { focused: true })
      .then(() => true)
      .catch(() => false)
    if (focused) return
    // The user closed it; fall through and open a replacement.
    panelWindowId = undefined
  }
  try {
    const created = await chrome.windows.create({
      url: chrome.runtime.getURL('panel/index.html'),
      type: 'popup',
      width: PANEL_WINDOW_WIDTH,
      height: PANEL_WINDOW_HEIGHT,
    })
    panelWindowId = created?.id
  } catch {
    // Every caller shares this promise, so a failed open must not reject onto them.
    panelWindowId = undefined
  }
}

/**
 * Whether this browser hosts the panel in a window of its own. Only then can
 * Chrome's last-focused window be the panel rather than a page, so callers use
 * this to keep tab affinity pointed at the user's browser window.
 */
export function hasPanelWindow(): boolean {
  return panelWindowOpening !== null || panelWindowId !== undefined
}

/** Whether a window is the panel's own popup rather than a browser window. */
export function isPanelWindow(windowId: number): boolean {
  return panelWindowId !== undefined && panelWindowId === windowId
}

/**
 * Whether a tab is showing the panel itself. Content scripts never match
 * `chrome-extension://`, so binding browser tools to this document would break
 * every one of them; the URL is authoritative where a window id can still race
 * the `windows.create` that produced it.
 */
export function isPanelDocument(url: string | undefined): boolean {
  if (url === undefined || url === '') return false
  return url.startsWith(chrome.runtime.getURL('panel/'))
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
