import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { BridgeServer, BridgeToolError, isLoopbackAddress, messageToText, payloadCode, payloadMessage } from '../src/server.ts'
import type { BridgeSessionApi } from '../src/session-api.ts'
import type { BridgeWorkspaceApi } from '../src/workspace-api.ts'
import type { BridgeCredentialsApi, BridgeDirectoryPickerApi, BridgeSettingsApi } from '../src/privileged-api.ts'
import type { BridgeLlmApi } from '../src/llm-api.ts'
import type { SessionEventEnvelope } from '../src/session-events.ts'
import { BRIDGE_INJECT_BROWSER_SNAPSHOT_METHOD, BRIDGE_SESSION_PURGE_METHOD, type BridgeFrame } from '../src/protocol.ts'
import { SessionPurgeError } from '../src/session-purge.ts'

const TOKEN = 'deadbeefdeadbeefdeadbeefdeadbeef'

/** 扩展上下文的 Origin（回环免 token 的必要条件）。 */
const EXT_ORIGIN = 'chrome-extension://test-extension-id'
const FIREFOX_EXT_ORIGIN = 'moz-extension://per-install-uuid'

/** Extension caps used by every hello in this suite. */
const CAPS = { textOnly: true as const, snapshotMaxChars: 12_000, maxInteractiveItems: 60 }

/** One-frame follow stream yielding a fixed snapshot, for `session.history` tests. */
function snapshotFollow(): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      yield {
        type: 'snapshot',
        header: {},
        cursor: 3,
        records: [
          { type: 'event', event: { type: 'user/message', seq: 1, time: 0, data: {} } },
          { type: 'chunks', event: { type: 'chunkrow/assistant', seq: 2, time: 0, data: {} } },
        ],
        hasMore: false,
        projections: { asOfSeq: 3, values: {} },
      }
    },
  }
}

function defaultSessionApi(): BridgeSessionApi {
  return {
    create: vi.fn(async () => ({ sessionId: 'session-created' })),
    prompt: vi.fn(async () => ({ accepted: true as const })),
    cancel: vi.fn(async () => ({ accepted: true as const })),
    list: vi.fn(async () => ({ items: [] })),
    rename: vi.fn(async () => ({ title: 't', seq: 0 })),
    page: vi.fn(async () => ({ records: [], hasMore: false })),
    openWorkspacePath: vi.fn(async () => ({ opened: true as const })),
    selectModel: vi.fn(async () => ({ selected: { provider: 'p', model: 'm' } })),
    attachment: vi.fn(async () => ({ attachment: {}, data: 'base64' })),
    follow: vi.fn(() => snapshotFollow()),
  } as unknown as BridgeSessionApi
}

function defaultWorkspaceApi(): BridgeWorkspaceApi {
  return {
    create: vi.fn(async () => ({ workspace: {}, created: true } as never)),
    archiveSession: vi.fn(async () => ({ archivedSessionIds: ['session-1'] })),
    list: vi.fn(async () => ({ items: [], archivedSessionIds: ['session-1'] })),
  } as unknown as BridgeWorkspaceApi
}

function defaultLlmApi(): BridgeLlmApi {
  return { discoverModels: vi.fn(async () => [{ id: 'gpt-x' }]) }
}

function defaultSettingsApi(): BridgeSettingsApi {
  return {
    describe: vi.fn(() => ({ writable: true, hasDocument: false, namespaces: [] })),
    update: vi.fn(async () => ({} as never)),
    replace: vi.fn(async () => ({} as never)),
    mutate: vi.fn(async () => ({} as never)),
    openSettingsDocument: vi.fn(async () => ({ opened: true as const })),
  } as unknown as BridgeSettingsApi
}

function defaultCredentialsApi(): BridgeCredentialsApi {
  return {
    describe: vi.fn(async () => ({})),
    set: vi.fn(async () => {}),
    unset: vi.fn(async () => {}),
  }
}

function defaultDirectoryPickerApi(): BridgeDirectoryPickerApi {
  return { pick: vi.fn(async () => null) }
}

function defaultSessionEvents(): AsyncIterable<SessionEventEnvelope> {
  return {
    async *[Symbol.asyncIterator]() {
      yield { rpcId: 'e1', method: 'session/subscribed', payload: { sessionId: 's1' } }
      yield { rpcId: 'e2', method: 'session/queue', payload: { sessionId: 's1', items: [] } }
    },
  }
}

interface Harness {
  bridge: BridgeServer
  server: Server
  url: string
  sessionApi: BridgeSessionApi
  settingsApi: BridgeSettingsApi
  workspaceApi: BridgeWorkspaceApi
  llmApi: BridgeLlmApi
}

async function startBridge(overrides: Partial<ConstructorParameters<typeof BridgeServer>[0]> = {}): Promise<Harness> {
  const sessionApi = overrides.sessionApi ?? defaultSessionApi()
  const settingsApi = overrides.settingsApi ?? defaultSettingsApi()
  const workspaceApi = overrides.workspaceApi ?? defaultWorkspaceApi()
  const llmApi = overrides.llmApi ?? defaultLlmApi()
  const bridge = new BridgeServer({
    token: TOKEN,
    sessionApi,
    settingsApi,
    workspaceApi,
    llmApi,
    credentialsApi: defaultCredentialsApi(),
    directoryPickerApi: defaultDirectoryPickerApi(),
    openSessionEvents: () => defaultSessionEvents(),
    toolTimeoutMs: 1_000,
    caps: { textOnly: true, snapshotMaxChars: 12_000, maxInteractiveItems: 60 },
    injectBrowserSnapshot: vi.fn(),
    purgeSession: vi.fn(async () => {}),
    ...overrides,
  })
  const server = createServer()
  server.on('upgrade', (req, socket, head) => { bridge.handleUpgrade(req, socket, head) })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const port = (server.address() as AddressInfo).port
  return { bridge, server, url: `ws://127.0.0.1:${port}/ext/bridge`, sessionApi, settingsApi, workspaceApi, llmApi }
}

