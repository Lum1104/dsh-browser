/**
 * End-to-end: the real Chrome extension connects to a REAL dsh composition.
 *
 * Boots the bridge composition through the vendored Loader (webserver +
 * minimal spine + api host + workspace/storage plugins + bridge plugin, same
 * shape as composition.spec), launches a real Chromium with the built
 * extension (`--load-extension`), pins the bridge through the panel's real
 * settings UI (URL + token, so the extension targets THIS composition instead
 * of whatever auto-discovery finds on the machine), and asserts the full
 * chain: panel → background SW → bridge WebSocket → token hello → caps →
 * status push → deferred session.create (no store trace) → first prompt
 * materializes the session inside the dedicated workspace group.
 *
 * Self-skips without a usable Chromium (env `PLAYWRIGHT_CHROMIUM_PATH` or the
 * Playwright cache) or without a built extension dist. Run:
 *   pnpm --filter @yuxianglin/dsh-bridge-browser exec vitest run tests/e2e/bridge-extension.e2e.ts
 */

import { existsSync } from 'node:fs'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { chromium, type BrowserContext } from 'playwright-core'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import SessionStore from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import LlmService, { type UserMessage } from '@deepseek-ai/dsh-llm'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import SessionProjection from '@deepseek-ai/dsh-session-projection'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import * as BridgeBrowser from '../../src/index.ts'
import { CurrentApiHost } from '../current-api-host.ts'

const BRIDGE = '@yuxianglin/dsh-bridge-browser'
const TOKEN = 'e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0'

/** Header-only persistence peer required by the real Workspace registry. */
const SessionPersistenceStub = {
  name: 'session-persistence-stub',
  apply(ctx: Context): void {
    ctx.provide('sessionPersistence', { list: () => Promise.resolve([]) } as never)
  },
}

async function bootComposition(): Promise<{ ctx: Context; port: number; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bridge-e2e-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    '    port: 3090',
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-user-questions'",
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-llm'",
    "- name: '@deepseek-ai/dsh-agent-loop'",
    "- name: '@deepseek-ai/dsh-session-projection'",
    "- name: '@deepseek-ai/dsh-storage'",
    "- name: '@deepseek-ai/dsh-storage-json'",
    '  config:',
    `    root: '${join(root, 'storage')}'`,
    "- name: '@deepseek-ai/dsh-storage-domain'",
    '  config:',
    "    backend: 'json'",
    "- name: 'test:session-persistence'",
    "- name: '@deepseek-ai/dsh-workspace'",
    "- name: 'test:api-host'",
    '  config:',
    `    cwd: '${root}'`,
    `- name: '${BRIDGE}'`,
    '  config:',
    `    token: '${TOKEN}'`,
    `    sessionWorkspacePath: '${join(root, 'browser-sessions')}'`,
    '',
  ].join('\n'))

  const context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-host-webserver', WebServer],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-user-questions', UserQuestionService],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRegistry],
    ['@deepseek-ai/dsh-llm', LlmService],
    ['@deepseek-ai/dsh-agent-loop', AgentLoop],
    ['@deepseek-ai/dsh-session-projection', SessionProjection],
    ['@deepseek-ai/dsh-storage', Storage],
    ['@deepseek-ai/dsh-storage-json', StorageJson],
    ['@deepseek-ai/dsh-storage-domain', StorageDomain],
    ['test:session-persistence', SessionPersistenceStub],
    ['@deepseek-ai/dsh-workspace', WorkspaceRegistry],
    ['test:api-host', CurrentApiHost],
    [BRIDGE, BridgeBrowser],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await context.loader.await()
  context.effect(() => context.webServer.register({
    kind: 'exact',
    path: '/e2e-approval-page',
    handler: (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<main><h1>Approval target</h1><button>Continue</button></main>')
    },
  }), 'e2e approval page')
  const port = (context.get('webServer') as { port: number }).port
  return { ctx: context, port, root }
}

