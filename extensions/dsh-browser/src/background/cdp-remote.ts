/**
 * Direct CDP over the browser's remote-debugging port.
 *
 * Chromium deliberately removed `debugger` from the optional-permission set
 * (it allowed one extension to attach to another's background context), so
 * `chrome.debugger` is unusable on current Edge builds. The remote-debugging
 * port speaks the same protocol with no permission gate at all: launch the
 * browser once with `--remote-debugging-port=<port>` and every page's MAIN
 * world is reachable over plain WebSocket.
 *
 * The port binds to loopback only, so exposure equals "other local processes",
 * the same trust boundary the extension itself already sits inside.
 *
 * One impedance mismatch needs bridging: CDP addresses pages by opaque
 * targetId while everything upstream uses chrome.tabs ids. URL match settles
 * most cases; when it is ambiguous, a probe attribute planted on the root
 * element through `chrome.scripting` (the DOM is shared between worlds) lets
 * each candidate identify itself.
 *
 * @module
 */

/** Ports probed in order; the first answering `/json/version` wins. */
export const REMOTE_CDP_PORTS = [9222, 9223, 9224]

const PROBE_ATTRIBUTE = 'data-dsh-probe'

/** Chrome seams for testability. */
export interface RemoteCdpDeps {
  fetch(url: string): Promise<Response>
  connect(url: string): WebSocket
  /** Plants a probe attribute on the tab's root element from the isolated world. */
  plantProbe(tabId: number, value: string): Promise<void>
}

interface PageTarget {
  id: string
  type?: string
  url: string
}

/** A command channel to one page target. */
interface TargetSession {
  send(method: string, params?: object): Promise<unknown>
  close(): void
}

/**
 * Evaluate an expression in a tab's MAIN world through the remote-debugging port.
 *
 * @param tabId - the chrome.tabs id of the controlled tab.
 * @param tabUrl - the tab's current URL, for target matching.
 * @param expression - the code; async results are awaited before reporting.
 * @param port - the remote-debugging port (see {@link discoverRemoteCdpPort}).
 * @param deps - Chrome seams.
 * @returns the serialized result text ('undefined' when there is no value).
 * @throws Error when no endpoint answers, no target matches, or the evaluation fails.
 */
export async function evaluateViaRemoteCdp(
  tabId: number,
  tabUrl: string,
  expression: string,
  port: number,
  deps: RemoteCdpDeps,
): Promise<string> {
  const targets = await listPageTargets(port, deps)
  const targetId = await resolveTargetId(tabId, tabUrl, targets, port, deps)
  const session = await attach(targetId, port, deps)
  try {
    // Same shape as the CDP path in evaluate.ts: awaited promises, JSON-shaped
    // values, user-gesture powers.
    const response = await session.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    }) as { result?: { type?: string; value?: unknown }; exceptionDetails?: { exception?: { description?: string } } }
    if (response.exceptionDetails !== undefined) {
      throw new Error(`the page threw an error: ${response.exceptionDetails.exception?.description ?? 'unknown error'}`)
    }
    if (response.result?.type === 'undefined') return 'undefined'
    return JSON.stringify(response.result?.value) ?? 'undefined'
  } finally {
    session.close()
  }
}

/**
 * Find the port of a live remote-debugging endpoint.
 *
 * @returns the answering port.
 * @throws Error naming exactly how the browser must be started, because that is the fix.
 */
export async function discoverRemoteCdpPort(deps: RemoteCdpDeps): Promise<number> {
  for (const port of REMOTE_CDP_PORTS) {
    try {
      const response = await deps.fetch(`http://127.0.0.1:${port}/json/version`)
      if (response.ok) return port
    } catch {
      // Not listening here; try the next configured port.
    }
  }
  throw new Error(
    'no remote-debugging endpoint is reachable on this browser; start it once with --remote-debugging-port=9222 '
    + '(fully exit Edge first, or the running instance ignores the flag)',
  )
}

async function listPageTargets(port: number, deps: RemoteCdpDeps): Promise<PageTarget[]> {
  try {
    const response = await deps.fetch(`http://127.0.0.1:${port}/json/list`)
    const parsed: unknown = await response.json()
    return Array.isArray(parsed) ? parsed.filter((t): t is PageTarget => typeof t === 'object' && t !== null && typeof (t as PageTarget).id === 'string') : []
  } catch {
    return []
  }
}

function stripHash(url: string): string {
  const hashAt = url.indexOf('#')
  return hashAt === -1 ? url : url.slice(0, hashAt)
}

async function resolveTargetId(
  tabId: number,
  tabUrl: string,
  targets: PageTarget[],
  port: number,
  deps: RemoteCdpDeps,
): Promise<string> {
  const pages = targets.filter((target) => (target.type ?? 'page') === 'page')
  const sameUrl = pages.filter((target) => stripHash(target.url) === stripHash(tabUrl))
  const candidates = sameUrl.length > 0 ? sameUrl : pages
  if (candidates.length === 1) return candidates[0]!.id

  // Ambiguous: let the tab itself answer which target it is. The DOM belongs
  // to both worlds, so an attribute planted via chrome.scripting is readable
  // from MAIN-world evaluation on each candidate.
  const probe = crypto.randomUUID()
  await deps.plantProbe(tabId, probe)
  try {
    for (const candidate of candidates) {
      let session: TargetSession | undefined
      try {
        session = await attach(candidate.id, port, deps)
      } catch {
        continue
      }
      try {
        const result = await session.send('Runtime.evaluate', {
          expression: `document.documentElement.getAttribute('${PROBE_ATTRIBUTE}')`,
          returnByValue: true,
        }) as { result?: { value?: unknown } }
        if (result.result?.value === probe) return candidate.id
      } finally {
        session.close()
      }
    }
  } finally {
    // Best-effort cleanup of the probe attribute.
    try {
      await deps.plantProbe(tabId, '')
    } catch {
      // The tab may have navigated mid-probe; nothing to clean then.
    }
  }
  throw new Error('could not match this tab to a debugging target (it may have navigated); retry after the page settles')
}

async function attach(targetId: string, port: number, deps: RemoteCdpDeps): Promise<TargetSession> {
  const ws = deps.connect(`ws://127.0.0.1:${port}/devtools/page/${targetId}`)
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true })
    ws.addEventListener('error', () => reject(new Error('could not open a debugging socket for this page')), { once: true })
  })

  let seq = 0
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  ws.addEventListener('message', (event) => {
    const frame = JSON.parse(String(event.data)) as { id?: number; error?: unknown; result?: unknown }
    if (typeof frame.id !== 'number') return
    const waiter = pending.get(frame.id)
    if (waiter === undefined) return
    pending.delete(frame.id)
    if (frame.error === undefined || frame.error === null) waiter.resolve(frame.result)
    else waiter.reject(new Error(JSON.stringify(frame.error)))
  })
  ws.addEventListener('close', () => {
    for (const [, waiter] of pending) waiter.reject(new Error('the debugging socket closed mid-command'))
    pending.clear()
  })

  return {
    send(method: string, params?: object) {
      seq += 1
      const id = seq
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        ws.send(JSON.stringify({ id, method, ...(params ?? {}) }))
      })
    },
    close() {
      pending.clear()
      ws.close()
    },
  }
}
