# dsh Browser Control Extension (Chrome and Firefox MV3)

English | [中文](README.zh.md)

The **browser-operation end** of dsh: the model reads and operates the browser page you have open — extract content, click elements, fill forms, scroll, and navigate, all in the real page with your login state preserved. The side panel is the conversation entry.

**Two explicit channels**: browser pages are still rendered as structured text (a numbered interactive-element inventory), so browser tools never take screenshots. Separately, a current dsh host can advertise multimodal image limits; the side panel then accepts PNG, JPEG, WebP, and GIF attachments and renders their durable history references.

## What the model can do

| Capability | Action | Notes |
|---|---|---|
| Read page | `browser_snapshot` | Title/URL/main text/numbered inventory/form fields (sensitive values masked); `delta: true` returns only changes |
| Click element | `browser_click` | Click by inventory number (links/buttons/checkboxes…), React/Vue compatible |
| Fill forms | `browser_type` | Type text; `replace` clears first |
| Keys | `browser_press` | Enter/Tab/Escape/arrows etc. |
| Scroll | `browser_scroll` | Viewport scrolling (up/down/top/bottom) |
| Navigate | `browser_navigate` / `browser_back` / `browser_forward` / `browser_reload` | Navigation inside the controlled tab, login state preserved |
| Open and follow a tab | `browser_open_tab` | Open an HTTP(S) URL in a new foreground tab and bind later browser tools to it |
| Manage open tabs | `browser_list_tabs` / `browser_follow_tab` / `browser_close_tab` | Inspect titles and URLs, bind an existing tab without activating it, or close a selected tab |
| Read region | `browser_get_text` | Lazy-loaded content / partial text |
| Wait | `browser_wait` | Page load and render-settle detection |
| Chat with images | `session.prompt` / `session.attachment` | Host-gated image selection, image-only sends, and durable history previews |
| Quote what you highlight | side panel composer | The text you select in the page becomes a quote in the composer and rides along with your next message |

## Architecture

```
side panel (React) ◄─port─► background SW/event page ◄─WS─► dsh bridge plugin
                                 │
                  tabs.sendMessage (DSH_ACTION, DSH_SELECTION_WATCH)
                                 ▲ DSH_SELECTION
                                 ▼
                        content script (snapshot/actions/privacy/selection)
```

- **background** (`src/background/`): bridge connection (token auth + exponential-backoff reconnect + keepalive), gateway RPC client, and **fail-closed tool dispatch to a user-controlled tab**.
- **content script** (`src/content/`): text-only snapshot (readability main text + numbered interactive inventory + form fields), **stable element numbers** (`data-dsh-el`), delta changes, click/type/press/scroll/navigate actions, sensitive-field masking, and a debounced selection watcher that stays disarmed until a side panel is open and page sharing is not `off`.
- **panel** (`src/panel/`): React conversation UI (resumable session/history/live events/settings); host-advertised image limits gate image selection and preflight checks, durable attachments render through session-authorized reads, messages render as sanitized Markdown, `ask_user_question` requests render as answerable cards, manual tab switches render a control-handoff strip, an active turn exposes a standard stop control, and a highlighted page passage renders as a removable quote that the next prompt carries inside the untrusted-content boundary.
- **Protocol**: `protocol.ts` in the `@yuxianglin/dsh-bridge-browser` workspace package is the single source of truth, shared by both ends through the package's source export.

## Build

```sh
pnpm install
pnpm --filter dsh-browser-extension run build
pnpm --filter dsh-browser-extension run build:firefox
pnpm --filter dsh-browser-extension run test
```

Run these commands from the repository root. Chrome outputs to `extensions/dsh-browser/dist/`; Firefox outputs to `extensions/dsh-browser/dist-firefox/`.

## Install and use

The recommended zero-configuration command does not require Git or a local clone:

1. **Build and install the extension**:

   ```sh
   curl -fsSL https://raw.githubusercontent.com/ChangeYourWay/dsh-browser/refs/heads/main/scripts/install.sh | bash
   ```

   On Windows, run this in PowerShell instead:

   ```powershell
   $s="$env:TEMP\dsh-install.ps1"; irm https://raw.githubusercontent.com/ChangeYourWay/dsh-browser/refs/heads/main/scripts/install.ps1 -OutFile $s; powershell -NoProfile -ExecutionPolicy Bypass -File $s
   ```

   The script downloads a managed workspace to `~/.dsh/dsh-browser`, builds the bridge plugin, registers its official bundle in the local dsh `web` profile, builds the extension, copies the output to the stable directory `~/.dsh/browser-extension`, and opens `chrome://extensions`. Enable Developer mode, choose Load unpacked, and select the extension directory. Running the command again updates the managed installation.

   A cloned checkout uses the same installer without downloading or overwriting source files:

   ```sh
   git clone https://github.com/ChangeYourWay/dsh-browser.git
   cd dsh-browser
   ./scripts/install.sh
   ```

   Windows checkouts run `.\scripts\install.ps1` instead.

