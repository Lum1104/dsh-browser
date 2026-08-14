/**
 * Side panel application: chat with the local dsh agent, plus a settings
 * view. Renders conversation from session history and live session events;
 * browser actions are driven by the model through the bridge tools (the panel
 * only shows tool activity cards).
 *
 * @module
 */

import { memo, useEffect, useMemo, useRef, useState } from 'react'
import type { BridgeCaps } from '@deepseek-ai/dsh-bridge-browser/src/protocol.ts'
import type { ServerFrame } from '@deepseek-ai/dsh-bridge-browser/src/protocol.ts'
import type { BridgeState } from '../background/bridge.ts'
import { connectPanel, type PanelApi, type PanelSettings } from './api.ts'
import { renderMarkdown } from './markdown.ts'
import whaleUrl from '../../assets/icons/deepseek-256.png'

/** One rendered conversation row. */
import {
  appendLiveRow,
  completeLastTool,
  isQuestionResolvedFrame,
  mergeHistoryRows,
  pendingQuestionFromFrame,
  rowFromEvent,
  toolSummary,
  type EventFrameView,
  type PendingQuestion,
  type QuestionItem,
  type Row,
  type SessionEventView,
} from './events.ts'

const STATE_LABEL: Record<BridgeState, string> = {
  connected: '已连接',
  connecting: '连接中…',
  reconnecting: '重连中…',
  stopped: '未连接',
}

function SettingsIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M10 7.35A2.65 2.65 0 1 0 10 12.65 2.65 2.65 0 0 0 10 7.35Z" />
      <path d="M16.15 11.2a6.4 6.4 0 0 0 0-2.4l1.18-.91-1.5-2.6-1.4.57a6.3 6.3 0 0 0-2.08-1.2L12.15 3h-3l-.2 1.66a6.3 6.3 0 0 0-2.08 1.2l-1.4-.57-1.5 2.6 1.18.91a6.4 6.4 0 0 0 0 2.4l-1.18.91 1.5 2.6 1.4-.57a6.3 6.3 0 0 0 2.08 1.2l.2 1.66h3l.2-1.66a6.3 6.3 0 0 0 2.08-1.2l1.4.57 1.5-2.6-1.18-.91Z" />
    </svg>
  )
}

function PageIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M5.25 2.75h6.1l3.4 3.4v11.1h-9.5V2.75Z" />
      <path d="M11.25 2.9v3.35h3.35M7.7 10h4.6M7.7 13h4.6" />
    </svg>
  )
}

function SendIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M10 15.5v-11M5.5 9 10 4.5 14.5 9" />
    </svg>
  )
}

function ToolIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M12.1 3.35a4 4 0 0 0-4.75 5.27l-4.1 4.1a1.85 1.85 0 1 0 2.62 2.62l4.1-4.1a4 4 0 0 0 5.25-4.78l-2.45 2.45-1.9-.5-.5-1.9 2.45-2.45a4 4 0 0 0-.72-.71Z" />
    </svg>
  )
}

function BackIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="m12.5 4.5-5.5 5.5 5.5 5.5" />
    </svg>
  )
}

/**
 * One conversation row body. Memoized: rows are immutable (append/merge copy
 * the array but reuse row objects), so markdown is re-parsed only when a
 * row's text actually changes — typing must not re-render every message.
 */
const MessageBody = memo(function MessageBody({ row }: { row: Row }): React.JSX.Element {
  if (row.kind === 'user' || row.kind === 'assistant') {
    return <div className="body md" dangerouslySetInnerHTML={{ __html: renderMarkdown(row.text) }} />
  }
  return <pre>{row.text}</pre>
})

const ToolActivity = memo(function ToolActivity({ row }: { row: Row }): React.JSX.Element {
  const running = row.status === 'running'
  return (
    <div className={`tool-activity ${running ? 'running' : 'complete'}`} role="status">
      <span className="tool-icon"><ToolIcon /></span>
      <span className="tool-copy">
        <span className="tool-label">{running ? '正在操作页面' : '页面操作'}</span>
        <span className="tool-summary">{row.text}</span>
      </span>
      <span className="tool-state" aria-label={running ? '进行中' : '已完成'}>
        {running ? <span className="spinner" /> : '完成'}
      </span>
    </div>
  )
})

/** 单个问题的草稿：已选项 + 自定义答案。 */
interface QuestionDraft {
  selected: string[]
  custom: string
}

/**
 * 待回答问题卡片：agent 调用 ask_user_question 后，主界面会弹问题卡片，
 * 但侧边栏此前看不到也答不了（表现为一直转圈）。这里把问题渲染出来，
 * 答案通过桥的 /api/respond 通道回传。
 */
