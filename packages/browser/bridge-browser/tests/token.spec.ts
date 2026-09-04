import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { generateToken, resolveToken, verifyToken, writeTokenFile } from '../src/token.ts'

describe('token', () => {
  it('generates hex tokens of the requested entropy', () => {
    const token = generateToken()
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    expect(generateToken(16)).toMatch(/^[0-9a-f]{32}$/)
  })

  it('verifies byte equality and rejects mismatches and bad shapes', () => {
    const token = generateToken()
    expect(verifyToken(token, token)).toBe(true)
    expect(verifyToken(token, generateToken())).toBe(false)
    expect(verifyToken(token, '')).toBe(false)
    expect(verifyToken('', token)).toBe(false)
    expect(verifyToken('zz', 'zzz')).toBe(false)
  })

  it('compares non-hex configured tokens as UTF-8 bytes (no hex truncation)', () => {
    expect(verifyToken('fixed-token', 'fixed-token')).toBe(true)
    expect(verifyToken('fixed-token', 'fixed-token ')).toBe(false)
    // hex 解码会把 deadbeef-team 截断成 deadbeef；UTF-8 比较不会
    expect(verifyToken('deadbeef-team', 'deadbeef')).toBe(false)
    expect(verifyToken('deadbeef-team', 'deadbeef-team')).toBe(true)
  })

  it('persists tokens with 0600 permissions and round-trips', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-bridge-token-'))
    const file = join(dir, 'token')
    const token = generateToken()
    await writeTokenFile(token, file)
    expect((await readFile(file, 'utf8')).trim()).toBe(token)
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600)
    const resolved = await resolveToken(undefined, file)
    expect(resolved.token).toBe(token)
    expect(resolved.generated).toBe(false)
  })

  it('generates and persists a fresh token when nothing is configured', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-bridge-token-'))
    const file = join(dir, 'token')
    const resolved = await resolveToken(undefined, file)
    expect(resolved.generated).toBe(true)
    expect(resolved.token).toMatch(/^[0-9a-f]{64}$/)
    expect((await readFile(file, 'utf8')).trim()).toBe(resolved.token)
  })

  it('prefers the configured token without touching the file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-bridge-token-'))
    const file = join(dir, 'token')
    const resolved = await resolveToken('fixed-token', file)
    expect(resolved).toEqual({ token: 'fixed-token', file, generated: false })
    await expect(readFile(file, 'utf8')).rejects.toThrow()
  })
})