2. **Start dsh with the bridge plugin mounted**. Use either the workspace-pinned runtime:

   ```sh
   cd ~/.dsh/dsh-browser && pnpm start
   ```

   From a clone, run `pnpm start` in the repository root instead.

   Or the latest public runtime:

   ```sh
   npx @deepseek-ai/dsh web
   ```

   Both commands load the same bundle from the local `web` profile. Port 3080 is used by default; append `--port <port>` when it is occupied.

   **DSH Desktop users**: the Desktop app assigns a random local Web port by default (`dsh-desktop.port: 0`), so port-based auto-discovery cannot predict it. Pin the port to `43189` in Desktop settings (see the [deepseek-harness-desktop user guide](https://github.com/anywhere-labs/deepseek-harness-desktop/blob/master/docs/user-guide.en.md)); auto-discovery covers that port. Alternatively, enter `http://127.0.0.1:<port>` manually in the side-panel settings.

   Loading or reloading the extension is passive: it does not probe local ports or open a WebSocket until the side panel is opened. A healthy connection established by the user may remain available for background approvals after the panel closes, but it will not reconnect without an open panel if it drops or another browser replaces it.

3. **Use it**: open any tab and click the DeepSeek whale icon. Both builds auto-discover local dsh. Chrome loopback connections need no address or token; Firefox must be given the token from `~/.dsh/ext-bridge-token` because a `moz-extension://` UUID is not an add-on identity. Chat directly or click "Read page" first. Normal `http://` and `https://` pages support every browser tool.

Pages that were already open before extension installation or reload are instrumented automatically on the first action, so they do not require a manual refresh. Browser-internal and protected pages such as `chrome://` and the Chrome Web Store prohibit DOM access, but the extension reports their tab URL and can navigate, open and follow a new HTTP(S) tab, go back, go forward, or reload through browser-level APIs. Reaching a normal page restores full snapshots, clicks, typing, scrolling, and text extraction.

For extension-only development, load `extensions/dsh-browser/dist/` from `chrome://extensions`, or run `build:firefox` and load `extensions/dsh-browser/dist-firefox/manifest.json` from `about:debugging#/runtime/this-firefox`. Rebuild and reload after code changes.

## Why browser operation stays text-only

- **Snapshot as the view**: the model's entire view of the page is structured text (title/URL/main/numbered elements/forms), budgeted at 32k chars by default (plugin-configurable, negotiated to the extension via `hello.ok`).
- **Page text is untrusted input**: snapshots and targeted text reads are enclosed in a fresh nonce-bound trust marker and explicitly tell the model never to treat page-authored commands as instructions. This is defense in depth; extension-side action approval is the enforcement boundary.
- **Stable numbering**: element numbers persist across snapshots (WeakMap + `data-dsh-el`), so the model can say "click 7"; a large page change explicitly reports "numbers reindexed".
- **Delta mode**: `browser_snapshot({delta:true})` returns only changed element numbers, saving tokens.
- **Privacy**: password/credit-card values always render as `••••` and never leave the page; accessible names never use a sensitive field's current value.
- **Tab affinity**: prompt submission binds the active tab before the model starts working; a direct browser-tool call also performs the initial bind when needed. A manual tab/window switch pauses later tools and asks whether the assistant should stay on the original tab or follow the newly visible one. Staying permits explicit background operation without changing the user's visible tab; following resets page-reference state. `browser_open_tab` creates and follows a foreground HTTP(S) tab; `browser_follow_tab` binds any tab returned by `browser_list_tabs` without activating it. A closed controlled tab fails closed until another tab is selected.
- **Proportional approval**: the default `auto` mode lets the model read the controlled tab without an extra prompt; `ask` restores per-read confirmation and `off` blocks reads. State-changing tools and all-tab metadata reads fail closed and show an approval request. The user may deny, allow once, or trust one origin for the current side-panel session; permanent trust is managed explicitly in Settings. The off-by-default unrestricted-control switch bypasses all browser approvals and page-sharing restrictions until disabled. If the panel is closed, an approval remains pending for up to 60 seconds and, when enabled, a system notification opens the panel for review.
- **Conversation continuity**: reopening the panel resumes the most recently active browser conversation by default, falling back to the latest non-empty durable session before creating a new one. This can be disabled in Settings.

## Permissions

Chrome uses `sidePanel`; Firefox uses `sidebar_action`. Both request `storage` (settings and recent-session continuity), `notifications` (optional reminders for approvals received while the panel is closed), `tabs` + `activeTab` + `scripting` (list tabs and inject/message the controlled tab), `webNavigation` (bind messages to frame documents), `alarms` (background keepalive), and `http/https` (content-script injection on normal pages). Firefox's AMO manifest declares the browsing activity, website content/activity, and personal communications sent to the configured dsh/model service. Manual switches never silently retarget tools. `browser_open_tab` may activate a new tab and `browser_close_tab` may change the visible tab when approved or when unrestricted control is enabled; `browser_follow_tab` rebinds tools without activating its target.

## Known limitations

- Only one extension connection at a time. An unopened browser profile never claims it; if another open panel replaces a live connection, the replaced client yields instead of starting a reconnect fight.
- Tab affinity is global to that extension connection rather than per chat session.
- Accessible cross-origin iframes are snapshotted and operated with stable `(frame, index)` addresses. Restricted or short-lived frames are reported as unavailable without failing the whole page snapshot.
- Captcha/image-only controls cannot be handled — the tool result reports "elements with no accessible name" and asks the user to complete that step manually.
- No automatic token rotation.
- Synthetic `browser_press` events do not trigger browser-native default actions such as Tab focus movement, arrow-key scrolling, or Enter activation; use manual input when a workflow depends on those defaults.
- `browser_wait` considers page load plus a fixed quiet window, but does not observe continuously changing DOM state; a live-updating SPA may be reported as stable.
