// @vitest-environment jsdom
/**
 * Developer-tools debugger session: attach/detach lifecycle, conflict mapping,
 * command timeouts, and pending-command settling on detach.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DebuggerSession,
  DevToolsError,
  debuggerApi,
  devToolsSupported,
  mapAttachFailure,
  type DebuggerApi,
  type DevToolsSessionListeners,
} from '../src/background/debugger-session.ts'

interface Harness {
  api: DebuggerApi
  attach: ReturnType<typeof vi.fn>
  detach: ReturnType<typeof vi.fn>
  sendCommand: ReturnType<typeof vi.fn>
  /** Methods that should never answer, simulating a stalled renderer. */
  hang: Set<string>
  emit: (method: string, params?: unknown) => void
  emitDetach: (reason: string) => void
}

function harness(options: { attachError?: Error; fail?: Set<string> } = {}): Harness {
  const eventListeners = new Set<(source: { tabId?: number }, method: string, params?: unknown) => void>()
  const detachListeners = new Set<(source: { tabId?: number }, reason: string) => void>()
  const hang = new Set<string>()
  const attach = vi.fn(async () => {
    if (options.attachError !== undefined) throw options.attachError
  })
  const detach = vi.fn(async () => undefined)
  const sendCommand = vi.fn(async (_target: { tabId: number }, method: string) => {
    if (options.fail?.has(method) === true) throw new Error(`${method} rejected`)
    if (hang.has(method)) return await new Promise(() => {})
    return {}
  })
  const api: DebuggerApi = {
    attach,
    detach,
    sendCommand: sendCommand as unknown as DebuggerApi['sendCommand'],
    onEvent: {
      addListener: (listener) => { eventListeners.add(listener) },
      removeListener: (listener) => { eventListeners.delete(listener) },
    },
    onDetach: {
      addListener: (listener) => { detachListeners.add(listener) },
      removeListener: (listener) => { detachListeners.delete(listener) },
    },
  }
  return {
    api,
    attach,
    detach,
    sendCommand,
    hang,
    emit: (method, params) => { for (const listener of eventListeners) listener({ tabId: 42 }, method, params) },
    emitDetach: (reason) => { for (const listener of detachListeners) listener({ tabId: 42 }, reason) },
  }
}

const enabledMethods = ['DOM.enable', 'CSS.enable', 'Runtime.enable', 'Network.enable']

let harnessed: Harness

function createSession(h: Harness, listeners: DevToolsSessionListeners = {}, timeout = 50): DebuggerSession {
  return new DebuggerSession(42, h.api, listeners, timeout)
}

