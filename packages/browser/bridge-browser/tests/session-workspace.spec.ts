import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { SessionCreateRequest, SessionCreateValue } from '../src/harness-types.ts'
import type { BridgeSessionApi } from '../src/session-api.ts'
import { withSessionWorkspace, type WorkspaceCreator } from '../src/session-workspace.ts'

const WORKSPACE_ID = 'workspace-browser' as WorkspaceId
const SESSION_ID = SessionId('session-browser')
const dirs: string[] = []

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function tempWorkspacePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-browser-workspace-'))
  dirs.push(root)
  return join(root, 'browser-sessions')
}

function apiHarness() {
  const create = vi.fn(async (_request: SessionCreateRequest): Promise<SessionCreateValue> => ({ sessionId: SESSION_ID }))
  const api = { create } as unknown as BridgeSessionApi
  return { api, create }
}

function workspaceSuccess(inspect?: (path: string) => Promise<void>): WorkspaceCreator {
  return {
    create: vi.fn(async (request: { path: string }) => {
      await inspect?.(request.path)
      return {
        created: true,
        workspace: {
          workspaceId: WORKSPACE_ID,
          path: request.path,
          title: 'browser-sessions',
          sessionIds: [],
          createdAt: '2026-08-06T00:00:00.000Z',
          updatedAt: '2026-08-06T00:00:00.000Z',
        },
      }
    }),
  }
}

describe('withSessionWorkspace', () => {
  it('creates the directory before one cached workspace registration and injects its id', async () => {
    const workspacePath = await tempWorkspacePath()
    const workspaceController = workspaceSuccess(async (path) => {
      expect((await stat(path)).isDirectory()).toBe(true)
    })
    const { api, create } = apiHarness()
    const warn = vi.fn()
    const wrapped = withSessionWorkspace(api, workspaceController, workspacePath, warn)
    const chosenId = SessionId('session-chosen')

    await Promise.all([
      wrapped.create({ cwd: '/ignored', sessionId: chosenId }),
      wrapped.create({}),
    ])

    expect(workspaceController.create).toHaveBeenCalledTimes(1)
    expect(workspaceController.create).toHaveBeenCalledWith({ path: workspacePath })
    expect(create).toHaveBeenNthCalledWith(1, { sessionId: chosenId, workspaceId: WORKSPACE_ID })
    expect(create).toHaveBeenNthCalledWith(2, { workspaceId: WORKSPACE_ID })
    expect(warn).not.toHaveBeenCalled()
  })

  it('passes an explicit workspace id through without preparing the configured workspace', async () => {
    const workspacePath = await tempWorkspacePath()
    const workspaceController = workspaceSuccess()
    const { api, create } = apiHarness()
    const wrapped = withSessionWorkspace(api, workspaceController, workspacePath, vi.fn())
    const request: SessionCreateRequest = { workspaceId: 'workspace-explicit' as WorkspaceId }

    await wrapped.create(request)

    expect(create).toHaveBeenCalledWith(request)
    expect(workspaceController.create).not.toHaveBeenCalled()
    await expect(stat(workspacePath)).rejects.toThrow()
  })

  it('returns the original API when grouping is opted out', () => {
    const workspaceController = workspaceSuccess()
    const { api } = apiHarness()

    expect(withSessionWorkspace(api, workspaceController, '', vi.fn())).toBe(api)
    expect(workspaceController.create).not.toHaveBeenCalled()
  })

  it('caches a workspace.create business failure and preserves session creation', async () => {
    const workspacePath = await tempWorkspacePath()
    const workspaceController: WorkspaceCreator = {
      create: vi.fn(async () => { throw new Error('workspace service missing') }),
    }
    const { api, create } = apiHarness()
    const warn = vi.fn()
    const wrapped = withSessionWorkspace(api, workspaceController, workspacePath, warn)
    const request: SessionCreateRequest = {}

    await wrapped.create(request)
    await wrapped.create(request)

    expect(workspaceController.create).toHaveBeenCalledOnce()
    expect(create).toHaveBeenCalledTimes(2)
    expect(create).toHaveBeenNthCalledWith(1, request)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('workspace service missing'))
  })

  it('catches a thrown workspace failure and preserves session creation', async () => {
    const workspacePath = await tempWorkspacePath()
    const workspaceController: WorkspaceCreator = {
      create: vi.fn(async () => { throw new Error('domain unavailable') }),
    }
    const { api, create } = apiHarness()
    const warn = vi.fn()
    const wrapped = withSessionWorkspace(api, workspaceController, workspacePath, warn)
    const request: SessionCreateRequest = { cwd: '/original' }

    await wrapped.create(request)

    expect(create).toHaveBeenCalledWith(request)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('domain unavailable'))
  })
})
