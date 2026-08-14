// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  appendLiveRow,
  completeLastTool,
  isQuestionResolvedFrame,
  isSessionEventFrame,
  mergeHistoryRows,
  pendingQuestionFromFrame,
  rowFromEvent,
  textFromBlocks,
  toolSummary,
  type SessionEventView,
} from '../src/panel/events.ts'

/** 构造符合真实 SessionEvent 形状（{ type, seq, time, data }）的事件。 */
function ev(type: string, data: Record<string, unknown>): SessionEventView {
  return { type, data }
}

describe('textFromBlocks', () => {
  it('extracts text blocks and ignores non-text', () => {
    expect(textFromBlocks([{ type: 'text', text: '你好' }, { type: 'reasoning', text: '思考' }])).toBe('你好')
    expect(textFromBlocks(undefined)).toBe('')
    expect(textFromBlocks([{ type: 'text' }])).toBe('')
  })
})

describe('rowFromEvent', () => {
  it('renders user messages from data.content (the real SessionEvent shape)', () => {
    const row = rowFromEvent(ev('user/message', { content: [{ type: 'text', text: '帮我看看页面' }], source: { kind: 'user' } }))
    expect(row).toEqual({ seq: 0, kind: 'user', text: '帮我看看页面' })
  })

  it('skips system-injected user/message events (source.kind = plugin)', () => {
    // dsh 每轮注入的运行时上下文（<system-reminder> 等）是 plugin 来源，
    // 绝不能渲染成用户消息。
    const injected = ev('user/message', {
      content: [{ type: 'text', text: '</system-reminder> 一段很长的系统注入…' }],
      source: { kind: 'plugin', plugin: 'workspace-context' },
    })
    expect(rowFromEvent(injected)).toBeNull()
  })

  it('renders assistant messages from data.message.content', () => {
    const row = rowFromEvent(ev('assistant/message', { message: { content: [{ type: 'text', text: '好的' }] } }))
    expect(row).toEqual({ seq: 0, kind: 'assistant', text: '好的' })
  })

  it('skips assistant events that contain only tool or blank blocks', () => {
    expect(rowFromEvent(ev('assistant/message', {
      message: { content: [{ type: 'tool_use', name: 'browser_snapshot' }] },
    }))).toBeNull()
    expect(rowFromEvent(ev('assistant/message', {
      message: { content: [{ type: 'text', text: '   \n' }] },
    }))).toBeNull()
  })

  it('returns null for non-message events', () => {
    expect(rowFromEvent(ev('turn/start', {}))).toBeNull()
    expect(rowFromEvent(ev('tool/call', { name: 'browser_click' }))).toBeNull()
  })
})

describe('toolSummary', () => {
  it('appends the inventory index when present', () => {
    expect(toolSummary('browser_click', '{"index":7}')).toBe('点击元素 #7')
    expect(toolSummary('browser_snapshot', '{"delta":true}')).toBe('读取页面')
    expect(toolSummary('browser_navigate', 'not-json')).toBe('打开页面')
    expect(toolSummary('custom_tool', '{}')).toBe('custom_tool')
  })
})

describe('appendLiveRow / completeLastTool', () => {
  it('merges consecutive tool rows into one line (no tool spam)', () => {
    let rows: ReturnType<typeof appendLiveRow> = []
    rows = appendLiveRow(rows, 'user', '帮我操作页面', 1)
    rows = appendLiveRow(rows, 'tool', '读取页面', 2)
    rows = appendLiveRow(rows, 'tool', '点击元素 #7', 3)
    rows = appendLiveRow(rows, 'tool', '填写内容 #9', 4)
    rows = completeLastTool(rows, 5)
    expect(rows.map((r) => r.kind)).toEqual(['user', 'tool'])
    expect(rows[1]).toMatchObject({ text: '读取页面 → 点击元素 #7 → 填写内容 #9', status: 'complete' })
    rows = appendLiveRow(rows, 'assistant', '完成', 6)
    expect(rows.map((r) => r.kind)).toEqual(['user', 'tool', 'assistant'])
  })
})