beforeEach(() => {
  harnessed = harness()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('DebuggerSession attach', () => {
  it('attaches once and enables the domains the tool group needs', async () => {
    const session = createSession(harnessed)
    await session.attach()
    expect(harnessed.attach).toHaveBeenCalledWith({ tabId: 42 }, '1.3')
    expect(harnessed.sendCommand.mock.calls.map((call) => call[1])).toEqual(enabledMethods)
    expect(session.isAttached).toBe(true)

    // Idempotent: a second attach keeps the existing attachment.
    await session.attach()
    expect(harnessed.attach).toHaveBeenCalledTimes(1)
  })

  it('maps a debugger conflict onto the actionable code', async () => {
    const conflict = harness({ attachError: new Error('Another debugger is already attached to the tab with id: 42') })
    await expect(createSession(conflict).attach()).rejects.toMatchObject({ code: 'devtools-conflict' })
    expect(mapAttachFailure('Another debugger is already attached')).toBeInstanceOf(DevToolsError)
    expect(mapAttachFailure('Another debugger is already attached').code).toBe('devtools-conflict')
    expect(mapAttachFailure(new Error('boom')).code).toBe('devtools-command-failed')
  })

  it('detaches again when enabling a domain fails, so no half-attachment leaks', async () => {
    const failing = harness({ fail: new Set(['CSS.enable']) })
    const session = createSession(failing)
    await expect(session.attach()).rejects.toMatchObject({ code: 'devtools-command-failed' })
    expect(session.isAttached).toBe(false)
    expect(failing.detach).toHaveBeenCalledWith({ tabId: 42 })
  })

  it('reports unsupported platforms without throwing', () => {
    vi.stubGlobal('chrome', {})
    expect(devToolsSupported()).toBe(false)
    expect(debuggerApi()).toBeUndefined()
    vi.stubGlobal('chrome', { debugger: harnessed.api })
    expect(devToolsSupported()).toBe(true)
    expect(debuggerApi()).toBe(harnessed.api)
  })
})

describe('DebuggerSession commands', () => {
  it('refuses commands before attach and after pause', async () => {
    const session = createSession(harnessed)
    await expect(session.send('Runtime.evaluate', {})).rejects.toMatchObject({ code: 'devtools-detached' })
    await session.attach()
    session.pause()
    await expect(session.send('Runtime.evaluate', {})).rejects.toMatchObject({ code: 'devtools-detached' })
    session.resume()
    await expect(session.send('Runtime.evaluate', { expression: '1' })).resolves.toEqual({})
  })

  it('times out a command that never answers', async () => {
    const session = createSession(harnessed)
    await session.attach()
    harnessed.hang.add('Runtime.evaluate')
    await expect(session.send('Runtime.evaluate', { expression: 'forever' })).rejects.toMatchObject({ code: 'devtools-timeout' })
  })

  it('reports a CDP failure with the command name', async () => {
    const session = createSession(harnessed)
    await session.attach()
    harnessed.hang.clear()
    const failing = harness({ fail: new Set(['Runtime.evaluate']) })
    const attached = createSession(failing)
    await attached.attach()
    await expect(attached.send('Runtime.evaluate', {})).rejects.toMatchObject({
      code: 'devtools-command-failed',
      message: expect.stringContaining('Runtime.evaluate'),
    })
  })

  it('settles in-flight commands when the debugger detaches underneath', async () => {
    const session = createSession(harnessed)
    await session.attach()
    harnessed.hang.add('Runtime.evaluate')
    const pending = session.send('Runtime.evaluate', { expression: '1' })
    harnessed.emitDetach('target closed')
    await expect(pending).rejects.toMatchObject({ code: 'devtools-detached' })
    expect(session.isAttached).toBe(false)
  })

  it('forwards events for its own tab only and reports detach', async () => {
    const events: [string, unknown][] = []
    const detaches: string[] = []
    const session = createSession(harnessed, {
      onCdpEvent: (method, params) => { events.push([method, params]) },
      onDetached: (reason) => { detaches.push(reason) },
    })
    await session.attach()
    harnessed.emit('Network.requestWillBeSent', { requestId: 'r1' })
    harnessed.emitDetach('replaced with another debugger')
    expect(events).toEqual([['Network.requestWillBeSent', { requestId: 'r1' }]])
    expect(detaches).toEqual(['replaced with another debugger'])
  })

  it('detaches cleanly and becomes a no-op afterwards', async () => {
    const session = createSession(harnessed)
    await session.attach()
    await session.detach()
    expect(session.isAttached).toBe(false)
    expect(harnessed.detach).toHaveBeenCalledWith({ tabId: 42 })
    await expect(session.detach()).resolves.toBeUndefined()
    expect(harnessed.detach).toHaveBeenCalledTimes(1)
  })

  it('rejects in-flight commands when the caller detaches first', async () => {
    const session = createSession(harnessed)
    await session.attach()
    harnessed.hang.add('Runtime.evaluate')
    const pending = session.send('Runtime.evaluate', {})
    await session.detach()
    await expect(pending).rejects.toMatchObject({ code: 'devtools-detached' })
  })

  it('does not attach when the platform reports no error but no promise either', async () => {
    const callbackStyle: DebuggerApi = {
      ...harnessed.api,
      sendCommand: (() => undefined) as unknown as DebuggerApi['sendCommand'],
    }
    const session = createSession({ ...harnessed, api: callbackStyle })
    await expect(session.attach()).rejects.toMatchObject({ code: 'devtools-command-failed' })
  })
})
