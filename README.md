# dsh Browser Control

**English** | [中文](README.zh.md)

<img width="1701" height="897" alt="dsh Browser Control" src="https://github.com/user-attachments/assets/3b1f3a25-f962-4e02-a9ef-d23e0d01fc8e" />

Connect [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) to the Chrome or Firefox tabs you already use. The model can read structured page content, operate controls, navigate, open and manage tabs, and keep the browser's existing login state, sessions, and cookies. A browser side panel provides the conversation UI.

This repository contains the dsh bridge plugin and the Chrome/Firefox Manifest V3 extension in one pnpm workspace. Browser tools are text-only: pages become structured text with stable numbered elements. Images attached by the user use the separate multimodal message path supported by dsh.

## Contents

- [Version compatibility](#version-compatibility)
- [Install](#install)
- [Start and use](#start-and-use)
- [Browser capabilities](#browser-capabilities)
- [Permissions and unrestricted control](#permissions-and-unrestricted-control)
- [Protected and internal pages](#protected-and-internal-pages)
- [Development](#development)
- [Troubleshooting](#troubleshooting)
- [Security and limitations](#security-and-limitations)
- [Performance](#performance)

## Version compatibility

| Component | Version or requirement |
|---|---|
| dsh-browser workspace | `0.1.3` |
| Browser bridge plugin | `0.0.4` |
| Chrome/Firefox extension | `0.1.3` |
| DeepSeek Harness npm package | exactly `0.1.2-rc.1` |
| Node.js | `^22.19.0` or `>=24.0.0` |
| Package manager | pnpm `11.7.0` |
| Browser | Chrome 116+ or Firefox 140+ |

`@deepseek-ai/dsh@0.1.2-rc.1` and every direct dsh development dependency are pinned to the same release. Workspace overrides align the available dsh runtime peers with `0.1.2-rc.1`, and the committed lockfile keeps the complete package set reproducible. Source development can instead launch a sibling `deepseek-harness` checkout at `0.1.2-rc.1` with `pnpm run start:source`.

### 0.1.3 feature set

- Uses the current DeepSeek Harness `connection` and `typertGateway` services instead of the removed `apiProxy` service.
- Translates the extension RPC protocol to current Typert descriptors, including the `_request` argument required by `session/list`.
- Registers the local bridge from Windows paths containing spaces without passing an ambiguous absolute `link:` spec through dsh.
- Shows a pasteable browser Bridge URL in the dsh General settings page.
- Reports metadata for browser-protected tabs and keeps browser-level navigation available when DOM injection is forbidden.
- Opens an HTTP(S) URL in a new foreground tab and immediately follows that tab with `browser_open_tab`.
- Lists every accessible open tab and lets the model follow or close a selected tab with stable tab IDs.
- Provides an opt-in **Allow unrestricted browser control** setting that removes browser-operation approval prompts until the setting is disabled.

## Install

This project includes both a dsh plugin and a browser extension, so installing only the plugin is insufficient. The installers build and register the bridge, build the Chrome extension, copy it to `~/.dsh/browser-extension`, and open the extension management page.

macOS or Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/ChangeYourWay/dsh-browser/refs/heads/main/scripts/install.sh | bash
```

Windows PowerShell:

```powershell
$s="$env:TEMP\dsh-install.ps1"; irm https://raw.githubusercontent.com/ChangeYourWay/dsh-browser/refs/heads/main/scripts/install.ps1 -OutFile $s; powershell -NoProfile -ExecutionPolicy Bypass -File $s
```

At `chrome://extensions`, enable Developer mode and load or reload **dsh Browser Assistant** from the path printed by the installer. The stable installation directory is:

```text
Windows: %USERPROFILE%\.dsh\browser-extension
macOS/Linux: ~/.dsh/browser-extension
```

The unscoped npm package named `dsh-browser` is unrelated to this repository. Use the installers above or this repository's source checkout.

### Install from a checkout

```sh
git clone https://github.com/ChangeYourWay/dsh-browser.git
cd dsh-browser
pnpm install --frozen-lockfile
pnpm run build
./scripts/install.sh
```

On Windows, run this final command from the checkout:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

For extension development without installing a stable copy, load `extensions/dsh-browser/dist` in Chrome. Build Firefox with `pnpm --filter dsh-browser-extension run build:firefox`, then temporarily load `extensions/dsh-browser/dist-firefox/manifest.json` from `about:debugging#/runtime/this-firefox`.

## Start and use

Set the DeepSeek API key in the same shell that starts dsh:

```powershell
$env:DEEPSEEK_API_KEY="your-api-key"
pnpm start
```

```sh
export DEEPSEEK_API_KEY="your-api-key"
pnpm start
```

`pnpm start` launches the pinned npm release through `dsh web`. Open the whale icon in Chrome or Firefox and wait until the side panel shows **Connected**.

To launch a DeepSeek Harness `0.1.2-rc.1` source checkout instead, keep both repositories under the same parent directory:

```text
parent/
  deepseek-harness/
  dsh-browser/
```

Then run:

```sh
cd dsh-browser
pnpm run build
pnpm run start:source
```

`start:source` delegates to `pnpm --dir ../deepseek-harness dsh web`. Rebuild and rerun the installer after changing the bridge or extension source, then reload the unpacked extension.

The extension discovers local dsh ports automatically. If discovery is unavailable, open dsh **Settings > General**, copy **Browser bridge address**, and paste it into the extension's **Bridge address** setting. Chrome loopback connections need no token. Firefox and remote connections require the bearer token stored at `~/.dsh/ext-bridge-token`.

## Browser capabilities

| Capability | Tool | Behavior |
|---|---|---|
| Read a page | `browser_snapshot` | Returns title, URL, structured text, form state, and numbered interactive elements; sensitive values are masked and `delta: true` returns only changes. |
| Click | `browser_click` | Clicks a numbered link, button, checkbox, or other interactive element. |
| Type | `browser_type` | Types into a numbered field and supports controlled React/Vue inputs; `replace` clears existing text first. |
| Press a key | `browser_press` | Sends Enter, Tab, Escape, arrow keys, and other supported keys. |
| Scroll | `browser_scroll` | Scrolls up, down, to the top, or to the bottom. |
| Navigate | `browser_navigate`, `browser_back`, `browser_forward`, `browser_reload` | Navigates the controlled tab while retaining its browser session. |
| Open and follow a new tab | `browser_open_tab` | Opens a complete HTTP(S) URL in a foreground tab and binds subsequent browser tools to it. |
| Inspect all tabs | `browser_list_tabs` | Returns each accessible tab's stable `tabId`, window, index, active/controlled state, title, and URL. |
| Follow an existing tab | `browser_follow_tab` | Binds the conversation to a `tabId` returned by `browser_list_tabs` without activating the tab. |
| Close a tab | `browser_close_tab` | Closes a `tabId` returned by `browser_list_tabs`. |
| Read a region | `browser_get_text` | Reads lazy-loaded or local page text. |
| Wait for stability | `browser_wait` | Waits for loading and rendering to settle. |
| Quote a selection | Side-panel composer | Adds user-selected page text, its title, and URL to the next message inside an untrusted-content boundary. |
| Send images | dsh session attachment APIs | Sends PNG, JPEG, WebP, or GIF when the selected model declares image support. |

For tab workflows, the model should call `browser_list_tabs` first and use the returned ID; it must not guess a browser tab ID. Following a tab changes only the controlled target and does not steal focus. Opening a tab intentionally creates it in the foreground.

## Permissions and unrestricted control

The default mode keeps page reads and state-changing actions under separate controls:

- Page sharing can be **Automatic**, **Ask every time**, or **Off**.
- Clicks, typing, key presses, navigation, tab opening, tab following, tab closing, history navigation, and reloads require approval unless the origin is trusted where applicable.
- Listing, following, and closing tabs do not inherit a trusted page origin. They request their own approval.
- The controlled tab stays bound to the conversation. Manually switching tabs does not silently redirect model actions.

The extension settings include **Allow unrestricted browser control**, disabled by default. When enabled, the model can read accessible HTTP(S) pages, inspect all open-tab titles and URLs, and perform all browser and tab-management actions without further approval. The setting persists in extension storage and applies to every conversation until disabled. Enable it only when the current model and task may safely control the whole browser profile.

## Protected and internal pages

Chrome and Firefox do not allow extensions to inject content scripts into pages such as `chrome://newtab`, `chrome://extensions`, browser stores, and some privileged viewers. On these pages the model can still:

- identify the controlled tab and receive its available URL metadata;
- navigate to an HTTP(S) URL;
- go back, go forward, or reload;
- open and follow a new HTTP(S) tab;
- list, follow, or close tabs.

DOM snapshots, clicks, typing, key presses, scrolling, waiting on page elements, and text extraction remain unavailable until the controlled tab reaches a normal HTTP(S) page. `file://` page access is not enabled by this extension.

## Development

Run commands from the repository root:

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

The bridge must be built before dsh loads the profile because the loader runs `lib/` with plain Node. The bridge package also copies its Web settings client into `lib/client.js` during the build.

Repository layout:

```text
packages/browser/bridge-browser/  dsh bridge, RPC compatibility adapter, and browser_* tools
extensions/dsh-browser/           Chrome/Firefox extension and side panel
scripts/install.ps1               Windows installer and profile registration
scripts/install.sh                macOS/Linux installer and profile registration
benchmark/                        paired deterministic browser benchmark
```

## Troubleshooting

### The side panel stays Disconnected

- Confirm that `dsh web` is running, normally at `http://127.0.0.1:3080`.
- Open `http://127.0.0.1:3080/ext/bridge-config`. It should return JSON containing a WebSocket URL such as `ws://127.0.0.1:3080/ext/bridge`.
- If that URL returns the Web app rather than JSON, restart dsh after installing the bridge and reload the extension.
- The extension probes ports 3080, 3081, 3090, and 14389. Enter the Bridge URL and token manually for another port or remote host.

### The bridge plugin remains pending for `apiProxy`

An older bridge build is registered. Rerun the installer, restart dsh, and verify that the profile points to bridge plugin `0.0.4`. This release consumes `connection` and `typertGateway`; it does not request `apiProxy`.

### `session/list` reports missing `_request`

An older RPC adapter is still loaded. Rebuild the bridge, rerun the installer, restart dsh, and reload the extension. The current adapter sends the descriptor field `_request` expected by DeepSeek Harness `0.1.2-rc.1`.

### Windows reports an unsupported resolver for a path containing spaces

Rerun `scripts/install.ps1` from this release. It stages the bridge under the Web profile and installs the relative spec `link:./.dsh-browser-source`, so an absolute path such as `D:\AI Agent Source\...` is not split into a package spec.

## Security and limitations

- The bridge route is outside the `/api` trust fence and uses its own bearer-token handshake. Privileged settings, credential, and host methods remain loopback-only.
- Page text, tab titles, and URLs are model-untrusted input. Tab inventory output and selected text are wrapped in explicit untrusted-content markers.
- Password and payment-card values are always masked. Browser tools do not capture screenshots.
- Only one bridge connection is active. Tool calls are bound to a conversation-controlled tab and fail closed when the tab changes during an approval.
- Origin trust is scoped to page actions. Explicit cross-origin navigation and unknown back/forward targets request approval again in the default mode.
- Unrestricted control removes browser approval prompts but does not bypass browser platform restrictions, enable `file://` access, or make protected-page DOM readable.
- Firefox's generated `moz-extension://` origin cannot establish Chrome-style local identity, so Firefox requires the bridge token.

## Performance

In 60 paired end-to-end evaluations completed on 2026-08-18, both backends completed all 30 assigned runs. dsh Browser Control used fewer model/tool turns and finished faster:

| Backend | Success | Mean elapsed time | Mean browser tool calls |
|---|---:|---:|---:|
| **dsh Browser Control** | **30/30** | **5.32 s** | **3.4** |
| Playwright baseline with aligned tools | 30/30 | 6.67 s | 4.7 |

The paired Playwright/extension duration ratio was **1.24** (95% CI **1.16–1.34**). The benchmark used six browser tasks, five deterministic seeds, the same dsh profile and `deepseek-v4-flash` model, and independent final-page validation. See [benchmark methodology and reproduction](benchmark/README.md).
