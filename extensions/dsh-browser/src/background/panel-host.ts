/**
 * Where the assistant panel opens, which is a per-browser decision.
 *
 * Chrome 116+ exposes `chrome.sidePanel`. Firefox and Opera do not: both render
 * the legacy `sidebar_action` manifest key natively and expose it as
 * `chrome.sidebarAction`, which Opera additionally mirrors on
 * `opr.sidebarAction`.
 *
 * The choice is made at runtime rather than from the build target because a
 * single Chrome build is loaded by browsers with different capabilities: Opera
 * runs the Chrome build but has no Side Panel API.
 *
 * A browser with neither API is told so, rather than being given the panel in
 * a window of its own. Hosting it that way puts a `chrome-extension://`
 * document where tab affinity expects the user's page, and affinity binds
 * browser tools to whatever the active tab is; every guard against that is a
 * guard against this extension's own window, which is a class of bug worth not
 * having for a browser nobody has reported using.
 *
 * @module
 */

import { getUiLocale } from '../i18n.ts'

/** The pre-`sidePanel` sidebar API, as exposed by Firefox and Opera. */
interface LegacySidebarAction {
  open?: () => Promise<void> | void
}

interface SidePanelApi {
  open: (options: { windowId: number }) => Promise<void>
}

const UNSUPPORTED_NOTIFICATION_ID = 'dsh-panel-unsupported'

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

/** Say why nothing opened, so a dead toolbar click is never the whole answer. */
function reportUnsupportedBrowser(): void {
  const copy = getUiLocale() === 'zh'
    ? {
      title: '此浏览器无法打开侧栏',
      message: '该浏览器既没有侧边面板，也没有侧栏扩展接口。请改用 Chrome 116+、Firefox 140+ 或 Opera。',
    }
    : {
      title: 'This browser cannot open the panel',
      message: 'It has neither a side panel nor a sidebar extension API. Use Chrome 116+, Firefox 140+, or Opera instead.',
    }
  void Promise.resolve(chrome.notifications.create(UNSUPPORTED_NOTIFICATION_ID, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('assets/icons/icon128.png'),
    title: copy.title,
    message: copy.message,
  })).catch(() => {})
}

/**
 * Open the panel wherever this browser can host it.
 *
 * Both APIs require the call to stay inside the user gesture that triggered it,
 * so the lookup and the `open()` call are synchronous. `windowId` targets the
 * Chrome side panel — the sidebar is scoped by the browser itself.
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
      // A declared-but-unusable sidebar is no different from having none.
    }
  }
  reportUnsupportedBrowser()
}
