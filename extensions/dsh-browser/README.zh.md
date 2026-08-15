# dsh 浏览器操作扩展（Chrome MV3）

[English](README.md) | 中文

dsh 的**浏览器操作端**：让模型直接读取并操作你在浏览器里打开的页面——抓取内容、点击元素、填写表单、滚动与导航，全部在真实页面执行、登录态保留。侧边栏面板是与模型对话的入口。

**纯文本模式**：DeepSeek 模型不支持图片输入，页面以结构化文本呈现（带编号的交互元素清单），模型用编号精确操作任意元素；整条管线**刻意不产生任何图像**。

## 模型能做什么

| 能力 | 动作 | 说明 |
|---|---|---|
| 读取页面 | `browser_snapshot` | 标题/URL/正文/编号交互清单/表单字段（敏感值掩码）；`delta: true` 只返回变化，省 token |
| 点击元素 | `browser_click` | 按编号点击（链接/按钮/复选框…），React/Vue 组件兼容 |
| 填写表单 | `browser_type` | 输入文本，`replace` 清空重填 |
| 按键 | `browser_press` | Enter/Tab/Escape/方向键等 |
| 滚动 | `browser_scroll` | 视口滚动（up/down/top/bottom） |
| 导航 | `browser_navigate` / `browser_back` / `browser_forward` / `browser_reload` | 当前标签页内跳转，登录态保留；可在设置中选择新标签页/新窗口打开 |
| 读区域 | `browser_get_text` | 懒加载内容 / 局部文本 |
| 等待 | `browser_wait` | 页面加载与渲染稳定检测 |

## 架构

```
side panel (React) ◄─port─► background SW ◄─WS─► dsh bridge plugin
                                 │
                  tabs.sendMessage (DSH_ACTION)
                                 ▼
                        content script (snapshot/actions/privacy)
```

- **background**（`src/background/`）：桥连接（token 认证 + 指数退避重连 + 保活）、网关 RPC 客户端、**工具分发到活动标签页**。
- **content script**（`src/content/`）：纯文本快照（可读性主文 + 编号交互清单 + 表单字段）、**稳定编号**（`data-dsh-el`）、delta 变化、点击/输入/按键/滚动/导航动作、敏感字段掩码。
- **panel**（`src/panel/`）：React 对话界面（独立会话/历史/实时事件/设置），消息以 Markdown 渲染（标题/列表/代码块/表格等，已消毒）。
- **协议**：`@deepseek-ai/dsh-bridge-browser` workspace 包中的 `protocol.ts` 是两端共享的真源，具体通过该包的源码 export 共享。

## 构建

```sh
pnpm install
pnpm --filter dsh-browser-extension run build
pnpm --filter dsh-browser-extension run test
```

请在仓库根目录执行这些命令；构建产物输出到 `extensions/dsh-browser/dist/`。

## 安装与使用

推荐的零配置命令无需安装 Git，也无需提前 clone：

1. **构建并安装扩展**：

   ```sh
   curl -fsSL https://raw.githubusercontent.com/Lum1104/dsh-browser/refs/heads/main/scripts/install.sh | bash
   ```

   脚本会把托管 workspace 下载到 `~/.dsh/dsh-browser`，构建桥插件，把它的官方 bundle 注册到本机 dsh 的 `web` profile，再构建扩展并把产物复制到稳定目录 `~/.dsh/browser-extension`，然后打开 `chrome://extensions`。开启开发者模式，选择「加载已解压的扩展程序」，加载扩展目录。再次运行该命令会更新托管安装。

   clone 得到的 checkout 也使用同一个安装器，而且不会下载或覆盖源码：

   ```sh
   git clone https://github.com/Lum1104/dsh-browser.git
   cd dsh-browser
   ./scripts/install.sh
   ```

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

   可以在 dsh 启动前加载或重新加载扩展：本机探测会等桥接服务可用后再创建 WebSocket，打开侧边栏也会立即触发新一轮探测。

