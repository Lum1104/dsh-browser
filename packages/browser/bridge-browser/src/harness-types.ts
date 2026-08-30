/**
 * Local mirrors of the Host `sessionController` / `workspaceController` /
 * `settingsController` / `credentialsController` / `directoryPickerController`
 * business API shapes this plugin calls, plus the cordis module augmentation
 * that declares them.
 *
 * These packages (`@deepseek-ai/dsh-api-session-controller` and friends) are
 * deepseek-harness workspace-internal and have never been published to npm —
 * their own package manifests use pnpm's `workspace:` protocol for their peer
 * dependencies, which only resolves inside that monorepo's own pnpm
 * workspace. A `link:` dependency from this separate repo cannot satisfy
 * that, so their real types cannot be imported here. This file mirrors
 * exactly the fields the calls below use, verified against the harness
 * source (`packages/api/{session,workspace,settings}-controller`) at
 * migration time; keep it in sync by hand if those shapes change upstream.
 *
 * @module @yuxianglin/dsh-bridge-browser/src/harness-types
 */

import type { JsonValue, SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'

/**
 * `dsh-settings`/`dsh-credentials` are published, but only up to a version
 * that predates these describe/view shapes (added alongside the unpublished
 * `dsh-api-settings-controller`) — so these are local too, not re-exports.
 */
export interface SettingsSecretView {
  readonly path: readonly string[]
  readonly set: boolean
}

export interface SettingsNamespaceView {
  readonly ns: string
  readonly schema: JsonValue
  readonly value: JsonValue
  readonly base?: JsonValue
  readonly user?: JsonValue
  readonly applies: boolean
  readonly secrets: readonly SettingsSecretView[]
  readonly revision: number
}

export interface SettingsDescribeValue {
  readonly writable: boolean
  readonly hasDocument: boolean
  readonly namespaces: readonly SettingsNamespaceView[]
}

export interface CredentialInfo {
  readonly configured: boolean
  readonly source?: string
  readonly writable: boolean
}

/** One path-addressed settings edit. Field-level shape not independently verified; treated as opaque. */
export type SettingsPathOpView = unknown

export interface SessionCreateRequest {
  readonly workspaceId?: WorkspaceId
  readonly cwd?: string
  readonly sessionId?: SessionId
  readonly agentPreset?: string
}

export interface SessionCreateValue {
  readonly sessionId: SessionId
  readonly agentPreset?: string
}

export interface SessionPromptRequest {
  readonly requestId: string
  readonly sessionId: SessionId
  readonly mode: 'queue' | 'steer'
  readonly content: readonly unknown[]
  readonly clientTimeZone?: string
}

export interface SessionPromptValue {
  readonly accepted: true
}

export interface SessionCancelRequest {
  readonly sessionId: SessionId
}

export interface SessionCancelValue {
  readonly accepted: true
}

export interface SessionListRequest {
  readonly cursor?: string
}

export interface SessionSummary {
  readonly sessionId: SessionId
  readonly updatedAt: number
  readonly running: boolean
  readonly blank: boolean
}

export interface SessionListValue {
  readonly items: readonly SessionSummary[]
}

export interface SessionRenameRequest {
  readonly sessionId: SessionId
  readonly title: string
}

export interface SessionRenameValue {
  readonly title: string
  readonly seq: number
}

/** Durable identity selecting an ordinary Session or one direct subagent child. */
export type SessionAddress =
  | { readonly kind: 'session'; readonly sessionId: SessionId }
  | {
    readonly kind: 'subagent'
    readonly parentSessionId: SessionId
    readonly childSessionId: SessionId
    readonly mode: 'one-shot' | 'continuable'
  }

export interface SessionPageRequest {
  readonly address: SessionAddress
  readonly throughSeq: number
  readonly beforeSeq?: number
  readonly maxMessages?: number
}

export interface SessionPage {
  readonly records: readonly unknown[]
  readonly hasMore: boolean
}

export interface SessionOpenWorkspacePathRequest {
  readonly path: string
}

export interface SessionOpenWorkspacePathValue {
  readonly opened: true
}

export interface WorkspaceView {
  readonly workspaceId: WorkspaceId
  readonly path: string
  readonly title: string
  readonly sessionIds: readonly SessionId[]
  readonly createdAt: string
  readonly updatedAt: string
}

export interface WorkspaceCreateRequest {
  readonly path: string
}

export interface WorkspaceCreateValue {
  readonly workspace: WorkspaceView
  readonly created: boolean
}

export interface SettingsDocumentOpenValue {
  readonly opened: true
}

export interface SessionSelectModelRequest {
  readonly sessionId: SessionId
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

export interface SessionSelectModelValue {
  readonly selected: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string }
}

export interface SessionAttachmentRequest {
  readonly sessionId: SessionId
  readonly attachmentId: string
}

export interface SessionAttachmentValue {
  readonly attachment: unknown
  readonly data: string
}

export interface SessionFollowRequest {
  readonly address: SessionAddress
  readonly maxMessages?: number
}

export interface SessionProjectionBaseline {
  readonly asOfSeq: number
  readonly values: Record<string, unknown>
}

/** One raw or packed history record. Chunk-packed assistant delta runs are not modeled — treated as opaque. */
export type SessionHistoryRecord =
  | { readonly type: 'event'; readonly event: { readonly type: string; readonly seq: number; readonly time: number; readonly data: unknown } }
  | { readonly type: 'chunks'; readonly event: unknown }

export type SessionFollowFrame =
  | {
    readonly type: 'snapshot'
    readonly header: unknown
    readonly cursor: number
    readonly records: readonly SessionHistoryRecord[]
    readonly hasMore: boolean
    readonly projections: SessionProjectionBaseline
  }
  | { readonly type: 'event'; readonly event: unknown }

export interface WorkspaceArchiveSessionRequest {
  readonly sessionId: SessionId
}

export interface WorkspaceArchiveValue {
  readonly archivedSessionIds: readonly SessionId[]
}

export interface WorkspaceBaseline {
  readonly items: readonly WorkspaceView[]
  readonly archivedSessionIds: readonly SessionId[]
}

export type WorkspaceFollowFrame =
  | { readonly type: 'baseline'; readonly value: WorkspaceBaseline }
  | { readonly type: 'upsert'; readonly workspace: WorkspaceView }
  | { readonly type: 'remove'; readonly workspaceId: WorkspaceId }
  | { readonly type: 'order'; readonly workspaceIds: readonly WorkspaceId[] }
  | { readonly type: 'archived'; readonly archivedSessionIds: readonly SessionId[] }

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host Session business API and Remote namespace owner (`@deepseek-ai/dsh-api-session-controller`). */
    sessionController: {
      list(request: SessionListRequest, signal: AbortSignal): Promise<SessionListValue>
      create(request: SessionCreateRequest): Promise<SessionCreateValue>
      rename(request: SessionRenameRequest): Promise<SessionRenameValue>
      prompt(request: SessionPromptRequest, signal: AbortSignal): Promise<SessionPromptValue>
      cancel(request: SessionCancelRequest): Promise<SessionCancelValue> | SessionCancelValue
      page(request: SessionPageRequest, signal: AbortSignal): Promise<SessionPage>
      openWorkspacePath(request: SessionOpenWorkspacePathRequest, signal: AbortSignal): Promise<SessionOpenWorkspacePathValue>
      selectModel(request: SessionSelectModelRequest): Promise<SessionSelectModelValue>
      attachment(request: SessionAttachmentRequest): Promise<SessionAttachmentValue>
      follow(request: SessionFollowRequest, signal: AbortSignal): AsyncIterable<SessionFollowFrame>
    }
    /** Host Workspace business API and Remote namespace owner (`@deepseek-ai/dsh-api-workspace-controller`). */
    workspaceController: {
      create(request: WorkspaceCreateRequest): Promise<WorkspaceCreateValue>
      archiveSession(request: WorkspaceArchiveSessionRequest): Promise<WorkspaceArchiveValue>
      follow(signal: AbortSignal): AsyncIterable<WorkspaceFollowFrame>
    }
    /** Host `settings` Remote namespace owner (`@deepseek-ai/dsh-api-settings-controller`). */
    settingsController: {
      describe(): SettingsDescribeValue
      update(ns: string, patch: Record<string, JsonValue>, expectedRevision: number | undefined): Promise<SettingsNamespaceView>
      replace(ns: string, section: Record<string, JsonValue>, expectedRevision: number | undefined): Promise<SettingsNamespaceView>
      mutate(ns: string, ops: SettingsPathOpView[], expectedRevision: number | undefined): Promise<SettingsNamespaceView>
      openSettingsDocument(signal: AbortSignal): Promise<SettingsDocumentOpenValue>
    }
    /** Host `credentials` Remote namespace owner (`@deepseek-ai/dsh-api-settings-controller`). */
    credentialsController: {
      describe(refs: string[]): Promise<Record<string, CredentialInfo>>
      set(ref: string, value: string): Promise<void>
      unset(ref: string): Promise<void>
    }
    /** Host directory-picking Remote namespace owner (`@deepseek-ai/dsh-api-workspace-controller`). */
    directoryPickerController: {
      pick(signal: AbortSignal): Promise<string | null>
    }
  }
}
