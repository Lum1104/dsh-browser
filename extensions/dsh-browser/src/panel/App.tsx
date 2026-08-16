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
import type { ApprovalDecision, ApprovalRequest } from '../security/approval.ts'
import { getUiLocale } from '../i18n.ts'
import { PANEL_COPY, type PanelCopy } from './strings.ts'
import { QuestionCard } from './QuestionCard.tsx'
import type { QuestionAnswer } from './questions.ts'
import {
  hasPendingQuestion,
  questionReceiptDisposition,
  removePendingQuestion,
  upsertPendingQuestion,
} from './pending-questions.ts'
import { normalizeTrustedOrigin } from '../security/trusted-origins.ts'
import {
  latestSessionTitle,
  projectedSessionTitle,
  resumableSessions,
  sessionAcceptsPrompts,
  sessionDisplayTitle,
  sessionTitleFromEvent,
  SessionRuntimeCache,
  type SessionPickerEntry,
} from './sessions.ts'

/** One rendered conversation row. */
import {
  appendLiveRow,
  completeLastTool,
  mergeHistoryRows,
  pendingQuestionFromFrame,
  resolvedQuestionFromFrame,
  rowFromEvent,
  toolSummary,
  type Row,
  type PendingQuestion,
  type ResolvedQuestion,
  type SessionEventView,
} from './events.ts'

function normalizeWebOrigin(value: string): string | null {
  return normalizeTrustedOrigin(value) ?? null
}

function SettingsIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M10 7.35A2.65 2.65 0 1 0 10 12.65 2.65 2.65 0 0 0 10 7.35Z" />
      <path d="M16.15 11.2a6.4 6.4 0 0 0 0-2.4l1.18-.91-1.5-2.6-1.4.57a6.3 6.3 0 0 0-2.08-1.2L12.15 3h-3l-.2 1.66a6.3 6.3 0 0 0-2.08 1.2l-1.4-.57-1.5 2.6 1.18.91a6.4 6.4 0 0 0 0 2.4l-1.18.91 1.5 2.6 1.4-.57a6.3 6.3 0 0 0 2.08 1.2l.2 1.66h3l.2-1.66a6.3 6.3 0 0 0 2.08-1.2l1.4.57 1.5-2.6-1.18-.91Z" />
    </svg>
  )
}

function ChevronDownIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="m5.5 7.5 4.5 4.5 4.5-4.5" />
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

function ShieldIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M10 2.5 16 5v4.2c0 3.8-2.45 6.45-6 8.3-3.55-1.85-6-4.5-6-8.3V5l6-2.5Z" />
      <path d="M10 6.5v4M10 13.5h.01" />
    </svg>
  )
}

