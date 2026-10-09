/** Shared panel/background contract for browser action approval. */

export type ApprovalKind = 'read' | 'action'
export type ApprovalDecision = 'deny' | 'allow-once' | 'always-allow-reads' | 'trust-session' | 'trust-origin' | 'trust-dev-tools'
/** Background authorization result; transport failures must not masquerade as a user decision. */
export type ApprovalAuthorization = 'approved' | 'denied' | 'unavailable' | 'timed-out' | 'cancelled'

/** A policy decision awaiting a user response. */
export interface ApprovalPrompt {
  kind: ApprovalKind
  action: string
  summary: string
  origins: string[]
  /** True only when one stable origin can safely be added to the action allowlist. */
  canTrust: boolean
  /**
   * Marks the high-privilege developer-tools group: the panel renders it as its
   * own consent surface and the background never satisfies it from the origin
   * allowlist or unrestricted access.
   */
  devTools?: true
}

/** Correlated request delivered to every open side-panel view. */
export interface ApprovalRequest extends ApprovalPrompt {
  id: string
  /** Agent session that requested the browser operation, when known. */
  sessionId?: string
}

export function isApprovalDecision(value: unknown): value is ApprovalDecision {
  return value === 'deny'
    || value === 'allow-once'
    || value === 'always-allow-reads'
    || value === 'trust-session'
    || value === 'trust-origin'
    || value === 'trust-dev-tools'
}
