import type { BridgeState } from '../background/bridge.ts'
import type { UiLocale } from '../i18n.ts'

export interface PanelCopy {
  documentTitle: string
  status: Record<BridgeState, string>
  approval: {
    eyebrow: string
    readTitle: string
    actionTitle: string
    request: string
    origins: string
    unknownOrigin: string
    deny: string
    allowOnce: string
    alwaysAllowReads: string
    trustSession: string
    readFootnote: string
    actionFootnote: string
  }
  tool: {
    running: string
    complete: string
    inProgress: string
    completed: string
    done: string
    labels: Record<string, string>
    overflow: (shown: string[], total: number) => string
  }
  question: {
    eyebrow: string
    title: string
    customAlternative: string
    customAnswer: string
    dismiss: string
    answer: string
    answering: string
    alreadyAnswered: string
    answerRejected: string
  }
  settings: {
    back: string
    eyebrow: string
    title: string
    bridgeAddress: string
    bridgeHelp: string
    bridgePlaceholder: string
    tokenHelp: string
    tokenPlaceholder: string
    pageSharing: string
    pageSharingHelp: string
    sharingAuto: string
    sharingAsk: string
    sharingOff: string
    autoOpenSidePanel: string
    autoOpenSidePanelHelp: string
    autoResumeSession: string
    autoResumeSessionHelp: string
    trustedOrigins: string
    trustedOriginsHelp: string
    trustedOriginInput: string
    add: string
    invalidOrigin: string
    noTrustedOrigins: string
    remove: string
    removeOrigin: (origin: string) => string
    save: string
    cancel: string
    snapshotHint: (maxChars: number) => string
  }
  app: {
    openSettings: string
    settings: string
    openSessions: string
    sessions: string
    newSession: string
    sessionPickerLoading: string
    sessionPickerEmpty: string
    emptyTitle: string
    emptyDescription: string
    overviewPage: string
    overviewPrompt: string
    assistant: string
    assistantWorking: string
    organizingResults: string
    thinking: string
    connectedPlaceholder: string
    disconnectedPlaceholder: string
    composerHelp: string
    sendMessage: string
    stopTurn: string
    stoppingTurn: string
  }
}

