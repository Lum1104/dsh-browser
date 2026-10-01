// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_SELECTION_CHARS, type SelectionCapture } from '../src/selection.ts'
import { SelectionWatcher, readSelectionCapture } from '../src/content/selection.ts'

function selectText(value: string, anchor: Node | null = document.body): void {
  const selection = {
    toString: () => value,
    anchorNode: anchor,
    focusNode: anchor,
    rangeCount: 0,
    getRangeAt: () => { throw new Error('no range') },
  }
  vi.stubGlobal('getSelection', () => selection)
  window.getSelection = () => selection as unknown as Selection
}

/** Transient activation is what separates a user drag from a page's own call. */
function setUserGesture(active: boolean): void {
  Object.defineProperty(navigator, 'userActivation', {
    configurable: true,
    value: { isActive: active, hasBeenActive: true },
  })
}

afterEach(() => {
  document.body.innerHTML = ''
  document.title = ''
  Reflect.deleteProperty(navigator, 'userActivation')
  vi.unstubAllGlobals()
  // Drop pending settle timers before restoring real clocks. Otherwise
  // useRealTimers() hands them to Node, and they fire after jsdom is gone.
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('reading a page selection', () => {
  it('captures the highlight with its page identity', () => {
    document.title = 'Example page'
    selectText('  quoted   text  ')

    expect(readSelectionCapture()).toEqual({
      text: 'quoted text',
      truncated: false,
      title: 'Example page',
      url: location.href,
    })
  })

  it('reports nothing when no text is highlighted', () => {
    selectText('')
    expect(readSelectionCapture()).toBeNull()
  })

  it('marks a highlight that exceeded the capture ceiling', () => {
    selectText('z'.repeat(MAX_SELECTION_CHARS + 1))
    expect(readSelectionCapture()?.truncated).toBe(true)
  })

  it('reads a focused field selection that window.getSelection() hides', () => {
    document.body.innerHTML = '<textarea id="notes">hello world</textarea>'
    const field = document.getElementById('notes') as HTMLTextAreaElement
    field.focus()
    field.setSelectionRange(0, 5)
    selectText('')

    expect(readSelectionCapture()?.text).toBe('hello')
  })

  it('never reads a selection inside a password or payment field', () => {
    document.body.innerHTML = '<input id="secret" type="password" value="hunter2">'
    const field = document.getElementById('secret') as HTMLInputElement
    field.focus()
    field.setSelectionRange(0, 7)
    selectText('')

    expect(readSelectionCapture()).toBeNull()
  })

  it('never reads a contenteditable card-number widget', () => {
    document.body.innerHTML = '<div id="cc" contenteditable="true" aria-label="Credit card number">4111 1111</div>'
    selectText('4111 1111', document.getElementById('cc'))

    expect(readSelectionCapture()).toBeNull()
  })

  it('never reads a password field inside a shadow root', () => {
    document.body.innerHTML = '<div id="host"></div>'
    const host = document.getElementById('host')!
    const shadow = host.attachShadow({ mode: 'open' })
    shadow.innerHTML = '<input id="inner" type="password" value="hunter2">'
    const inner = shadow.getElementById('inner') as HTMLInputElement
    inner.focus()
    inner.setSelectionRange(0, 7)
    selectText('')

    expect(readSelectionCapture()).toBeNull()
  })
})

describe('selection watcher', () => {
  const watchers: SelectionWatcher[] = []

  afterEach(() => {
    for (const watcher of watchers.splice(0)) watcher.dispose()
  })

  function createWatcher(
    emit: (capture: SelectionCapture) => void,
    settleMs = 10,
  ): SelectionWatcher {
    const watcher = new SelectionWatcher(emit, settleMs)
    watchers.push(watcher)
    return watcher
  }

  it('ignores a selection the page moved without a user gesture', () => {
    vi.useFakeTimers()
    const emit = vi.fn()
    const watcher = createWatcher(emit)
    watcher.setEnabled(true)

    // An iframe calling getSelection().selectAllChildren() looks like this.
    setUserGesture(false)
    selectText('attacker text')
    document.dispatchEvent(new Event('selectionchange'))
    vi.advanceTimersByTime(50)
    expect(emit).not.toHaveBeenCalled()

    setUserGesture(true)
    selectText('the user own highlight')
    document.dispatchEvent(new Event('selectionchange'))
    vi.advanceTimersByTime(50)
    expect(emit).toHaveBeenCalledTimes(1)
  })

  it('reports the same passage again after the panel dropped it', () => {
    vi.useFakeTimers()
    const emit = vi.fn()
    const watcher = createWatcher(emit)
    watcher.setEnabled(true)

    selectText('quoted text')
    document.dispatchEvent(new Event('selectionchange'))
    vi.advanceTimersByTime(20)
    expect(emit).toHaveBeenCalledTimes(1)

    watcher.resetDedupe()
    document.dispatchEvent(new Event('selectionchange'))
    vi.advanceTimersByTime(20)

    expect(emit).toHaveBeenCalledTimes(2)
  })

  it('ignores an arm command older than the one already applied', () => {
    vi.useFakeTimers()
    const emit = vi.fn()
    const watcher = createWatcher(emit)

    expect(watcher.setEnabled(true, 5, 'worker-a')).toBe(true)
    // A slow DSH_CONTENT_READY reply computed before the panel opened.
    expect(watcher.setEnabled(false, 2, 'worker-a')).toBe(false)

    selectText('quoted text')
    document.dispatchEvent(new Event('selectionchange'))
    vi.advanceTimersByTime(20)

    expect(emit).toHaveBeenCalledTimes(1)
  })

  it('accepts a fresh worker even when its revision counter restarted', () => {
    vi.useFakeTimers()
    const emit = vi.fn()
    const watcher = createWatcher(emit)

    expect(watcher.setEnabled(true, 5, 'worker-a')).toBe(true)
    expect(watcher.setEnabled(false, 0, 'worker-b')).toBe(true)
    selectText('quoted text')
    document.dispatchEvent(new Event('selectionchange'))
    vi.advanceTimersByTime(20)

    expect(emit).not.toHaveBeenCalled()
  })

  it('stays silent until a panel arms it', () => {
    vi.useFakeTimers()
    const emit = vi.fn()
    const watcher = createWatcher(emit)

    selectText('quoted text')
    document.dispatchEvent(new Event('selectionchange'))
    vi.advanceTimersByTime(50)
    expect(emit).not.toHaveBeenCalled()

    watcher.setEnabled(true)
    document.dispatchEvent(new Event('selectionchange'))
    vi.advanceTimersByTime(50)
    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit.mock.calls[0]?.[0]).toMatchObject({ text: 'quoted text' })
  })

  it('reports a highlight made before the panel opened', () => {
    vi.useFakeTimers()
    const emit = vi.fn()
    const watcher = createWatcher(emit)

    selectText('highlighted before opening')
    watcher.setEnabled(true)
    vi.advanceTimersByTime(20)

    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit.mock.calls[0]?.[0]).toMatchObject({ text: 'highlighted before opening' })
  })

  it('emits once for a drag that fires many selection changes', () => {
    vi.useFakeTimers()
    const emit = vi.fn()
    const watcher = createWatcher(emit)
    watcher.setEnabled(true)

    for (const partial of ['q', 'qu', 'quoted text']) {
      selectText(partial)
      document.dispatchEvent(new Event('selectionchange'))
      vi.advanceTimersByTime(5)
    }
    vi.advanceTimersByTime(20)

    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit.mock.calls[0]?.[0]).toMatchObject({ text: 'quoted text' })
  })

  it('keeps the captured quote when the user clears the highlight', () => {
    vi.useFakeTimers()
    const emit = vi.fn()
    const watcher = createWatcher(emit)
    watcher.setEnabled(true)

    selectText('quoted text')
    document.dispatchEvent(new Event('selectionchange'))
    vi.advanceTimersByTime(20)
    selectText('')
    document.dispatchEvent(new Event('selectionchange'))
    vi.advanceTimersByTime(20)

    expect(emit).toHaveBeenCalledTimes(1)
  })

  it('reports the same passage after the highlight was cleared', () => {
    vi.useFakeTimers()
    const emit = vi.fn()
    const watcher = createWatcher(emit)
    watcher.setEnabled(true)

    selectText('quoted text')
    document.dispatchEvent(new Event('selectionchange'))
    vi.advanceTimersByTime(20)
    selectText('')
    document.dispatchEvent(new Event('selectionchange'))
    vi.advanceTimersByTime(20)
    selectText('quoted text')
    document.dispatchEvent(new Event('selectionchange'))
    vi.advanceTimersByTime(20)

    expect(emit).toHaveBeenCalledTimes(2)
  })

  it('reports when the same captured prefix becomes truncated', () => {
    vi.useFakeTimers()
    const emit = vi.fn()
    const watcher = createWatcher(emit)
    watcher.setEnabled(true)

    selectText('x'.repeat(MAX_SELECTION_CHARS))
    document.dispatchEvent(new Event('selectionchange'))
    vi.advanceTimersByTime(20)
    selectText('x'.repeat(MAX_SELECTION_CHARS + 1))
    document.dispatchEvent(new Event('selectionchange'))
    vi.advanceTimersByTime(20)

    expect(emit).toHaveBeenCalledTimes(2)
    expect(emit.mock.calls[1]?.[0]).toMatchObject({ truncated: true })
  })

  it('does not resend an unchanged highlight', () => {
    vi.useFakeTimers()
    const emit = vi.fn()
    const watcher = createWatcher(emit)
    watcher.setEnabled(true)

    selectText('quoted text')
    for (let attempt = 0; attempt < 3; attempt += 1) {
      document.dispatchEvent(new Event('selectionchange'))
      vi.advanceTimersByTime(20)
    }

    expect(emit).toHaveBeenCalledTimes(1)
  })

  it('releases the page listener when it is disarmed', () => {
    vi.useFakeTimers()
    const emit = vi.fn()
    const watcher = createWatcher(emit)
    watcher.setEnabled(true, 5)
    selectText('quoted text')
    document.dispatchEvent(new Event('selectionchange'))
    watcher.dispose()
    vi.advanceTimersByTime(50)

    expect(emit).not.toHaveBeenCalled()
  })
})
