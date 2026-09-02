/**
 * Resolve ApiProxy (rc) or Typert (Desktop alpha) gateway access for the bridge.
 * @module @yuxianglin/dsh-bridge-browser/src/gateway-access
 */

import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy/api'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api'
import { toFetchHandler } from '@deepseek-ai/dsh-host-apiproxy'
import type { BridgeGateway, TypertGatewayLike } from './gateway-types.ts'
import { createTypertApiProxy, createTypertFetchHandler } from './typert-api-proxy.ts'

/** Mutable connection probe shared with the Typert mux while the server boots. */
export interface BridgeConnectionProbe {
  hasConnection(): boolean
}

function readApiProxy(ctx: Context): ApiProxy | undefined {
  const candidate = ctx.get('apiProxy')
  return candidate as ApiProxy | undefined
}

function readTypertGateway(ctx: Context): TypertGatewayLike | undefined {
  const candidate = ctx.get('typertGateway')
  if (candidate === undefined) return undefined
  const gateway = candidate as TypertGatewayLike
  if (typeof gateway.invoke !== 'function' || typeof gateway.wireStream?.open !== 'function') {
    return undefined
  }
  return gateway
}

/** Wait until either ApiProxy or TypertGateway is available in the composition. */
export function waitForGateway(ctx: Context): Promise<'apiProxy' | 'typertGateway'> {
  const existing = readApiProxy(ctx) !== undefined
    ? 'apiProxy'
    : readTypertGateway(ctx) !== undefined
      ? 'typertGateway'
      : undefined
  if (existing !== undefined) return Promise.resolve(existing)

  return new Promise((resolve) => {
    const dispose = ctx.on('internal/service', () => {
      if (readApiProxy(ctx) !== undefined) {
        dispose()
        resolve('apiProxy')
        return
      }
      if (readTypertGateway(ctx) !== undefined) {
        dispose()
        resolve('typertGateway')
      }
    })
  })
}

/** Build bridge gateway dependencies from whichever host face is composed. */
export async function resolveBridgeGateway(
  ctx: Context,
  connection: BridgeConnectionProbe,
): Promise<BridgeGateway> {
  const kind = await waitForGateway(ctx)
  if (kind === 'apiProxy') {
    const api = readApiProxy(ctx)!
    return {
      api,
      apiHandler: toFetchHandler(api),
      openEvents: (signal) => api.events.mux({ rpcId: RpcId(randomUUID()), payload: {} }, signal),
    }
  }

  const gateway = readTypertGateway(ctx)!
  const api = createTypertApiProxy(ctx, gateway, connection)
  return {
    api,
    apiHandler: createTypertFetchHandler(api),
    openEvents: (signal) => api.events.mux({ rpcId: RpcId(randomUUID()), payload: {} }, signal),
  }
}
