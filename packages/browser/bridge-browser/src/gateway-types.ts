/**
 * Shared gateway abstractions for ApiProxy (rc) and Typert (Desktop alpha) hosts.
 * @module @yuxianglin/dsh-bridge-browser/src/gateway-types
 */

import type { ApiProxy, MuxFrame, RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api'

/** In-process Typert gateway surface used on Desktop alpha compositions. */
export interface TypertGatewayLike {
  invoke(request: {
    namespace: string
    method: string
    args: Readonly<Record<string, unknown>>
    signal?: AbortSignal
  }): Promise<unknown>
  wireStream: {
    open(endpoint: string, payload: unknown, signal: AbortSignal): Promise<AsyncIterable<unknown>>
  }
}

/** Everything the bridge server and session wrappers need from either gateway face. */
export interface BridgeGateway {
  api: ApiProxy
  apiHandler: { fetch: (request: Request) => Promise<Response> }
  openEvents: (signal: AbortSignal) => AsyncIterable<RpcRequest<MuxFrame>>
}