function ApprovalDialog({
  request,
  onDecision,
  copy,
}: {
  request: ApprovalRequest
  onDecision: (decision: ApprovalDecision) => void
  copy: PanelCopy
}): React.JSX.Element {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onDecision('deny')
    }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown) }
  }, [request.id, onDecision])

  return (
    <div className="approval-backdrop">
      <section className="approval-dialog" role="alertdialog" aria-modal="true" aria-labelledby="approval-title">
        <div className="approval-rail" aria-hidden="true" />
        <div className="approval-heading">
          <span className="approval-shield"><ShieldIcon /></span>
          <div>
            <span className="eyebrow">{copy.approval.eyebrow}</span>
            <h2 id="approval-title">{request.kind === 'read' ? copy.approval.readTitle : copy.approval.actionTitle}</h2>
          </div>
        </div>
        <div className="approval-detail">
          <span>{copy.approval.request}</span>
          <strong>{request.summary}</strong>
        </div>
        <div className="approval-origins">
          <span>{copy.approval.origins}</span>
          {request.origins.length === 0
            ? <code className="unknown">{copy.approval.unknownOrigin}</code>
            : request.origins.map((origin) => <code key={origin}>{origin}</code>)}
        </div>
        <div className="approval-actions">
          <button className="deny" autoFocus onClick={() => onDecision('deny')}>{copy.approval.deny}</button>
          <button className="allow" onClick={() => onDecision('allow-once')}>{copy.approval.allowOnce}</button>
          {request.kind === 'read' && (
            <button className="read-always" onClick={() => onDecision('always-allow-reads')}>{copy.approval.alwaysAllowReads}</button>
          )}
          {request.kind === 'action' && request.canTrust && request.origins.length === 1 && (
            <button className="session-trust" onClick={() => onDecision('trust-session')}>{copy.approval.trustSession}</button>
          )}
        </div>
        <small className="approval-footnote">
          {request.kind === 'read'
            ? copy.approval.readFootnote
            : copy.approval.actionFootnote}
        </small>
      </section>
    </div>
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

const ToolActivity = memo(function ToolActivity({ row, copy }: { row: Row; copy: PanelCopy }): React.JSX.Element {
  const running = row.status === 'running'
  return (
    <div className={`tool-activity ${running ? 'running' : 'complete'}`} role="status">
      <span className="tool-icon"><ToolIcon /></span>
      <span className="tool-copy">
        <span className="tool-label">{running ? copy.tool.running : copy.tool.complete}</span>
        <span className="tool-summary">{row.text}</span>
      </span>
      <span className="tool-state" aria-label={running ? copy.tool.inProgress : copy.tool.completed}>
        {running ? <span className="spinner" /> : copy.tool.done}
      </span>
    </div>
  )
})

export function App(): React.JSX.Element {
  const locale = useMemo(() => getUiLocale(), [])
  const copy = PANEL_COPY[locale]
  const [api] = useState<PanelApi>(() => connectPanel())
  const [state, setState] = useState<BridgeState>('stopped')
  const [caps, setCaps] = useState<BridgeCaps | null>(null)
  const [settings, setSettings] = useState<PanelSettings | null>(null)
  const [rows, setRows] = useState<Row[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [working, setWorking] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [approvalQueue, setApprovalQueue] = useState<ApprovalRequest[]>([])
  const [pendingApprovals, setPendingApprovals] = useState<ApprovalRequest[]>([])
  const [trustedOriginInput, setTrustedOriginInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [showSessionPicker, setShowSessionPicker] = useState(false)
  const [loadingSessions, setLoadingSessions] = useState(false)
  const [sessionChanging, setSessionChanging] = useState(false)
  const [sessionList, setSessionList] = useState<SessionPickerEntry[]>([])
  const [sessionTitle, setSessionTitle] = useState<string | null>(null)
  const [questions, setQuestions] = useState<PendingQuestion[]>([])
  const [questionSubmissions, setQuestionSubmissions] = useState<ResolvedQuestion[]>([])
  const questionsRef = useRef<PendingQuestion[]>([])
  const questionSubmissionsRef = useRef<ResolvedQuestion[]>([])
  const stoppingRef = useRef(false)
  const sessionChangingRef = useRef(false)
  const sessionTransitionRef = useRef(0)
  const sessionRuntimeRef = useRef(new SessionRuntimeCache())
  const seqRef = useRef(0)
  const sessionRef = useRef<string | null>(null)
  const resumeHintRef = useRef<string | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  const nextSeq = (): number => { seqRef.current += 1; return seqRef.current }
  const question = questions[0] ?? null
  const questionSubmitting = question !== null && hasPendingQuestion(questionSubmissions, question)
  const sessionSwitchBlocked = sessionChanging || busy || working || stopping
    || questions.length > 0 || approvalQueue.length > 0
  const sessionReady = sessionAcceptsPrompts(
    state === 'connected',
    sessionChanging,
    sessionRef.current,
  )

  function replaceQuestions(next: PendingQuestion[]): void {
    questionsRef.current = next
    setQuestions(next)
  }

  function removeQuestion(target: ResolvedQuestion): void {
    sessionRuntimeRef.current.resolveQuestion(target)
    replaceQuestions(removePendingQuestion(questionsRef.current, target))
    setQuestionBusy(target, false)
  }

  function clearQuestions(): void {
    replaceQuestions([])
    questionSubmissionsRef.current = []
    setQuestionSubmissions([])
  }

  function setQuestionBusy(target: PendingQuestion | ResolvedQuestion, next: boolean): void {
    const current = questionSubmissionsRef.current
    const updated = next
      ? hasPendingQuestion(current, target)
        ? current
        : [...current, { sessionId: target.sessionId, rpcId: target.rpcId }]
      : removePendingQuestion(current, target)
    questionSubmissionsRef.current = updated
    setQuestionSubmissions(updated)
  }

  // Settings: seed from storage, then let the panel own the form.
  useEffect(() => {
    void chrome.storage.local.get('dshSettings').then((stored) => {
      const raw = stored.dshSettings as Partial<PanelSettings> | undefined
      setSettings({
        bridgeUrl: raw?.bridgeUrl ?? '',
        token: raw?.token ?? '',
        sharePageContent: raw?.sharePageContent ?? 'auto',
        trustedActionOrigins: raw?.trustedActionOrigins ?? [],
        autoOpenSidePanel: raw?.autoOpenSidePanel ?? true,
        autoResumeSession: raw?.autoResumeSession ?? true,
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
        sessionTransitionRef.current += 1
        sessionChangingRef.current = false
        sessionRef.current = null
        sessionRuntimeRef.current.clear()
        setRows([])
        setSessionTitle(null)
        setWorking(false)
        setStopping(false)
        setSessionChanging(false)
        setShowSessionPicker(false)
        stoppingRef.current = false
        clearQuestions()
        setSessionEpoch((epoch) => epoch + 1)
      }
    })
    const offEvent = api.onEvent((frame) => { void onFrame(frame) })
    const offResumeHint = api.onResumeHint((sessionId) => { resumeHintRef.current = sessionId })
    const offApproval = api.onApprovalRequest((request) => {
      if (sessionChangingRef.current) {
        setPendingApprovals((current) => current.some((entry) => entry.id === request.id) ? current : [...current, request])
        return
      }
      setApprovalQueue((current) => current.some((entry) => entry.id === request.id) ? current : [...current, request])
    })
    const offApprovalResolved = api.onApprovalResolved((id) => {
      setApprovalQueue((current) => current.filter((request) => request.id !== id))
      setPendingApprovals((current) => current.filter((request) => request.id !== id))
    })
    api.requestStatus()
    return () => { offStatus(); offEvent(); offResumeHint(); offApproval(); offApprovalResolved() }
  }, [api])

  // 会话切换完成后，把等待中的审批请求并入显示队列。
  useEffect(() => {
    if (sessionChanging) return
    if (pendingApprovals.length === 0) return
    setApprovalQueue((current) => {
      const merged = [...current]
      for (const request of pendingApprovals) {
        if (!merged.some((entry) => entry.id === request.id)) merged.push(request)
      }
      return merged
    })
    setPendingApprovals([])
  }, [sessionChanging, pendingApprovals])

  useEffect(() => {
    if (state === 'connected' && sessionRef.current === null) {
      if (settings?.autoResumeSession !== false) {
        void resumeMostRecentSession()
      } else {
        void ensureSession()
      }
    }
  }, [state, sessionEpoch, settings?.autoResumeSession])

  // Auto-scroll to the newest row.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [rows, working])

  /** Live frame handling: session events append rows; turn/end reconciles with history. */
  async function onFrame(frame: ServerFrame): Promise<void> {
    if (frame.t !== 'event') return
    const pendingQuestion = pendingQuestionFromFrame(frame.frame)
    if (pendingQuestion !== null) {
      sessionRuntimeRef.current.rememberQuestion(pendingQuestion)
      if (pendingQuestion.sessionId === sessionRef.current) {
        const wasEmpty = questionsRef.current.length === 0
        replaceQuestions(upsertPendingQuestion(questionsRef.current, pendingQuestion))
        if (wasEmpty) setError(null)
      }
      return
    }
    const resolvedQuestion = resolvedQuestionFromFrame(frame.frame)
    if (resolvedQuestion !== null) {
      removeQuestion(resolvedQuestion)
      return
    }
    const payload = frame.frame.payload as { sessionId?: string; event?: SessionEventView } | undefined
    if (payload?.sessionId === undefined || payload.event === undefined) return
    const nextTitle = sessionTitleFromEvent(payload.event)
    if (nextTitle !== undefined && payload.sessionId === sessionRef.current) {
      setSessionTitle(nextTitle)
      return
    }
    if (payload.event.type === 'turn/start') {
      sessionRuntimeRef.current.startTurn(payload.sessionId)
      if (payload.sessionId !== sessionRef.current) return
      stoppingRef.current = false
      setStopping(false)
      setWorking(true)
      return
    }
    if (payload.event.type === 'turn/end') {
      sessionRuntimeRef.current.finishTurn(payload.sessionId)
      if (payload.sessionId !== sessionRef.current) return
      stoppingRef.current = false
      setStopping(false)
      setWorking(false)
      clearQuestions()
      await refreshHistory(payload.sessionId)
      return
    }
    if (payload.sessionId !== sessionRef.current) return
    const row = rowFromEvent(payload.event)
    if (row !== null) {
      setRows((prev) => appendLiveRow(prev, row.kind, row.text, nextSeq()))
      return
    }
    if (payload.event.type === 'tool/call') {
      setWorking(true)
      const summary = toolSummary(payload.event.data?.name ?? 'tool', payload.event.data?.arguments, locale)
      setRows((prev) => appendLiveRow(prev, 'tool', summary, nextSeq()))
      return
    }
    if (payload.event.type === 'tool/result') {
      // 并入最后一行工具行：调用已完成（不新增行）。
      setRows((prev) => completeLastTool(prev, nextSeq()))
      return
    }
  }

  async function answerQuestion(target: PendingQuestion, answers: QuestionAnswer[]): Promise<void> {
    if (hasPendingQuestion(questionSubmissionsRef.current, target)
      || !hasPendingQuestion(questionsRef.current, target)) return
    setQuestionBusy(target, true)
    setError(null)
    try {
      const receipt = await api.respond(target.rpcId, {
        ok: true,
        value: { sessionId: target.sessionId, answer: { answers } },
      })
      settleQuestionReceipt(target, receipt)
    } catch (cause) {
      if (hasPendingQuestion(questionsRef.current, target)) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
      setQuestionBusy(target, false)
    }
  }

  async function dismissQuestion(target: PendingQuestion): Promise<void> {
    if (hasPendingQuestion(questionSubmissionsRef.current, target)
      || !hasPendingQuestion(questionsRef.current, target)) return
    setQuestionBusy(target, true)
    setError(null)
    try {
      const receipt = await api.respond(target.rpcId, {
        ok: false,
        error: { code: 'cancelled', message: 'the user dismissed this question request', details: {} },
      })
      settleQuestionReceipt(target, receipt)
    } catch (cause) {
      if (hasPendingQuestion(questionsRef.current, target)) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
      setQuestionBusy(target, false)
    }
  }

  function settleQuestionReceipt(target: PendingQuestion, receipt: unknown): void {
    const disposition = questionReceiptDisposition(receipt)
    if (disposition === 'accepted') {
      removeQuestion(target)
      return
    }
    if (disposition === 'not-pending') {
      setError(copy.question.alreadyAnswered)
      removeQuestion(target)
      return
    }
    setError(copy.question.answerRejected)
    setQuestionBusy(target, false)
  }

  async function refreshHistory(requestedId: string | null = sessionRef.current): Promise<void> {
    const id = requestedId
    if (id === null) return
    try {
      const result = await api.rpc<{ events: { event: SessionEventView }[] }>('session.history', { sessionId: id })
      if (sessionRef.current !== id) return
      const events = result.events.map((entry) => entry.event)
      const historyTitle = latestSessionTitle(events)
      if (historyTitle !== undefined) setSessionTitle(historyTitle)
      setRows(mergeHistoryRows(events, nextSeq, locale))
    } catch (cause) {
      if (sessionRef.current === id) setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  /** 连接后优先续接当前会话：resume-hint 指定 → 最近非空白会话 → 新建。 */
  async function resumeMostRecentSession(): Promise<void> {
    const hinted = resumeHintRef.current
    try {
      const result = await api.rpc<{ items: SessionPickerEntry[] }>('session.list', {})
      for (const entry of result.items ?? []) {
        sessionRuntimeRef.current.seedRunning(entry.sessionId, entry.running)
      }
      const items = resumableSessions(result.items ?? [])
      const target = (hinted !== null ? items.find((entry) => entry.sessionId === hinted) : undefined)
        ?? items[0]
      if (target !== undefined && !sessionChangingRef.current) {
        await resumeSession(target)
        return
      }
    } catch {
      // 列表不可用时回退到新建会话。
    }
    await ensureSession()
  }

  /** 每次打开侧边栏都新建一个会话（与 GUI/其他界面的历史完全隔离）。 */
  async function ensureSession(): Promise<void> {
    const transition = beginSessionTransition()
    try {
      const created = await api.rpc<{ sessionId: string }>('session.create', {})
      if (sessionTransitionRef.current !== transition) return
      sessionRef.current = created.sessionId
      setSessionTitle(null)
      sessionRuntimeRef.current.seedRunning(created.sessionId, false)
      await refreshHistory(created.sessionId)
    } catch (cause) {
      if (sessionTransitionRef.current === transition) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    } finally {
      finishSessionTransition(transition)
    }
  }

  /** 打开历史会话选择器：拉取持久化会话列表（已过滤空白会话），供恢复。 */
  async function openSessionPicker(): Promise<void> {
    if (showSessionPicker) {
      setShowSessionPicker(false)
      return
    }
    if (state !== 'connected' || sessionSwitchBlocked || sessionChangingRef.current) return
    setShowSessionPicker(true)
    setLoadingSessions(true)
    try {
      const result = await api.rpc<{ items: SessionPickerEntry[] }>('session.list', {})
      for (const entry of result.items ?? []) {
        sessionRuntimeRef.current.seedRunning(entry.sessionId, entry.running)
      }
      const items = resumableSessions(result.items ?? [])
      const current = items.find((entry) => entry.sessionId === sessionRef.current)
      const currentTitle = current === undefined ? undefined : projectedSessionTitle(current)
      if (currentTitle !== undefined) setSessionTitle(currentTitle)
      setSessionList(items)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoadingSessions(false)
    }
  }

  /** 恢复历史会话：切换当前 session 并加载其历史。 */
  async function resumeSession(entry: SessionPickerEntry): Promise<void> {
    if (sessionSwitchBlocked || sessionChangingRef.current) return
    const transition = beginSessionTransition()
    const runtime = sessionRuntimeRef.current.snapshot(entry.sessionId, entry.running)
    prepareSessionSwitch(runtime.running, runtime.questions)
    sessionRef.current = entry.sessionId
    setSessionTitle(projectedSessionTitle(entry) ?? sessionDisplayTitle(entry))
    try {
      await refreshHistory(entry.sessionId)
    } finally {
      finishSessionTransition(transition)
    }
  }

  /** 新建会话：丢弃当前会话指针，走正常的隐式创建。 */
  async function startNewSession(): Promise<void> {
    if (sessionSwitchBlocked || sessionChangingRef.current) return
    sessionRef.current = null
    setSessionTitle(null)
    prepareSessionSwitch(false)
    await ensureSession()
  }

  function beginSessionTransition(): number {
    sessionChangingRef.current = true
    setSessionChanging(true)
    sessionTransitionRef.current += 1
    return sessionTransitionRef.current
  }

  function finishSessionTransition(transition: number): void {
    if (sessionTransitionRef.current !== transition) return
    sessionChangingRef.current = false
    setSessionChanging(false)
  }

  function prepareSessionSwitch(nextWorking: boolean, nextQuestions: PendingQuestion[] = []): void {
    setRows([])
    setInput('')
    setWorking(nextWorking)
    setStopping(false)
    stoppingRef.current = false
    replaceQuestions(nextQuestions)
    questionSubmissionsRef.current = []
    setQuestionSubmissions([])
    setError(null)
    setShowSessionPicker(false)
  }

  const sendingRef = useRef(false)
  async function send(textOverride?: string): Promise<void> {
    const text = (textOverride ?? input).trim()
    const id = sessionRef.current
    // busy state 是异步的：连续回车可能都通过 state 检查——用 ref 同步锁。
    if (text === '' || busy || sendingRef.current || sessionChangingRef.current || id === null) return
    sendingRef.current = true
    setInput('')
    setBusy(true)
    setWorking(true)
    setError(null)
    // 不渲染乐观行：live user/message 事件即时回显，避免同一消息出现两行。
    try {
      await api.rpc('session.prompt', {
        sessionId: id,
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

  /** Cancel the active turn while keeping the sidebar session available. */
  async function stopTurn(): Promise<void> {
    const id = sessionRef.current
    if (id === null || stoppingRef.current || sessionChangingRef.current) return
    stoppingRef.current = true
    setStopping(true)
    setError(null)
    try {
      await api.rpc('session.cancel', { sessionId: id })
      if (sessionRef.current === id) {
        sessionRuntimeRef.current.finishTurn(id)
        setWorking(false)
        clearQuestions()
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      stoppingRef.current = false
      setStopping(false)
    }
  }

  function saveSettings(): void {
    if (settings === null) return
    api.updateSettings(settings)
    setShowSettings(false)
  }

  function decideApproval(decision: ApprovalDecision): void {
    const request = approvalQueue[0]
    if (request === undefined) return
    api.respondToApproval(request.id, decision)
    if (decision === 'always-allow-reads') {
      setSettings((current) => current === null ? current : { ...current, sharePageContent: 'auto' })
    }
    setApprovalQueue((current) => current.filter((entry) => entry.id !== request.id))
  }

  function addTrustedOrigin(): void {
    const origin = normalizeWebOrigin(trustedOriginInput)
    if (origin === null) return
    setSettings((current) => current === null
      ? current
      : { ...current, trustedActionOrigins: [...new Set([...current.trustedActionOrigins, origin])].sort() })
    setTrustedOriginInput('')
  }

  function removeTrustedOrigin(origin: string): void {
    setSettings((current) => current === null
      ? current
      : { ...current, trustedActionOrigins: current.trustedActionOrigins.filter((candidate) => candidate !== origin) })
  }

  // 状态栏只显示连接状态；快照上限是技术细节，在设置页说明（见 hint）。
  const statusText = copy.status[state]
  const sessionMenuTitle = sessionTitle ?? copy.app.newSession
  const approvalDialog = approvalQueue[0] === undefined
    ? null
    : <ApprovalDialog request={approvalQueue[0]} onDecision={decideApproval} copy={copy} />

  if (showSettings) {
    return (
      <><div className="settings">
        <div className="settings-heading">
          <button className="icon-button" onClick={() => setShowSettings(false)} aria-label={copy.settings.back}><BackIcon /></button>
          <div>
            <span className="eyebrow">{copy.settings.eyebrow}</span>
            <h1>{copy.settings.title}</h1>
          </div>
        </div>
        <div className="settings-panel">
          <label>
            <span>{copy.settings.bridgeAddress}</span>
            <small>{copy.settings.bridgeHelp}</small>
            <input
              value={settings?.bridgeUrl ?? ''}
              onChange={(e) => setSettings((prev) => prev === null ? prev : { ...prev, bridgeUrl: e.target.value })}
              placeholder={copy.settings.bridgePlaceholder}
            />
          </label>
          <label>
            <span>Token</span>
            <small>{copy.settings.tokenHelp}</small>
            <input
              type="password"
              value={settings?.token ?? ''}
              onChange={(e) => setSettings((prev) => prev === null ? prev : { ...prev, token: e.target.value })}
              placeholder={copy.settings.tokenPlaceholder}
            />
          </label>
          <label>
            <span>{copy.settings.pageSharing}</span>
            <small>{copy.settings.pageSharingHelp}</small>
            <select
              value={settings?.sharePageContent ?? 'auto'}
              onChange={(e) => setSettings((prev) => prev === null ? prev : { ...prev, sharePageContent: e.target.value as PanelSettings['sharePageContent'] })}
            >
              <option value="auto">{copy.settings.sharingAuto}</option>
              <option value="ask">{copy.settings.sharingAsk}</option>
              <option value="off">{copy.settings.sharingOff}</option>
            </select>
          </label>
          <label>
            <span>{copy.settings.autoOpenSidePanel}</span>
            <small>{copy.settings.autoOpenSidePanelHelp}</small>
            <input
              type="checkbox"
              className="local-toggle"
              checked={settings?.autoOpenSidePanel ?? true}
              onChange={(e) => setSettings((prev) => prev === null ? prev : { ...prev, autoOpenSidePanel: e.target.checked })}
            />
          </label>
          <label>
            <span>{copy.settings.autoResumeSession}</span>
            <small>{copy.settings.autoResumeSessionHelp}</small>
            <input
              type="checkbox"
              className="local-toggle"
              checked={settings?.autoResumeSession ?? true}
              onChange={(e) => setSettings((prev) => prev === null ? prev : { ...prev, autoResumeSession: e.target.checked })}
            />
          </label>
        </div>
        <section className="trusted-origins" aria-labelledby="trusted-origins-title">
          <div>
            <span id="trusted-origins-title">{copy.settings.trustedOrigins}</span>
            <small>{copy.settings.trustedOriginsHelp}</small>
          </div>
          <div className="trusted-origin-add">
            <input
              aria-label={copy.settings.trustedOriginInput}
              value={trustedOriginInput}
              onChange={(event) => setTrustedOriginInput(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') addTrustedOrigin() }}
              placeholder="https://example.com / https://*.example.com"
            />
            <button disabled={normalizeWebOrigin(trustedOriginInput) === null} onClick={addTrustedOrigin}>{copy.settings.add}</button>
          </div>
          {trustedOriginInput.trim() !== '' && normalizeWebOrigin(trustedOriginInput) === null && (
            <p className="origin-error">{copy.settings.invalidOrigin}</p>
          )}
          {settings?.trustedActionOrigins.length === 0 && <p>{copy.settings.noTrustedOrigins}</p>}
          {settings?.trustedActionOrigins.map((origin) => (
            <div className="trusted-origin" key={origin}>
              <code>{origin}</code>
              <button onClick={() => removeTrustedOrigin(origin)} aria-label={copy.settings.removeOrigin(origin)}>{copy.settings.remove}</button>
            </div>
          ))}
        </section>
        <div className="settings-actions">
          <button className="primary" onClick={saveSettings}>{copy.settings.save}</button>
          <button className="secondary" onClick={() => setShowSettings(false)}>{copy.settings.cancel}</button>
        </div>
        <p className="hint">{copy.settings.snapshotHint(caps?.snapshotMaxChars ?? 12000)}</p>
      </div>{approvalDialog}</>
    )
  }

  return (
    <><div className="app">
      <header className="topbar">
        <span className="connection" role="status">
          <span className={`dot ${state}`} />
          <span className="connection-label">{statusText}</span>
        </span>
        <button className="session-menu-trigger" disabled={state !== 'connected' || sessionSwitchBlocked}
          aria-expanded={showSessionPicker} aria-label={copy.app.openSessions}
          onClick={() => { void openSessionPicker() }} title={sessionMenuTitle}>
          <span>{sessionMenuTitle}</span>
          <ChevronDownIcon />
        </button>
        <button className="icon-button settings-trigger" onClick={() => setShowSettings(true)}
          aria-label={copy.app.openSettings} title={copy.app.settings}><SettingsIcon /></button>
      </header>
      {showSessionPicker && (
        <section className="session-picker" aria-label={copy.app.sessions}>
          <div className="session-picker-head">
            <strong>{copy.app.sessions}</strong>
            <button className="session-new" disabled={state !== 'connected' || sessionSwitchBlocked}
              onClick={() => { void startNewSession() }}>
              {copy.app.newSession}
            </button>
          </div>
          {loadingSessions
            ? <p className="session-empty">{copy.app.sessionPickerLoading}</p>
            : sessionList.length === 0
              ? <p className="session-empty">{copy.app.sessionPickerEmpty}</p>
              : (
                <ul className="session-list">
                  {sessionList.map((entry) => {
                    const title = sessionDisplayTitle(entry)
                    return (
                      <li key={entry.sessionId}>
                        <button disabled={sessionSwitchBlocked}
                          aria-current={entry.sessionId === sessionRef.current ? 'true' : undefined}
                          onClick={() => { void resumeSession(entry) }}>
                          <span className="session-title" title={title}>{title}</span>
                          <span className="session-meta">
                            <span className="session-time">{new Date(entry.updatedAt).toLocaleString()}</span>
                            {entry.cwd !== undefined && <span className="session-cwd" title={entry.cwd}>{entry.cwd}</span>}
                          </span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
        </section>
      )}
      <div className="messages" ref={scrollRef}>
        {rows.length === 0 && !working && (
          <div className="empty">
            <span className="empty-logo"><img src={whaleUrl} alt="" /></span>
            <div>
              <h1>{copy.app.emptyTitle}</h1>
              <p>{copy.app.emptyDescription}</p>
            </div>
            <button disabled={!sessionReady}
              onClick={() => { void send(copy.app.overviewPrompt) }}>
              {copy.app.overviewPage}
            </button>
          </div>
        )}
        {rows.map((row) => (
          <div key={row.seq} className={`row ${row.kind}`}>
            {row.kind === 'assistant' && <span className="assistant-avatar"><img src={whaleUrl} alt={copy.app.assistant} /></span>}
            {row.kind === 'tool' ? <ToolActivity row={row} copy={copy} /> : <MessageBody row={row} />}
          </div>
        ))}
        {working && question === null && rows[rows.length - 1]?.status !== 'running' && (
          <div className="ai-progress" role="status" aria-label={copy.app.assistantWorking}>
            <span className="assistant-avatar"><img src={whaleUrl} alt="" /></span>
            <span className="progress-dots" aria-hidden="true"><i /><i /><i /></span>
            <span>{rows[rows.length - 1]?.kind === 'tool' ? copy.app.organizingResults : copy.app.thinking}</span>
          </div>
        )}
      </div>
      {question !== null && (
        <QuestionCard
          key={`${question.sessionId}:${question.rpcId}`}
          question={question}
          copy={copy}
          submitting={questionSubmitting}
          onAnswer={(answers) => { void answerQuestion(question, answers) }}
          onDismiss={() => { void dismissQuestion(question) }}
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
            placeholder={state === 'connected' ? copy.app.connectedPlaceholder : copy.app.disconnectedPlaceholder}
            disabled={!sessionReady}
            rows={2}
          />
          <div className="composer-actions">
            <span>{copy.app.composerHelp}</span>
            {working ? (
              <button
                className="stop-button"
                onClick={() => { void stopTurn() }}
                disabled={!sessionReady || stopping}
                aria-label={stopping ? copy.app.stoppingTurn : copy.app.stopTurn}
                title={stopping ? copy.app.stoppingTurn : copy.app.stopTurn}
              >
                <span className="stop-glyph" aria-hidden="true" />
              </button>
            ) : (
              <button onClick={() => void send()} disabled={!sessionReady || busy || input.trim() === ''} aria-label={copy.app.sendMessage}><SendIcon /></button>
            )}
          </div>
        </div>
      </footer>
    </div>{approvalDialog}</>
  )
}
