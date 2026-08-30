/**
 * The subset of the Host `sessionController` business API the browser bridge
 * calls, isolated so the workspace/deferral wrappers depend on plain typed
 * methods instead of the full `SessionController` class or its Remote
 * decoration.
 * @module @yuxianglin/dsh-bridge-browser/src/session-api
 */

import type { Context } from '@deepseek-ai/cordis'
import type {
  SessionAttachmentRequest,
  SessionAttachmentValue,
  SessionCancelRequest,
  SessionCancelValue,
  SessionCreateRequest,
  SessionCreateValue,
  SessionFollowFrame,
  SessionFollowRequest,
  SessionListRequest,
  SessionListValue,
  SessionOpenWorkspacePathRequest,
  SessionOpenWorkspacePathValue,
  SessionPage,
  SessionPageRequest,
  SessionPromptRequest,
  SessionPromptValue,
  SessionRenameRequest,
  SessionRenameValue,
  SessionSelectModelRequest,
  SessionSelectModelValue,
} from './harness-types.ts'

/** The `sessionController` surface the bridge needs. Methods resolve on success and throw a business failure shaped like `{ failure: { code, message } }` on business error. */
export interface BridgeSessionApi {
  create(request: SessionCreateRequest): Promise<SessionCreateValue>
  prompt(request: SessionPromptRequest, signal: AbortSignal): Promise<SessionPromptValue>
  cancel(request: SessionCancelRequest): Promise<SessionCancelValue> | SessionCancelValue
  list(request: SessionListRequest, signal: AbortSignal): Promise<SessionListValue>
  rename(request: SessionRenameRequest): Promise<SessionRenameValue>
  page(request: SessionPageRequest, signal: AbortSignal): Promise<SessionPage>
  openWorkspacePath(request: SessionOpenWorkspacePathRequest, signal: AbortSignal): Promise<SessionOpenWorkspacePathValue>
  selectModel(request: SessionSelectModelRequest): Promise<SessionSelectModelValue>
  attachment(request: SessionAttachmentRequest): Promise<SessionAttachmentValue>
  follow(request: SessionFollowRequest, signal: AbortSignal): AsyncIterable<SessionFollowFrame>
}

/**
 * Bind the injected `sessionController` service into a {@link BridgeSessionApi}.
 * @param ctx - cordis context with `sessionController` injected.
 * @returns the typed session-call surface used throughout the plugin.
 */
export function createSessionApi(ctx: Context): BridgeSessionApi {
  return {
    create: request => ctx.sessionController.create(request),
    prompt: (request, signal) => ctx.sessionController.prompt(request, signal),
    cancel: request => ctx.sessionController.cancel(request),
    list: (request, signal) => ctx.sessionController.list(request, signal),
    rename: request => ctx.sessionController.rename(request),
    page: (request, signal) => ctx.sessionController.page(request, signal),
    openWorkspacePath: (request, signal) => ctx.sessionController.openWorkspacePath(request, signal),
    selectModel: request => ctx.sessionController.selectModel(request),
    attachment: request => ctx.sessionController.attachment(request),
    follow: (request, signal) => ctx.sessionController.follow(request, signal),
  }
}