const EN: PanelCopy = {
  documentTitle: 'dsh Browser Assistant',
  status: {
    connected: 'Connected',
    connecting: 'Connecting…',
    reconnecting: 'Reconnecting…',
    stopped: 'Disconnected',
  },
  approval: {
    eyebrow: 'Security check',
    readTitle: 'Allow page access?',
    actionTitle: 'Allow page action?',
    request: 'Request',
    origins: 'Origins involved',
    unknownOrigin: 'Unknown origin',
    deny: 'Deny',
    allowOnce: 'Allow once',
    alwaysAllowReads: 'Always allow reads',
    trustSession: 'Trust this domain for this session',
    readFootnote: 'Esc to deny · You can disable automatic reading in Settings at any time',
    actionFootnote: 'Esc to deny · Temporary trust ends when the side panel closes · Typed content is never shown',
  },
  tool: {
    running: 'Working on page',
    complete: 'Page action',
    inProgress: 'In progress',
    completed: 'Completed',
    done: 'Done',
    labels: {
      browser_snapshot: 'Read page',
      browser_click: 'Click element',
      browser_type: 'Enter text',
      browser_press: 'Press key',
      browser_scroll: 'Scroll page',
      browser_navigate: 'Open page',
      browser_back: 'Go back',
      browser_forward: 'Go forward',
      browser_reload: 'Reload page',
      browser_get_text: 'Extract text',
      browser_wait: 'Wait for page',
    },
    overflow: (shown, total) => `${shown.join(' → ')} → ${total - shown.length} more`,
  },
  question: {
    eyebrow: 'Waiting for your answer',
    title: 'The assistant needs your input',
    customAlternative: 'Or type a different answer',
    customAnswer: 'Type your answer',
    dismiss: 'Dismiss',
    answer: 'Answer',
    answering: 'Answering…',
    alreadyAnswered: 'This question was already handled in another window.',
    answerRejected: 'The answer was not accepted. Review it and try again.',
  },
  settings: {
    back: 'Back to chat',
    eyebrow: 'Preferences',
    title: 'Connection & Privacy',
    bridgeAddress: 'Bridge address',
    bridgeHelp: 'Leave blank to detect a local service automatically',
    bridgePlaceholder: 'Auto-detect 3080 / 3081 / 3090',
    tokenHelp: 'Not required for local connections',
    tokenPlaceholder: 'Required for remote deployments',
    pageSharing: 'Page content sharing',
    pageSharingHelp: 'Control when the assistant can read page text',
    sharingAuto: 'Share automatically (default)',
    sharingAsk: 'Ask every time',
    sharingOff: 'Off',
    autoOpenSidePanel: 'Browser approval notifications',
    autoOpenSidePanelHelp: 'Notify when a browser action needs approval while the panel is closed. Off = no notifications.',
    autoResumeSession: 'Resume current session on open',
    autoResumeSessionHelp: 'Resume the latest conversation on open. Off = always start fresh.',
    trustedOrigins: 'Always-allowed domains',
    trustedOriginsHelp: 'The approval dialog can trust a domain for the current side-panel session only. Domains added here permanently skip action confirmation when every known origin is trusted. Wildcards include the base domain and subdomains, and stay scoped to their scheme and port; `*.example.com` defaults to HTTPS.',
    trustedOriginInput: 'Domain to always trust (e.g. https://example.com or https://*.example.com)',
    add: 'Add',
    invalidOrigin: 'Enter an http:// or https:// origin, or a wildcard such as https://*.example.com.',
    noTrustedOrigins: 'No domains are currently trusted.',
    remove: 'Remove',
    removeOrigin: (origin) => `Remove ${origin}`,
    save: 'Save & Connect',
    cancel: 'Cancel',
    snapshotHint: (maxChars) => `Page snapshots are limited to ${maxChars} characters and longer content is truncated. Change snapshotMaxChars in the dsh plugin to adjust this limit.`,
  },
  app: {
    openSettings: 'Open settings',
    settings: 'Settings',
    openSessions: 'Session history',
    sessions: 'Sessions',
    newSession: 'New chat',
    sessionPickerLoading: 'Loading…',
    sessionPickerEmpty: 'No past sessions yet',
    emptyTitle: 'Hand me the current page',
    emptyDescription: 'I can read the page, find information, and click, fill, or navigate for you.',
    overviewPage: 'Give me an overview',
    overviewPrompt: 'First give me an overview of the current page, tell me the most important information, and wait for my next instruction.',
    assistant: 'Assistant',
    assistantWorking: 'Assistant is working',
    organizingResults: 'Organizing results',
    thinking: 'Thinking',
    connectedPlaceholder: 'Tell me what you want to do on this page…',
    disconnectedPlaceholder: 'Connect to dsh to get started',
    composerHelp: 'Enter to send · Shift + Enter for a new line',
    sendMessage: 'Send message',
    stopTurn: 'Stop generating',
    stoppingTurn: 'Stopping…',
  },
}

