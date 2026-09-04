/**
 * Best-effort workspace grouping for sessions created through the browser
 * bridge. The wrapper changes only implicit `session.create` requests;
 * explicit workspace choices and every other gateway method pass through.
 * @module @yuxianglin/dsh-bridge-browser/src/session-workspace
 */

import { mkdir } from 'node:fs/promises'
import type { LegacyRpc } from './legacy-rpc.ts'

type Warn = (message: string) => void

/**
 * Add a dedicated Workspace to implicit session creation without making
 * grouping a session-creation dependency. The first implicit create mkdirs
 * and registers the configured path; that result, including failure, is
 * cached for the wrapper lifetime.
 *
 * @param api - Injected gateway API implementation.
 * @param workspacePath - Dedicated directory, or an empty string to opt out.
 * @param warn - Logger called once when grouping cannot be established.
 * @returns the original API for opt-out, otherwise an API with wrapped session creation.
 */
export function withSessionWorkspace(
  api: LegacyRpc,
  workspacePath: string,
  warn: Warn,
): LegacyRpc {
  if (workspacePath === '') return api

  let workspacePromise: Promise<string | undefined> | undefined
  const ensureWorkspace = (): Promise<string | undefined> => {
    if (workspacePromise !== undefined) return workspacePromise
    workspacePromise = (async () => {
      try {
        await mkdir(workspacePath, { recursive: true })
        const response = await api('workspace.create', { path: workspacePath }) as {
          workspace?: { workspaceId?: unknown }
        }
        if (typeof response.workspace?.workspaceId !== 'string') {
          throw new Error('workspace.create returned no workspaceId')
        }
        return response.workspace.workspaceId
      } catch (error: unknown) {
        warn(
          `browser bridge: could not prepare session workspace "${workspacePath}": `
          + `${String(error)}; sessions will remain ungrouped`,
        )
        return undefined
      }
    })()
    return workspacePromise
  }

  return async (method, payload, signal) => {
    if (method !== 'session.create') return api(method, payload, signal)
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      return api(method, payload, signal)
    }
    const request = payload as Record<string, unknown>
    if (request.workspaceId !== undefined) return api(method, payload, signal)
    const workspaceId = await ensureWorkspace()
    if (workspaceId === undefined) return api(method, payload, signal)
    const grouped: Record<string, unknown> = { ...request, workspaceId }
    delete grouped.cwd
    return api(method, grouped, signal)
  }
}
