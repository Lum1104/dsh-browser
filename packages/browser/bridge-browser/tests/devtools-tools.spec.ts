import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { DEVTOOLS_TOOL_NAMES } from '../src/protocol.ts'
import { defineDevTools, registerBrowserDevTools } from '../src/devtools-tools.ts'
import { createBrowserToolCall } from '../src/tools.ts'

interface Registered {
  name: string
  definition: Record<string, unknown>
}

function makeHarness() {
  const registered: Registered[] = []
  const ctx = {
    tools: {
      register: vi.fn((definition: { name: string }) => {
        registered.push({ name: definition.name, definition: definition as Record<string, unknown> })
        return () => {}
      }),
    },
  } as unknown as Context
  const requestTool = vi.fn(async (_name: string, _args: Record<string, unknown>, _signal: AbortSignal, _timeoutMs?: number): Promise<unknown> => ({ text: 'ok' }))
  const call = async (exec: { signal: AbortSignal }, name: string, args: Record<string, unknown>): Promise<{ text: string }> =>
    await requestTool(name, args, exec.signal, 1_000) as { text: string }
  return { ctx, call, requestTool, registered }
}

const OPTIONS = { toolTimeoutMs: 1_000, devToolsMaxChars: 24_000 }

describe('registerBrowserDevTools', () => {
  it('registers exactly the negotiated devtools names', () => {
    const { ctx, call, registered } = makeHarness()
    const disposers = registerBrowserDevTools(ctx, call, OPTIONS)
    expect(registered.map((entry) => entry.name)).toEqual([...DEVTOOLS_TOOL_NAMES])
    expect(disposers.size).toBe(DEVTOOLS_TOOL_NAMES.length)
    for (const dispose of disposers.values()) dispose()
  })

  it('keeps every tool schema descriptive and warns about untrusted content', () => {
    const tools = defineDevTools(async () => ({ text: '' }), OPTIONS)
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(40)
      expect(tool.timeoutMs).toBe(1_000)
      expect(tool.parameters).toBeTypeOf('object')
    }
    const elements = tools.find((tool) => tool.name === 'browser_devtools_elements')!
    expect(elements.description).toContain('untrusted data')
    const evaluate = tools.find((tool) => tool.name === 'browser_console_eval')!
    expect(evaluate.description).toContain('untrusted data')
    const requests = tools.find((tool) => tool.name === 'browser_devtools_list_requests')!
    expect(requests.description).toContain('untrusted data')
  })

  it('forwards canonical arguments and drops omitted optionals', async () => {
    const { ctx, call, requestTool, registered } = makeHarness()
    registerBrowserDevTools(ctx, call, OPTIONS)
    const tool = registered.find((entry) => entry.name === 'browser_devtools_elements')!
    const exec = { signal: new AbortController().signal }
    await (tool.definition.execute as (args: unknown, e: typeof exec) => Promise<unknown>)({ index: 4, frame: 2 }, exec)
    expect(requestTool).toHaveBeenCalledWith('browser_devtools_elements', { index: 4, frame: 2 }, exec.signal, 1_000)
  })

  it('keeps the console evaluation expression verbatim', async () => {
    const { ctx, call, requestTool, registered } = makeHarness()
    registerBrowserDevTools(ctx, call, OPTIONS)
    const tool = registered.find((entry) => entry.name === 'browser_console_eval')!
    const exec = { signal: new AbortController().signal }
    await (tool.definition.execute as (args: unknown, e: typeof exec) => Promise<unknown>)({
      expression: 'fetch("/api").then(r => r.status)',
      awaitPromise: true,
    }, exec)
    expect(requestTool).toHaveBeenCalledWith('browser_console_eval', {
      expression: 'fetch("/api").then(r => r.status)',
      awaitPromise: true,
    }, exec.signal, 1_000)
  })

  it('associates devtools calls with the owning Agent session', async () => {
    const { ctx, requestTool, registered } = makeHarness()
    const bridge = { requestTool } as unknown as Parameters<typeof createBrowserToolCall>[0]
    registerBrowserDevTools(ctx, createBrowserToolCall(bridge, 1_000), OPTIONS)
    const tool = registered.find((entry) => entry.name === 'browser_devtools_network')!
    const exec = { signal: new AbortController().signal, agent: { id: 'session-browser' } }
    await (tool.definition.execute as (args: unknown, e: typeof exec) => Promise<unknown>)({ action: 'start' }, exec)
    expect(requestTool).toHaveBeenCalledWith('browser_devtools_network', { action: 'start' }, exec.signal, 1_000, 'session-browser')
  })

  it('normalizes a result that carries no text', async () => {
    const tools = defineDevTools(async () => ({ text: 'plain' }), OPTIONS)
    const network = tools.find((tool) => tool.name === 'browser_devtools_network')!
    const result = await (network.execute as (args: unknown, e: { signal: AbortSignal }) => Promise<unknown>)({ action: 'status' }, { signal: new AbortController().signal })
    expect(result).toEqual({ text: 'plain' })
  })
})