const ZH: PanelCopy = {
  documentTitle: 'dsh 浏览器助手',
  status: {
    connected: '已连接',
    connecting: '连接中…',
    reconnecting: '重连中…',
    stopped: '未连接',
  },
  approval: {
    eyebrow: '安全检查',
    readTitle: '允许读取页面？',
    actionTitle: '允许执行页面操作？',
    request: '请求',
    origins: '涉及来源',
    unknownOrigin: '未知来源',
    deny: '拒绝',
    allowOnce: '仅允许这一次',
    alwaysAllowReads: '始终允许读取',
    trustSession: '本次会话信任此域',
    readFootnote: 'Esc 拒绝 · 可随时在设置中关闭自动读取',
    actionFootnote: 'Esc 拒绝 · 关闭侧栏后临时信任失效 · 输入内容不会显示',
  },
  tool: {
    running: '正在操作页面',
    complete: '页面操作',
    inProgress: '进行中',
    completed: '已完成',
    done: '完成',
    labels: {
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
    },
    overflow: (shown, total) => `${shown.join(' → ')} 等${total}个工具`,
  },
  question: {
    eyebrow: '等待你的回答',
    title: '助手需要你确认',
    customAlternative: '或输入其他答案',
    customAnswer: '输入你的答案',
    dismiss: '放弃',
    answer: '回答',
    answering: '回答中…',
    alreadyAnswered: '这个问题已在另一个窗口中处理。',
    answerRejected: '回答未被接受，请检查后重试。',
  },
  settings: {
    back: '返回对话',
    eyebrow: '偏好设置',
    title: '连接与隐私',
    bridgeAddress: '桥地址',
    bridgeHelp: '留空时自动检测本机服务',
    bridgePlaceholder: '自动检测 3080 / 3081 / 3090',
    tokenHelp: '本地连接无需填写',
    tokenPlaceholder: '远程部署时填写',
    pageSharing: '页面内容共享',
    pageSharingHelp: '控制助手何时可以读取页面文字',
    sharingAuto: '自动共享（默认）',
    sharingAsk: '每次询问',
    sharingOff: '关闭',
    autoOpenSidePanel: '浏览器审批通知',
    autoOpenSidePanelHelp: '侧边栏关闭时有浏览器操作待审批时提醒你。关闭则不再弹通知。',
    autoResumeSession: '打开时自动续接当前会话',
    autoResumeSessionHelp: '打开时续接最近对话；关闭则每次全新会话。',
    trustedOrigins: '永久免确认域名',
    trustedOriginsHelp: '审批框可只信任本次侧栏会话。这里添加的域名仅在所有已知来源均受信任时免除操作确认。通配符包含主域及其子域，并严格区分协议和端口；`*.example.com` 默认使用 HTTPS。',
    trustedOriginInput: '要永久信任的域名（如 https://example.com 或 https://*.example.com）',
    add: '添加',
    invalidOrigin: '请输入 http://、https:// 来源或 https://*.example.com 形式的通配符。',
    noTrustedOrigins: '尚未信任任何域名。',
    remove: '移除',
    removeOrigin: (origin) => `移除 ${origin}`,
    save: '保存并连接',
    cancel: '取消',
    snapshotHint: (maxChars) => `页面快照上限为 ${maxChars} 字符，超出内容会被截断。可在 dsh 插件中调整 snapshotMaxChars。`,
  },
  app: {
    openSettings: '打开设置',
    settings: '设置',
    openSessions: '历史会话',
    sessions: '会话',
    newSession: '新对话',
    sessionPickerLoading: '加载中…',
    sessionPickerEmpty: '暂无历史会话',
    emptyTitle: '把当前页面交给我',
    emptyDescription: '我可以阅读页面、查找信息，也可以替你点击、填写和导航。',
    overviewPage: '先概览这个页面',
    overviewPrompt: '请先概览当前页面，告诉我最重要的信息，并等待我的下一步指令。',
    assistant: '助手',
    assistantWorking: '助手正在处理',
    organizingResults: '正在整理结果',
    thinking: '正在思考',
    connectedPlaceholder: '告诉我想在这个页面做什么…',
    disconnectedPlaceholder: '连接 dsh 后即可开始',
    composerHelp: 'Enter 发送 · Shift + Enter 换行',
    sendMessage: '发送消息',
    stopTurn: '停止生成',
    stoppingTurn: '正在停止…',
  },
}

export const PANEL_COPY: Record<UiLocale, PanelCopy> = { en: EN, zh: ZH }
