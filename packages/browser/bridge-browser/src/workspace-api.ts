/**
 * The subset of the Host `workspaceController` business API the browser
 * bridge calls. `list` has no unary Remote method anymore — it's synthesized
 * here from the first baseline frame of `follow`.
 * @module @yuxianglin/dsh-bridge-browser/src/workspace-api
 */

import type { Context } from '@deepseek-ai/cordis'
import type {
  WorkspaceArchiveSessionRequest,
  WorkspaceArchiveValue,
  WorkspaceBaseline,
  WorkspaceCreateValue,
} from './harness-types.ts'

/** The `workspaceController` surface this wrapper needs. */
export interface WorkspaceCreator {
  create(request: { path: string }): Promise<WorkspaceCreateValue>
}

/** The full `workspaceController` surface the bridge needs. */
export interface BridgeWorkspaceApi extends WorkspaceCreator {
  archiveSession(request: WorkspaceArchiveSessionRequest): Promise<WorkspaceArchiveValue>
  list(signal: AbortSignal): Promise<WorkspaceBaseline>
}

/**
 * Bind the injected `workspaceController` service into a {@link BridgeWorkspaceApi}.
 * @param ctx - cordis context with `workspaceController` injected.
 * @returns the typed workspace-call surface used throughout the plugin.
 */
export function createWorkspaceApi(ctx: Context): BridgeWorkspaceApi {
  return {
    create: request => ctx.workspaceController.create(request),
    archiveSession: request => ctx.workspaceController.archiveSession(request),
    async list(signal) {
      const iterator = ctx.workspaceController.follow(signal)[Symbol.asyncIterator]()
      const first = await iterator.next()
      if (first.done || first.value.type !== 'baseline') {
        throw new Error('workspace follow stream produced no opening baseline')
      }
      await iterator.return?.()
      return first.value.value
    },
  }
}
