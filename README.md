# dsh Browser Control

**English** | [中文](README.zh.md)

<img width="1701" height="897" alt="dsh Browser Control" src="https://github.com/user-attachments/assets/3b1f3a25-f962-4e02-a9ef-d23e0d01fc8e" />

Connect [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) to the Chrome or Firefox tab you are already using. The model can read page content, click controls, fill forms, scroll, and navigate while preserving your login state, session, and cookies. A side panel or sidebar provides the conversation UI.

`dsh` is DeepSeek AI's open-source, plugin-based agent harness. This repository provides a companion browser bridge plugin and Chrome/Firefox MV3 extension as one standalone pnpm workspace.

Browser operation remains text-only: pages become structured text with a numbered inventory of interactive elements, and the model addresses those elements by number. dsh 0.1.2 multimodal chat is separate from that page channel—the side panel accepts PNG, JPEG, WebP, and GIF attachments when the host advertises image support, while browser tools still never capture screenshots.

> [!IMPORTANT]
> The workspace pins dsh 0.1.2-rc.1, the minimum supported runtime. Older DSH releases are not supported.

## Quick install

The standard `dsh plugin` command alone cannot install this project. The integration contains both a dsh bridge plugin and a browser extension. The one-line installer currently sets up the Chrome build.

macOS and Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/Lum1104/dsh-browser/refs/heads/main/scripts/install.sh | bash
```

Windows, in PowerShell:

```powershell
$s="$env:TEMP\dsh-install.ps1"; irm https://raw.githubusercontent.com/Lum1104/dsh-browser/refs/heads/main/scripts/install.ps1 -OutFile $s; powershell -NoProfile -ExecutionPolicy Bypass -File $s
```

When the installer opens `chrome://extensions`, follow its instructions to load or reload **dsh Browser Assistant**. If dsh is already running, restart it after installation. See [Detailed installation and usage](#detailed-installation-and-usage) for prerequisites, startup commands, updates, and developer installation.