3. **开始使用**：打开普通的 `http://` 或 `https://` 页面，点击 DeepSeek 鲸鱼图标打开侧边栏。扩展会自动探测本机 dsh，回环连接无需填写地址或 Token；远程部署时才需要在设置中配置。可以直接对话，或先点「读取页面」。

页面即使在扩展安装或重载之前已经打开，也会在第一次操作时自动补加载内容脚本，无需手动刷新。`chrome://`、Chrome Web Store 等浏览器内置或受保护页面不支持读取和操作。

如果只开发扩展，请先 clone 仓库，在仓库根目录运行 `pnpm --filter dsh-browser-extension run build`，然后直接加载 `extensions/dsh-browser/dist/`。代码更新后需要重新构建，并在 `chrome://extensions` 中重新加载扩展。

## 纯文本优化（为什么这样做）

- **快照即视图**：模型对页面的全部认知 = 结构化文本（标题/URL/正文/编号元素/表单），预算 12k 字符（插件可配，经 `hello.ok` 协商给扩展）。
- **页面文字是不可信输入**：快照和局部文本读取会放进带随机 nonce 的信任边界，并明确要求模型不得把网页中的命令当成指令。这只是纵深防御；扩展侧的操作审批才是强制安全边界。
- **稳定编号**：元素编号跨快照保持（WeakMap + `data-dsh-el`），模型可以说"点 7 号"；页面大改时显式提示"编号已重排"。
- **delta 模式**：`browser_snapshot({delta:true})` 只返回变化元素的编号，省 token。
- **隐私**：密码/卡号字段的值永远以 `••••` 呈现，绝不回传；可访问名称从不使用敏感字段的当前值。
- **分级审批**：默认「自动共享」允许模型按需读取活动标签页而不额外弹窗；「每次询问」可恢复逐次读取确认，「关闭」会阻断读取。在「每次询问」模式下，读取弹窗可以仅允许一次，也可以持久切回自动读取，之后仍可在设置中关闭。状态变更工具仍然失败关闭，并显示实际 origin 和脱敏动作摘要；用户可拒绝、仅允许一次，或只在当前侧栏会话中信任单个 origin。最后一个侧栏关闭或 Service Worker 重启会清空临时信任；永久信任需在设置中显式管理。显式跨域 `browser_navigate` / 未知目标的历史跳转不继承信任，侧边栏关闭时一律拒绝。调用方取消或桥接超时时，会先撤销尚未完成的审批，过期动作不会继续执行。
- **打开页面的方式**：设置面板可选 `browser_navigate` 的打开目标——当前标签页（默认）、新标签页或新窗口。选择新标签页/新窗口时，你正在看的页面不会被覆盖，适合助手查链接、你继续读当前页的场景；新建的标签页会成为后续快照/点击工具操作的目标。

## 权限说明

`sidePanel`（侧边栏）、`storage`（设置）、`tabs` + `activeTab` + `scripting`（向活动标签页注入/发消息，并为安装前已打开的页面按需补注入）、`webNavigation`（枚举活动标签页中的 frame，并把消息绑定到具体文档）、`alarms`（SW 保活）、`http/https`（内容脚本注入普通网页）。只操作**活动标签页**，绝不静默切页。

## 已知限制

- 同时只有一个扩展连接桥（后连顶替先连）。
- 可访问的跨源 iframe 会进入快照，并通过稳定的 `(frame, index)` 地址执行操作；受保护或已销毁的 frame 会标记为不可访问，不影响整页快照。
- 验证码/纯图片按钮无法处理——工具结果会标注"存在无文本可访问名的元素"，提示用户手动完成该步。
- 令牌无自动轮换。
- `browser_press` 的合成按键不触发浏览器原生默认行为（Tab 焦点移动、方向键、Enter 激活等），仅用于框架内的键盘事件；依赖原生行为的场景请手动操作。
- `browser_wait` 以加载完成 + 固定静默窗口为准，不观察持续 DOM 更新（连续刷新的 SPA 可能被报为稳定）。
