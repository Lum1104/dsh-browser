# dsh 浏览器操作

[English](README.md) | **中文**

<img width="1701" height="897" alt="dsh 浏览器操作" src="https://github.com/user-attachments/assets/3b1f3a25-f962-4e02-a9ef-d23e0d01fc8e" />

将 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 连接到你正在使用的 Chrome 或 Firefox 标签页。模型可以读取结构化页面内容、操作控件、导航、新建和管理标签页，并保留浏览器现有的登录状态、会话与 Cookie。浏览器侧栏提供对话界面。

本仓库将 dsh 浏览器桥插件与 Chrome/Firefox Manifest V3 扩展放在同一个 pnpm workspace 中。浏览器工具采用纯文本接口：页面会转换为结构化文本和带稳定编号的交互元素。用户添加的图片通过 dsh 独立的多模态消息通道发送。

## 目录

- [版本兼容性](#版本兼容性)
- [安装](#安装)
- [启动与使用](#启动与使用)
- [浏览器能力](#浏览器能力)
- [授权与完全控制](#授权与完全控制)
- [受保护页面和浏览器内置页](#受保护页面和浏览器内置页)
- [开发](#开发)
- [故障排查](#故障排查)
- [安全与限制](#安全与限制)
- [性能](#性能)

## 版本兼容性

| 组件 | 版本或要求 |
|---|---|
| dsh-browser workspace | `0.1.3` |
| 浏览器桥插件 | `0.0.4` |
| Chrome/Firefox 扩展 | `0.1.3` |
| DeepSeek Harness npm 包 | 精确版本 `0.1.2-rc.1` |
| Node.js | `^22.19.0` 或 `>=24.0.0` |
| 包管理器 | pnpm `11.7.0` |
| 浏览器 | Chrome 116+ 或 Firefox 140+ |

`@deepseek-ai/dsh@0.1.2-rc.1` 与所有直接使用的 dsh 开发依赖都固定在同一版本。Workspace overrides 会把可用的 dsh 运行时 peer 对齐到 `0.1.2-rc.1`，提交的 lockfile 会保持完整依赖集合可复现。源码开发也可以通过 `pnpm run start:source` 启动同级且版本为 `0.1.2-rc.1` 的 `deepseek-harness` checkout。

### 0.1.3 功能范围

- 使用现版 DeepSeek Harness 的 `connection` 和 `typertGateway` 服务，不再依赖已经移除的 `apiProxy` 服务。
- 将扩展 RPC 协议转换为当前 Typert 描述符，包括 `session/list` 要求的 `_request` 参数。
- Windows 路径包含空格时，通过相对 `link:` 地址将本地桥注册到 Web profile，避免绝对路径被误解析。
- 在 dsh 的 General settings 页面显示可直接复制的浏览器 Bridge URL。
- 浏览器禁止注入 DOM 时仍返回标签页元数据，并保留浏览器级导航能力。
- 通过 `browser_open_tab` 在前台新建 HTTP(S) 标签页，并立即让后续工具跟随该标签页。
- 通过稳定标签页 ID 查看所有可访问的已打开标签页，并让模型跟随或关闭指定标签页。
- 提供可选的**允许模型完全控制浏览器**设置；关闭该设置前，浏览器操作不再逐次请求批准。

## 安装

本项目同时包含 dsh 插件和浏览器扩展，只安装插件并不完整。安装器会构建并注册浏览器桥、构建 Chrome 扩展、复制到 `~/.dsh/browser-extension`，然后打开扩展管理页。

macOS 或 Linux：

```sh
curl -fsSL https://raw.githubusercontent.com/ChangeYourWay/dsh-browser/refs/heads/main/scripts/install.sh | bash
```

Windows PowerShell：

```powershell
$s="$env:TEMP\dsh-install.ps1"; irm https://raw.githubusercontent.com/ChangeYourWay/dsh-browser/refs/heads/main/scripts/install.ps1 -OutFile $s; powershell -NoProfile -ExecutionPolicy Bypass -File $s
```

打开 `chrome://extensions`，启用开发者模式，然后从安装器打印的目录加载或重新加载 **dsh 浏览器助手**。稳定安装目录为：

```text
Windows: %USERPROFILE%\.dsh\browser-extension
macOS/Linux: ~/.dsh/browser-extension
```

npm 上未加 scope 的 `dsh-browser` 包属于另一个项目。请使用上方安装器或本仓库源码。

### 从源码 checkout 安装

```sh
git clone https://github.com/ChangeYourWay/dsh-browser.git
cd dsh-browser
pnpm install --frozen-lockfile
pnpm run build
./scripts/install.sh
```

Windows 请在 checkout 中执行最后一步：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

如果只进行扩展开发、不安装稳定副本，请在 Chrome 中加载 `extensions/dsh-browser/dist`。Firefox 构建命令为 `pnpm --filter dsh-browser-extension run build:firefox`，随后在 `about:debugging#/runtime/this-firefox` 中临时加载 `extensions/dsh-browser/dist-firefox/manifest.json`。

## 启动与使用

在启动 dsh 的同一个终端中设置 DeepSeek API Key：

```powershell
$env:DEEPSEEK_API_KEY="your-api-key"
pnpm start
```

```sh
export DEEPSEEK_API_KEY="your-api-key"
pnpm start
```

`pnpm start` 通过 `dsh web` 启动固定的 npm 版本。在 Chrome 或 Firefox 中点击鲸鱼图标，等待侧栏显示**已连接**。

如果要启动 DeepSeek Harness `0.1.2-rc.1` 源码，请让两个仓库位于同一个父目录：

```text
parent/
  deepseek-harness/
  dsh-browser/
```

然后运行：

```sh
cd dsh-browser
pnpm run build
pnpm run start:source
```

`start:source` 会转调 `pnpm --dir ../deepseek-harness dsh web`。修改浏览器桥或扩展源码后，请重新构建、再次运行安装器，然后重新加载已解压扩展。

扩展会自动探测本机 dsh 端口。如果自动发现不可用，请打开 dsh 的 **Settings > General**，复制 **Browser bridge address**，再粘贴到扩展的**桥地址**设置中。Chrome 回环连接不需要 token；Firefox 和远程连接需要 `~/.dsh/ext-bridge-token` 中的 bearer token。

## 浏览器能力

| 能力 | 工具 | 行为 |
|---|---|---|
| 读取页面 | `browser_snapshot` | 返回标题、URL、结构化正文、表单状态和编号交互元素；敏感值会被遮盖，`delta: true` 只返回变化。 |
| 点击 | `browser_click` | 点击编号对应的链接、按钮、复选框或其他交互元素。 |
| 输入 | `browser_type` | 在编号字段中输入，兼容 React/Vue 受控组件；`replace` 会先清空原内容。 |
| 按键 | `browser_press` | 发送 Enter、Tab、Escape、方向键等受支持按键。 |
| 滚动 | `browser_scroll` | 向上、向下、到顶部或到底部滚动。 |
| 导航 | `browser_navigate`、`browser_back`、`browser_forward`、`browser_reload` | 在受控标签页中导航并保留浏览器会话。 |
| 新建并跟随标签页 | `browser_open_tab` | 在前台打开完整 HTTP(S) URL，并让后续浏览器工具绑定该标签页。 |
| 查看全部标签页 | `browser_list_tabs` | 返回每个可访问标签页的稳定 `tabId`、窗口、位置、活动/受控状态、标题和 URL。 |
| 跟随已有标签页 | `browser_follow_tab` | 绑定 `browser_list_tabs` 返回的 `tabId`，但不会激活标签页或抢走焦点。 |
| 关闭标签页 | `browser_close_tab` | 关闭 `browser_list_tabs` 返回的 `tabId`。 |
| 读取区域 | `browser_get_text` | 读取懒加载内容或局部页面文字。 |
| 等待稳定 | `browser_wait` | 等待页面加载和渲染稳定。 |
| 引用选中内容 | 侧栏输入框 | 把用户划选的页面文字、标题和 URL 放入下一条消息，并标记为不可信内容。 |
| 发送图片 | dsh 会话附件 API | 所选模型声明图片能力时，可发送 PNG、JPEG、WebP 或 GIF。 |

管理标签页时，模型应先调用 `browser_list_tabs`，再使用返回的 ID，不应猜测浏览器标签页 ID。跟随标签页只改变受控目标，不会切换浏览器焦点；新建标签页则会按设计在前台打开。

## 授权与完全控制

默认模式分别控制页面读取和会改变状态的操作：

- 页面共享可以选择**自动共享**、**每次询问**或**关闭**。
- 点击、输入、按键、导航、新建标签页、跟随标签页、关闭标签页、历史跳转和刷新需要批准；适用时可以信任单个来源。
- 列出、跟随和关闭标签页不会继承网页来源信任，默认会请求独立批准。
- 对话会保持原有受控标签页；用户手动切换标签页不会静默改变模型操作目标。

扩展设置中提供默认关闭的**允许模型完全控制浏览器**开关。开启后，模型可以读取可访问的 HTTP(S) 页面、查看所有已打开标签页的标题和 URL，并执行所有浏览器及标签页管理操作，不再请求批准。该设置保存在扩展存储中，并持续作用于所有对话，直到用户关闭。仅在当前模型和任务可以安全控制整个浏览器配置文件时启用。

## 受保护页面和浏览器内置页

Chrome 和 Firefox 不允许扩展在 `chrome://newtab`、`chrome://extensions`、浏览器扩展商店和部分特权查看器中注入内容脚本。在这些页面上，模型仍然可以：

- 识别受控标签页并获得浏览器可提供的 URL 元数据；
- 导航到 HTTP(S) URL；
- 后退、前进或刷新；
- 新建并跟随 HTTP(S) 标签页；
- 列出、跟随或关闭标签页。

在受控标签页进入普通 HTTP(S) 页面前，DOM 快照、点击、输入、按键、滚动、等待页面元素和文本提取仍不可用。本扩展没有启用 `file://` 页面访问。

## 开发

所有命令都在仓库根目录执行：

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm run typecheck
pnpm run test

pnpm --filter @yuxianglin/dsh-bridge-browser run build
pnpm --filter @yuxianglin/dsh-bridge-browser run typecheck
pnpm --filter @yuxianglin/dsh-bridge-browser run test

pnpm --filter dsh-browser-extension run build
pnpm --filter dsh-browser-extension run build:firefox
pnpm --filter dsh-browser-extension run typecheck
pnpm --filter dsh-browser-extension run test
```

dsh profile Loader 使用普通 Node 加载 `lib/`，因此启动前必须构建浏览器桥。构建时还会把 Web 设置客户端复制到 `lib/client.js`。

仓库结构：

```text
packages/browser/bridge-browser/  dsh 浏览器桥、RPC 兼容适配器和 browser_* 工具
extensions/dsh-browser/           Chrome/Firefox 扩展和侧栏
scripts/install.ps1               Windows 安装器和 profile 注册
scripts/install.sh                macOS/Linux 安装器和 profile 注册
benchmark/                        配对确定性浏览器性能测试
```

## 故障排查

### 侧栏一直显示未连接

- 确认 `dsh web` 正在运行，默认地址通常为 `http://127.0.0.1:3080`。
- 打开 `http://127.0.0.1:3080/ext/bridge-config`，应返回包含 `ws://127.0.0.1:3080/ext/bridge` 等 WebSocket 地址的 JSON。
- 如果该地址返回 Web 页面而不是 JSON，请在安装浏览器桥后重启 dsh，并重新加载扩展。
- 扩展会探测 3080、3081、3090 和 14389 端口。其他端口或远程主机需要手动填写 Bridge URL 和 token。

### 浏览器桥插件一直等待 `apiProxy`

当前 profile 仍注册着旧版浏览器桥。重新运行安装器、重启 dsh，并确认 profile 指向浏览器桥插件 `0.0.4`。本版本使用 `connection` 和 `typertGateway`，不会请求 `apiProxy`。

### `session/list` 报告缺少 `_request`

当前进程仍加载着旧 RPC 适配器。重新构建浏览器桥、运行安装器、重启 dsh，并重新加载扩展。现版适配器会发送 DeepSeek Harness `0.1.2-rc.1` 描述符要求的 `_request` 字段。

### Windows 报告包含空格的路径不受 resolver 支持

请重新运行本版本的 `scripts/install.ps1`。脚本会把浏览器桥暂存到 Web profile，并安装相对地址 `link:./.dsh-browser-source`，因此 `D:\AI Agent Source\...` 等绝对路径不会被拆成错误的包规范。

## 安全与限制

- 浏览器桥路径位于 `/api` 信任栅栏之外，并使用独立 bearer token 握手。特权设置、凭据和宿主方法仍只允许回环调用。
- 页面文字、标签页标题和 URL 都是不可信模型输入。标签页清单和用户选中文字会放在明确的不可信内容标记中。
- 密码和支付卡字段始终遮盖。浏览器工具不会截取页面截图。
- 同时只有一个活动浏览器桥连接。工具调用绑定到对话的受控标签页；批准期间标签页发生变化时会失败关闭。
- 来源信任只适用于页面操作。默认模式下，显式跨域导航和目标未知的后退/前进会重新请求批准。
- 完全控制会移除浏览器批准弹窗，但不会绕过浏览器平台限制、启用 `file://` 访问，或让受保护页面的 DOM 变得可读。
- Firefox 每次安装生成的 `moz-extension://` 来源不能建立 Chrome 式本机身份，因此必须填写浏览器桥 token。

## 性能

在 2026 年 8 月 18 日完成的 60 次配对端到端评测中，两个后端分配到的 30 次运行均全部成功；dsh 浏览器操作使用了更少的模型/工具轮次，并以更短时间完成任务：

| 后端 | 成功率 | 平均端到端耗时 | 平均浏览器工具调用 |
|---|---:|---:|---:|
| **dsh 浏览器操作** | **30/30** | **5.32 秒** | **3.4** |
| 对齐工具接口的 Playwright 基线 | 30/30 | 6.67 秒 | 4.7 |

Playwright/扩展的配对耗时比为 **1.24**（95% CI **1.16–1.34**）。评测使用 6 个浏览器任务、5 个确定性 seed、相同的 dsh profile 和 `deepseek-v4-flash` 模型，并通过独立页面状态验证结果。详见[评测方法与复现说明](benchmark/README.md)。
