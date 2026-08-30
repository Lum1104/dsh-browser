/**
 * Test-only adapter: wraps the still-published `@deepseek-ai/dsh-host-apiproxy`
 * gateway (real session/workspace business logic over the minimal spine —
 * `sessions`, `agents`, `workspaceRegistry`) behind the plain-call,
 * thrown-failure `sessionController`/`workspaceController` contract this
 * plugin now expects.
 *
 * Production code never imports `dsh-host-apiproxy` (it's gone from the
 * harness); this shim exists only so integration tests can drive a real
 * session store without reimplementing `dsh-api-session-controller`'s
 * business logic from scratch — that package is deepseek-harness
 * workspace-internal and cannot be installed from this separate repo (see
 * `src/harness-types.ts`).
 *
 * @module
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { createApiProxy, RpcId } from '@deepseek-ai/dsh-host-apiproxy'
import type { ApiProxyDefaults } from '@deepseek-ai/dsh-host-apiproxy'
import type { RpcResponse } from '@deepseek-ai/dsh-host-apiproxy/api'
import type {} from '../../src/harness-types.ts'

function remoteFailure(error: { code: string; message: string }): Error {
  return Object.assign(new Error(error.message), { failure: { code: error.code, message: error.message } })
}

async function unwrap<T>(response: Promise<RpcResponse<T>>): Promise<T> {
  const { result } = await response
  if (!result.ok) throw remoteFailure(result.error)
  return result.value
}

/** Build the new-shaped `sessionController`/`workspaceController` services over a real `createApiProxy` gateway. */
export function apiProxyControllers(ctx: Context, defaults: ApiProxyDefaults): {
  sessionController: Context['sessionController']
  workspaceController: Context['workspaceController']
} {
  const api = createApiProxy(ctx, defaults)
  return {
    sessionController: {
      list: request => unwrap(api.sessions.list({ rpcId: RpcId(randomUUID()), payload: request })),
      create: request => unwrap(api.sessions.create({ rpcId: RpcId(randomUUID()), payload: request })),
      rename: request => unwrap(api.sessions.rename({ rpcId: RpcId(randomUUID()), payload: request })),
      prompt: request => unwrap(api.sessions.prompt({ rpcId: RpcId(randomUUID()), payload: request })),
      cancel: request => unwrap(api.sessions.cancel({ rpcId: RpcId(randomUUID()), payload: request })),
      page: () => { throw remoteFailure({ code: 'not-implemented', message: 'page/history is not exercised by this test fixture' }) },
      openWorkspacePath: () => { throw remoteFailure({ code: 'not-implemented', message: 'openWorkspacePath is not exercised by this test fixture' }) },
    },
    workspaceController: {
      create: request => unwrap(api.workspace.create({ rpcId: RpcId(randomUUID()), payload: request })),
    },
  }
}
