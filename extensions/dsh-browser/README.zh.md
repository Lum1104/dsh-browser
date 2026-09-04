# dsh 浏览器操作扩展（Chrome 与 Firefox MV3）

[English](README.md) | 中文

dsh 的**浏览器操作端**：让模型直接读取并操作你在浏览器里打开的页面——抓取内容、点击元素、填写表单、滚动与导航，全部在真实页面执行、登录态保留。侧边栏面板是与模型对话的入口。

**两条明确分离的通道**：浏览器页面仍以结构化文本呈现（带编号的交互元素清单），浏览器工具不会截图；另一方面，现版本 dsh 宿主可声明多模态图片限制，侧栏据此接收 PNG、JPEG、WebP 和 GIF，并渲染会话中的持久图片附件。

## 模型能做什么

| 能力 | 动作 | 说明 |
|---|---|---|
| 读取页面 | `browser_snapshot` | 标题/URL/正文/编号交互清单/表单字段（敏感值掩码）；`delta: true` 只返回变化，省 token |
| 点击元素 | `browser_click` | 按编号点击（链接/按钮/复选框…），React/Vue 组件兼容 |
| 填写表单 | `browser_type` | 输入文本，`replace` 清空重填 |
| 按键 | `browser_press` | Enter/Tab/Escape/方向键等 |
| 滚动 | `browser_scroll` | 视口滚动（up/down/top/bottom） |
| 导航 | `browser_navigate` / `browser_back` / `browser_forward` / `browser_reload` | 受控标签页内跳转，登录态保留 |
| 新建并跟随标签页 | `browser_open_tab` | 在前台新标签页打开 HTTP(S) 地址，并让后续浏览器工具绑定该标签页 |
| 管理已打开标签页 | `browser_list_tabs` / `browser_follow_tab` / `browser_close_tab` | 查看标题和链接、绑定某个已有标签页但不激活它，或关闭指定标签页 |
| 读区域 | `browser_get_text` | 懒加载内容 / 局部文本 |
| 等待 | `browser_wait` | 页面加载与渲染稳定检测 |
| 图片对话 | `session.prompt` / `session.attachment` | 按宿主能力启用图片选择、纯图片发送和持久历史预览 |
| 引用你划选的内容 | 侧栏输入框 | 你在页面里选中的文字会变成输入框里的引用，随下一条消息一起发送 |

## 架构

```
side panel (React) ◄─port─► background SW/事件页 ◄─WS─► dsh bridge plugin
                                 │
                  tabs.sendMessage (DSH_ACTION, DSH_SELECTION_WATCH)
                                 ▲ DSH_SELECTION
                                 ▼
                        content script (snapshot/actions/privacy/selection)
```

- **background**（`src/background/`）：桥连接（token 认证 + 指数退避重连 + 保活）、网关 RPC 客户端，以及**失败关闭地分发工具到用户受控标签页**。
- **content script**（`src/content/`）：纯文本快照（可读性主文 + 编号交互清单 + 表单字段）、**稳定编号**（`data-dsh-el`）、delta 变化、点击/输入/按键/滚动/导航动作、敏感字段掩码，以及带防抖的划选监听——只有侧栏打开且页面共享不是「关闭」时才会启用。
- **panel**（`src/panel/`）：React 对话界面（可续接会话/历史/实时事件/设置）；图片选择和预检由宿主声明的限制控制，持久图片通过会话授权读取；消息以已消毒的 Markdown 渲染，`ask_user_question` 请求会显示成可直接作答的卡片，手动切页时显示控制权交接条，运行中的回合提供标准停止按钮，页面划选的段落显示为可移除的引用卡片，并在下一条消息中包在不可信内容边界里发送。
- **协议**：`@yuxianglin/dsh-bridge-browser` workspace 包中的 `protocol.ts` 是两端共享的真源，具体通过该包的源码 export 共享。

## 构建

```sh
pnpm install
pnpm --filter dsh-browser-extension run build
pnpm --filter dsh-browser-extension run build:firefox
pnpm --filter dsh-browser-extension run test
```

