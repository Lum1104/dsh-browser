// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BridgeState } from '../src/background/bridge.ts'
import type { PanelApi } from '../src/panel/api.ts'

let panelApi: PanelApi

vi.mock('../src/panel/api.ts', () => ({
  connectPanel: (): PanelApi => panelApi,
}))

import { App } from '../src/panel/App.tsx'

describe('panel session transitions', () => {
  let root: Root
  let onStatus: ((state: BridgeState, caps: null) => void) | undefined
  let onResumeHint: ((sessionId: string | null) => void) | undefined

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
      permissions: { contains: vi.fn(async () => false) },
    })

    const rpc = vi.fn(async (method: string, _payload?: unknown) => {
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
      onEvent: vi.fn(() => unsubscribe),
      onApprovalRequest: vi.fn(() => unsubscribe),
      onApprovalResolved: vi.fn(() => unsubscribe),
      onTabAffinity: vi.fn(() => unsubscribe),
      onSelection: vi.fn(() => unsubscribe),
      onSessionResumeHint: vi.fn((callback) => { onResumeHint = callback; return unsubscribe }),
      onPermissionRequest: vi.fn(() => unsubscribe),
      respondToPermission: vi.fn(async () => {}),
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
