/**
 * Content script entry: listens for DSH_ACTION messages from the background
 * service worker, runs the action against the real page, and answers with a
 * text-only result. Starts the DOM watcher that marks the snapshot dirty, and
 * the panel-gated watcher that reports what the user highlights.
 *
 * The content script is the only part that touches the page; the bridge and
 * the model never see page internals beyond the structured text snapshots.
 *
 * @module
 */

import { DEFAULT_SNAPSHOT_MAX_CHARS } from '@yuxianglin/dsh-bridge-browser/src/protocol.ts'
import { runAction, ActionError, type ActionResult } from './actions.ts'
import { ElementIds } from './ids.ts'
import { SelectionWatcher } from './selection.ts'
import type { SnapshotBudget } from './snapshot.ts'

/** Negotiated snapshot budgets, patched in from the background via message. */
let budget: SnapshotBudget = { maxItems: 200, maxForms: 100, maxChars: DEFAULT_SNAPSHOT_MAX_CHARS }

const ids = new ElementIds()

const selectionWatcher = new SelectionWatcher((selection) => {
  void chrome.runtime.sendMessage({ type: 'DSH_SELECTION', selection }).catch(() => {})
})

const CONTENT_SCRIPT_LISTENER = '__dshBrowserContentScriptListener__'
const CONTENT_SELECTION_WATCHER = '__dshBrowserSelectionWatcher__'
type ContentListener = typeof onMessage

/** A tool-call result for the bridge. */
export interface ToolResult {
  ok: boolean
  result?: ActionResult
  error?: { code: string; message: string }
}

function onMessage(message: unknown, _sender: chrome.runtime.MessageSender, sendResponse: (response: ToolResult) => void): true | undefined {
  if (typeof message !== 'object' || message === null) return
  const msg = message as { type?: string }
  if (msg.type === 'DSH_BUDGET') {
    const incoming = (message as { budget?: Partial<SnapshotBudget> }).budget
    if (incoming !== undefined) {
      budget = { ...budget, ...incoming }
      sendResponse({ ok: true, result: { text: `快照预算已更新: ${JSON.stringify(budget)}` } })
    }
    return
  }
  if (msg.type === 'DSH_SELECTION_WATCH') {
    const command = message as { enabled?: unknown; epoch?: unknown; revision?: unknown }
    const epoch = typeof command.epoch === 'string' ? command.epoch : undefined
    const revision = typeof command.revision === 'number' ? command.revision : undefined
    selectionWatcher.setEnabled(command.enabled === true, revision, epoch)
    sendResponse({ ok: true })
    return
  }
  if (msg.type === 'DSH_SELECTION_RESET') {
    // The panel dropped this frame's quote; let the same passage be re-reported.
    selectionWatcher.resetDedupe()
    sendResponse({ ok: true })
    return
  }
  if (msg.type !== 'DSH_ACTION') return
  const actionMsg = message as {
    action?: string
    args?: Record<string, unknown>
    budget?: Partial<SnapshotBudget>
    includePageDelta?: boolean
  }
  const action = actionMsg.action ?? ''
  const args = actionMsg.args ?? {}
  const actionBudget = actionMsg.budget === undefined ? budget : { ...budget, ...actionMsg.budget }
  void runAction(action, args, {
    ids,
    budget: actionBudget,
    includePageDelta: actionMsg.includePageDelta === true,
  }).then(
    (result) => { sendResponse({ ok: true, result }) },
    (error: unknown) => {
      const code = error instanceof ActionError ? error.code : 'action-failed'
      const messageText = error instanceof Error ? error.message : String(error)
      sendResponse({ ok: false, error: { code, message: messageText } })
    },
  )
  return true // async response
}

// executeScript is used to recover tabs opened before extension install/reload.
// Replace any stale listener left in the isolated world so a reload always
// installs a listener belonging to the current extension context.
const contentGlobal = globalThis as typeof globalThis & {
  [CONTENT_SCRIPT_LISTENER]?: ContentListener
  [CONTENT_SELECTION_WATCHER]?: { dispose: () => void }
}
const previousListener = contentGlobal[CONTENT_SCRIPT_LISTENER]
if (previousListener !== undefined) {
  try { chrome.runtime.onMessage.removeListener(previousListener) } catch { /* stale extension context */ }
}
// A replaced content script keeps its page listeners until this instance
// releases them: `selectionchange` is a document listener, not an extension one.
contentGlobal[CONTENT_SELECTION_WATCHER]?.dispose()
contentGlobal[CONTENT_SCRIPT_LISTENER] = onMessage
contentGlobal[CONTENT_SELECTION_WATCHER] = selectionWatcher
chrome.runtime.onMessage.addListener(onMessage)

// A navigation action answers before unloading. The replacement content
// script announces when the new document can accept its automatic snapshot,
// and learns from the reply whether a side panel wants selection reports.
void chrome.runtime.sendMessage({ type: 'DSH_CONTENT_READY' }).then((response: unknown) => {
  if (typeof response !== 'object' || response === null) return
  const ready = response as {
    selectionWatch?: unknown
    selectionWatchEpoch?: unknown
    selectionWatchRevision?: unknown
  }
  const epoch = typeof ready.selectionWatchEpoch === 'string' ? ready.selectionWatchEpoch : undefined
  const revision = typeof ready.selectionWatchRevision === 'number' ? ready.selectionWatchRevision : undefined
  selectionWatcher.setEnabled(ready.selectionWatch === true, revision, epoch)
}).catch(() => {})
