import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'

const root = fileURLToPath(new URL('../', import.meta.url))
const bridge = join(root, 'packages/browser/bridge-browser')
const require = createRequire(join(root, 'package.json'))
const expectedVersion = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).dependencies['@deepseek-ai/dsh']
const cli = join(dirname(require.resolve('@deepseek-ai/dsh/package.json')), 'lib/bin.js')
const bridgeRequire = createRequire(join(bridge, 'package.json'))
const { default: WebSocket } = await import(pathToFileURL(bridgeRequire.resolve('ws')).href)
const temp = await mkdtemp(join(tmpdir(), 'dsh-runtime-smoke-'))
const home = join(temp, 'home')
const marker = join(temp, 'observation.json')
const patch = join(temp, 'smoke.patch.yml')
const sessionId = `session-${randomUUID()}`
const token = randomUUID()
const env = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' }
// Do not inherit bridge settings or credentials from the developer's shell.
delete env.DSH_EXT_TOKEN
delete env.DSH_BROWSER_SESSION_WORKSPACE
let host
let socket
let hostLog = ''
let succeeded = false

async function waitFor(check, label, timeout = 60_000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (host && (host.exitCode !== null || host.signalCode !== null)) {
      throw new Error(`DSH exited (${host.exitCode ?? host.signalCode}) while waiting for ${label}`)
    }
    const value = await check()
    if (value) return value
    await delay(100)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

async function command(args) {
  const child = spawn(process.execPath, [cli, ...args], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', data => { output += data })
  child.stderr.on('data', data => { output += data })
  const timeout = setTimeout(() => child.kill('SIGKILL'), 120_000)
  try {
    const [code] = await once(child, 'exit')
    assert.equal(code, 0, output)
  } finally { clearTimeout(timeout) }
}

async function start(reopen) {
  await rm(marker, { force: true })
  // The production bridge is registered through the normal profile command;
  // only test settings and the observation probe are additional patch rows.
  await writeFile(patch, [
    '- id: bridge-browser',
    '  config:',
    `    token: ${JSON.stringify(token)}`,
    '    sessionWorkspacePath: ""',
    '    deferSessionCreate: false',
    '- insert:',
    '    - id: runtime-smoke-probe',
    `      name: ${JSON.stringify(pathToFileURL(join(root, 'scripts/fixtures/runtime-probe.mjs')).href)}`,
    '      config:',
    `        sessionId: ${JSON.stringify(sessionId)}`,
    `        marker: ${JSON.stringify(marker)}`,
    `        reopen: ${reopen}`,
    '',
  ].join('\n'))
  hostLog = ''
  host = spawn(process.execPath, [cli, 'web', '--patch', patch, '--no-open', '--port', '0'], {
    cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'],
  })
  host.stdout.on('data', data => { hostLog += data })
  host.stderr.on('data', data => { hostLog += data })
  let spawnError
  host.on('error', error => { spawnError = error })
  const base = await waitFor(() => {
    if (spawnError) throw spawnError
    return hostLog.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+)/)?.[1]
  }, 'host readiness')
  const response = await fetch(`${base}/ext/bridge-config`, { signal: AbortSignal.timeout(10_000) })
  assert.equal(response.status, 200)
  const config = await response.json()
  assert.equal(config.wsUrl, base.replace('http:', 'ws:') + '/ext/bridge')
  // Inspect what the actual profile Loader resolves, not just workspace hoists.
  const resolve = createRequire(join(home, 'profiles/web/package.json'))
  for (const name of ['dsh-session-query', 'dsh-session-projection-cache']) {
    const path = resolve.resolve(`@deepseek-ai/${name}/package.json`)
    const { version } = JSON.parse(await readFile(path, 'utf8'))
    console.log(`Host ${name}@${version}: ${path}`)
    assert.equal(version, expectedVersion, `Profile resolved an incompatible ${name} at ${path}`)
  }
  // Firefox-style origin requires a valid token even on loopback.
  socket = new WebSocket(config.wsUrl, { origin: 'moz-extension://runtime-smoke', handshakeTimeout: 10_000 })
  const frames = []
  let socketError
  socket.on('error', error => { socketError = error })
  socket.on('message', data => { frames.push(JSON.parse(data.toString())) })
  await once(socket, 'open')
  async function frame(predicate) {
    return waitFor(() => {
      if (socketError) throw socketError
      const found = frames.find(predicate)
      if (found) return found
      if (socket.readyState === WebSocket.CLOSED) throw new Error(`Bridge closed: ${JSON.stringify(frames)}`)
    }, 'bridge response', 15_000)
  }
  socket.send(JSON.stringify({ t: 'hello', token, caps: { textOnly: true, snapshotMaxChars: 32_000, maxInteractiveItems: 60 } }))
  await frame(value => value.t === 'hello.ok')
  return async (method, payload) => {
    const id = randomUUID()
    socket.send(JSON.stringify({ t: 'rpc', id, method, payload }))
    const result = await frame(value => value.t === 'rpc.result' && value.id === id)
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.result?.result?.ok, true, JSON.stringify(result))
    return result.result.result.value
  }
}

async function observation() {
  return waitFor(async () => {
    try { return JSON.parse(await readFile(marker, 'utf8')) } catch (error) {
      if (error.code === 'ENOENT') return undefined
      throw error
    }
  }, 'persisted session observation')
}

async function stop() {
  socket?.terminate()
  socket = undefined
  if (!host || host.exitCode !== null || host.signalCode !== null) return
  const exited = once(host, 'exit')
  host.kill('SIGTERM')
  const timeout = setTimeout(() => host.kill('SIGKILL'), 10_000)
  try { await exited } finally { clearTimeout(timeout) }
  host = undefined
}

try {
  await mkdir(home, { recursive: true })
  await command(['plugin', '--profile', 'web', 'add', '-w', `@yuxianglin/dsh-bridge-browser@link:${bridge}`])
  let rpc = await start(false)
  const created = await rpc('session.create', { sessionId, cwd: temp })
  assert.equal(created.sessionId, sessionId)
  assert.equal((await observation()).sessionId, sessionId)
  assert.ok((await rpc('session.list', {})).items.some(item => item.sessionId === sessionId))
  const history = await rpc('session.history', { sessionId })
  assert.ok(Array.isArray(history.events))
  await stop()
  rpc = await start(true)
  assert.equal((await observation()).source, 'prepared')
  assert.ok((await rpc('session.list', {})).items.some(item => item.sessionId === sessionId))
  assert.deepEqual((await rpc('session.history', { sessionId })).events, history.events)
  console.log('Real DSH smoke passed: discovery, token authentication, create/list/history, and prepared projections after restart')
  succeeded = true
} catch (error) {
  console.error(hostLog)
  console.error(`Smoke artifacts retained at ${temp}`)
  throw error
} finally {
  await stop()
  if (succeeded) await rm(temp, { recursive: true, force: true, maxRetries: 3 })
}
