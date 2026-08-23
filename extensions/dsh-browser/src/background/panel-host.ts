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

/**
 * Session storage outlives a service-worker restart and dies with the browser
 * session, which is exactly the lifetime of the window it names. Without it an
 * MV3 restart forgets a popup that is still open, and the next toolbar click
 * opens a second one.
 */
const PANEL_WINDOW_STORAGE_KEY = 'dshPanelWindow'

/** The remembered fallback window, so a second click focuses it rather than stacking a duplicate. */
let panelWindowId: number | undefined
/**
 * The in-flight open, held for two reasons: overlapping clicks must share one
 * window rather than each creating its own, and the browser focuses the new
 * window before `windows.create` resolves, so the panel has to be claimed
 * before there is an id to claim it by.
 */
let panelWindowOpening: Promise<void> | null = null

/** Rehydrate the remembered window before the first open decides anything. */
const panelWindowReady: Promise<void> = (async () => {
  try {
    const stored = await chrome.storage.session.get(PANEL_WINDOW_STORAGE_KEY)
    const id: unknown = stored[PANEL_WINDOW_STORAGE_KEY]
    if (typeof id === 'number' && Number.isInteger(id) && id >= 0) panelWindowId = id
  } catch {
    // A forgotten id costs a duplicate popup, not correctness.
  }
})()

function rememberPanelWindow(windowId: number | undefined): void {
  panelWindowId = windowId
  try {
    void (windowId === undefined
      ? chrome.storage.session.remove(PANEL_WINDOW_STORAGE_KEY)
      : chrome.storage.session.set({ [PANEL_WINDOW_STORAGE_KEY]: windowId })
    ).catch(() => {})
  } catch {
    // Same as above: persistence here is a convenience, not a guarantee.
  }
}

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
  // A popup from before a service-worker restart is still open and still ours.
  await panelWindowReady
  if (panelWindowId !== undefined) {
    const focused = await chrome.windows.update(panelWindowId, { focused: true })
      .then(() => true)
      .catch(() => false)
    if (focused) return
    // The user closed it; fall through and open a replacement.
    rememberPanelWindow(undefined)
  }
  try {
    const created = await chrome.windows.create({
      url: chrome.runtime.getURL('panel/index.html'),
      type: 'popup',
      width: PANEL_WINDOW_WIDTH,
      height: PANEL_WINDOW_HEIGHT,
    })
    rememberPanelWindow(created?.id)
  } catch {
    // Every caller shares this promise, so a failed open must not reject onto them.
    rememberPanelWindow(undefined)
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

/**
 * Resolves once any in-flight open has settled, at which point
 * {@link isPanelWindow} can answer for the window it created. The browser
 * focuses that window before `windows.create` resolves, so a focus event
 * arriving mid-open cannot be judged until this settles.
 */
export function panelWindowSettled(): Promise<void> {
  return panelWindowOpening ?? panelWindowReady
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
  if (panelWindowId === windowId) rememberPanelWindow(undefined)
}
