/**
 * REAL-composition coverage: a test-only cordis.yml booted through the
 * published Loader mounts the webserver, the minimal spine (sessions /
 * user-questions / agents / system-prompt / tools), a test-only Remote
 * Host seam, and the bridge plugin itself. A real WebSocket
 * client then authenticates over a real socket and drives Host calls against
 * the real Session store; disposal removes the tool registrations (HMR safety).
 *
 * Mocked boundary: the Gateway / Connection services;
 * focused adapter tests pin their wire contracts against the upstream source,
 * while these cases verify Remote transport and Loader topology.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import WebSocket from 'ws'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import LlmService, { createUserMessage, type GenerateOptions, type UserMessage } from '@deepseek-ai/dsh-llm'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { createSessionFormatV3ToV4 } from '@deepseek-ai/dsh-session-format-v3-to-v4'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import * as BridgeBrowser from '../src/index.ts'
import { BRIDGE_INJECT_BROWSER_SNAPSHOT_METHOD, BRIDGE_PATH, type BridgeFrame } from '../src/protocol.ts'
import { BROWSER_CONTEXT_KIND } from '../src/browser-context.ts'

const BRIDGE = '@yuxianglin/dsh-bridge-browser'
const TOKEN = 'abcdabcdabcdabcdabcdabcdabcdabcd'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  root = undefined
})

/**
 * Minimal structural implementation of the dsh 0.1.5 Host seams. Focused
 * Remote-adapter tests pin the argument and stream contracts separately; this
 * fixture verifies Loader injection, real sockets, and real Session storage.
 */
const RemoteApiHost = {
  name: 'remote-api-host',
  inject: ['sessions'],
  apply(ctx: Context, config: { cwd: string }): void {
    const gateway = {
      wireStream: {
        async open(endpoint: string, _payload: unknown, signal: AbortSignal): Promise<AsyncIterable<unknown>> {
          if (endpoint === '$events') {
            return {
              async *[Symbol.asyncIterator]() {
                yield { type: 'ready', clientId: 'composition-client', host: { home: root } }
                await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
              },
            }
          }
          throw new Error(`unexpected composition stream ${endpoint}`)
        },
        failure: (error: unknown) => ({
          code: typeof (error as { code?: unknown }).code === 'string'
            ? (error as { code: string }).code
            : 'internal',
          message: String(error),
          details: {},
        }),
      },
      async invoke(request: { namespace: string; method: string; args: Record<string, unknown> }) {
        if (request.namespace === 'session' && request.method === 'create') {
          const payload = request.args.request as { sessionId?: string; cwd?: string }
          const session = ctx.sessions.create(
            SessionId(payload.sessionId ?? `session-${crypto.randomUUID()}`),
            { meta: { cwd: payload.cwd ?? config.cwd } },
          )
          return { sessionId: session.id }
        }
        if (request.namespace === 'session' && request.method === 'list') {
          return {
            items: ctx.sessions.list().map(session => ({
              sessionId: session.id,
              cwd: session.header.cwd,
              running: false,
              blank: session.seq === 0,
              updatedAt: session.header.createdAt,
            })),
          }
        }
        throw new Error(`unexpected composition invoke ${request.namespace}/${request.method}`)
      },
    }
    const connection = {
      createSharedFetchHandler: () => ({
        fetch: async (request: Request) => {
          const envelope = await request.json() as { rpcId: string }
          return Response.json({
            type: 'server-response', rpcId: envelope.rpcId, result: { ok: true },
          })
        },
      }),
    }
    ctx.provide('typertGateway' as never, gateway as never)
    ctx.provide('connection' as never, connection as never)
  },
}

/** Write a dist fixture and the composition cordis.yml, then boot it through the real Loader. */
async function loadComposition(): Promise<{ ctx: Context; configPath: string; port: number }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-bridge-browser-'))
  const configPath = join(root, 'cordis.yml')
  const apiHostName = 'test:remote-api-host'
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    '    port: 0',
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-session-projection'",
    "- name: '@deepseek-ai/dsh-user-questions'",
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-llm'",
    "- name: '@deepseek-ai/dsh-agent-loop'",
    `- name: '${apiHostName}'`,
    '  config:',
    `    cwd: '${root}'`,
    `- name: '${BRIDGE}'`,
    '  config:',
    `    token: '${TOKEN}'`,
    `    sessionWorkspacePath: '${join(root, 'browser-sessions')}'`,
    // This spec drives the raw gateway chain (create → real session); the
    // deferred-creation behavior is covered by its focused wrapper spec.
    '    deferSessionCreate: false',
    '',
  ].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-host-webserver', WebServer],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-user-questions', UserQuestionService],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRegistry],
    ['@deepseek-ai/dsh-llm', LlmService],
    ['@deepseek-ai/dsh-agent-loop', AgentLoop],
    [apiHostName, RemoteApiHost],
    [BRIDGE, BridgeBrowser],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  const web = context.get('webServer') as typeof WebServer.prototype
  return { ctx: context, configPath, port: web.port }
}