请在仓库根目录执行这些命令。Chrome 产物输出到 `extensions/dsh-browser/dist/`；Firefox 产物输出到 `extensions/dsh-browser/dist-firefox/`。

## 安装与使用

推荐的零配置命令无需安装 Git，也无需提前 clone：

1. **构建并安装扩展**：

   ```sh
   curl -fsSL https://raw.githubusercontent.com/ChangeYourWay/dsh-browser/refs/heads/main/scripts/install.sh | bash
   ```

   Windows 请改在 PowerShell 中运行：

   ```powershell
   $s="$env:TEMP\dsh-install.ps1"; irm https://raw.githubusercontent.com/ChangeYourWay/dsh-browser/refs/heads/main/scripts/install.ps1 -OutFile $s; powershell -NoProfile -ExecutionPolicy Bypass -File $s
   ```

   脚本会把托管 workspace 下载到 `~/.dsh/dsh-browser`，构建桥插件，把它的官方 bundle 注册到本机 dsh 的 `web` profile，再构建扩展并把产物复制到稳定目录 `~/.dsh/browser-extension`，然后打开 `chrome://extensions`。开启开发者模式，选择「加载已解压的扩展程序」，加载扩展目录。再次运行该命令会更新托管安装。

   clone 得到的 checkout 也使用同一个安装器，而且不会下载或覆盖源码：

   ```sh
   git clone https://github.com/ChangeYourWay/dsh-browser.git
   cd dsh-browser
   ./scripts/install.sh
   ```

   Windows checkout 请运行 `.\scripts\install.ps1`。

