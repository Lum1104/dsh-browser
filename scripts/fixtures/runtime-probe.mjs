// Loaded only by smoke-runtime.mjs into its isolated real DSH profile.
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

export const name = 'runtime-smoke-probe'
export const inject = ['sessions', 'sessionPersistence', 'sessionQuery', 'sessionProjectionCache']

export async function apply(ctx, config) {
  // DSH 0.1.7 resolves profile packages through process-local module hooks.
  // Inspect providers inside the host where those hooks are installed.
  const resolve = createRequire(config.profileManifest)
  for (const [name, service] of [
    ['dsh-session-query', 'sessionQuery'],
    ['dsh-session-projection-cache', 'sessionProjectionCache'],
  ]) {
    const packageName = `@deepseek-ai/${name}`
    const path = resolve.resolve(`${packageName}/package.json`)
    const { version } = JSON.parse(await readFile(path, 'utf8'))
    assert.equal(version, config.expectedVersion, `Profile resolved an incompatible ${name} at ${path}`)
    const { default: Provider } = await import(pathToFileURL(resolve.resolve(packageName)).href)
    assert.ok(ctx.get(service) instanceof Provider, `${service} must use the profile's resolved provider`)
  }
  if (config.reopen) {
    assert.equal(ctx.sessions.get(config.sessionId), undefined, 'session must be cold after restart')
    // A prepared observation calls the real cache.hydratePrepared, the exact
    // failing boundary in #71. No mocked query, cache, or persistence services.
    const observation = await ctx.sessionQuery.observeSession(config.sessionId)
    try {
      assert.equal(observation.source, 'prepared')
      assert.ok(observation.projections)
      await writeFile(config.marker, JSON.stringify({ source: observation.source }))
    } finally {
      observation[Symbol.dispose]()
    }
    return
  }
  ctx.on('session/created', async (session) => {
    if (session.id !== config.sessionId) return
    // A durable Session choice must survive catalog refreshes and cold reads,
    // independently of the deployment default. No model request is needed.
    session.append('model/selection', { provider: 'smoke-provider', model: 'smoke-model' })
    // Persist a blank session without an LLM call so restart exercises reads
    // from disk even though normal empty sessions may be deferred.
    // AgentLoop owns writes through its SessionHandle; the service flush
    // barrier drains those handles and materializes even an empty session.
    await ctx.sessionPersistence.flush()
    await writeFile(config.marker, JSON.stringify({ sessionId: session.id }))
  })
}