/** Locate a usable Chromium executable (env override, then the Playwright cache). */
function chromiumExecutable(): string | undefined {
  const fromEnv = process.env.PLAYWRIGHT_CHROMIUM_PATH
  if (fromEnv !== undefined && existsSync(fromEnv)) return fromEnv
  const home = process.env.HOME ?? ''
  const cacheRoot = join(home, 'Library', 'Caches', 'ms-playwright')
  if (!existsSync(cacheRoot)) return undefined
  for (const dir of ['chromium-1217', 'chromium-1226', 'chromium-1181']) {
    const mac = join(cacheRoot, dir, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing')
    const macIntel = join(cacheRoot, dir, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium')
    const linux = join(cacheRoot, dir, 'chrome-linux', 'chrome')
    for (const candidate of [mac, macIntel, linux]) {
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

const EXTENSION_DIR = resolve(import.meta.dirname, '../../../../../extensions/dsh-browser/dist')

let context: Context | undefined
let root: string | undefined
let port: number | undefined
let browser: BrowserContext | undefined
let executable: string | undefined

beforeAll(async () => {
  executable = chromiumExecutable()
  if (executable === undefined) return
  if (!existsSync(join(EXTENSION_DIR, 'manifest.json'))) return
  const booted = await bootComposition()
  context = booted.ctx
  root = booted.root
  port = booted.port
  // Extensions require a persistent context; channel 'chromium' selects the
  // new headless mode, which supports MV3 extensions.
  browser = await chromium.launchPersistentContext(join(root, 'chrome-profile'), {
    executablePath: executable,
    channel: 'chromium',
    headless: true,
    args: [
      `--disable-extensions-except=${EXTENSION_DIR}`,
      `--load-extension=${EXTENSION_DIR}`,
    ],
  })
})

afterAll(async () => {
  await browser?.close()
  await context?.fiber.dispose()
  if (root !== undefined) await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
})

describe('extension ↔ bridge e2e', () => {
  it('loads the extension, connects to the real bridge, and shows connected in the panel', { timeout: 120_000 }, async () => {
    if (executable === undefined) {
      console.warn('SKIP: no usable Chromium (set PLAYWRIGHT_CHROMIUM_PATH or install playwright chromium)')
      return
    }
    if (browser === undefined || context === undefined) {
      console.warn('SKIP: extension dist not built (run: pnpm --filter dsh-browser-extension run build)')
      return
    }

    const ctx = browser
    const inboxInsertions: Array<{ agentId: string; message: UserMessage }> = []
    context.on('agent/inbox/inserted', ({ agent, message }) => {
      inboxInsertions.push({ agentId: String(agent.id), message })
    })
    // The service worker may already be registered when launchPersistentContext
    // returns — waitForEvent would then miss it and time out; check first.
    let sw = ctx.serviceWorkers()[0]
    if (sw === undefined) {
      sw = await ctx.waitForEvent('serviceworker', { timeout: 30_000 })
    }
    expect(new URL(sw.url()).host.length).toBeGreaterThan(0)

    const manifest = await sw.evaluate(() => chrome.runtime.getManifest().name)
    expect(manifest).toBe('dsh 浏览器助手')

    // Clicking the toolbar icon must open the side panel automatically.
    const behavior = await sw.evaluate(() => chrome.sidePanel.getPanelBehavior())
    expect(behavior.openPanelOnActionClick).toBe(true)

    const extensionId = new URL(sw.url()).host
    const panel = await ctx.newPage()
    await panel.goto(`chrome-extension://${extensionId}/panel/index.html`)
    await panel.waitForSelector('header.topbar', { timeout: 15_000 })
    const discoveryUrl = `http://127.0.0.1:${port}/ext/bridge-config`
    expect((await fetch(discoveryUrl)).status).toBe(200)
    expect(await panel.evaluate(async (url) => (await fetch(url)).status, discoveryUrl)).toBe(200)

    // Pin the bridge deterministically through the real settings UI (URL +
    // token). Auto-discovery is environment-dependent — a local dsh may own
    // port 3081 — so without pinning, the panel could connect to a different
    // bridge than this composition and the store assertions would be void.
    // The URL is entered WITHOUT the /ext/bridge path: the extension must
    // normalize it (regression guard for manual address entry).
    const sessions = context.get('sessions') as {
      list(): Array<{ id: string; header: { cwd?: string } }>
    }
    const initialSessions = sessions.list()
    const initialIds = new Set(initialSessions.map(session => session.id))

    await panel.click('button[aria-label="打开设置"]')
    await panel.fill('input[placeholder*="自动检测"]', `ws://127.0.0.1:${port}`)
    await panel.fill('input[type="password"]', TOKEN)
    await panel.selectOption('select', 'ask')
    await panel.click('text=保存并连接')

    // The settings must land in background storage before the reconnect.
    await panel.waitForFunction((expected) => {
      return chrome.storage.local.get('dshSettings').then((stored) => {
        const settings = stored.dshSettings as { bridgeUrl?: string } | undefined
        return settings?.bridgeUrl === expected
      })
    }, `ws://127.0.0.1:${port}`, { timeout: 15_000 })

    // The panel must report "connected" after the token-authenticated
    // reconnect to this composition. (Intermediate states like 未连接 can be
    // coalesced into one render frame, so only the end state is asserted.)
    await expect.poll(
      () => panel.locator('.connection').textContent(),
      { timeout: 30_000 },
    ).toContain('已连接')
    const statusText = await panel.textContent('.connection')

    // The compact header keeps status and settings at the edges while the
    // centered current-session title owns the history dropdown.
    expect(await panel.locator('.brand').count()).toBe(0)
    const sessionMenu = panel.locator('.session-menu-trigger')
    await expect.poll(() => sessionMenu.isEnabled(), { timeout: 15_000 }).toBe(true)
    expect(await sessionMenu.textContent()).toContain('新对话')
    await sessionMenu.click()
    await panel.locator('.session-picker').waitFor({ state: 'visible' })
    await sessionMenu.click()
    await panel.locator('.session-picker').waitFor({ state: 'hidden' })

    // A real tool call must pause in the service worker until the real panel
    // resolves its origin-scoped approval. Keep a normal HTTP tab active while
    // the panel remains open as a separate extension page in this headless test.
    const target = await ctx.newPage()
    await target.goto(`http://127.0.0.1:${port}/e2e-approval-page`)
    await target.setContent('<main><h1>Approval target</h1><button>Continue</button></main>')
    // Prepare the extra window before binding a controlled tab. Headless
    // Chromium may briefly focus a newly created window despite
    // `focused: false`; bringing `target` forward afterwards establishes the
    // intended foreground window before any browser tool runs.
    const backgroundTarget = await sw.evaluate(async (url) => {
      const backgroundWindow = await chrome.windows.create({ url, focused: false })
      if (backgroundWindow?.id === undefined) throw new Error('failed to create background window')
      const alternate = await chrome.tabs.create({ windowId: backgroundWindow.id, url, active: false })
      if (alternate.id === undefined) throw new Error('failed to create background tab')
      return { tabId: alternate.id, windowId: backgroundWindow.id }
    }, `http://127.0.0.1:${port}/e2e-approval-page`)
    await target.bringToFront()
    const snapshot = context.tools.execute({
      callId: 'e2e-browser-snapshot' as never,
      name: 'browser_snapshot',
      arguments: {},
      signal: new AbortController().signal,
    })
    const approval = panel.locator('.approval-dialog')
    await Promise.race([
      approval.waitFor({ state: 'visible', timeout: 15_000 }),
      snapshot.then((result) => {
        throw new Error(`snapshot settled before its approval appeared: ${JSON.stringify(result)}`)
      }),
    ])
    expect(await approval.locator('#approval-title').textContent()).toBe('允许读取页面？')
    expect(await approval.textContent()).toContain(`http://127.0.0.1:${port}`)
    expect(await approval.locator('button.session-trust').count()).toBe(0)
    expect(await approval.locator('button.read-always').count()).toBe(1)
    await approval.locator('button.read-always').click()
    const snapshotResult = await snapshot
    expect(snapshotResult.isError).toBe(false)
    if (!snapshotResult.isError) {
      expect(snapshotResult.value).toMatchObject({ text: expect.stringContaining('UNTRUSTED_PAGE_CONTENT') })
    }
    await approval.waitFor({ state: 'hidden', timeout: 15_000 })
    await panel.waitForFunction(() => chrome.storage.local.get('dshSettings').then((stored) => {
      return (stored.dshSettings as { sharePageContent?: string } | undefined)?.sharePageContent === 'auto'
    }), undefined, { timeout: 15_000 })

    // "Always allow reads" changes the persisted read policy, so the next
    // snapshot completes without another approval dialog.
    await target.bringToFront()
    const repeatedSnapshot = await context.tools.execute({
      callId: 'e2e-browser-snapshot-repeated' as never,
      name: 'browser_snapshot',
      arguments: { delta: true },
      signal: new AbortController().signal,
    })
    expect(repeatedSnapshot.isError).toBe(false)
    expect(await approval.isVisible()).toBe(false)

    // Caller cancellation must withdraw a pending approval in the extension.
    // A late user response must never navigate after the tool has expired.
    const urlBeforeCancellation = target.url()
    const cancelled = new AbortController()
    const cancelledNavigation = context.tools.execute({
      callId: 'e2e-browser-navigate-cancelled' as never,
      name: 'browser_navigate',
      arguments: { url: `http://127.0.0.1:${port}/must-not-open` },
      signal: cancelled.signal,
    })
    await approval.waitFor({ state: 'visible', timeout: 15_000 })
    expect(await approval.locator('#approval-title').textContent()).toBe('允许执行页面操作？')
    cancelled.abort()
    expect((await cancelledNavigation).isError).toBe(true)
    await approval.waitFor({ state: 'hidden', timeout: 15_000 })
    await target.waitForTimeout(200)
    expect(target.url()).toBe(urlBeforeCancellation)

    // An explicit denial must reach the tool caller as that exact event. It
    // must not be collapsed with a missing panel or an unanswered prompt.
    const deniedPress = context.tools.execute({
      callId: 'e2e-browser-press-denied' as never,
      name: 'browser_press',
      arguments: { key: 'Escape' },
      signal: new AbortController().signal,
    })
    await approval.waitFor({ state: 'visible', timeout: 15_000 })
    await approval.locator('button.deny').click()
    const deniedResult = await deniedPress
    expect(deniedResult.isError).toBe(true)
    if (deniedResult.isError) {
      expect(deniedResult.error.message).toBe('The user denied the browser approval request for "browser_press".')
    }
    await approval.waitFor({ state: 'hidden', timeout: 15_000 })

    // The first state-changing operation can trust this origin only for the
    // current side-panel lifetime. A second operation on the same origin then
    // runs without another prompt; persistent trust is managed in Settings.
    await target.bringToFront()
    const firstPress = context.tools.execute({
      callId: 'e2e-browser-press-first' as never,
      name: 'browser_press',
      arguments: { key: 'Escape' },
      signal: new AbortController().signal,
    })
    await approval.waitFor({ state: 'visible', timeout: 15_000 })
    expect(await approval.locator('#approval-title').textContent()).toBe('允许执行页面操作？')
    expect(await approval.textContent()).not.toContain('网页内容可能包含')
    expect(await approval.locator('button.session-trust').count()).toBe(1)
    await approval.locator('button.session-trust').click()
    expect((await firstPress).isError).toBe(false)
    await approval.waitFor({ state: 'hidden', timeout: 15_000 })

    await target.bringToFront()
    const repeatedPress = await context.tools.execute({
      callId: 'e2e-browser-press-repeated' as never,
      name: 'browser_press',
      arguments: { key: 'Escape' },
      signal: new AbortController().signal,
    })
    expect(repeatedPress.isError).toBe(false)
    expect(await approval.isVisible()).toBe(false)

    // An active-tab change inside an unfocused Chrome window is not a user
    // handoff. It must leave the focused target bound and keep tools running.
    await sw.evaluate(async ({ tabId, windowId }) => {
      const backgroundWindow = await chrome.windows.get(windowId)
      if (backgroundWindow.focused) throw new Error('background test window unexpectedly has focus')
      await chrome.tabs.update(tabId, { active: true })
    }, backgroundTarget)
    await panel.waitForTimeout(250)
    expect(await panel.locator('.tab-affinity').count()).toBe(0)
    const afterBackgroundActivation = await context.tools.execute({
      callId: 'e2e-browser-snapshot-after-background-activation' as never,
      name: 'browser_snapshot',
      arguments: {},
      signal: new AbortController().signal,
    })
    if (afterBackgroundActivation.isError) {
      throw new Error(`background activation interrupted the controlled tab: ${JSON.stringify(afterBackgroundActivation)}`)
    }
    expect(afterBackgroundActivation.value).toMatchObject({ text: expect.stringContaining('Approval target') })
    await sw.evaluate((windowId) => chrome.windows.remove(windowId), backgroundTarget.windowId)

    // A manual tab switch must never silently retarget browser tools. The
    // side panel exposes the A → B relationship, blocks tools until a choice,
    // and can explicitly keep operating A in the background.
    const other = await ctx.newPage()
    await other.goto(`http://127.0.0.1:${port}/e2e-approval-page`)
    await other.setContent('<main><h1>Other target</h1><button>Continue elsewhere</button></main>')
    await other.bringToFront()
    const handoff = panel.locator('.tab-affinity.handoff')
    await handoff.waitFor({ state: 'visible', timeout: 15_000 })
    expect(await handoff.textContent()).toContain('助手要跟随当前页面吗？')
    expect(await handoff.locator('.tab-affinity-node').count()).toBe(2)

    const blockedSnapshot = await context.tools.execute({
      callId: 'e2e-browser-snapshot-blocked-by-handoff' as never,
      name: 'browser_snapshot',
      arguments: {},
      signal: new AbortController().signal,
    })
    expect(blockedSnapshot.isError).toBe(true)
    if (blockedSnapshot.isError) {
      expect(blockedSnapshot.error.message).toBe(
        'The user switched tabs, so browser operations are paused. In the side panel, choose whether to keep the previous page or follow the current page.',
      )
    }

    await handoff.locator('button.keep').click()
    const backgroundAffinity = panel.locator('.tab-affinity.background')
    await backgroundAffinity.waitFor({ state: 'visible', timeout: 15_000 })
    expect(await backgroundAffinity.textContent()).toContain('后续浏览器操作仍会在原页面执行')
    const originalSnapshot = await context.tools.execute({
      callId: 'e2e-browser-snapshot-original-tab' as never,
      name: 'browser_snapshot',
      arguments: {},
      signal: new AbortController().signal,
    })
    expect(originalSnapshot.isError).toBe(false)
    if (!originalSnapshot.isError) expect(originalSnapshot.value).toMatchObject({ text: expect.stringContaining('Approval target') })

    await backgroundAffinity.locator('button.follow').click()
    await panel.locator('.tab-affinity').waitFor({ state: 'hidden', timeout: 15_000 })

    // Session deferral: opening the panel and using browser tools alone must
    // leave no session trace. The first prompt materializes the provisional
    // session, but it may not overtake the followed-page refresh.
    await panel.waitForSelector('.messages', { timeout: 30_000 })
    await panel.waitForTimeout(1_200)
    expect(sessions.list().length).toBe(initialSessions.length)
    await panel.fill('textarea', '这个页面的标题是什么？')
    await panel.press('textarea', 'Enter')
    await expect.poll(() => sessions.list().length, { timeout: 30_000 }).toBeGreaterThan(initialSessions.length)

    const createdSession = sessions.list().find(session => !initialIds.has(session.id))
    if (createdSession === undefined) throw new Error('the panel did not materialize its deferred session')
    await expect.poll(
      () => inboxInsertions.filter(entry => entry.agentId === createdSession.id).length,
      { timeout: 15_000 },
    ).toBeGreaterThanOrEqual(1)
    const sessionInbox = inboxInsertions.filter(entry => entry.agentId === createdSession.id)
    const browserContextIndex = sessionInbox.findIndex(({ message }) => {
      return message.source.kind === 'plugin'
        && message.source.plugin === BRIDGE
        && message.source.form === 'snapshot'
    })
    expect(browserContextIndex).toBeGreaterThanOrEqual(0)
    expect(JSON.stringify(sessionInbox[browserContextIndex]!.message.content)).toContain('Other target')

    const workspace = (context.get('workspaceRegistry') as WorkspaceRegistry).list()[0]
    expect(workspace?.path).toBe(await realpath(join(root as string, 'browser-sessions')))
    expect(workspace?.sessionIds).toContain(createdSession.id)
    expect(createdSession.header.cwd).toBe(workspace?.path)

    // Closing the controlled tab is a distinct fail-closed state; the current
    // page must be selected explicitly before tools can resume.
    await other.close()
    await target.bringToFront()
    const lostAffinity = panel.locator('.tab-affinity.lost')
    await lostAffinity.waitFor({ state: 'visible', timeout: 15_000 })
    expect(await lostAffinity.textContent()).toContain('受控标签页已关闭')
    const lostSnapshot = await context.tools.execute({
      callId: 'e2e-browser-snapshot-blocked-by-lost-tab' as never,
      name: 'browser_snapshot',
      arguments: {},
      signal: new AbortController().signal,
    })
    expect(lostSnapshot.isError).toBe(true)
    if (lostSnapshot.isError) {
      expect(lostSnapshot.error.message).toBe(
        'The controlled tab was closed. Select the current page in the side panel before retrying.',
      )
    }
    await lostAffinity.locator('button.follow').click()
    await panel.locator('.tab-affinity').waitFor({ state: 'hidden', timeout: 15_000 })

    // A host-side ask_user_question request for this exact live agent must be
    // rendered and answered by the sidebar. Keep both the short header and the
    // complete question in the assertion: losing the latter was the original
    // review regression when a request supplied both fields.
    const agent = context.agents.get(createdSession.id)
    if (agent === undefined) throw new Error('the panel session has no live agent')
    const answer = context.userQuestions.ask({
      agent,
      questions: [
        {
          id: 'constructor',
          header: 'Transport',
          question: 'Which transport should the sidebar use?',
          detail: 'Choose the primary connection for this session.',
          options: [
            { label: 'WebSocket', description: 'Keep the live bridge connection.' },
            { label: 'Polling', description: 'Periodically fetch new events.' },
          ],
        },
        {
          id: 'constructor',
          question: 'Which optional capabilities should be enabled?',
          options: [{ label: 'Delta snapshots' }, { label: 'Stable element IDs' }],
          multiSelect: true,
        },
      ],
    })
    const questionCard = panel.locator('.question-card')
    await questionCard.waitFor({ state: 'visible', timeout: 15_000 })
    expect(await questionCard.locator('.question-header').textContent()).toBe('Transport')
    expect(await questionCard.textContent()).toContain('Which transport should the sidebar use?')
    expect(await questionCard.textContent()).toContain('Choose the primary connection for this session.')
    await questionCard.locator('.question-item').nth(0).locator('.question-option', { hasText: 'WebSocket' }).click()
    await questionCard.locator('.question-item').nth(1).locator('.question-custom').fill('Session-scoped confirmations')
    await questionCard.locator('.question-item').nth(1).locator('.question-option', { hasText: 'Delta snapshots' }).click()
    await questionCard.locator('.question-actions .primary').click()
    await expect(answer).resolves.toEqual({
      answers: [
        { id: 'constructor', selected: ['WebSocket'] },
        { id: 'constructor', selected: ['Delta snapshots'], custom: 'Session-scoped confirmations' },
      ],
    })
    await questionCard.waitFor({ state: 'hidden', timeout: 15_000 })

    // Concurrent asks stay queued by rpcId. Resolving the first reveals the
    // second, and dismissing that second ask must produce a schema-valid
    // cancelled RpcError that actually rejects the host Promise.
    const firstConcurrentAnswer = context.userQuestions.ask({
      agent,
      questions: [{ id: '__proto__', question: 'Answer the first concurrent question.' }],
    })
    const secondConcurrentOutcome = context.userQuestions.ask({
      agent,
      questions: [{ id: 'toString', question: 'Dismiss the second concurrent question.' }],
    }).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    await questionCard.waitFor({ state: 'visible', timeout: 15_000 })
    await expect.poll(() => questionCard.textContent()).toContain('Answer the first concurrent question.')
    await questionCard.locator('.question-custom').fill('first answer')
    await questionCard.locator('.question-actions .primary').click()
    await expect(firstConcurrentAnswer).resolves.toEqual({
      answers: [{ id: '__proto__', selected: [], custom: 'first answer' }],
    })
    await expect.poll(() => questionCard.textContent()).toContain('Dismiss the second concurrent question.')
    await questionCard.locator('.question-actions .secondary').click()
    expect(await secondConcurrentOutcome).toMatchObject({ ok: false, error: { code: 'ASK_CANCELLED' } })
    await questionCard.waitFor({ state: 'hidden', timeout: 15_000 })

    // Closing the panel must leave a new approval pending, surface a system
    // notification, and replay the request when the panel returns. The owning
    // session is restored before the approval becomes visible, so its history
    // supplies the decision context instead of a fresh empty chat.
    await panel.close()
    const pendingAfterClose = context.tools.execute({
      callId: 'e2e-browser-press-panel-closed' as never,
      name: 'browser_press',
      arguments: { key: 'Escape' },
      agent,
      signal: new AbortController().signal,
    })
    await expect.poll(async () => {
      return Object.keys(await sw.evaluate(() => chrome.notifications.getAll())).length
    }, { timeout: 15_000 }).toBeGreaterThan(0)

    const reopenedUrl = `chrome-extension://${extensionId}/panel/index.html`
    const reopenedPage = ctx.waitForEvent('page')
    await sw.evaluate(async (url) => {
      await chrome.tabs.create({ url, active: false })
    }, reopenedUrl)
    const reopenedPanel = await reopenedPage
    await reopenedPanel.waitForSelector('header.topbar', { timeout: 15_000 })
    const reopenedApproval = reopenedPanel.locator('.approval-dialog')
    await reopenedApproval.waitFor({ state: 'visible', timeout: 15_000 })
    await expect.poll(async () => {
      const stored = await sw.evaluate(() => chrome.storage.session.get('dshRecentBrowserSession'))
      return stored.dshRecentBrowserSession
    }, { timeout: 15_000 }).toBe(createdSession.id)
    await reopenedApproval.locator('button.allow').click()
    expect((await pendingAfterClose).isError).toBe(false)
    await expect.poll(async () => {
      return Object.keys(await sw.evaluate(() => chrome.notifications.getAll())).length
    }, { timeout: 15_000 }).toBe(0)
    await reopenedPanel.close()

    expect(statusText).toContain('已连接')

  }, 120_000)
})