function QuestionCard({
  question,
  drafts,
  draftOf,
  onToggleOption,
  onCustom,
  onSubmit,
  onCancel,
  submitting,
}: {
  question: PendingQuestion
  drafts: Record<string, QuestionDraft>
  draftOf: (questionId: string) => QuestionDraft
  onToggleOption: (item: QuestionItem, label: string, checked: boolean) => void
  onCustom: (item: QuestionItem, value: string) => void
  onSubmit: () => void
  onCancel: () => void
  submitting: boolean
}): React.JSX.Element {
  return (
    <div className="question-card" role="status" aria-label="等待回答">
      <div className="question-heading">
        <span className="question-mark">?</span>
        <div>
          <span className="eyebrow">等待回答</span>
          <h1>助手需要你确认</h1>
        </div>
      </div>
      {question.questions.map((item, index) => {
        const draft = draftOf(item.id)
        const multi = item.multiSelect === true
        return (
          <div className="question-item" key={item.id}>
            <div className="question-copy">
              {question.questions.length > 1 && <span className="question-index">{index + 1}.</span>}
              <strong>{item.header ?? item.question}</strong>
              {item.detail !== undefined && item.detail !== '' && <small>{item.detail}</small>}
            </div>
            {Array.isArray(item.options) && item.options.length > 0 && (
              <div className="question-options" role={multi ? 'group' : 'radiogroup'}>
                {item.options.map((option) => {
                  const checked = draft.selected.includes(option.label)
                  return (
                    <label key={option.label} className={`question-option ${checked ? 'checked' : ''}`}>
                      <input
                        type={multi ? 'checkbox' : 'radio'}
                        name={`q-${item.id}`}
                        checked={checked}
                        onChange={(e) => onToggleOption(item, option.label, e.target.checked)}
                      />
                      <span className="question-option-copy">
                        <span>{option.label}</span>
                        {option.description !== undefined && option.description !== '' && <small>{option.description}</small>}
                      </span>
                    </label>
                  )
                })}
              </div>
            )}
            <label className="question-custom">
              <input
                type="text"
                placeholder="输入你的答案"
                value={draft.custom}
                disabled={submitting}
                onChange={(e) => onCustom(item, e.target.value)}
              />
            </label>
          </div>
        )
      })}
      <div className="question-actions">
        <button className="primary" onClick={onSubmit} disabled={submitting || !allQuestionsAnswered(question, drafts)}>
          {submitting ? '提交中…' : '提交'}
        </button>
        <button className="secondary" onClick={onCancel} disabled={submitting}>放弃</button>
      </div>
    </div>
  )
}

/** 提交按钮可用性：每个问题都必须已作答（选项或自定义答案）。 */
function allQuestionsAnswered(question: PendingQuestion, drafts: Record<string, QuestionDraft>): boolean {
  return question.questions.every((item) => {
    const draft = drafts[item.id]
    return draft !== undefined && (draft.selected.length > 0 || draft.custom.trim() !== '')
  })
}

