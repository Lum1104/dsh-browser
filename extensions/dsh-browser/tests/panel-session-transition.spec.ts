// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { BridgeState } from '../src/background/bridge.ts'
import type { PanelApi } from '../src/panel/api.ts'
import { BRIDGE_SESSION_PURGE_METHOD, type ServerFrame } from '@yuxianglin/dsh-bridge-browser/src/protocol.ts'

let panelApi: PanelApi

vi.mock('../src/panel/api.ts', () => ({
  connectPanel: (): PanelApi => panelApi,
}))

import { App } from '../src/panel/App.tsx'
import { createRemoteHostApi } from '@yuxianglin/dsh-bridge-browser/src/remote-host-api.ts'

describe('panel session transitions', () => {
  let root: Root
  let onStatus: ((state: BridgeState, caps: null) => void) | undefined
  let onResumeHint: ((sessionId: string | null) => void) | undefined
  let onEvent: ((frame: ServerFrame) => void) | undefined
  let rpc: Mock<(method: string, payload?: unknown) => Promise<unknown>>

  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    HTMLElement.prototype.scrollTo = vi.fn()
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn(async () => ({ dshSettings: { autoResumeSession: false } })),
        },
      },
      windows: { getCurrent: vi.fn(async () => ({ id: 1 })) },
    })

    rpc = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === 'session.create') return { sessionId: 'session-current' }
      if (method === 'session.history') return { events: [] }
      if (method === 'session.list') {
        return {
          items: [
            { sessionId: 'session-current', updatedAt: 2, running: false, blank: false },
            { sessionId: 'session-saved', updatedAt: 1, running: false, blank: false },
          ],
        }
      }
      throw new Error(`unexpected RPC: ${method}`)
    })
    const unsubscribe = (): void => {}
    panelApi = {
      rpc: async <T = unknown>(method: string, payload?: unknown): Promise<T> =>
        await rpc(method, payload) as T,
      respond: vi.fn(async () => undefined),
      onStatus: vi.fn((callback) => { onStatus = callback; return unsubscribe }),
      onEvent: vi.fn((callback) => { onEvent = callback; return unsubscribe }),
      onApprovalRequest: vi.fn(() => unsubscribe),
      onApprovalResolved: vi.fn(() => unsubscribe),
      onTabAffinity: vi.fn(() => unsubscribe),
      onSelection: vi.fn(() => unsubscribe),
      onSessionResumeHint: vi.fn((callback) => { onResumeHint = callback; return unsubscribe }),
      respondToApproval: vi.fn(async () => {}),
      resolveTabAffinity: vi.fn(async () => {}),
      rebindTabAffinity: vi.fn(async () => {}),
      clearSelection: vi.fn(async () => {}),
      registerWindow: vi.fn(async () => {}),
      setActiveSession: vi.fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('runtime port unavailable')),
      updateSettings: vi.fn(async () => {}),
      requestStatus: vi.fn(async () => {}),
    }

    root = createRoot(document.querySelector('#root')!)
  })

  afterEach(async () => {
    await act(async () => { root.unmount() })
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  async function renderConnected(hint: string | null): Promise<void> {
    await act(async () => { root.render(createElement(App)) })
    await act(async () => {
      onStatus?.('connected', null)
      onResumeHint?.(hint)
    })
  }

  it('shows the saved Session model and allows switching to the deployment default', async () => {
    let selected = { provider: 'provider', model: 'saved-model' }
    const host = createRemoteHostApi({
      invoke: async ({ method, args }) => {
        if (method === 'modelCatalog') return {
          default: { provider: 'provider', model: 'default-model' },
          routableProviders: ['provider'],
          groups: [{ id: 'provider', name: 'Provider', models: [
            { id: 'default-model', name: 'Default model' }, { id: 'saved-model', name: 'Saved model' },
          ] }],
          failures: [],
        }
        if (method === 'projections') return { asOfSeq: 7, values: { modelSelection: { next: selected } } }
        if (method === 'selectModel') {
          const request = args.request as { provider: string; model: string }
          selected = { provider: request.provider, model: request.model }
          return { selected }
        }
        throw new Error(`Unexpected Host method: ${method}`)
      },
      wireStream: {
        open: async () => { throw new Error('unexpected stream') },
        failure: (error) => ({ code: 'internal', message: String(error), details: {} }),
      },
    }, { createSharedFetchHandler: () => ({ fetch: async () => { throw new Error('unexpected fetch') } }) })
    const original = rpc.getMockImplementation()!
    rpc.mockImplementation(async (method, payload) => {
      if (method !== 'session.models' && method !== 'session.selectModel') return original(method, payload)
      const result = await host.call({ rpcId: method, method, payload, signal: new AbortController().signal })
      if (!result.ok) throw new Error(result.error.message)
      return result.value
    })
    await renderConnected(null)
    const trigger = document.querySelector<HTMLButtonElement>('.composer-model-trigger')!
    expect(trigger.textContent).toContain('Saved model')
    await act(async () => { trigger.click() })
    const option = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')]
      .find((button) => button.textContent === 'Default model')!
    await act(async () => { option.click() })
    expect(rpc).toHaveBeenCalledWith('session.selectModel', {
      sessionId: 'session-current', provider: 'provider', model: 'default-model',
    })
    expect(selected.model).toBe('default-model')
    expect(trigger.textContent).toContain('Default model')
  })

  it('keeps following arriving rows and stops only when the reader scrolls up', async () => {
    await renderConnected(null)
    const messages = document.querySelector<HTMLDivElement>('.messages')!
    let scrollHeight = 1000
    let scrollTop = 400
    Object.defineProperties(messages, {
      scrollHeight: { get: () => scrollHeight },
      clientHeight: { get: () => 600 },
      scrollTop: { get: () => scrollTop },
    })
    // Model the intermediate scroll event produced by CSS smooth scrolling.
    messages.scrollTo = vi.fn((options: ScrollToOptions) => {
      const destination = Math.min(options.top ?? 0, scrollHeight - 600)
      scrollTop = options.behavior === 'instant' ? destination : scrollTop + 1
      messages.dispatchEvent(new Event('scroll'))
    }) as typeof messages.scrollTo
    const append = async (seq: number): Promise<void> => {
      await act(async () => {
        scrollHeight += 200
        onEvent?.({ t: 'event', frame: { rpcId: `row-${seq}`, method: 'session/event', payload: {
          sessionId: 'session-current', event: { type: 'assistant/message', seq, surfaceOp: 'append', data: {
            turn: seq, step: 0, message: { content: [{ type: 'text', text: `Message ${seq}` }] },
          } },
        } } })
      })
    }
    await append(1)
    await append(2)
    expect(scrollTop).toBe(scrollHeight - 600)
    expect(document.querySelector('.scroll-to-bottom')).toBeNull()

    await act(async () => {
      scrollTop -= 200
      messages.dispatchEvent(new Event('scroll'))
    })
    const readingPosition = scrollTop
    await append(3)
    expect(scrollTop).toBe(readingPosition)
    const jump = document.querySelector<HTMLButtonElement>('.scroll-to-bottom')!
    expect(jump).not.toBeNull()
    await act(async () => { jump.click() })
    expect(messages.scrollTo).toHaveBeenLastCalledWith({ top: scrollHeight, behavior: 'smooth' })
  })

  it('keeps the reconnect stream suffix when history resolves late, then shows only the durable settlement', async () => {
    let finishHistory: ((history: unknown) => void) | undefined
    const historyPromise = new Promise((resolve) => { finishHistory = resolve })
    const original = rpc.getMockImplementation()!
    rpc.mockImplementation(async (method, payload) => method === 'session.history' ? historyPromise : original(method, payload))
    const baseline = { revision: 2, activeAttempt: {
      attemptId: 'attempt-1', turn: 0, step: 0, startedAfterSeq: 4, nextIndex: 1,
      stream: [{ type: 'text-chunks', index: 0, time0: 1, dt: [], texts: ['Hello'] }],
    } }
    await renderConnected(null)
    const emit = (method: string, payload: unknown): void => {
      onEvent?.({ t: 'event', frame: { rpcId: 'event-1', method, payload } })
    }
    await act(async () => {
      emit('session/assistant-stream', { sessionId: 'session-current', snapshotId: 'snapshot-1', frame: { type: 'snapshot', baseline } })
      emit('session/assistant-stream', { sessionId: 'session-current', frame: {
        type: 'chunk', attemptId: 'attempt-1', revision: 3, index: 1, time: 2,
        chunk: { type: 'text-delta', index: 0, text: ' world' },
      } })
    })
    expect(document.querySelector('.row.assistant')?.textContent?.trim()).toBe('Hello world')
    await act(async () => {
      emit('session/event', { sessionId: 'session-current', event: {
        type: 'assistant/message', seq: 5, surfaceOp: 'append', data: {
          turn: 0, step: 0, message: { content: [{ type: 'text', text: 'Hello world!' }] },
        },
      } })
      emit('session/assistant-stream', { sessionId: 'session-current', frame: {
        type: 'end', attemptId: 'attempt-1', revision: 4, index: 2,
        outcome: { kind: 'committed', seq: 5, eventType: 'assistant/message' },
      } })
    })
    expect(document.querySelectorAll('.row.assistant')).toHaveLength(1)
    expect(document.querySelector('.row.assistant')?.textContent?.trim()).toBe('Hello world!')
    await act(async () => { finishHistory?.({ events: [], snapshotId: 'snapshot-1', assistantStream: baseline }) })
    expect(document.querySelectorAll('.row.assistant')).toHaveLength(1)
    expect(document.querySelector('.row.assistant')?.textContent?.trim()).toBe('Hello world!')
  })

  it.each([
    { state: 'omits assistantStream', assistantStream: undefined, activeText: undefined },
    { state: 'has no active attempt', assistantStream: { revision: 4 }, activeText: undefined },
    { state: 'has a new active attempt', assistantStream: {
      revision: 6,
      activeAttempt: {
        attemptId: 'attempt-new', turn: 1, step: 0, startedAfterSeq: 5, nextIndex: 1,
        stream: [{ type: 'text-chunks', index: 0, time0: 3, dt: [], texts: ['New response in progress'] }],
      },
    }, activeText: 'New response in progress' },
  ])('replaces a cached partial response on revisit when history $state', async ({ assistantStream, activeText }) => {
    panelApi.setActiveSession = vi.fn(async () => {})
    let currentHistoryReads = 0
    const original = rpc.getMockImplementation()!
    rpc.mockImplementation(async (method, payload) => {
      if (method === 'session.history' && (payload as { sessionId: string }).sessionId === 'session-current') {
        currentHistoryReads += 1
        if (currentHistoryReads > 1) {
          return {
            events: [{ event: { type: 'assistant/message', seq: 5, surfaceOp: 'append', data: {
              turn: 0, step: 0, message: { content: [{ type: 'text', text: 'Settled while away' }] },
            } } }],
            ...(assistantStream === undefined ? {} : { assistantStream }),
          }
        }
      }
      return original(method, payload)
    })
    await renderConnected(null)
    await act(async () => {
      onEvent?.({ t: 'event', frame: { rpcId: 'opening', method: 'session/assistant-stream', payload: {
        sessionId: 'session-current', snapshotId: 'old-follower',
        frame: { type: 'snapshot', baseline: { revision: 2, activeAttempt: {
          attemptId: 'attempt-old', turn: 0, step: 0, startedAfterSeq: 4, nextIndex: 1,
          stream: [{ type: 'text-chunks', index: 0, time0: 1, dt: [], texts: ['Stale partial response'] }],
        } } },
      } } })
    })
    expect(document.querySelector('.row.assistant')?.textContent?.trim()).toBe('Stale partial response')

    const selectSession = async (index: number): Promise<void> => {
      await act(async () => { document.querySelector<HTMLButtonElement>('.session-menu-trigger')!.click() })
      const sessions = document.querySelectorAll<HTMLButtonElement>('.session-list li > button:not(.session-delete)')
      expect(sessions).toHaveLength(2)
      await act(async () => { sessions[index]!.click() })
    }
    await selectSession(1)
    expect(panelApi.setActiveSession).toHaveBeenLastCalledWith('session-saved')
    expect(document.querySelector('.row.assistant')).toBeNull()

    // The old follower stops on switch; only the next history RPC reports what
    // settled while this session was inactive, before any fresh stream opening.
    await selectSession(0)
    expect(panelApi.setActiveSession).toHaveBeenLastCalledWith('session-current')
    expect(currentHistoryReads).toBe(2)
    const assistantTexts = [...document.querySelectorAll('.row.assistant')].map(row => row.textContent?.trim())
    expect(assistantTexts).toEqual([
      'Settled while away',
      ...(activeText === undefined ? [] : [activeText]),
    ])
  })

  it('keeps a session in the picker when the Host storage lock refuses deletion', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const original = rpc.getMockImplementation()!
    rpc.mockImplementation(async (method, payload) => {
      if (method === BRIDGE_SESSION_PURGE_METHOD) throw new Error('session storage is locked')
      return original(method, payload)
    })
    await renderConnected(null)
    const menu = document.querySelector<HTMLButtonElement>('.session-menu-trigger')!
    await act(async () => { menu.click() })
    const buttons = document.querySelectorAll<HTMLButtonElement>('.session-delete')
    expect(buttons).toHaveLength(2)
    await act(async () => { buttons[1]!.click() })
    expect(rpc).toHaveBeenCalledWith(BRIDGE_SESSION_PURGE_METHOD, { sessionId: 'session-saved' })
    expect(rpc.mock.calls.some(([method]) => method === 'workspace.archiveSession')).toBe(false)
    expect(document.querySelectorAll('.session-delete')).toHaveLength(2)
    expect(document.querySelector('.error')?.textContent).toContain('session storage is locked')
  })

  it('waits for the matching stream baseline when a replacement history RPC arrives first', async () => {
    await renderConnected(null)
    const emit = (snapshotId: string, baseline: unknown): void => {
      onEvent?.({ t: 'event', frame: { rpcId: 'stream', method: 'session/assistant-stream',
        payload: { sessionId: 'session-current', snapshotId, frame: { type: 'snapshot', baseline } },
      } })
    }
    await act(async () => { emit('opening', { revision: 0 }) })
    const original = rpc.getMockImplementation()!
    rpc.mockImplementation(async (method, payload) => method === 'session.history' ? {
      snapshotId: 'replacement', assistantStream: { revision: 4 },
      events: [{ event: { type: 'assistant/message', seq: 5, data: {
        message: { content: [{ type: 'text', text: 'Recovered response' }] },
      } } }],
    } : original(method, payload))
    await act(async () => {
      onEvent?.({ t: 'event', frame: { rpcId: 'gap', method: 'session/assistant-stream', payload: {
        sessionId: 'session-current', frame: {
          type: 'chunk', attemptId: 'missing', revision: 3, index: 1,
          chunk: { type: 'text-delta', index: 0, text: 'suffix without prefix' },
        },
      } } })
    })
    expect(rpc.mock.calls.filter(([method]) => method === 'session.history')).toHaveLength(2)
    expect(document.querySelector('.row.assistant')).toBeNull()
    await act(async () => { emit('replacement', { revision: 4 }) })
    expect(document.querySelector('.row.assistant')?.textContent?.trim()).toBe('Recovered response')
  })

  it('automatically restores only a valid contextual hint', async () => {
    const storageGet = chrome.storage.local.get as unknown as Mock
    storageGet.mockResolvedValue({ dshSettings: { autoResumeSession: true } })
    rpc.mockImplementation(async (method: string, payload?: unknown) => {
      if (method === 'session.list') {
        return { items: [
          { sessionId: 'session-page', updatedAt: 2, running: true, blank: true },
          { sessionId: 'session-global', updatedAt: 1, running: false, blank: false },
        ] }
      }
      if (method === 'workspace.list') return { archivedSessionIds: [] }
      if (method === 'session.history') return { events: [], sessionId: (payload as { sessionId?: string }).sessionId }
      if (method === 'session.create') return { sessionId: 'session-new' }
      throw new Error(`unexpected RPC: ${method}`)
    })
    panelApi.setActiveSession = vi.fn(async () => {})

    await renderConnected('session-page')

    await vi.waitFor(() => { expect(panelApi.setActiveSession).toHaveBeenCalledWith('session-page') })
    expect(rpc).not.toHaveBeenCalledWith('session.create', {})
  })

  it('creates a new session for a stale hint without falling back to global history', async () => {
    const storageGet = chrome.storage.local.get as unknown as Mock
    storageGet.mockResolvedValue({ dshSettings: { autoResumeSession: true } })
    rpc.mockImplementation(async (method: string) => {
      if (method === 'session.list') {
        return { items: [{ sessionId: 'session-global', updatedAt: 9, running: false, blank: false }] }
      }
      if (method === 'workspace.list') return { archivedSessionIds: [] }
      if (method === 'session.create') return { sessionId: 'session-new' }
      if (method === 'session.history') return { events: [] }
      throw new Error(`unexpected RPC: ${method}`)
    })
    panelApi.setActiveSession = vi.fn(async () => {})

    await renderConnected('session-missing')

    await vi.waitFor(() => { expect(panelApi.setActiveSession).toHaveBeenCalledWith('session-new', true) })
    expect(panelApi.setActiveSession).not.toHaveBeenCalledWith('session-global')
  })

  it.each([
    ['archived', true, false],
    ['unreadable', false, true],
  ])('creates a new session when the contextual hint is %s', async (_case, archived, historyFails) => {
    const storageGet = chrome.storage.local.get as unknown as Mock
    storageGet.mockResolvedValue({ dshSettings: { autoResumeSession: true } })
    rpc.mockImplementation(async (method: string, payload?: unknown) => {
      if (method === 'session.list') {
        return { items: [{ sessionId: 'session-page', updatedAt: 1, running: false, blank: false }] }
      }
      if (method === 'workspace.list') return { archivedSessionIds: archived ? ['session-page'] : [] }
      if (method === 'session.create') return { sessionId: 'session-new' }
      if (method === 'session.history') {
        if ((payload as { sessionId?: string }).sessionId === 'session-page' && historyFails) throw new Error('missing history')
        return { events: [] }
      }
      throw new Error(`unexpected RPC: ${method}`)
    })
    panelApi.setActiveSession = vi.fn(async () => {})

    await renderConnected('session-page')

    await vi.waitFor(() => { expect(panelApi.setActiveSession).toHaveBeenCalledWith('session-new', true) })
    expect(panelApi.setActiveSession).not.toHaveBeenCalledWith('session-page')
  })

  it('does not scan global history when the current page has no hint', async () => {
    const storageGet = chrome.storage.local.get as unknown as Mock
    storageGet.mockResolvedValue({ dshSettings: { autoResumeSession: true } })
    panelApi.setActiveSession = vi.fn(async () => {})

    await renderConnected(null)

    await vi.waitFor(() => { expect(panelApi.setActiveSession).toHaveBeenCalledWith('session-current', true) })
    expect(rpc).not.toHaveBeenCalledWith('session.list', {})
  })

  it('waits for a fresh contextual hint after a bridge restart', async () => {
    const storageGet = chrome.storage.local.get as unknown as Mock
    storageGet.mockResolvedValue({ dshSettings: { autoResumeSession: true } })
    rpc.mockImplementation(async (method: string) => {
      if (method === 'session.list') {
        return { items: [{ sessionId: 'session-page', updatedAt: 1, running: false, blank: false }] }
      }
      if (method === 'workspace.list') return { archivedSessionIds: [] }
      if (method === 'session.history') return { events: [] }
      if (method === 'session.create') return { sessionId: 'session-after-restart' }
      throw new Error(`unexpected RPC: ${method}`)
    })
    panelApi.setActiveSession = vi.fn(async () => {})
    await renderConnected('session-page')
    await vi.waitFor(() => { expect(panelApi.setActiveSession).toHaveBeenCalledWith('session-page') })

    await act(async () => { onStatus?.('stopped', null) })
    await act(async () => { onStatus?.('connected', null) })
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(panelApi.setActiveSession).toHaveBeenCalledTimes(1)

    await act(async () => { onResumeHint?.(null) })
    await vi.waitFor(() => {
      expect(panelApi.setActiveSession).toHaveBeenCalledWith('session-after-restart', true)
    })
  })

  it('releases the controls and surfaces an activation failure', async () => {
    await act(async () => { root.render(createElement(App)) })
    await act(async () => {
      onStatus?.('connected', null)
      onResumeHint?.(null)
    })
    await vi.waitFor(() => {
      expect(panelApi.setActiveSession).toHaveBeenCalledWith('session-current', true)
    })

    const sessionMenu = document.querySelector<HTMLButtonElement>('.session-menu-trigger')!
    const originalSessionTitle = sessionMenu.textContent
    await act(async () => { sessionMenu.click() })
    await vi.waitFor(() => {
      expect(document.querySelectorAll('.session-list li > button:not(.session-delete)')).toHaveLength(2)
    })

    const savedSession = document.querySelectorAll<HTMLButtonElement>('.session-list li > button:not(.session-delete)')[1]
    await act(async () => { savedSession.click() })
    await vi.waitFor(() => {
      expect(document.querySelector('.error')?.textContent).toBe('runtime port unavailable')
    })

    expect(sessionMenu.disabled).toBe(false)
    expect(document.querySelector<HTMLButtonElement>('.new-session-trigger')?.disabled).toBe(false)
    expect(savedSession.disabled).toBe(false)
    expect(sessionMenu.textContent).toBe(originalSessionTitle)
  })

  it('allows starting a new session while current session is working', async () => {
    let onEventCallback: ((frame: any) => void) | undefined
    panelApi.onEvent = vi.fn((callback) => { onEventCallback = callback; return () => {} })
    panelApi.setActiveSession = vi.fn().mockResolvedValue(undefined)

    await act(async () => { root.render(createElement(App)) })
    await act(async () => {
      onStatus?.('connected', null)
      onResumeHint?.(null)
    })
    await vi.waitFor(() => {
      expect(panelApi.setActiveSession).toHaveBeenCalledWith('session-current', true)
    })

    await act(async () => {
      onEventCallback?.({
        t: 'event',
        frame: {
          type: 'event',
          payload: {
            sessionId: 'session-current',
            event: { type: 'turn/start', seq: 1 },
          },
        },
      })
    })

    const newSessionButton = document.querySelector<HTMLButtonElement>('.new-session-trigger')!
    expect(newSessionButton.disabled).toBe(false)

    await act(async () => { newSessionButton.click() })
    await vi.waitFor(() => {
      expect(panelApi.setActiveSession).toHaveBeenCalledTimes(2)
    })
    expect(panelApi.rebindTabAffinity).not.toHaveBeenCalled()
  })
})