2. **启动 dsh 并挂载桥插件**。可以使用 workspace 固定的运行时：

   ```sh
   cd ~/.dsh/dsh-browser && pnpm start
   ```

   如果使用 clone，请改为在仓库根目录运行 `pnpm start`。

   或者使用 npm 上最新的公开运行时：

   ```sh
   npx @deepseek-ai/dsh web
   ```

   两种命令都会从本机 `web` profile 加载同一个 bundle。默认端口为 3080；如被占用，可追加 `--port <port>`。

   **DSH Desktop 用户**：桌面版默认让系统随机分配本地 Web 端口（`dsh-desktop.port: 0`），自动探测无法预知随机端口。请在桌面版设置中把端口固定为 `43189`（见 [deepseek-harness-desktop 用户指南](https://github.com/anywhere-labs/deepseek-harness-desktop/blob/master/docs/user-guide.md)），扩展的自动探测会覆盖该端口；或直接在侧栏设置中手动填写 `http://127.0.0.1:<端口>`。

   加载或重新加载扩展本身是被动的：只有打开侧栏后，扩展才会探测本机端口并创建 WebSocket。用户已建立的健康连接可在侧栏关闭后继续用于后台审批；但连接一旦掉线或被另一浏览器替换，没有打开侧栏时就不会重连。

3. **开始使用**：打开任意标签页，点击 DeepSeek 鲸鱼图标打开侧边栏。两个构建都会自动探测本机 dsh。Chrome 回环连接无需地址或 Token；Firefox 的 `moz-extension://` UUID 不能证明扩展身份，必须在设置中填入 `~/.dsh/ext-bridge-token`。可以直接对话，或先点「读取页面」。普通 `http://`、`https://` 页面支持全部浏览器工具。

页面即使在扩展安装或重载之前已经打开，也会在第一次操作时自动补加载内容脚本，无需手动刷新。`chrome://`、Chrome Web Store 等浏览器内置或受保护页面禁止扩展访问 DOM，但扩展仍会报告标签页 URL，并可通过浏览器级 API 执行导航、新建并跟随 HTTP(S) 标签页、后退、前进和刷新；进入普通页面后，完整快照、点击、输入、滚动和文本提取会恢复可用。

如果只开发扩展，Chrome 从 `chrome://extensions` 加载 `extensions/dsh-browser/dist/`；Firefox 运行 `build:firefox` 后，从 `about:debugging#/runtime/this-firefox` 加载 `extensions/dsh-browser/dist-firefox/manifest.json`。代码更新后需重新构建并重新加载。

## 为什么浏览器操作仍采用纯文本

- **快照即视图**：模型对页面的全部认知 = 结构化文本（标题/URL/正文/编号元素/表单），默认预算 32k 字符（插件可配，经 `hello.ok` 协商给扩展）。
- **页面文字是不可信输入**：快照和局部文本读取会放进带随机 nonce 的信任边界，并明确要求模型不得把网页中的命令当成指令。这只是纵深防御；扩展侧的操作审批才是强制安全边界。
- **稳定编号**：元素编号跨快照保持（WeakMap + `data-dsh-el`），模型可以说"点 7 号"；页面大改时显式提示"编号已重排"。
- **delta 模式**：`browser_snapshot({delta:true})` 只返回变化元素的编号，省 token。
- **隐私**：密码/卡号字段的值永远以 `••••` 呈现，绝不回传；可访问名称从不使用敏感字段的当前值。
- **标签页绑定**：提交提示时会在模型开始工作前绑定活动标签页；如果直接调用浏览器工具，也会在需要时完成首次绑定。手动切换标签页或窗口后，后续工具会暂停，并询问助手继续原页面还是跟随当前页。选择原页面后允许后台操作，但不会改变用户正在看的页面；选择跟随后会重置页面引用状态。`browser_open_tab` 会新建并跟随一个 HTTP(S) 前台标签页；`browser_follow_tab` 可绑定 `browser_list_tabs` 返回的任意标签页而不激活它。受控页关闭后失败关闭，直到重新选择其他标签页。
- **分级审批**：默认「自动共享」允许模型按需读取受控标签页而不额外弹窗；「每次询问」可恢复逐次读取确认，「关闭」会阻断读取。状态变更工具和全部标签页元数据读取仍然失败关闭，并显示审批请求；用户可拒绝、仅允许一次，或只在当前侧栏会话中信任单个 origin，永久信任需在设置中显式管理。默认关闭的完全控制开关会绕过所有浏览器审批和页面共享限制，直到用户再次关闭。侧栏关闭时，审批最多保留 60 秒；启用通知后，系统通知可把用户带回侧栏。
- **会话续接**：重新打开侧栏时默认恢复最近活跃的浏览器会话；若该会话不可用，则恢复最新的非空持久会话，最后才创建新会话。可在设置中关闭。

## 权限说明

Chrome 使用 `sidePanel`，Firefox 使用 `sidebar_action`。两者都申请 `storage`（设置与最近会话续接）、`notifications`（侧栏关闭时可选的审批提醒）、`tabs` + `activeTab` + `scripting`（列举标签页，并向受控标签页注入/发消息）、`webNavigation`（把消息绑定到 frame 文档）、`alarms`（后台保活）和 `http/https`（内容脚本注入普通网页）。Firefox AMO manifest 如实声明扩展会把浏览活动、网页内容/操作和对话内容发送给用户配置的 dsh/模型服务。手动切页不会静默改变工具目标；`browser_open_tab` 可激活新标签页，`browser_close_tab` 在批准或启用完全控制后可能改变可见标签页，`browser_follow_tab` 则只改绑工具而不激活目标标签页。

## 已知限制

- 同时只有一个扩展连接桥。未打开侧栏的浏览器 Profile 不会抢占连接；另一个已打开的侧栏顶替连接后，被替换的一端会主动让权，不再反复重连互踢。
- 标签页绑定属于整个扩展连接，而不是单个对话会话。
- 可访问的跨源 iframe 会进入快照，并通过稳定的 `(frame, index)` 地址执行操作；受保护或已销毁的 frame 会标记为不可访问，不影响整页快照。
- 验证码/纯图片按钮无法处理——工具结果会标注"存在无文本可访问名的元素"，提示用户手动完成该步。
- 令牌无自动轮换。
- `browser_press` 的合成按键不触发浏览器原生默认行为（Tab 焦点移动、方向键、Enter 激活等），仅用于框架内的键盘事件；依赖原生行为的场景请手动操作。
- `browser_wait` 以加载完成 + 固定静默窗口为准，不观察持续 DOM 更新（连续刷新的 SPA 可能被报为稳定）。
