// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { transferredImageFiles } from '../src/panel/App.tsx'

function transferData(items: Array<{ kind: string; type: string; file?: File }>): DataTransfer {
  // jsdom has no DataTransfer constructor; the handler only reads `items`.
  return {
    items: items.map((item) => ({
      kind: item.kind,
      type: item.type,
      getAsFile: () => item.file ?? null,
    })),
  } as unknown as DataTransfer
}

describe('transferredImageFiles', () => {
  const png = new File([new Uint8Array([137, 80, 78, 71])], 'shot.png', { type: 'image/png' })
  const txt = new File(['hi'], 'note.txt', { type: 'text/plain' })

  it('collects image files from a paste payload', () => {
    expect(transferredImageFiles(transferData([
      { kind: 'string', type: 'text/plain' },
      { kind: 'file', type: 'image/png', file: png },
    ]))).toEqual([png])
  })

  it('ignores non-image files', () => {
    expect(transferredImageFiles(transferData([
      { kind: 'file', type: 'text/plain', file: txt },
    ]))).toEqual([])
  })

  it('returns empty for a text-only paste and a null payload', () => {
    expect(transferredImageFiles(transferData([{ kind: 'string', type: 'text/plain' }]))).toEqual([])
    expect(transferredImageFiles(null)).toEqual([])
  })

  it('skips declared image items whose file could not be produced', () => {
    expect(transferredImageFiles(transferData([
      { kind: 'file', type: 'image/png' },
    ]))).toEqual([])
  })
})