> [!IMPORTANT]
> The unscoped [`dsh-browser`](https://www.npmjs.com/package/dsh-browser) package on npm belongs to a different project and is not affiliated with this repository. This project is not currently published as an npm package; use the installer above.

## Performance

In a paired 60-run end-to-end benchmark on August 18, 2026, both backends completed all 30 assigned runs successfully, while dsh Browser Control required fewer model/tool round trips and finished faster:

| Backend | Success | Mean end-to-end latency | Mean browser tool calls |
|---|---:|---:|---:|
| **dsh Browser Control** | **30/30** | **5.32 s** | **3.4** |
| Matched Playwright baseline | 30/30 | 6.67 s | 4.7 |

The paired Playwright / extension duration ratio was **1.24** (95% CI **1.16–1.34**): Playwright took about 24% longer, or equivalently, dsh Browser Control reduced latency by about 20% and saved 1.35 seconds per task on average. The suite used six browser tasks, five deterministic seeds, the same DSH profile and model (`deepseek-v4-flash`), and independently validated page state. See the [benchmark methodology and reproduction guide](benchmark/README.md).

## Core capabilities

| Capability | Tool | Notes |
|---|---|---|
| Read page | `browser_snapshot` | Structured text snapshot: title, URL, main text, numbered controls, and masked form fields; `delta: true` returns only changes |
| Click element | `browser_click` | Click links, buttons, checkboxes, and other controls by inventory number |
| Fill forms | `browser_type` | React/Vue-compatible input; `replace` clears the field first |
| Press keys | `browser_press` | Keyboard events such as Enter, Tab, Escape, and arrow keys |
| Scroll | `browser_scroll` | Viewport scrolling: up, down, top, and bottom |
| Navigate | `browser_navigate` / `browser_open_tab` / `browser_back` / `browser_forward` / `browser_reload` | Navigation inside the controlled tab, or open a URL in a new tab and follow it |
| Read region | `browser_get_text` | Lazy-loaded or partial page text |
| Wait for stability | `browser_wait` | Page-load and render-settle detection |
| Send images | `session.prompt` / `session.attachment` | Host-capability-gated image drafts, image-only prompts, and durable history previews |
| Quote a selection | side panel composer | Text you highlight in the page appears in the composer and is sent with your next message as fenced, attributed page content |

## Repository layout

```
packages/browser/bridge-browser/
  cordis.patch.yml
extensions/dsh-browser/
scripts/install.sh
scripts/install.ps1
```

## Why this design

- **Your real browser, not a headless copy**: the model works in the page you already have open, retaining logins, sessions, and cookies.
- **A text-first page interface**: numbered controls, stable IDs across snapshots, delta updates, and masked sensitive values make pages operable without screenshots; user-attached chat images use dsh's separate multimodal message path.
- **Pointing instead of describing**: highlight the passage you mean and the side panel quotes it, so "explain this" needs no page tour. The quote is captured only while a panel is open, and nothing is sent until you send the message.
- **A narrow privacy boundary**: passwords and payment-card values are always rendered as `••••` and never leave the page.
- **A guarded bridge**: authenticated handshakes protect remote connections, privileged gateway methods reject non-loopback callers, and the extension binds tools to one user-controlled tab.

## Detailed installation and usage

Requirements: Node.js `^22.19` or `>=24`, Corepack/pnpm, and Chrome 116+ or Firefox 140+. Windows additionally needs Windows PowerShell 5.1, which ships with Windows, or PowerShell 7+.

### Install or update

For a managed installation, run:

```sh
curl -fsSL https://raw.githubusercontent.com/Lum1104/dsh-browser/refs/heads/main/scripts/install.sh | bash
```

or, on Windows:

```powershell
$s="$env:TEMP\dsh-install.ps1"; irm https://raw.githubusercontent.com/Lum1104/dsh-browser/refs/heads/main/scripts/install.ps1 -OutFile $s; powershell -NoProfile -ExecutionPolicy Bypass -File $s
```

The installer downloads `main`, builds and registers the bridge plugin, builds the Chrome extension into `~/.dsh/browser-extension`, and opens `chrome://extensions`. On the first install, load that directory as an unpacked extension; on updates, click **Reload**. Restart dsh if it is already running.

`scripts/install.sh` covers macOS and Linux, and `scripts/install.ps1` covers Windows; both write the same managed workspace and the same install metadata. The installer copies the extension path to the clipboard when a clipboard tool is available (`pbcopy`, `wl-copy`, `xclip`, `xsel`, or PowerShell's `Set-Clipboard`), and prints the path either way. When no Chrome or Chromium install is found, it prints the command that installs one; set `DSH_INSTALL_BROWSER=1` to let the installer attempt that install itself.

The Windows command downloads `install.ps1` and runs it rather than piping it into `Invoke-Expression`: the script is UTF-8 with a byte order mark so Windows PowerShell renders its Chinese output, and `Invoke-Expression` rejects a leading mark.

To install the current branch from a source checkout instead:

```sh
git clone https://github.com/Lum1104/dsh-browser.git
cd dsh-browser
./scripts/install.sh
```

On Windows, run `.\scripts\install.ps1` from the checkout instead. After pulling or switching revisions, rerun the installer and reload the extension.

### Firefox source build

Firefox uses a separate MV3 manifest, event-page background, and sidebar. Build it from a checkout, then open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**, and select `extensions/dsh-browser/dist-firefox/manifest.json`:

```sh
pnpm install
pnpm --filter dsh-browser-extension run build:firefox
```

The bridge address is still auto-discovered. Firefox's `moz-extension://` UUID does not authenticate an add-on, so copy the bearer token from `~/.dsh/ext-bridge-token` into the extension settings (the dsh startup log reports that file's path). Signed distribution can package the same `dist-firefox/` output.

### Start and use

Start the managed installation with:

```sh
cd ~/.dsh/dsh-browser && pnpm start
```

From a source checkout, run `pnpm start` in the repository root. Once it is published, the exact supported public runtime is:

```sh
npx @deepseek-ai/dsh@0.1.2-rc.1 web
```

Local Chrome use requires no configuration; Firefox requires the local bridge token described above. Open an `http://` or `https://` page, click the DeepSeek whale icon, and wait for **Connected**. Existing tabs are instrumented on the first action; protected browser pages and extension stores are not supported.

## Troubleshooting

**Side panel stays "Not connected"**

- Make sure dsh web is running locally (default `http://127.0.0.1:3080`).
- Verify the bridge is loaded: open `http://127.0.0.1:3080/ext/bridge-config`. It should return JSON such as `{"wsUrl":"ws://127.0.0.1:3080/ext/bridge"}`. If it returns a web page instead of JSON, the running dsh predates the bridge registration — restart dsh and refresh the page; the extension reconnects on its own.
- The extension probes ports 3080, 3081, 3090, and 14389 automatically. If dsh runs on another port — or you use a remote `--host 0.0.0.0` deployment — set the address (and bridge token) in the panel settings. Firefox always requires the token.

## Development

The bridge plugin and Chrome/Firefox extension are both members of this repository's workspace. Run all commands from the repository root. For the first development installation, run `pnpm install`.

```sh
pnpm run build
pnpm run typecheck
pnpm run test
pnpm run check:runtime
pnpm run test:smoke

pnpm --filter @yuxianglin/dsh-bridge-browser run build
pnpm --filter @yuxianglin/dsh-bridge-browser run typecheck
pnpm --filter @yuxianglin/dsh-bridge-browser run test

pnpm --filter dsh-browser-extension run build
pnpm --filter dsh-browser-extension run build:firefox
pnpm --filter dsh-browser-extension run test
```

Notes:

- The bridge plugin must have a built `lib/` before startup because the loader consumes it; both `scripts/install.sh` and the root `pnpm run build` build the plugin before the extension.
- The dependencies of `@deepseek-ai/dsh` and the bridge plugin are pinned to the same tested public release line. An upgrade must update the manifests and lockfile together and rerun the root checks.

`check:runtime` checks the resolved DSH dependencies and lockfile; `test:smoke` starts the real web host in a temporary DSH home and verifies the bridge and session reads after a restart, without model credentials. CI runs these checks after a clean installation.

If you encounter `cache.hydratePrepared is not a function`, update the repository, rerun `pnpm install --frozen-lockfile` and `pnpm run build`, then restart `pnpm start`. Session data and the global package cache can be kept.

## Security

- The bridge path sits outside the `/api` trust boundary and performs its own bearer-token authentication.
- Local Chrome extension origins retain zero-configuration loopback access; Firefox origins are per-install UUIDs and must present the bearer token.
- Privileged gateway methods such as `settings.*`, `credentials.*`, and `host.open*` reject non-loopback sources.
- The browser-page pipeline is text-only and never captures screenshots; explicitly attached chat images use dsh's durable attachment service. Password and payment-card values never leave the page.
- When work begins, the assistant binds to the active tab (at prompt submission, or at the first direct browser-tool call). If you switch tabs manually, later browser actions pause and the side panel asks whether the assistant should continue on the original tab or follow the new one. Choosing the original tab permits background operation; the extension never silently retargets or changes your visible tab. Closing the controlled tab also pauses tools until you explicitly select the current page.
- Text you highlight is captured only while a side panel is open and page sharing is not `off`, and never from password or payment-card fields. It stays inside the extension until you send the message, is dropped when you dismiss it or its page navigates or closes, and reaches the model inside the same untrusted-content boundary as page snapshots — including its source title and URL, which the page also controls.
- Page-authored text is wrapped as untrusted input. The default `auto` mode reads only the controlled tab without an extra prompt; privacy-sensitive users can select `ask` for per-read confirmation or `off` to block reads entirely. In `ask` mode, the read dialog can allow one read or persistently switch back to `auto`; this can be reversed in Settings. Read page text is sent to the selected model.
- Click, type, keypress, navigation, history, and reload calls fail closed until the user approves them. An origin may be trusted for the current side-panel session (cleared when the last panel closes or the service worker restarts), while permanent trust is managed explicitly in Settings. Explicit cross-origin `browser_navigate` calls and unknown history destinations always prompt again.
