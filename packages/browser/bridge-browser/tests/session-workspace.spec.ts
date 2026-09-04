import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LegacyRpc } from '../src/legacy-rpc.ts'
import { withSessionWorkspace } from '../src/session-workspace.ts'

const dirs: string[] = []

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function tempWorkspacePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-browser-workspace-'))
  dirs.push(root)
  return join(root, 'browser-sessions')
}

function apiHarness(workspace: 'success' | 'failure' = 'success') {
  const calls: Array<{ method: string; payload: unknown }> = []
  const api: LegacyRpc = vi.fn(async (method, payload) => {
    calls.push({ method, payload })
    if (method === 'workspace.create') {
      if (workspace === 'failure') throw new Error('domain unavailable')
      return { workspace: { workspaceId: 'workspace-browser' }, created: true }
    }
    return { sessionId: 'session-browser' }
  })
  return { api, calls }
}

describe('withSessionWorkspace', () => {
  it('creates and caches the Workspace before grouped Session creation', async () => {
    const workspacePath = await tempWorkspacePath()
    const { api, calls } = apiHarness()
    const wrapped = withSessionWorkspace(api, workspacePath, vi.fn())
    await Promise.all([
      wrapped('session.create', { cwd: '/ignored', sessionId: 'session-one' }),
      wrapped('session.create', {}),
    ])
    expect((await stat(workspacePath)).isDirectory()).toBe(true)
    expect(calls.filter(call => call.method === 'workspace.create')).toEqual([
      { method: 'workspace.create', payload: { path: workspacePath } },
    ])
    expect(calls.filter(call => call.method === 'session.create')).toEqual([
      { method: 'session.create', payload: { sessionId: 'session-one', workspaceId: 'workspace-browser' } },
      { method: 'session.create', payload: { workspaceId: 'workspace-browser' } },
    ])
  })

  it('preserves an explicit Workspace and supports grouping opt-out', async () => {
    const workspacePath = await tempWorkspacePath()
    const { api, calls } = apiHarness()
    const wrapped = withSessionWorkspace(api, workspacePath, vi.fn())
    await wrapped('session.create', { workspaceId: 'workspace-explicit' })
    expect(calls).toEqual([{ method: 'session.create', payload: { workspaceId: 'workspace-explicit' } }])
    await expect(stat(workspacePath)).rejects.toThrow()
    expect(withSessionWorkspace(api, '', vi.fn())).toBe(api)
  })

  it('caches setup failure and falls through to ungrouped Session creation', async () => {
    const workspacePath = await tempWorkspacePath()
    const { api, calls } = apiHarness('failure')
    const warn = vi.fn()
    const wrapped = withSessionWorkspace(api, workspacePath, warn)
    await wrapped('session.create', { cwd: '/original' })
    await wrapped('session.create', { cwd: '/second' })
    expect(calls.filter(call => call.method === 'workspace.create')).toHaveLength(1)
    expect(calls.filter(call => call.method === 'session.create')).toEqual([
      { method: 'session.create', payload: { cwd: '/original' } },
      { method: 'session.create', payload: { cwd: '/second' } },
    ])
    expect(warn).toHaveBeenCalledOnce()
  })
})
