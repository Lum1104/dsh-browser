/**
 * Pure conversation-rendering logic: maps session events (live and history)
 * to display rows. Kept framework-free so the wire shapes are unit-tested
 * against the REAL SessionEvent contract: `{ type, seq, time, data }` — the
 * payload always lives in `data`, never on the event root.
 *
 * @module
 */

/** One rendered conversation row. */
export interface Row {
  seq: number
  kind: 'user' | 'assistant' | 'tool' | 'info'
  text: string
  status?: 'running' | 'complete'
}

/** Minimal view of a SessionEvent (payload in `data`). */
export interface SessionEventView {
  type: string
  data?: {
    content?: unknown
    message?: { content?: unknown }
    name?: string
    arguments?: string
  }
}

/** One option of a pending question (mirrors askUserQuestionItemSchema). */
export interface QuestionOption {
  label: string
  description?: string
}

/** One item of a pending question batch. */
export interface QuestionItem {
  id: string
  question: string
  header?: string
  detail?: string
  options?: QuestionOption[]
  multiSelect?: boolean
}

/** A pending host interaction rendered as a question card (question/requested). */
export interface PendingQuestion {
  /** The mux envelope rpcId, echoed back when answering. */
  rpcId: string
  sessionId: string
  questions: QuestionItem[]
}

/** The event-frame shape the bridge relays for one mux envelope. */
export interface EventFrameView {
  rpcId: string
  method: string
  payload: unknown
}

/** Extract a pending question from a `question/requested` mux frame (or null). */
export function pendingQuestionFromFrame(frame: EventFrameView): PendingQuestion | null {
  if (frame.method !== 'question/requested') return null
  if (typeof frame.payload !== 'object' || frame.payload === null) return null
  const payload = frame.payload as { sessionId?: unknown; questions?: unknown }
  if (typeof payload.sessionId !== 'string' || !Array.isArray(payload.questions)) return null
  return { rpcId: frame.rpcId, sessionId: payload.sessionId, questions: payload.questions as QuestionItem[] }
}

/** Whether a mux frame marks an earlier question as resolved. */
export function isQuestionResolvedFrame(frame: EventFrameView): boolean {
  return frame.method === 'question/resolved'
}

/** Whether a mux frame is a session event for a given session (session/event). */
export function isSessionEventFrame(frame: EventFrameView, sessionId: string): boolean {
  if (typeof frame.payload !== 'object' || frame.payload === null) return false
  const payload = frame.payload as { sessionId?: unknown; event?: unknown }
  return payload.sessionId === sessionId && typeof payload.event === 'object' && payload.event !== null
}

/** Extract model-visible text from content blocks (defensive: unknown block shapes degrade to markers). */
export function textFromBlocks(blocks: unknown): string {
  if (!Array.isArray(blocks)) return String(blocks ?? '')
  const parts: string[] = []
  for (const block of blocks) {
    if (typeof block !== 'object' || block === null) continue
    const b = block as { type?: string; text?: unknown }
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
  }
  return parts.join('\n')
}

/** Map one session event to a row (user/assistant only; tools handled separately). */
export function rowFromEvent(event: SessionEventView): Row | null {
  switch (event.type) {
    case 'user/message': {
      // dsh 每轮把运行时常量上下文作为 source.kind='plugin' 的 user/message
      // 记入日志（如 <system-reminder> 注入内容）——它们不是用户消息，
      // 渲染会污染对话流，必须跳过。
      const source = (event.data as { source?: { kind?: string } } | undefined)?.source
      if (source?.kind !== 'user') return null
      const text = textFromBlocks(event.data?.content)
      return text.trim() === '' ? null : { seq: 0, kind: 'user', text }
    }
    case 'assistant/message': {
      // 工具调用也会产生 assistant/message，但其 content 可能只有 tool_use
      // 等非文本块。不要为这种中间事件渲染一个空的 AI 气泡。
      const text = textFromBlocks(event.data?.message?.content)
      return text.trim() === '' ? null : { seq: 0, kind: 'assistant', text }
    }
    default:
      return null
  }
}

const TOOL_LABELS: Record<string, string> = {
  browser_snapshot: '读取页面',
  browser_click: '点击元素',
  browser_type: '填写内容',
  browser_press: '按下按键',
  browser_scroll: '滚动页面',
  browser_navigate: '打开页面',
  browser_back: '返回上一页',
  browser_forward: '前进下一页',
  browser_reload: '刷新页面',
  browser_get_text: '提取文字',
  browser_wait: '等待页面',
}

/** 工具调用的友好展示名：带 index 参数时附上（如「点击元素 #7」）。 */
export function toolSummary(name: string, argsJson: unknown): string {
  let summary = TOOL_LABELS[name] ?? name
  try {
    const args = JSON.parse(String(argsJson ?? '{}')) as unknown
    if (typeof args === 'object' && args !== null && 'index' in args) {
      summary += ` #${String((args as { index?: unknown }).index)}`
    }
  } catch {
    // 模型参数不可解析：只显示工具名。
  }
  return summary
}

/** live 合并：若最后一行是工具行则并入（连续工具调用不刷屏），否则新增一行。 */
export function appendLiveRow(rows: Row[], kind: Row['kind'], text: string, seq: number): Row[] {
  if (kind === 'tool') {
    const last = rows[rows.length - 1]
    if (last?.kind === 'tool') {
      return [...rows.slice(0, -1), { seq, kind: 'tool', text: `${last.text} → ${text}`, status: 'running' }]
    }
    return [...rows, { seq, kind, text, status: 'running' }]
  }
  return [...rows, { seq, kind, text }]
}

/** 标记最后一行工具调用已完成（并入，不新增行）。 */
export function completeLastTool(rows: Row[], seq: number): Row[] {
  const last = rows[rows.length - 1]
  if (last?.kind === 'tool') {
    return [...rows.slice(0, -1), { ...last, seq, status: 'complete' }]
  }
  return rows
}

/** 历史渲染：连续工具调用归并成一行（tool/call..result 不逐条刷屏；超 3 个折叠计数）。 */
export function mergeHistoryRows(events: SessionEventView[], nextSeq: () => number): Row[] {
  const rows: Row[] = []
  let pendingTool: { items: string[]; total: number } | null = null
  const flushTool = (): void => {
    if (pendingTool === null) return
    const shown = pendingTool.items.slice(0, 3)
    const label = pendingTool.total > shown.length
      ? `${shown.join(' → ')} 等${pendingTool.total}个工具`
      : shown.join(' → ')
    rows.push({ seq: nextSeq(), kind: 'tool', text: label, status: 'complete' })
    pendingTool = null
  }
  for (const ev of events) {
    if (ev.type === 'tool/call') {
      const summary = toolSummary(ev.data?.name ?? 'tool', ev.data?.arguments)
      if (pendingTool === null) pendingTool = { items: [summary], total: 1 }
      else {
        pendingTool.items.push(summary)
        pendingTool.total += 1
      }
      continue
    }
    if (ev.type === 'tool/result') continue
    flushTool()
    const row = rowFromEvent(ev)
    if (row !== null) rows.push({ ...row, seq: nextSeq() })
  }
  flushTool()
  return rows
}