describe('mergeHistoryRows', () => {
  it('aggregates tool calls and renders user/assistant text from data', () => {
    let seq = 0
    const nextSeq = (): number => { seq += 1; return seq }
    const events = [
      ev('user/message', { content: [{ type: 'text', text: '操作页面' }], source: { kind: 'user' } }),
      ev('turn/start', {}),
      ev('tool/call', { name: 'browser_snapshot', arguments: '{}' }),
      ev('tool/result', {}),
      ev('tool/call', { name: 'browser_click', arguments: '{"index":7}' }),
      ev('tool/result', {}),
      ev('tool/call', { name: 'browser_click', arguments: '{"index":8}' }),
      ev('tool/result', {}),
      ev('assistant/message', { message: { content: [{ type: 'text', text: '已点击' }] } }),
      ev('turn/end', {}),
    ]
    const rows = mergeHistoryRows(events, nextSeq)
    expect(rows.map((r) => r.kind)).toEqual(['user', 'tool', 'assistant'])
    expect(rows[0]!.text).toBe('操作页面')
    expect(rows[2]!.text).toBe('已点击')
    // 连续工具调用归并一行（不逐条刷屏）
    expect(rows[1]).toMatchObject({ text: '读取页面 → 点击元素 #7 → 点击元素 #8', status: 'complete' })
  })

  it('does not restore empty assistant rows from history', () => {
    let seq = 0
    const rows = mergeHistoryRows([
      ev('assistant/message', { message: { content: [{ type: 'tool_use', name: 'browser_snapshot' }] } }),
      ev('tool/call', { name: 'browser_snapshot', arguments: '{}' }),
      ev('tool/result', {}),
    ], () => { seq += 1; return seq })
    expect(rows).toEqual([{ seq: 1, kind: 'tool', text: '读取页面', status: 'complete' }])
  })

  it('handles empty history', () => {
    expect(mergeHistoryRows([], () => 0)).toEqual([])
  })
})

describe('pendingQuestionFromFrame', () => {
  it('extracts a pending question from a question/requested mux frame', () => {
    const pending = pendingQuestionFromFrame({
      rpcId: 'rpc-1',
      method: 'question/requested',
      payload: {
        type: 'question/requested',
        sessionId: 's1',
        questions: [{
          id: 'mention_target',
          question: '评论区 @王世楷，指的是哪一位？',
          header: '确认 @ 目标',
          options: [{ label: '小鹏内部王世楷', description: '同部门' }, { label: 'Karry' }],
        }],
      },
    })
    expect(pending).toEqual({
      rpcId: 'rpc-1',
      sessionId: 's1',
      questions: [{
        id: 'mention_target',
        question: '评论区 @王世楷，指的是哪一位？',
        header: '确认 @ 目标',
        options: [{ label: '小鹏内部王世楷', description: '同部门' }, { label: 'Karry' }],
      }],
    })
  })

  it('rejects non-question frames and malformed payloads', () => {
    expect(pendingQuestionFromFrame({ rpcId: 'r', method: 'session/event', payload: { sessionId: 's', event: {} } })).toBeNull()
    expect(pendingQuestionFromFrame({ rpcId: 'r', method: 'question/requested', payload: null })).toBeNull()
    expect(pendingQuestionFromFrame({ rpcId: 'r', method: 'question/requested', payload: { sessionId: 5, questions: [] } })).toBeNull()
    expect(pendingQuestionFromFrame({ rpcId: 'r', method: 'question/requested', payload: { sessionId: 's', questions: 'nope' } })).toBeNull()
  })
})

describe('isQuestionResolvedFrame / isSessionEventFrame', () => {
  it('recognizes question/resolved by method', () => {
    expect(isQuestionResolvedFrame({ rpcId: 'r', method: 'question/resolved', payload: { type: 'question/resolved', sessionId: 's', questionRpcId: 'q' } })).toBe(true)
    expect(isQuestionResolvedFrame({ rpcId: 'r', method: 'question/requested', payload: {} })).toBe(false)
  })

  it('recognizes session/event frames for the matching session', () => {
    const frame = { rpcId: 'r', method: 'session/event', payload: { sessionId: 's1', event: { type: 'turn/start' } } }
    expect(isSessionEventFrame(frame, 's1')).toBe(true)
    expect(isSessionEventFrame(frame, 's2')).toBe(false)
    expect(isSessionEventFrame({ rpcId: 'r', method: 'question/requested', payload: { sessionId: 's1' } }, 's1')).toBe(false)
  })
})
