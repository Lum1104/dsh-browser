import { describe, expect, it, vi } from 'vitest'
import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'
import {
  BROWSER_CONTEXT_KIND,
  BrowserContextInjector,
  createBrowserSnapshotMessage,
} from '../src/browser-context.ts'

function fakeAgent(id: string): Agent & { inject: ReturnType<typeof vi.fn> } {
  return { id, inbox: { nextStep: [] }, inject: vi.fn() } as unknown as Agent & { inject: ReturnType<typeof vi.fn> }
}

describe('browser page context', () => {
  it('builds plugin-owned snapshot context for the model', () => {
    const message = createBrowserSnapshotMessage('Page: Example')

    expect(message.role).toBe('user')
    expect(message.source).toEqual({
      kind: BROWSER_CONTEXT_KIND,
      form: 'snapshot',
      sections: [{
        name: 'browser-page',
        text: expect.stringContaining('Page: Example'),
      }],
    })
    expect(message.content).toEqual([{
      type: 'text',
      text: expect.stringContaining('browser page context was refreshed'),
    }])
    expect(message.content[0].text).toContain('already completed browser_snapshot')
    expect(message.content[0].text).toContain('do not take an immediate duplicate snapshot')
  })

  it('injects immediately when the Agent is live', () => {
    const agent = fakeAgent('session-live')
    const agents = { get: vi.fn(() => agent) } as unknown as Pick<AgentRegistry, 'get'>
    const injector = new BrowserContextInjector(agents)

    expect(injector.inject('session-live', 'Live page')).toBe('injected')
    expect(agent.inject).toHaveBeenCalledOnce()
    expect(agent.inject.mock.calls[0]![0].content[0].text).toContain('Live page')
  })

  it('retains only the latest snapshot until a deferred Agent starts', () => {
    const agent = fakeAgent('session-later')
    const agents = { get: vi.fn(() => undefined) } as unknown as Pick<AgentRegistry, 'get'>
    const injector = new BrowserContextInjector(agents)

    expect(injector.inject('session-later', 'Old page')).toBe('queued')
    expect(injector.inject('session-later', 'New page')).toBe('queued')
    expect(injector.activate(agent)).toBe(true)
    expect(injector.activate(agent)).toBe(false)
    expect(agent.inject).toHaveBeenCalledOnce()
    expect(agent.inject.mock.calls[0]![0].content[0].text).toContain('New page')
    expect(agent.inject.mock.calls[0]![0].content[0].text).not.toContain('Old page')
  })

  it('drops provisional context when the Agent becomes live before another injection', () => {
    const agent = fakeAgent('session-race')
    const get = vi.fn()
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce(agent)
    const injector = new BrowserContextInjector({ get } as unknown as Pick<AgentRegistry, 'get'>)

    injector.inject('session-race', 'Queued page')
    injector.inject('session-race', 'Live page')

    expect(injector.activate(agent)).toBe(false)
    expect(agent.inject).toHaveBeenCalledOnce()
    expect(agent.inject.mock.calls[0]![0].content[0].text).toContain('Live page')
  })

  it('bounds snapshots for provisional sessions that never materialize', () => {
    const agents = { get: vi.fn(() => undefined) } as unknown as Pick<AgentRegistry, 'get'>
    const injector = new BrowserContextInjector(agents, 2)
    const first = fakeAgent('first')
    const second = fakeAgent('second')
    const third = fakeAgent('third')

    injector.inject('first', 'First page')
    injector.inject('second', 'Second page')
    injector.inject('third', 'Third page')

    expect(injector.activate(first)).toBe(false)
    expect(injector.activate(second)).toBe(true)
    expect(injector.activate(third)).toBe(true)
  })
})
