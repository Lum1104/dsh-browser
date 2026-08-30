/**
 * Best-effort workspace grouping for sessions created through the browser
 * bridge. The wrapper changes only implicit `session.create` requests;
 * explicit workspace choices and every other gateway method pass through.
 * @module @yuxianglin/dsh-bridge-browser/src/session-workspace
 */

import { mkdir } from 'node:fs/promises'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { BridgeSessionApi } from './session-api.ts'
import type { WorkspaceCreator } from './workspace-api.ts'

export type { WorkspaceCreator } from './workspace-api.ts'

type Warn = (message: string) => void

/**
 * Add a dedicated Workspace to implicit session creation without making
 * grouping a session-creation dependency. The first implicit create mkdirs
 * and registers the configured path; that result, including failure, is
 * cached for the wrapper lifetime.
 *
 * @param api - Injected session-call surface.
 * @param workspaceController - Injected `workspaceController` surface.
 * @param workspacePath - Dedicated directory, or an empty string to opt out.
 * @param warn - Logger called once when grouping cannot be established.
 * @returns the original API for opt-out, otherwise an API with wrapped session creation.
 */
export function withSessionWorkspace(
  api: BridgeSessionApi,
  workspaceController: WorkspaceCreator,
  workspacePath: string,
  warn: Warn,
): BridgeSessionApi {
  if (workspacePath === '') return api

  let workspacePromise: Promise<WorkspaceId | undefined> | undefined
  const ensureWorkspace = (): Promise<WorkspaceId | undefined> => {
    if (workspacePromise !== undefined) return workspacePromise
    workspacePromise = (async () => {
      try {
        await mkdir(workspacePath, { recursive: true })
        const response = await workspaceController.create({ path: workspacePath })
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

  return {
    ...api,
    async create(request) {
      if (request.workspaceId !== undefined) return api.create(request)
      const workspaceId = await ensureWorkspace()
      if (workspaceId === undefined) return api.create(request)
      return api.create({
        workspaceId,
        ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
        ...(request.agentPreset === undefined ? {} : { agentPreset: request.agentPreset }),
      })
    },
  }
}