function connect(url: string, origin?: string): Promise<{ ws: WebSocket; frames: BridgeFrame[]; done: Promise<void> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, origin !== undefined ? { headers: { origin } } : undefined)
    const frames: BridgeFrame[] = []
    ws.on('message', (data) => { frames.push(JSON.parse(data.toString()) as BridgeFrame) })
    ws.on('error', reject)
    ws.on('open', () => {
      resolve({
        ws,
        frames,
        done: new Promise<void>((doneResolve) => {
          ws.on('close', () => { doneResolve() })
        }),
      })
    })
  })
}

function send(ws: WebSocket, frame: BridgeFrame): void {
  ws.send(JSON.stringify(frame))
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((resolve) => { setTimeout(resolve, 10) })
  }
}

const harnesses: Harness[] = []
afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    await h.bridge.close()
    await new Promise<void>((resolve) => { h.server.close(() => resolve()) })
  }
})

describe('BridgeServer', () => {
  it('decodes every ws message delivery shape', () => {
    expect(messageToText([Buffer.from('a'), Buffer.from('b')])).toBe('ab')
    expect(messageToText(Buffer.from('hi'))).toBe('hi')
    expect(messageToText(new TextEncoder().encode('x').buffer)).toBe('x')
  })

  it('extracts tool error codes and messages with parser-gated fallbacks', () => {
    expect(payloadCode({ code: 'timeout', message: 'm' })).toBe('timeout')
    expect(payloadCode({ code: 42, message: 'm' })).toBe('internal')
    expect(payloadCode('garbage')).toBe('internal')
    expect(payloadCode(null)).toBe('internal')
    expect(payloadMessage({ code: 'x', message: 'm' })).toBe('m')
    expect(payloadMessage({ code: 'x', message: '' })).toBe('browser action failed')
    expect(payloadMessage({ code: 'x', message: 42 })).toBe('browser action failed')
    expect(payloadMessage('garbage')).toBe('browser action failed')
  })

  it('authenticates a valid hello and acknowledges caps', async () => {
    const h = await startBridge()
    harnesses.push(h)
    const { ws, frames } = await connect(h.url)
    send(ws, { t: 'hello', token: TOKEN, caps: { textOnly: true, snapshotMaxChars: 12000, maxInteractiveItems: 60 } })
    await waitFor(() => frames.some((f) => f.t === 'hello.ok'))
    expect(frames.find((f) => f.t === 'hello.ok')).toEqual({ t: 'hello.ok', caps: { textOnly: true, snapshotMaxChars: 12000, maxInteractiveItems: 60 } })
    ws.close()
  })

  it('accepts loopback connections without a token when Origin is an extension (zero-config mode)', async () => {
    const h = await startBridge()
    harnesses.push(h)
    const { ws, frames } = await connect(h.url, EXT_ORIGIN)
    send(ws, { t: 'hello', token: '', caps: CAPS })
    await waitFor(() => frames.some((f) => f.t === 'hello.ok'))
    expect(frames.find((f) => f.t === 'hello.ok')).toBeDefined()
    ws.close()
  })

  it('requires a token from Firefox extension origins because their UUID is not an extension identity', async () => {
    const h = await startBridge()
    harnesses.push(h)
    const { ws, done } = await connect(h.url, FIREFOX_EXT_ORIGIN)
    send(ws, { t: 'hello', token: '', caps: CAPS })
    await done
    expect(ws.readyState).toBe(WebSocket.CLOSED)
  })

  it('accepts an authenticated Firefox extension origin', async () => {
    const h = await startBridge()
    harnesses.push(h)
    const { ws, frames } = await connect(h.url, FIREFOX_EXT_ORIGIN)
    send(ws, { t: 'hello', token: TOKEN, caps: CAPS })
    await waitFor(() => frames.some((f) => f.t === 'hello.ok'))
    expect(frames.find((f) => f.t === 'hello.ok')).toBeDefined()
    ws.close()
  })

  it('rejects loopback connections without a token when Origin is not an extension (malicious page)', async () => {
    const h = await startBridge()
    harnesses.push(h)
    const { ws, done } = await connect(h.url, 'https://evil.example')
    send(ws, { t: 'hello', token: '', caps: CAPS })
    await done
    expect(ws.readyState).toBe(WebSocket.CLOSED)
  })

  it('rejects loopback connections without a token and without any Origin', async () => {
    const h = await startBridge()
    harnesses.push(h)
    const { ws, done } = await connect(h.url)
    send(ws, { t: 'hello', token: '', caps: CAPS })
    await done
    expect(ws.readyState).toBe(WebSocket.CLOSED)
  })

  it('still requires the token from non-loopback remotes', async () => {
    const h = await startBridge({ remoteAddressOverride: '192.168.1.5' })
    harnesses.push(h)
    const { ws, done } = await connect(h.url)
    send(ws, { t: 'hello', token: '', caps: CAPS })
    await done
    expect(ws.readyState).toBe(WebSocket.CLOSED)
  })

  it('closes sockets that never present hello', async () => {
    const h = await startBridge({ helloTimeoutMs: 500 })
    harnesses.push(h)
    const { ws, done } = await connect(h.url)
    await done
    expect(ws.readyState).toBe(WebSocket.CLOSED)
  })

  it('rejects frames before hello', async () => {
    const h = await startBridge()
    harnesses.push(h)
    const { ws, done } = await connect(h.url)
    send(ws, { t: 'pong' })
    await done
    expect(ws.readyState).toBe(WebSocket.CLOSED)
  })

  it('dispatches rpc frames directly to the injected sessionController surface', async () => {
    const h = await startBridge()
    harnesses.push(h)
    const { ws, frames } = await connect(h.url)
    send(ws, { t: 'hello', token: TOKEN, caps: { textOnly: true, snapshotMaxChars: 12000, maxInteractiveItems: 60 } })
    await waitFor(() => frames.some((f) => f.t === 'hello.ok'))
    send(ws, { t: 'rpc', id: 'rpc-1', method: 'session.list', payload: {} })
    await waitFor(() => frames.some((f) => f.t === 'rpc.result'))
    const result = frames.find((f) => f.t === 'rpc.result')
    expect(result).toEqual({ t: 'rpc.result', id: 'rpc-1', ok: true, result: { items: [] } })
    expect(h.sessionApi.list).toHaveBeenCalledTimes(1)
    ws.close()
  })

  it('reports a thrown Host business failure (shaped like TypertRemoteFailure) as an rpc.result error carrying its code', async () => {
    const sessionApi = defaultSessionApi()
    vi.mocked(sessionApi.list).mockRejectedValueOnce(
      Object.assign(new Error('listing failed'), { failure: { code: 'internal', message: 'listing failed' } }),
    )
    const h = await startBridge({ sessionApi })
    harnesses.push(h)
    const { ws, frames } = await connect(h.url)
    send(ws, { t: 'hello', token: TOKEN, caps: { textOnly: true, snapshotMaxChars: 12000, maxInteractiveItems: 60 } })
    await waitFor(() => frames.some((f) => f.t === 'hello.ok'))
    send(ws, { t: 'rpc', id: 'rpc-2', method: 'session.list', payload: {} })
    await waitFor(() => frames.some((f) => f.t === 'rpc.result' && f.id === 'rpc-2'))
    expect(frames.find((f) => f.t === 'rpc.result' && f.id === 'rpc-2'))
      .toEqual({ t: 'rpc.result', id: 'rpc-2', ok: false, error: { code: 'internal', message: 'listing failed' } })
    ws.close()
  })

  it('dispatches session.selectModel, session.attachment, workspace.archiveSession, and llm.discoverModels', async () => {
    const h = await startBridge()
    harnesses.push(h)
    const { ws, frames } = await connect(h.url)
    send(ws, { t: 'hello', token: TOKEN, caps: CAPS })
    await waitFor(() => frames.some((f) => f.t === 'hello.ok'))

    send(ws, { t: 'rpc', id: 'select', method: 'session.selectModel', payload: { sessionId: 's1', provider: 'p', model: 'm' } })
    await waitFor(() => frames.some((f) => f.t === 'rpc.result' && f.id === 'select'))
    expect(h.sessionApi.selectModel).toHaveBeenCalledWith({ sessionId: 's1', provider: 'p', model: 'm' })

    send(ws, { t: 'rpc', id: 'attach', method: 'session.attachment', payload: { sessionId: 's1', attachmentId: 'a1' } })
    await waitFor(() => frames.some((f) => f.t === 'rpc.result' && f.id === 'attach'))
    expect(h.sessionApi.attachment).toHaveBeenCalledWith({ sessionId: 's1', attachmentId: 'a1' })

    send(ws, { t: 'rpc', id: 'archive', method: 'workspace.archiveSession', payload: { sessionId: 's1' } })
    await waitFor(() => frames.some((f) => f.t === 'rpc.result' && f.id === 'archive'))
    expect(frames.find((f) => f.t === 'rpc.result' && f.id === 'archive'))
      .toEqual({ t: 'rpc.result', id: 'archive', ok: true, result: { archivedSessionIds: ['session-1'] } })

    send(ws, { t: 'rpc', id: 'workspaces', method: 'workspace.list', payload: {} })
    await waitFor(() => frames.some((f) => f.t === 'rpc.result' && f.id === 'workspaces'))
    expect(frames.find((f) => f.t === 'rpc.result' && f.id === 'workspaces'))
      .toEqual({ t: 'rpc.result', id: 'workspaces', ok: true, result: { items: [], archivedSessionIds: ['session-1'] } })

    send(ws, {
      t: 'rpc',
      id: 'discover',
      method: 'llm.discoverModels',
      payload: { settingsNs: 'llm-pi-ai', provider: 'openai', baseURL: 'https://x' },
    })
    await waitFor(() => frames.some((f) => f.t === 'rpc.result' && f.id === 'discover'))
    expect(frames.find((f) => f.t === 'rpc.result' && f.id === 'discover'))
      .toEqual({ t: 'rpc.result', id: 'discover', ok: true, result: { models: [{ id: 'gpt-x' }] } })
    expect(h.llmApi.discoverModels).toHaveBeenCalledWith(
      'llm-pi-ai',
      expect.objectContaining({ provider: 'openai', baseURL: 'https://x' }),
    )
    ws.close()
  })

  it('dispatches session.history from the follow snapshot, dropping packed chunk runs', async () => {
    const h = await startBridge()
    harnesses.push(h)
    const { ws, frames } = await connect(h.url)
    send(ws, { t: 'hello', token: TOKEN, caps: CAPS })
    await waitFor(() => frames.some((f) => f.t === 'hello.ok'))
    send(ws, { t: 'rpc', id: 'history', method: 'session.history', payload: { sessionId: 's1' } })
    await waitFor(() => frames.some((f) => f.t === 'rpc.result' && f.id === 'history'))
    const result = frames.find((f) => f.t === 'rpc.result' && f.id === 'history')
    expect(result).toEqual({
      t: 'rpc.result',
      id: 'history',
      ok: true,
      result: {
        events: [{ event: { type: 'user/message', seq: 1, time: 0, data: {} } }],
        projections: { asOfSeq: 3, values: {} },
      },
    })
    ws.close()
  })

  it('rejects an unknown rpc method without calling any injected service', async () => {
    const h = await startBridge()
    harnesses.push(h)
    const { ws, frames } = await connect(h.url)
    send(ws, { t: 'hello', token: TOKEN, caps: CAPS })
    await waitFor(() => frames.some((f) => f.t === 'hello.ok'))
    send(ws, { t: 'rpc', id: 'rpc-unknown', method: 'session.export', payload: {} })
    await waitFor(() => frames.some((f) => f.t === 'rpc.result' && f.id === 'rpc-unknown'))
    expect(frames.find((f) => f.t === 'rpc.result' && f.id === 'rpc-unknown'))
      .toMatchObject({ t: 'rpc.result', id: 'rpc-unknown', ok: false, error: { code: 'not-found' } })
    ws.close()
  })

  it('rejects malformed payloads for a known method as bad-request', async () => {
    const h = await startBridge()
    harnesses.push(h)
    const { ws, frames } = await connect(h.url)
    send(ws, { t: 'hello', token: TOKEN, caps: CAPS })
    await waitFor(() => frames.some((f) => f.t === 'hello.ok'))
    send(ws, { t: 'rpc', id: 'rpc-bad', method: 'session.rename', payload: { sessionId: '' } })
    await waitFor(() => frames.some((f) => f.t === 'rpc.result' && f.id === 'rpc-bad'))
    expect(frames.find((f) => f.t === 'rpc.result' && f.id === 'rpc-bad'))
      .toMatchObject({ t: 'rpc.result', id: 'rpc-bad', ok: false, error: { code: 'bad-request' } })
    expect(h.sessionApi.rename).not.toHaveBeenCalled()
    ws.close()
  })

  it('injects followed-page snapshots without dispatching the internal RPC as a session call', async () => {
    const injectBrowserSnapshot = vi.fn()
    const h = await startBridge({ injectBrowserSnapshot })
    harnesses.push(h)
    const { ws, frames } = await connect(h.url)
    send(ws, { t: 'hello', token: TOKEN, caps: CAPS })
    await waitFor(() => frames.some((frame) => frame.t === 'hello.ok'))

    send(ws, {
      t: 'rpc',
      id: 'snapshot-1',
      method: BRIDGE_INJECT_BROWSER_SNAPSHOT_METHOD,
      payload: { sessionId: 'session-1', snapshot: 'Page: Other target' },
    })
    await waitFor(() => frames.some((frame) => frame.t === 'rpc.result' && frame.id === 'snapshot-1'))

    expect(injectBrowserSnapshot).toHaveBeenCalledWith('session-1', 'Page: Other target')
    expect(frames).toContainEqual({
      t: 'rpc.result', id: 'snapshot-1', ok: true, result: { accepted: true },
    })

    send(ws, {
      t: 'rpc',
      id: 'snapshot-invalid',
      method: BRIDGE_INJECT_BROWSER_SNAPSHOT_METHOD,
      payload: { sessionId: '', snapshot: '' },
    })
    await waitFor(() => frames.some((frame) => frame.t === 'rpc.result' && frame.id === 'snapshot-invalid'))
    expect(frames).toContainEqual(expect.objectContaining({
      t: 'rpc.result', id: 'snapshot-invalid', ok: false, error: expect.objectContaining({ code: 'bad-request' }),
    }))
    ws.close()
  })

  it('purges sessions through the internal RPC without dispatching it as a session call', async () => {
    const purgeSession = vi.fn(async () => {})
    const h = await startBridge({ purgeSession })
    harnesses.push(h)
    const { ws, frames } = await connect(h.url)
    send(ws, { t: 'hello', token: TOKEN, caps: CAPS })
    await waitFor(() => frames.some((frame) => frame.t === 'hello.ok'))

    send(ws, {
      t: 'rpc',
      id: 'purge-1',
      method: BRIDGE_SESSION_PURGE_METHOD,
      payload: { sessionId: 'session-82222a77-aab5-4c0b-b33e-6376973ec93d' },
    })
    await waitFor(() => frames.some((frame) => frame.t === 'rpc.result' && frame.id === 'purge-1'))

    expect(purgeSession).toHaveBeenCalledWith('session-82222a77-aab5-4c0b-b33e-6376973ec93d')
    expect(frames).toContainEqual({
      t: 'rpc.result', id: 'purge-1', ok: true, result: { purged: true },
    })

    send(ws, {
      t: 'rpc',
      id: 'purge-invalid',
      method: BRIDGE_SESSION_PURGE_METHOD,
      payload: { sessionId: '' },
    })
    await waitFor(() => frames.some((frame) => frame.t === 'rpc.result' && frame.id === 'purge-invalid'))
    expect(frames).toContainEqual(expect.objectContaining({
      t: 'rpc.result', id: 'purge-invalid', ok: false, error: expect.objectContaining({ code: 'bad-request' }),
    }))

    const failing = vi.fn(async () => { throw new SessionPurgeError('running', 'cancel it first') })
    const failureBridge = await startBridge({ purgeSession: failing })
    harnesses.push(failureBridge)
    const failure = await connect(failureBridge.url)
    send(failure.ws, { t: 'hello', token: TOKEN, caps: CAPS })
    await waitFor(() => failure.frames.some((frame) => frame.t === 'hello.ok'))
    send(failure.ws, {
      t: 'rpc',
      id: 'purge-running',
      method: BRIDGE_SESSION_PURGE_METHOD,
      payload: { sessionId: 'session-82222a77-aab5-4c0b-b33e-6376973ec93d' },
    })
    await waitFor(() => failure.frames.some((frame) => frame.t === 'rpc.result' && frame.id === 'purge-running'))
    expect(failure.frames).toContainEqual(expect.objectContaining({
      t: 'rpc.result', id: 'purge-running', ok: false, error: { code: 'running', message: 'cancel it first' },
    }))
    ws.close()
    failure.ws.close()
  })

  it('finishes snapshot injection before forwarding a prompt for the same session', async () => {
    let releaseInjection!: () => void
    const injectionGate = new Promise<void>((resolve) => { releaseInjection = resolve })
    const injectBrowserSnapshot = vi.fn(async () => { await injectionGate })
    const h = await startBridge({ injectBrowserSnapshot })
    harnesses.push(h)
    const { ws, frames } = await connect(h.url)
    send(ws, { t: 'hello', token: TOKEN, caps: CAPS })
    await waitFor(() => frames.some((frame) => frame.t === 'hello.ok'))

    send(ws, {
      t: 'rpc', id: 'snapshot', method: BRIDGE_INJECT_BROWSER_SNAPSHOT_METHOD,
      payload: { sessionId: 'session-ordered', snapshot: 'Current page' },
    })
    send(ws, {
      t: 'rpc', id: 'prompt-after-snapshot', method: 'session.prompt',
      payload: { sessionId: 'session-ordered', mode: 'queue', content: [] },
    })

    await waitFor(() => injectBrowserSnapshot.mock.calls.length === 1)
    expect(h.sessionApi.prompt).not.toHaveBeenCalled()
    releaseInjection()
    await waitFor(() => vi.mocked(h.sessionApi.prompt).mock.calls.length === 1)
    await waitFor(() => frames.some((frame) => frame.t === 'rpc.result' && frame.id === 'prompt-after-snapshot'))
    expect(frames.filter((frame) => frame.t === 'rpc.result').map((frame) => frame.id)).toEqual([
      'snapshot',
      'prompt-after-snapshot',
    ])
    ws.close()
  })

  it('orders prompt before cancel for one session without blocking other sessions', async () => {
    let releasePrompt!: () => void
    const promptGate = new Promise<void>((resolve) => { releasePrompt = resolve })
    const calls: Array<{ method: string; sessionId: string }> = []
    const sessionApi = defaultSessionApi()
    vi.mocked(sessionApi.prompt).mockImplementation(async (request: { sessionId: string }) => {
      calls.push({ method: 'session.prompt', sessionId: request.sessionId })
      if (request.sessionId === 'provisional') await promptGate
      return { accepted: true as const }
    })
    vi.mocked(sessionApi.cancel).mockImplementation(async (request: { sessionId: string }) => {
      calls.push({ method: 'session.cancel', sessionId: request.sessionId })
      return { accepted: true as const }
    })
    const h = await startBridge({ sessionApi })
    harnesses.push(h)
    const { ws, frames } = await connect(h.url)
    send(ws, { t: 'hello', token: TOKEN, caps: CAPS })
    await waitFor(() => frames.some((frame) => frame.t === 'hello.ok'))

    send(ws, {
      t: 'rpc', id: 'prompt', method: 'session.prompt',
      payload: { sessionId: 'provisional', mode: 'queue', content: [] },
    })
    send(ws, { t: 'rpc', id: 'cancel', method: 'session.cancel', payload: { sessionId: 'provisional' } })
    send(ws, { t: 'rpc', id: 'other-cancel', method: 'session.cancel', payload: { sessionId: 'other' } })

    await waitFor(() => calls.some((call) => call.sessionId === 'other'))
    expect(calls).toContainEqual({ method: 'session.prompt', sessionId: 'provisional' })
    expect(calls).toContainEqual({ method: 'session.cancel', sessionId: 'other' })
    expect(calls).not.toContainEqual({ method: 'session.cancel', sessionId: 'provisional' })

    releasePrompt()
    await waitFor(() => calls.some((call) => call.method === 'session.cancel' && call.sessionId === 'provisional'))
    expect(calls.filter((call) => call.sessionId === 'provisional')).toEqual([
      { method: 'session.prompt', sessionId: 'provisional' },
      { method: 'session.cancel', sessionId: 'provisional' },
    ])
    await waitFor(() => frames.filter((frame) => frame.t === 'rpc.result').length === 3)
    ws.close()
  })

  it('answers respond frames with not-implemented (no in-process replacement for the old approval bridge)', async () => {
    const h = await startBridge()
    harnesses.push(h)
    const { ws, frames } = await connect(h.url)
    send(ws, { t: 'hello', token: TOKEN, caps: CAPS })
    await waitFor(() => frames.some((frame) => frame.t === 'hello.ok'))
    send(ws, {
      t: 'respond',
      id: 'response-1',
      rpcId: 'question-1',
      result: { ok: true, value: { sessionId: 'session-1' } },
    })
    await waitFor(() => frames.some((frame) => frame.t === 'respond.result'))

    expect(frames).toContainEqual({
      t: 'respond.result', id: 'response-1', ok: false, error: { code: 'not-implemented', message: expect.any(String) },
    })
    ws.close()
  })

  it('rejects privileged methods from non-loopback remotes', async () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('::1')).toBe(true)
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('192.168.1.5')).toBe(false)
    expect(isLoopbackAddress(undefined)).toBe(false)
  })

  it('dispatches tool calls and resolves on tool.result', async () => {
    const h = await startBridge()
    harnesses.push(h)
    const { ws, frames } = await connect(h.url)
    send(ws, { t: 'hello', token: TOKEN, caps: { textOnly: true, snapshotMaxChars: 12000, maxInteractiveItems: 60 } })
    await waitFor(() => frames.some((f) => f.t === 'hello.ok'))
    const result = h.bridge.requestTool('browser_click', { index: 1 }, new AbortController().signal)
    await waitFor(() => frames.some((f) => f.t === 'tool.call'))
    const call = frames.find((f) => f.t === 'tool.call') as Extract<BridgeFrame, { t: 'tool.call' }>
    expect(call.name).toBe('browser_click')
    expect(call.args).toEqual({ index: 1 })
    send(ws, { t: 'tool.result', id: call.id, ok: true, result: { text: 'clicked' } })
    await expect(result).resolves.toEqual({ text: 'clicked' })
    ws.close()
  })

  it('rejects tool calls whose signal is already aborted before dispatch', async () => {
    const h = await startBridge()
    harnesses.push(h)
    const { ws, frames } = await connect(h.url, EXT_ORIGIN)
    send(ws, { t: 'hello', token: '', caps: CAPS })
    await waitFor(() => frames.some((f) => f.t === 'hello.ok'))
    const abort = new AbortController()
    abort.abort()
    expect(() => h.bridge.requestTool('browser_click', {}, abort.signal))
      .toThrowError(expect.objectContaining({ code: 'bridge-closed' }))
    // 没有 tool.call 被发出
    await new Promise((resolve) => { setTimeout(resolve, 50) })
    expect(frames.some((f) => f.t === 'tool.call')).toBe(false)
    ws.close()
  })

  it('rejects tool calls when no extension is connected', async () => {
    const h = await startBridge()
    harnesses.push(h)
    expect(() => h.bridge.requestTool('browser_click', {}, new AbortController().signal))
      .toThrowError(expect.objectContaining({ code: 'bridge-closed' }))
  })

  it('times out tool calls that never settle', async () => {
    const h = await startBridge()
    harnesses.push(h)
    const { ws, frames } = await connect(h.url)
    send(ws, { t: 'hello', token: TOKEN, caps: { textOnly: true, snapshotMaxChars: 12000, maxInteractiveItems: 60 } })
    await waitFor(() => frames.some((f) => f.t === 'hello.ok'))
    await expect(h.bridge.requestTool('browser_wait', {}, new AbortController().signal, 30))
      .rejects.toMatchObject({ code: 'timeout' })
    await waitFor(() => frames.some((frame) => frame.t === 'tool.cancel'))
    const call = frames.find((frame) => frame.t === 'tool.call') as Extract<BridgeFrame, { t: 'tool.call' }>
    expect(frames).toContainEqual({ t: 'tool.cancel', id: call.id })
    ws.close()
  })

  it('propagates extension-reported tool errors', async () => {
    const h = await startBridge()
    harnesses.push(h)
    const { ws, frames } = await connect(h.url)
    send(ws, { t: 'hello', token: TOKEN, caps: { textOnly: true, snapshotMaxChars: 12000, maxInteractiveItems: 60 } })
    await waitFor(() => frames.some((f) => f.t === 'hello.ok'))
    const result = h.bridge.requestTool('browser_navigate', { url: 'https://x' }, new AbortController().signal)
    await waitFor(() => frames.some((f) => f.t === 'tool.call'))
    const call = frames.find((f) => f.t === 'tool.call') as Extract<BridgeFrame, { t: 'tool.call' }>
    send(ws, { t: 'tool.result', id: call.id, ok: false, error: { code: 'action-failed', message: 'blocked' } })
    await expect(result).rejects.toBeInstanceOf(BridgeToolError)
    await expect(result).rejects.toMatchObject({ code: 'action-failed', message: 'blocked' })
    ws.close()
  })

  it('settles pending tool calls when a replacement connection arrives', async () => {
    const h = await startBridge()
    harnesses.push(h)
    const first = await connect(h.url)
    send(first.ws, { t: 'hello', token: TOKEN, caps: { textOnly: true, snapshotMaxChars: 12000, maxInteractiveItems: 60 } })
    await waitFor(() => first.frames.some((f) => f.t === 'hello.ok'))
    const pending = h.bridge.requestTool('browser_click', {}, new AbortController().signal)
    // Attach the assertion eagerly: the replacement below settles it before the final await.
    const pendingAssertion = expect(pending).rejects.toMatchObject({ code: 'bridge-closed' })
    await waitFor(() => first.frames.some((f) => f.t === 'tool.call'))

    const second = await connect(h.url)
    send(second.ws, { t: 'hello', token: TOKEN, caps: { textOnly: true, snapshotMaxChars: 12000, maxInteractiveItems: 60 } })
    await waitFor(() => second.frames.some((f) => f.t === 'hello.ok'))

    await pendingAssertion
    first.ws.close()
    second.ws.close()
  })

  it('aborts tool calls when the caller signal fires', async () => {
    const h = await startBridge()
    harnesses.push(h)
    const { ws, frames } = await connect(h.url)
    send(ws, { t: 'hello', token: TOKEN, caps: { textOnly: true, snapshotMaxChars: 12000, maxInteractiveItems: 60 } })
    await waitFor(() => frames.some((f) => f.t === 'hello.ok'))
    const abort = new AbortController()
    const pending = h.bridge.requestTool('browser_click', {}, abort.signal)
    await waitFor(() => frames.some((f) => f.t === 'tool.call'))
    const call = frames.find((frame) => frame.t === 'tool.call') as Extract<BridgeFrame, { t: 'tool.call' }>
    abort.abort()
    await expect(pending).rejects.toMatchObject({ code: 'bridge-closed' })
    await waitFor(() => frames.some((frame) => frame.t === 'tool.cancel'))
    expect(frames).toContainEqual({ t: 'tool.cancel', id: call.id })
    ws.close()
  })

  it('forwards the owning session with a tool call', async () => {
    const h = await startBridge()
    harnesses.push(h)
    const { ws, frames } = await connect(h.url)
    send(ws, { t: 'hello', token: TOKEN, caps: CAPS })
    await waitFor(() => frames.some((f) => f.t === 'hello.ok'))
    const pending = h.bridge.requestTool(
      'browser_click',
      {},
      new AbortController().signal,
      1_000,
      'session-browser',
    )
    await waitFor(() => frames.some((f) => f.t === 'tool.call'))
    const call = frames.find((frame) => frame.t === 'tool.call') as Extract<BridgeFrame, { t: 'tool.call' }>
    expect(call.sessionId).toBe('session-browser')
    send(ws, { t: 'tool.result', id: call.id, ok: true, result: { text: 'done' } })
    await expect(pending).resolves.toEqual({ text: 'done' })
    ws.close()
  })

  it('pumps event frames to the connected extension', async () => {
    const h = await startBridge()
    harnesses.push(h)
    const { ws, frames } = await connect(h.url)
    send(ws, { t: 'hello', token: TOKEN, caps: { textOnly: true, snapshotMaxChars: 12000, maxInteractiveItems: 60 } })
    await waitFor(() => frames.filter((f) => f.t === 'event').length >= 2)
    const events = frames.filter((f) => f.t === 'event') as Extract<BridgeFrame, { t: 'event' }>[]
    expect(events.map((e) => e.frame.method)).toEqual(['session/subscribed', 'session/queue'])
    ws.close()
  })

  it('settles pending tool calls when the send fails mid-flight', async () => {
    const h = await startBridge()
    harnesses.push(h)
    const { ws, frames } = await connect(h.url)
    send(ws, { t: 'hello', token: TOKEN, caps: CAPS })
    await waitFor(() => frames.some((f) => f.t === 'hello.ok'))
    const pending = h.bridge.requestTool('browser_click', {}, new AbortController().signal)
    // Tear the socket down immediately: the in-flight send reports a write
    // failure (or the close path wins — either settles as bridge-closed).
    const assertion = expect(pending).rejects.toMatchObject({ code: 'bridge-closed' })
    ws.terminate()
    await assertion
  })

  it('closes cleanly twice (second close is a no-op on the acceptor)', async () => {
    const h = await startBridge()
    harnesses.push(h)
    await h.bridge.close()
    await h.bridge.close()
  })

  it('sends protocol pings on the configured cadence and the client answers pong', async () => {
    const h = await startBridge({ pingIntervalMs: 50 })
    harnesses.push(h)
    const { ws, frames } = await connect(h.url)
    send(ws, { t: 'hello', token: TOKEN, caps: CAPS })
    await waitFor(() => frames.some((f) => f.t === 'ping'))
    send(ws, { t: 'pong' })
    ws.close()
  })

  it('stops the stream-failed arm when the pump fails after the socket closed', async () => {
    const lateFailEvents: AsyncIterable<SessionEventEnvelope> = {
      async *[Symbol.asyncIterator]() {
        yield { rpcId: 'l1', method: 'session/subscribed', payload: { sessionId: 's1' } }
        await new Promise((resolve) => { setTimeout(resolve, 120) })
        throw new Error('late failure')
      },
    }
    const h = await startBridge({ openSessionEvents: () => lateFailEvents })
    harnesses.push(h)
    const { ws, frames, done } = await connect(h.url)
    send(ws, { t: 'hello', token: TOKEN, caps: CAPS })
    await waitFor(() => frames.some((f) => f.t === 'hello.ok'))
    ws.close()
    await done
    // The pump fails after the close: the abort flag suppresses the error frame.
    await new Promise((resolve) => { setTimeout(resolve, 200) })
    expect(frames.some((f) => f.t === 'error')).toBe(false)
  })

  it('closes cleanly and rejects pending work', async () => {
    const h = await startBridge()
    const { ws, frames } = await connect(h.url)
    send(ws, { t: 'hello', token: TOKEN, caps: CAPS })
    await waitFor(() => frames.some((f) => f.t === 'hello.ok'))
    const pending = h.bridge.requestTool('browser_click', {}, new AbortController().signal)
    // Attach the assertion eagerly: close() settles it before the final await.
    const pendingAssertion = expect(pending).rejects.toMatchObject({ code: 'bridge-closed' })
    await h.bridge.close()
    await pendingAssertion
    expect(() => h.bridge.requestTool('browser_click', {}, new AbortController().signal))
      .toThrowError(expect.objectContaining({ code: 'bridge-closed' }))
    ws.close()
  })

  it('tracks connection state through auth, close, and replacement', async () => {
    const h = await startBridge()
    harnesses.push(h)
    expect(h.bridge.hasConnection()).toBe(false)
    const { ws, frames, done } = await connect(h.url)
    send(ws, { t: 'hello', token: TOKEN, caps: CAPS })
    await waitFor(() => frames.some((f) => f.t === 'hello.ok'))
    expect(h.bridge.hasConnection()).toBe(true)
    ws.close()
    await done
    // The server processes the close asynchronously; poll for the outcome.
    await expect.poll(() => h.bridge.hasConnection()).toBe(false)
  })

  it('closes sockets on unparseable frames and ignores client-only frames when ready', async () => {
    const h = await startBridge()
    harnesses.push(h)
    const { ws, frames, done } = await connect(h.url)
    send(ws, { t: 'hello', token: TOKEN, caps: CAPS })
    await waitFor(() => frames.some((f) => f.t === 'hello.ok'))
    // Client-only shapes after ready are ignored (no error frame, no close).
    send(ws, { t: 'pong' })
    send(ws, { t: 'hello', token: TOKEN, caps: CAPS })
    await new Promise((resolve) => { setTimeout(resolve, 50) })
    expect(ws.readyState).toBe(WebSocket.OPEN)
    // Garbage is a protocol violation and closes the socket.
    ws.send('not-json')
    await done
    expect(ws.readyState).toBe(WebSocket.CLOSED)
  })

  it('reports a non-Error thrown value as an internal rpc.result error', async () => {
    const sessionApi = defaultSessionApi()
    vi.mocked(sessionApi.list).mockRejectedValueOnce('boom')
    const h = await startBridge({ sessionApi })
    harnesses.push(h)
    const { ws, frames } = await connect(h.url)
    send(ws, { t: 'hello', token: TOKEN, caps: CAPS })
    await waitFor(() => frames.some((f) => f.t === 'hello.ok'))
    send(ws, { t: 'rpc', id: 'rpc-4', method: 'session.list', payload: {} })
    await waitFor(() => frames.some((f) => f.t === 'rpc.result' && f.id === 'rpc-4'))
    expect(frames.find((f) => f.t === 'rpc.result' && f.id === 'rpc-4'))
      .toMatchObject({ t: 'rpc.result', id: 'rpc-4', ok: false, error: { code: 'internal', message: 'boom' } })
    ws.close()
  })

  it('ignores tool results with unknown ids', async () => {
    const h = await startBridge()
    harnesses.push(h)
    const { ws, frames } = await connect(h.url)
    send(ws, { t: 'hello', token: TOKEN, caps: CAPS })
    await waitFor(() => frames.some((f) => f.t === 'hello.ok'))
    // Unknown id: ignored, connection stays healthy.
    send(ws, { t: 'tool.result', id: 'nope', ok: true, result: {} })
    await new Promise((resolve) => { setTimeout(resolve, 50) })
    expect(ws.readyState).toBe(WebSocket.OPEN)
    ws.close()
  })

  it('rejects privileged methods from non-loopback remotes over a real socket', async () => {
    // The sandbox cannot bind arbitrary loopback literals, so the remote
    // address is forced through the test seam; the socket itself is real.
    const h = await startBridge({ remoteAddressOverride: '192.168.1.5' })
    harnesses.push(h)
    const { ws, frames } = await connect(h.url)
    send(ws, { t: 'hello', token: TOKEN, caps: CAPS })
    await waitFor(() => frames.some((f) => f.t === 'hello.ok'))
    send(ws, { t: 'rpc', id: 'priv-1', method: 'settings.describe', payload: {} })
    await waitFor(() => frames.some((f) => f.t === 'rpc.result' && f.id === 'priv-1'))
    expect(frames.find((f) => f.t === 'rpc.result' && f.id === 'priv-1'))
      .toMatchObject({ t: 'rpc.result', id: 'priv-1', ok: false, error: { code: 'forbidden' } })
    // Non-privileged methods still pass for the same remote.
    send(ws, { t: 'rpc', id: 'priv-2', method: 'session.list', payload: {} })
    await waitFor(() => frames.some((f) => f.t === 'rpc.result' && f.id === 'priv-2'))
    const allowed = frames.find((f): f is Extract<BridgeFrame, { t: 'rpc.result' }> => f.t === 'rpc.result' && f.id === 'priv-2')!
    expect(allowed.ok).toBe(true)
    expect(h.settingsApi.describe).not.toHaveBeenCalled()
    ws.close()
  })

  it('emits a stream-failed error frame when the event stream throws', async () => {
    const failingEvents: AsyncIterable<SessionEventEnvelope> = {
      async *[Symbol.asyncIterator]() {
        yield { rpcId: 'f1', method: 'session/subscribed', payload: { sessionId: 's1' } }
        throw new Error('stream broke')
      },
    }
    const h = await startBridge({ openSessionEvents: () => failingEvents })
    harnesses.push(h)
    const { ws, frames } = await connect(h.url)
    send(ws, { t: 'hello', token: TOKEN, caps: CAPS })
    await waitFor(() => frames.some((f) => f.t === 'error' && f.code === 'stream-failed'))
    expect(frames.find((f) => f.t === 'error')).toMatchObject({ t: 'error', code: 'stream-failed' })
    ws.close()
  })

  it('stops pumping events once the socket closes mid-stream', async () => {
    const slowEvents: AsyncIterable<SessionEventEnvelope> = {
      async *[Symbol.asyncIterator]() {
        for (let i = 0; i < 100; i += 1) {
          yield { rpcId: `s${i}`, method: 'session/subscribed', payload: { sessionId: 's1', lastSeq: i } }
          await new Promise((resolve) => { setTimeout(resolve, 10) })
        }
      },
    }
    const h = await startBridge({ openSessionEvents: () => slowEvents })
    harnesses.push(h)
    const { ws, frames, done } = await connect(h.url)
    send(ws, { t: 'hello', token: TOKEN, caps: CAPS })
    await waitFor(() => frames.filter((f) => f.t === 'event').length >= 2)
    ws.close()
    await done
    // The pump must stop sending after close instead of writing to a dead socket.
    const countBefore = frames.filter((f) => f.t === 'event').length
    await new Promise((resolve) => { setTimeout(resolve, 80) })
    expect(frames.filter((f) => f.t === 'event').length).toBe(countBefore)
  })
})