/** 扩展上下文 Origin（回环免 token 的必要条件）。 */
const EXT_ORIGIN = 'chrome-extension://test-extension-id'

function connect(port: number): Promise<{
  ws: WebSocket
  frames: BridgeFrame[]
  closed: Promise<{ code: number; reason: string }>
}> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${BRIDGE_PATH}`, { headers: { origin: EXT_ORIGIN } })
    const frames: BridgeFrame[] = []
    ws.on('message', (data) => { frames.push(JSON.parse(data.toString()) as BridgeFrame) })
    ws.on('error', reject)
    ws.on('open', () => {
      resolve({
        ws,
        frames,
        closed: new Promise((doneResolve) => {
          ws.on('close', (code, reason) => { doneResolve({ code, reason: reason.toString() }) })
        }),
      })
    })
  })
}

function send(ws: WebSocket, frame: BridgeFrame): void {
  ws.send(JSON.stringify(frame))
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((resolve) => { setTimeout(resolve, 10) })
  }
}

async function connectReady(port: number): Promise<Awaited<ReturnType<typeof connect>>> {
  const client = await connect(port)
  send(client.ws, { t: 'hello', token: '', caps: { textOnly: true, snapshotMaxChars: 32_000, maxInteractiveItems: 60 } })
  await Promise.race([
    waitFor(() => client.frames.some((f) => f.t === 'hello.ok')),
    client.closed.then(({ code, reason }) => {
      throw new Error(`bridge closed before hello.ok (${String(code)} ${reason}): ${JSON.stringify(client.frames)}`)
    }),
  ])
  return client
}

describe('real Loader composition', () => {
  it.each(['native', 'migrated'] as const)('supersedes a %s followed page through the durable inbox without waking an idle Agent', async (snapshotKind) => {
    const { ctx, port } = await loadComposition()
    const client = await connectReady(port)
    const sessionId = SessionId('followed-page-lifecycle')
    const requests: GenerateOptions[] = []
    ctx.on('llm/stream', async function* (request) {
      requests.push(request)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Read the current page.' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })

    const followPage = async (id: string, snapshot: string): Promise<void> => {
      send(client.ws, {
        t: 'rpc', id, method: BRIDGE_INJECT_BROWSER_SNAPSHOT_METHOD,
        payload: { sessionId, snapshot },
      })
      await waitFor(() => client.frames.some(frame => frame.t === 'rpc.result' && frame.id === id))
      expect(client.frames.find(frame => frame.t === 'rpc.result' && frame.id === id)).toMatchObject({ ok: true })
    }

    // This snapshot arrives before async creation publishes the Agent. The
    // bridge's real agent/created listener must flush it into the new inbox.
    await followPage('before-create', 'Page: provisional tab')
    const agent = await ctx.agentLoop.create(sessionId, { provider: 'test', model: 'test' })
    expect(ctx.agents.get(sessionId)).toBe(agent)
    expect(agent.inbox.nextStep).toHaveLength(1)
    expect(agent.inbox.nextStep[0]?.content).toContainEqual({ type: 'text', text: expect.stringContaining('provisional tab') })

    if (snapshotKind === 'migrated') {
      // Exercise the published V3-to-V4 conversion of a durable pending
      // snapshot under the 0.2 browser-context producer kind.
      const snapshot = agent.inbox.nextStep[0]!
      const queued = agent.session.snapshotEvents().find(event => event.type === 'agent/inbox/spliced')!
      const migration = createSessionFormatV3ToV4([])
      const sourceHeader = { ...agent.session.header, version: 3, delegationDepth: 0 }
      const stage = migration.createStage({
        sourceHeader,
        targetHeader: migration.migrateHeader(sourceHeader),
        sourceInheritedEventCount: 0,
        sourceKind: 'decoded',
      })
      const restored: UserMessage[] = []
      const output = {
        emitEvent(event: Parameters<typeof stage.transformEvent>[0]): void {
          restored.push(...(event.data as unknown as { inserted: UserMessage[] }).inserted)
        },
        emitRun(): never { throw new Error('unexpected compact run') },
      }
      stage.transformEvent({
        ...queued,
        seq: 0,
        data: { ...queued.data, inserted: [{ ...snapshot, source: { ...snapshot.source, kind: BROWSER_CONTEXT_KIND } }] },
      }, output)
      stage.finish(output)
      expect(restored).toHaveLength(1)
      expect(restored[0]!.source.kind).toBe(BROWSER_CONTEXT_KIND)
      expect(restored[0]!.source).not.toHaveProperty('plugin')
      agent.inbox.remove(snapshot.id)
      agent.inbox.append('next-step', restored[0]!)
    }

    const steering = createUserMessage({
      content: [{ type: 'text', text: 'Keep my page selection.' }], source: { kind: 'human' },
    })
    agent.inbox.append('next-step', steering)
    await followPage('live-page', 'Page: current tab')

    expect(agent.status).toBe('idle')
    expect(requests).toHaveLength(0)
    expect(agent.inbox.nextStep).toHaveLength(2)
    expect(agent.inbox.nextStep[0]?.id).toBe(steering.id)
    expect(JSON.stringify(agent.inbox.nextStep)).not.toContain('provisional tab')
    expect(agent.session.snapshotEvents().some(event => event.type === 'agent/inbox/spliced'
      && event.data.outcome === 'canceled')).toBe(true)

    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Summarize this page.' }], source: { kind: 'human' },
    }))
    await agent.whenIdle()

    expect(requests).toHaveLength(1)
    expect(JSON.stringify(requests[0]?.messages)).toContain('current tab')
    expect(JSON.stringify(requests[0]?.messages)).not.toContain('provisional tab')
    expect(agent.inbox.nextStep).toHaveLength(0)
    client.ws.close()
  })

  it('boots the bridge, authenticates over a real socket, and drives real gateway RPCs', { timeout: 60_000 }, async () => {
    const { ctx, port } = await loadComposition()

    // The bridge plugin mounted the browser tool set on the real registry.
    const tools = ctx.get('tools') as ToolRegistry
    expect(tools.get('browser_snapshot')).toBeDefined()

    const browserPrompt = (await ctx.systemPrompt.assemble()).sections
      .find((section) => section.name === 'tool:bridge-browser')?.text
    expect(browserPrompt).toContain('page content you have not snapshotted')
    expect(browserPrompt).toContain('Reuse that injected snapshot')
    expect(browserPrompt).not.toMatch(/\p{Script=Han}/u)

    // Zero-config discovery endpoint answers with the bridge WebSocket URL.
    const configResponse = await fetch(`http://127.0.0.1:${port}/ext/bridge-config`)
    expect(configResponse.status).toBe(200)
    const config = await configResponse.json() as { wsUrl?: unknown }
    expect(typeof config.wsUrl).toBe('string')
    expect(config.wsUrl).toBe(`ws://127.0.0.1:${port}/ext/bridge`)
    expect(tools.get('browser_click')).toBeDefined()
    expect(tools.get('browser_navigate')).toBeDefined()

    // Zero-config semantics: loopback connections need no token (the
    // non-loopback token gate is covered by server.spec overrides).
    const client = await connectReady(port)
    expect(client.frames.find((f) => f.t === 'hello.ok')).toEqual({
      t: 'hello.ok',
      caps: { textOnly: true, snapshotMaxChars: 32_000, maxInteractiveItems: 60 },
    })

    // Gateway RPC round-trip against the real session store.
    send(client.ws, { t: 'rpc', id: 'c-1', method: 'session.create', payload: { cwd: root } })
    await waitFor(() => client.frames.some((f) => f.t === 'rpc.result' && f.id === 'c-1'))
    const created = client.frames.find((f): f is Extract<BridgeFrame, { t: 'rpc.result' }> => f.t === 'rpc.result' && f.id === 'c-1')!
    expect(created.ok).toBe(true)
    const sessionId = ((created as { result: { result: { value: { sessionId: string } } } }).result).result.value.sessionId
    expect(sessionId).toMatch(/^session-[0-9a-f-]{36}$/)
    expect(ctx.sessions.get(SessionId(sessionId))?.header.cwd).toBe(root)

    send(client.ws, { t: 'rpc', id: 'c-2', method: 'session.list', payload: {} })
    await waitFor(() => client.frames.some((f) => f.t === 'rpc.result' && f.id === 'c-2'))
    const listed = client.frames.find((f) => f.t === 'rpc.result' && f.id === 'c-2')!
    const listedText = JSON.stringify((listed as { result: unknown }).result)
    expect(listedText).toContain(sessionId)

    client.ws.close()
  })

  it('unregisters the browser tools when the bridge fiber disposes (HMR safety)', { timeout: 60_000 }, async () => {
    const { ctx, configPath } = await loadComposition()
    const tools = ctx.get('tools') as ToolRegistry
    expect(tools.get('browser_snapshot')).toBeDefined()

    const bridgeEntry = [...ctx.loader.entries()].find((entry) => entry.options.name === BRIDGE)!
    await bridgeEntry.fiber!.dispose()
    expect(tools.get('browser_snapshot')).toBeUndefined()
    expect(tools.get('browser_click')).toBeUndefined()
    // Self-disposing an include-tree entry persists `disabled: true`; await
    // that debounced write so it cannot race the temp-dir removal.
    await expect.poll(async () => (await readFile(configPath, 'utf8')).includes('disabled: true')).toBe(true)
  })
})
