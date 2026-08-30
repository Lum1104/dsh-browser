// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { connectPanel, PanelRpcError } from '../src/panel/api.ts'
import { isApprovalDecision, type ApprovalRequest } from '../src/security/approval.ts'
import type { TabAffinityState } from '../src/background/tab-affinity.ts'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('panel protocol', () => {
  it('accepts session trust while retaining the previous permanent-trust wire value', () => {
    expect(isApprovalDecision('always-allow-reads')).toBe(true)
    expect(isApprovalDecision('trust-session')).toBe(true)
    expect(isApprovalDecision('trust-origin')).toBe(true)
    expect(isApprovalDecision('trust-forever')).toBe(false)
  })

  it('preserves structured gateway failures for product-level handling', async () => {
    let receive: ((message: unknown) => void) | undefined
    const postMessage = vi.fn()
    const port = {
      postMessage,
      onMessage: { addListener: vi.fn((listener: (message: unknown) => void) => { receive = listener }) },
      onDisconnect: { addListener: vi.fn() },
    }
    vi.stubGlobal('chrome', { runtime: { connect: vi.fn(() => port) } })
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('12345678-1234-4234-8234-123456789aba')
    const api = connectPanel()

    const pending = api.rpc('session.prompt', { sessionId: 'session-1' })
    expect(postMessage).toHaveBeenCalledWith({
      type: 'rpc',
      id: '12345678-1234-4234-8234-123456789aba',
      method: 'session.prompt',
      payload: { sessionId: 'session-1' },
    })
    receive?.({
      type: 'rpc.result',
      id: '12345678-1234-4234-8234-123456789aba',
      ok: false,
      error: {
        code: 'attachment-error',
        message: 'Model does not support image input.',
        details: { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' },
      },
    })

    await expect(pending).rejects.toEqual(expect.objectContaining<Partial<PanelRpcError>>({
      name: 'PanelRpcError',
      code: 'attachment-error',
      message: 'Model does not support image input.',
      details: { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' },
    }))
  })

  it('delivers approval requests, resolution events, and correlated decisions', () => {
    let receive: ((message: unknown) => void) | undefined
    const postMessage = vi.fn()
    const port = {
      postMessage,
      onMessage: { addListener: vi.fn((listener: (message: unknown) => void) => { receive = listener }) },
      onDisconnect: { addListener: vi.fn() },
    }
    vi.stubGlobal('chrome', { runtime: { connect: vi.fn(() => port) } })
    const api = connectPanel()
    const requestListener = vi.fn()
    const resolvedListener = vi.fn()
    api.onApprovalRequest(requestListener)
    api.onApprovalResolved(resolvedListener)
    const request: ApprovalRequest = {
      id: 'approval-1',
      kind: 'action',
      action: 'browser_click',
      summary: '点击元素 [3]',
      origins: ['https://example.com'],
      canTrust: true,
    }

    receive?.({ type: 'approval.request', request })
    receive?.({ type: 'approval.resolved', id: request.id })
    api.respondToApproval(request.id, 'trust-session')

    expect(requestListener).toHaveBeenCalledWith(request)
    expect(resolvedListener).toHaveBeenCalledWith(request.id)
    expect(postMessage).toHaveBeenCalledWith({
      type: 'approval.response',
      id: request.id,
      decision: 'trust-session',
    })
  })

  it('delivers tab-affinity state and sends revision-bound handoff choices', () => {
    let receive: ((message: unknown) => void) | undefined
    const postMessage = vi.fn()
    const port = {
      postMessage,
      onMessage: { addListener: vi.fn((listener: (message: unknown) => void) => { receive = listener }) },
      onDisconnect: { addListener: vi.fn() },
    }
    vi.stubGlobal('chrome', { runtime: { connect: vi.fn(() => port) } })
    const api = connectPanel()
    const listener = vi.fn()
    api.onTabAffinity(listener)
    const state: TabAffinityState = {
      revision: 4,
      status: 'handoff',
      controlled: { tabId: 1, windowId: 2, title: 'Original', url: 'https://original.example/' },
      active: { tabId: 3, windowId: 2, title: 'Current', url: 'https://current.example/' },
    }

    receive?.({ type: 'tab-affinity', state })
    api.resolveTabAffinity(state.revision, 'follow', 'session-1')

    expect(listener).toHaveBeenCalledWith(state)
    expect(postMessage).toHaveBeenCalledWith({
      type: 'tab-affinity.response',
      revision: 4,
      decision: 'follow',
      sessionId: 'session-1',
    })
  })

  it('waits for a correlated acknowledgement before completing a tab rebind', async () => {
    vi.useFakeTimers()
    let receive: ((message: unknown) => void) | undefined
    const postMessage = vi.fn()
    const port = {
      postMessage,
      onMessage: { addListener: vi.fn((listener: (message: unknown) => void) => { receive = listener }) },
      onDisconnect: { addListener: vi.fn() },
    }
    vi.stubGlobal('chrome', { runtime: { connect: vi.fn(() => port) } })
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('12345678-1234-4234-8234-123456789abe')
    const api = connectPanel()

    const pending = api.rebindTabAffinity()
    const settled = vi.fn()
    void pending.then(() => { settled('resolved') }, () => { settled('rejected') })
    expect(postMessage).toHaveBeenCalledWith({
      type: 'tab-affinity.rebind',
      id: '12345678-1234-4234-8234-123456789abe',
    })
    await vi.advanceTimersByTimeAsync(20_000)
    expect(settled).not.toHaveBeenCalled()

    receive?.({
      type: 'tab-affinity.rebind.result',
      id: '12345678-1234-4234-8234-123456789abe',
      ok: true,
    })
    await expect(pending).resolves.toBeUndefined()
  })

  it('keeps a failed tab rebind visible to the caller', async () => {
    let receive: ((message: unknown) => void) | undefined
    const port = {
      postMessage: vi.fn(),
      onMessage: { addListener: vi.fn((listener: (message: unknown) => void) => { receive = listener }) },
      onDisconnect: { addListener: vi.fn() },
    }
    vi.stubGlobal('chrome', { runtime: { connect: vi.fn(() => port) } })
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('12345678-1234-4234-8234-123456789abf')
    const api = connectPanel()

    const pending = api.rebindTabAffinity()
    receive?.({
      type: 'tab-affinity.rebind.result',
      id: '12345678-1234-4234-8234-123456789abf',
      ok: false,
      error: { code: 'no-active-tab', message: 'current tab unavailable' },
    })

    await expect(pending).rejects.toThrow('current tab unavailable')
  })

  it('delivers a resume hint and records the panel session', () => {
    let receive: ((message: unknown) => void) | undefined
    const postMessage = vi.fn()
    const port = {
      postMessage,
      onMessage: { addListener: vi.fn((listener: (message: unknown) => void) => { receive = listener }) },
      onDisconnect: { addListener: vi.fn() },
    }
    vi.stubGlobal('chrome', { runtime: { connect: vi.fn(() => port) } })
    const api = connectPanel()
    const listener = vi.fn()
    api.onSessionResumeHint(listener)

    receive?.({ type: 'session.resume-hint', sessionId: 'session-recent' })
    void api.setActiveSession('session-current', true)

    expect(listener).toHaveBeenCalledWith('session-recent')
    expect(postMessage).toHaveBeenCalledWith({ type: 'session.active', sessionId: 'session-current', isNew: true })
  })

  it('correlates host-interaction answers with globally unique response ids', async () => {
    let receive: ((message: unknown) => void) | undefined
    const postMessage = vi.fn()
    const port = {
      postMessage,
      onMessage: { addListener: vi.fn((listener: (message: unknown) => void) => { receive = listener }) },
      onDisconnect: { addListener: vi.fn() },
    }
    vi.stubGlobal('chrome', { runtime: { connect: vi.fn(() => port) } })
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('12345678-1234-4234-8234-123456789abc')
    const api = connectPanel()

    const pending = api.respond('question-rpc', {
      ok: true,
      value: { sessionId: 'session-1', answer: { answers: [] } },
    })
    expect(postMessage).toHaveBeenCalledWith({
      type: 'respond',
      id: '12345678-1234-4234-8234-123456789abc',
      rpcId: 'question-rpc',
      result: { ok: true, value: { sessionId: 'session-1', answer: { answers: [] } } },
    })
    receive?.({
      type: 'respond.result',
      id: '12345678-1234-4234-8234-123456789abc',
      ok: true,
      result: { accepted: true },
    })
    await expect(pending).resolves.toEqual({ accepted: true })
  })

  it('rejects a pending host-interaction answer when its receipt reports failure', async () => {
    let receive: ((message: unknown) => void) | undefined
    const port = {
      postMessage: vi.fn(),
      onMessage: { addListener: vi.fn((listener: (message: unknown) => void) => { receive = listener }) },
      onDisconnect: { addListener: vi.fn() },
    }
    vi.stubGlobal('chrome', { runtime: { connect: vi.fn(() => port) } })
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('12345678-1234-4234-8234-123456789abd')
    const api = connectPanel()
    const pending = api.respond('question-rpc', { ok: false, error: { code: 'cancelled', message: 'closed', details: {} } })
    receive?.({
      type: 'respond.result',
      id: '12345678-1234-4234-8234-123456789abd',
      ok: false,
      error: { code: 'bridge-disconnected', message: 'connection lost' },
    })
    await expect(pending).rejects.toThrow('connection lost')
  })

  it('waits for the replacement port when a call starts during reconnect', async () => {
    vi.useFakeTimers()
    let disconnectFirst: (() => void) | undefined
    let receiveSecond: ((message: unknown) => void) | undefined
    const firstPost = vi.fn()
    const secondPost = vi.fn()
    const first = {
      postMessage: firstPost,
      onMessage: { addListener: vi.fn() },
      onDisconnect: { addListener: vi.fn((listener: () => void) => { disconnectFirst = listener }) },
    }
    const second = {
      postMessage: secondPost,
      onMessage: { addListener: vi.fn((listener: (message: unknown) => void) => { receiveSecond = listener }) },
      onDisconnect: { addListener: vi.fn() },
    }
    const connect = vi.fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second)
    vi.stubGlobal('chrome', { runtime: { connect } })
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('12345678-1234-4234-8234-123456789ac0')
    const api = connectPanel()

    disconnectFirst?.()
    const pending = api.rpc<string>('session.list', {})
    expect(secondPost).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(150)
    expect(connect).toHaveBeenCalledTimes(2)
    expect(secondPost).toHaveBeenCalledWith({
      type: 'rpc',
      id: '12345678-1234-4234-8234-123456789ac0',
      method: 'session.list',
      payload: {},
    })
    receiveSecond?.({
      type: 'rpc.result',
      id: '12345678-1234-4234-8234-123456789ac0',
      ok: true,
      result: 'reconnected',
    })

    await expect(pending).resolves.toBe('reconnected')
  })

  it('rejects in-flight work from a disconnected port without replaying side effects', async () => {
    vi.useFakeTimers()
    let disconnectFirst: (() => void) | undefined
    const firstPost = vi.fn()
    const secondPost = vi.fn()
    const first = {
      postMessage: firstPost,
      onMessage: { addListener: vi.fn() },
      onDisconnect: { addListener: vi.fn((listener: () => void) => { disconnectFirst = listener }) },
    }
    const second = {
      postMessage: secondPost,
      onMessage: { addListener: vi.fn() },
      onDisconnect: { addListener: vi.fn() },
    }
    const connect = vi.fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second)
    vi.stubGlobal('chrome', { runtime: { connect } })
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('12345678-1234-4234-8234-123456789ac1')
    const api = connectPanel()

    const pending = api.rpc('session.prompt', { sessionId: 'session-1' })
    disconnectFirst?.()
    await expect(pending).rejects.toThrow('Background connection lost')
    await vi.advanceTimersByTimeAsync(150)

    expect(secondPost).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'rpc' }))
  })

  it('retries a message that a stale port synchronously refuses', async () => {
    vi.useFakeTimers()
    const first = {
      postMessage: vi.fn(() => { throw new Error('Attempting to use a disconnected port object') }),
      onMessage: { addListener: vi.fn() },
      onDisconnect: { addListener: vi.fn() },
    }
    const secondPost = vi.fn()
    const second = {
      postMessage: secondPost,
      onMessage: { addListener: vi.fn() },
      onDisconnect: { addListener: vi.fn() },
    }
    const connect = vi.fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second)
    vi.stubGlobal('chrome', { runtime: { connect } })
    const api = connectPanel()

    const sent = api.updateSettings({ bridgeUrl: 'ws://127.0.0.1:3080' })
    await vi.advanceTimersByTimeAsync(150)
    await expect(sent).resolves.toBeUndefined()

    expect(secondPost).toHaveBeenCalledWith({
      type: 'settings',
      settings: { bridgeUrl: 'ws://127.0.0.1:3080' },
    })
  })
})