export function App(): React.JSX.Element {
  const [api] = useState<PanelApi>(() => connectPanel())
  const [state, setState] = useState<BridgeState>('stopped')
  const [caps, setCaps] = useState<BridgeCaps | null>(null)
  const [settings, setSettings] = useState<PanelSettings | null>(null)
  const [pageInfo, setPageInfo] = useState<string | null>(null)
  const [rows, setRows] = useState<Row[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [working, setWorking] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [question, setQuestion] = useState<PendingQuestion | null>(null)
  const [questionDrafts, setQuestionDrafts] = useState<Record<string, QuestionDraft>>({})
  const [submitting, setSubmitting] = useState(false)
  const respondSeq = useRef(0)
  const seqRef = useRef(0)
  const sessionRef = useRef<string | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  const nextSeq = (): number => { seqRef.current += 1; return seqRef.current }

  /** 单个问题的草稿（选项/自定义答案）。 */
  const draftOf = (questionId: string): QuestionDraft => questionDrafts[questionId] ?? { selected: [], custom: '' }

  const setDraft = (questionId: string, patch: Partial<QuestionDraft>): void => {
    setQuestionDrafts((prev) => ({
      ...prev,
      [questionId]: { ...(prev[questionId] ?? { selected: [], custom: '' }), ...patch },
    }))
  }

  const toggleOption = (item: QuestionItem, label: string, checked: boolean): void => {
    const draft = draftOf(item.id)
    if (item.multiSelect === true) {
      const selected = checked
        ? [...draft.selected, label]
        : draft.selected.filter((existing) => existing !== label)
      setDraft(item.id, { selected, custom: '' })
    } else {
      setDraft(item.id, { selected: checked ? [label] : [], custom: '' })
    }
  }

  const changeCustom = (item: QuestionItem, value: string): void => {
    const draft = draftOf(item.id)
    // 自定义答案会清空单选（与主界面行为一致）；多选保留已选项。
    setDraft(item.id, { selected: item.multiSelect === true ? draft.selected : [], custom: value })
  }

  /** 把答案回传给桥 /api/respond，解除 agent 的等待。 */
  async function submitQuestion(): Promise<void> {
    if (question === null || submitting) return
    if (!allQuestionsAnswered(question, questionDrafts)) {
      setError('请先完成这道问题。')
      return
    }
    setSubmitting(true)
    setError(null)
    const answers = question.questions.map((item) => {
      const draft = draftOf(item.id)
      return { id: item.id, selected: draft.selected, ...(draft.custom.trim() !== '' ? { custom: draft.custom.trim() } : {}) }
    })
    try {
      const receipt = await api.respond(`respond-${++respondSeq.current}`, question.rpcId, {
        ok: true,
        value: { sessionId: question.sessionId, answer: { answers } },
      }) as { accepted?: boolean }
      if (receipt.accepted === false) {
        setError('问题应答被拒绝，可能已被处理。')
        return
      }
      setQuestion(null)
      setQuestionDrafts({})
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSubmitting(false)
    }
  }

  /** 放弃整组问题（agent 的 ask_user_question 以 cancelled 结算）。 */
  async function cancelQuestion(): Promise<void> {
    if (question === null || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      await api.respond(`respond-${++respondSeq.current}`, question.rpcId, {
        ok: false,
        error: { code: 'cancelled', message: 'the user closed this question request' },
      })
      setQuestion(null)
      setQuestionDrafts({})
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSubmitting(false)
    }
  }

  /** 停止当前正在运行的 turn（等价于主界面的“停止生成”）。 */
  async function stopTurn(): Promise<void> {
    const id = sessionRef.current
    if (id === null) return
    setError(null)
    try {
      await api.rpc('session.cancel', { sessionId: id })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  // Settings: seed from storage, then let the panel own the form.
  useEffect(() => {
    void chrome.storage.local.get('dshSettings').then((stored) => {
      const raw = stored.dshSettings as Partial<PanelSettings> | undefined
      setSettings({
        bridgeUrl: raw?.bridgeUrl ?? '',
        token: raw?.token ?? '',
        sharePageContent: raw?.sharePageContent ?? 'ask',
      })
    })
  }, [])

  // 每次连接重启（设置变更/断线重连）都新建会话。状态消息逐条监听：
  // React 会把 stopped/connecting 等瞬时状态合并进同一帧渲染，依赖渲染
  // 状态无法可靠观察到"连接已重置"，因此在这里按消息粒度判定。
  const [sessionEpoch, setSessionEpoch] = useState(0)
  const lastStateRef = useRef<BridgeState | null>(null)
  useEffect(() => {
    const offStatus = api.onStatus((next, nextCaps) => {
      setState(next)
      setCaps(nextCaps)
      const previous = lastStateRef.current
      lastStateRef.current = next
      if (previous !== null && next !== previous && next === 'stopped') {
        sessionRef.current = null
        setRows([])
        setWorking(false)
        setSessionEpoch((epoch) => epoch + 1)
      }
    })
    const offEvent = api.onEvent((frame) => { void onFrame(frame) })
    api.requestStatus()
    return () => { offStatus(); offEvent() }
  }, [api])

  useEffect(() => {
    if (state === 'connected' && sessionRef.current === null) {
      void ensureSession()
    }
  }, [state, sessionEpoch])

  // 页面芯片显示浏览器当前活动标签页（标题，缺省退回 URL）；切换/更新时刷新。
  useEffect(() => {
    const refresh = (): void => {
      void chrome.tabs.query({ active: true, lastFocusedWindow: true }).then((tabs) => {
        const tab = tabs[0]
        setPageInfo(
          tab !== undefined && tab.title !== undefined && tab.title !== ''
            ? tab.title
            : tab !== undefined && tab.url !== undefined && tab.url !== ''
              ? tab.url
              : null,
        )
      }).catch(() => setPageInfo(null))
    }
    refresh()
    chrome.tabs.onActivated.addListener(refresh)
    chrome.tabs.onUpdated.addListener(refresh)
    return () => {
      chrome.tabs.onActivated.removeListener(refresh)
      chrome.tabs.onUpdated.removeListener(refresh)
    }
  }, [])

  // Auto-scroll to the newest row.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [rows, working])

  /** Live frame handling: session events append rows; turn/end reconciles with history. */
  async function onFrame(frame: ServerFrame): Promise<void> {
    if (frame.t !== 'event') return
    const inner = frame.frame as EventFrameView
    // 待回答的问题：agent 卡在 ask_user_question 上。侧边栏必须能直接应答，
    // 否则面板会一直显示“正在操作页面 ask_user_question”转圈（假死）。
    const pending = pendingQuestionFromFrame(inner)
    if (pending !== null) {
      if (pending.sessionId === sessionRef.current) {
        setQuestion(pending)
        setQuestionDrafts({})
        setError(null)
      }
      return
    }
    if (isQuestionResolvedFrame(inner)) {
      setQuestion(null)
      setQuestionDrafts({})
      return
    }
    const payload = inner.payload as { sessionId?: string; event?: SessionEventView } | undefined
    if (payload?.sessionId !== sessionRef.current || payload.event === undefined) return
    if (payload.event.type === 'turn/start') {
      setWorking(true)
      return
    }
    const row = rowFromEvent(payload.event)
    if (row !== null) {
      setRows((prev) => appendLiveRow(prev, row.kind, row.text, nextSeq()))
      if (row.kind === 'assistant') setWorking(false)
      return
    }
    if (payload.event.type === 'tool/call') {
      setWorking(true)
      const summary = toolSummary(payload.event.data?.name ?? 'tool', payload.event.data?.arguments)
      setRows((prev) => appendLiveRow(prev, 'tool', summary, nextSeq()))
      return
    }
    if (payload.event.type === 'tool/result') {
      // 并入最后一行工具行：调用已完成（不新增行）。
      setRows((prev) => completeLastTool(prev, nextSeq()))
      return
    }
    if (payload.event.type === 'turn/end') {
      setWorking(false)
      await refreshHistory()
    }
  }

  async function refreshHistory(): Promise<void> {
    const id = sessionRef.current
    if (id === null) return
    try {
      const result = await api.rpc<{ events: { event: SessionEventView }[] }>('session.history', { sessionId: id })
      setRows(mergeHistoryRows(result.events.map((entry) => entry.event), nextSeq))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  /** 每次打开侧边栏都新建一个会话（与 GUI/其他界面的历史完全隔离）。 */
  async function ensureSession(): Promise<void> {
    try {
      const created = await api.rpc<{ sessionId: string }>('session.create', {})
      sessionRef.current = created.sessionId
      await refreshHistory()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const sendingRef = useRef(false)
  async function send(textOverride?: string): Promise<void> {
    const text = (textOverride ?? input).trim()
    // busy state 是异步的：连续回车可能都通过 state 检查——用 ref 同步锁。
    if (text === '' || busy || sendingRef.current || sessionRef.current === null) return
    sendingRef.current = true
    setInput('')
    setBusy(true)
    setWorking(true)
    setError(null)
    // 不渲染乐观行：live user/message 事件即时回显，避免同一消息出现两行。
    try {
      await api.rpc('session.prompt', {
        sessionId: sessionRef.current,
        mode: 'queue',
        content: [{ type: 'text', text }],
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setWorking(false)
    } finally {
      setBusy(false)
      sendingRef.current = false
    }
  }

  function saveSettings(): void {
    if (settings === null) return
    api.updateSettings(settings)
    setShowSettings(false)
  }

  // 状态栏只显示连接状态；快照上限是技术细节，在设置页说明（见 hint）。
  const statusText = useMemo(() => STATE_LABEL[state], [state])

  if (showSettings) {
    return (
      <div className="settings">
        <div className="settings-heading">
          <button className="icon-button" onClick={() => setShowSettings(false)} aria-label="返回对话"><BackIcon /></button>
          <div>
            <span className="eyebrow">偏好设置</span>
            <h1>连接与隐私</h1>
          </div>
        </div>
        <div className="settings-panel">
          <label>
            <span>桥地址</span>
            <small>留空时自动检测本机服务</small>
            <input
              value={settings?.bridgeUrl ?? ''}
              onChange={(e) => setSettings((prev) => prev === null ? prev : { ...prev, bridgeUrl: e.target.value })}
              placeholder="自动检测 3080 / 3081 / 3090"
            />
          </label>
          <label>
            <span>Token</span>
            <small>本地连接无需填写</small>
            <input
              type="password"
              value={settings?.token ?? ''}
              onChange={(e) => setSettings((prev) => prev === null ? prev : { ...prev, token: e.target.value })}
              placeholder="远程部署时填写"
            />
          </label>
          <label>
            <span>页面内容共享</span>
            <small>控制助手何时可以读取页面文字</small>
            <select
              value={settings?.sharePageContent ?? 'ask'}
              onChange={(e) => setSettings((prev) => prev === null ? prev : { ...prev, sharePageContent: e.target.value as PanelSettings['sharePageContent'] })}
            >
              <option value="ask">每次询问</option>
              <option value="auto">自动共享</option>
              <option value="off">关闭</option>
            </select>
          </label>
        </div>
        <div className="settings-actions">
          <button className="primary" onClick={saveSettings}>保存并连接</button>
          <button className="secondary" onClick={() => setShowSettings(false)}>取消</button>
        </div>
        <p className="hint">页面快照上限为 {caps?.snapshotMaxChars ?? 12000} 字符，超出内容会被截断。可在 dsh 插件中调整 snapshotMaxChars。</p>
      </div>
    )
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark"><img src={whaleUrl} alt="" /></span>
          <span className="brand-copy"><strong>浏览助手</strong><small>页面副驾驶</small></span>
        </div>
        <span className="connection" role="status"><span className={`dot ${state}`} />{statusText}</span>
        <button className="icon-button" onClick={() => setShowSettings(true)} aria-label="打开设置" title="设置"><SettingsIcon /></button>
      </header>
      <section className="context-card" aria-label="当前页面">
        <span className="context-icon"><PageIcon /></span>
        <span className="context-copy">
          <small>当前页面</small>
          <strong title={pageInfo ?? undefined}>{pageInfo ?? '等待浏览器页面'}</strong>
        </span>
        <button className="context-action" disabled={state !== 'connected' || busy}
          onClick={() => { void send('请用 browser_snapshot 读取当前页面，然后告诉我页面上有什么，并等待我的指令。') }}>
          读取页面
        </button>
      </section>
      <div className="messages" ref={scrollRef}>
        {rows.length === 0 && !working && (
          <div className="empty">
            <span className="empty-logo"><img src={whaleUrl} alt="" /></span>
            <div>
              <h1>把当前页面交给我</h1>
              <p>我可以阅读页面、查找信息，也可以替你点击、填写和导航。</p>
            </div>
            <button disabled={state !== 'connected'}
              onClick={() => { void send('请先概览当前页面，告诉我最重要的信息，并等待我的下一步指令。') }}>
              先概览这个页面
            </button>
          </div>
        )}
        {rows.map((row) => (
          <div key={row.seq} className={`row ${row.kind}`}>
            {row.kind === 'assistant' && <span className="assistant-avatar"><img src={whaleUrl} alt="助手" /></span>}
            {row.kind === 'tool' ? <ToolActivity row={row} /> : <MessageBody row={row} />}
          </div>
        ))}
        {working && question === null && rows[rows.length - 1]?.status !== 'running' && (
          <div className="ai-progress" role="status" aria-label="助手正在处理">
            <span className="assistant-avatar"><img src={whaleUrl} alt="" /></span>
            <span className="progress-dots" aria-hidden="true"><i /><i /><i /></span>
            <span>{rows[rows.length - 1]?.kind === 'tool' ? '正在整理结果' : '正在思考'}</span>
          </div>
        )}
      </div>
      {question !== null && (
        <QuestionCard
          question={question}
          drafts={questionDrafts}
          draftOf={draftOf}
          onToggleOption={toggleOption}
          onCustom={changeCustom}
          onSubmit={() => void submitQuestion()}
          onCancel={() => void cancelQuestion()}
          submitting={submitting}
        />
      )}
      {error !== null && <div className="error">{error}</div>}
      <footer className="composer">
        <div className="composer-box">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              // isComposing：输入法组词中的回车是确认选字，不是发送。
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void send()
              }
            }}
            placeholder={state === 'connected' ? '告诉我想在这个页面做什么…' : '连接 dsh 后即可开始'}
            disabled={state !== 'connected'}
            rows={2}
          />
          <div className="composer-actions">
            <span>Enter 发送 · Shift + Enter 换行</span>
            {working ? (
              <button className="stop" onClick={() => void stopTurn()} aria-label="停止生成" title="停止当前回合">
                停止
              </button>
            ) : (
              <button onClick={() => void send()} disabled={state !== 'connected' || busy || input.trim() === ''} aria-label="发送消息"><SendIcon /></button>
            )}
          </div>
        </div>
      </footer>
    </div>
  )
}
