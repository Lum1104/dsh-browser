/** Browser-extension RPC types retained while the Host uses Typert Remote. */

/** One business-level RPC call from the extension compatibility layer. */
export type LegacyRpc = (
  method: string,
  payload: unknown,
  signal?: AbortSignal,
) => Promise<unknown>

/** One event envelope consumed by the existing extension wire. */
export interface LegacyEventEnvelope {
  readonly rpcId: string
  readonly payload: Readonly<Record<string, unknown>> & { readonly type: string }
}

/** Stable business failure carried through the legacy response envelope. */
export class LegacyRpcError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: unknown = {},
  ) {
    super(message)
    this.name = 'LegacyRpcError'
  }
}
