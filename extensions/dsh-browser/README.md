# dsh Browser Control Extension (Chrome MV3)

English | [中文](README.zh.md)

The **browser-operation end** of dsh: the model reads and operates the browser page you have open — extract content, click elements, fill forms, scroll, and navigate, all in the real page with your login state preserved. The side panel is the conversation entry.

**Text-only mode**: DeepSeek models cannot see images, so the page is rendered as structured text (a numbered interactive-element inventory) and the model addresses elements by number; the pipeline deliberately never produces images.

## What the model can do

| Capability | Action | Notes |
|---|---|---|
| Read page | `browser_snapshot` | Title/URL/main text/numbered inventory/form fields (sensitive values masked); `delta: true` returns only changes |
| Click element | `browser_click` | Click by inventory number (links/buttons/checkboxes…), React/Vue compatible |
| Fill forms | `browser_type` | Type text; `replace` clears first |
| Keys | `browser_press` | Enter/Tab/Escape/arrows etc. |
| Scroll | `browser_scroll` | Viewport scrolling (up/down/top/bottom) |
| Navigate | `browser_navigate` / `browser_back` / `browser_forward` / `browser_reload` | In-tab navigation, login state preserved |
| Read region | `browser_get_text` | Lazy-loaded content / partial text |
| Wait | `browser_wait` | Page load and render-settle detection |

## Architecture

```
side panel (React) ◄─port─► background SW ◄─WS─► dsh bridge plugin
                                 │
                  tabs.sendMessage (DSH_ACTION)
                                 ▼
                        content script (snapshot/actions/privacy)
```

- **background** (`src/background/`): bridge connection (token auth + exponential-backoff reconnect + keepalive), gateway RPC client, **tool dispatch to the active tab**.
- **content script** (`src/content/`): text-only snapshot (readability main text + numbered interactive inventory + form fields), **stable element numbers** (`data-dsh-el`), delta changes, click/type/press/scroll/navigate actions, sensitive-field masking.
- **panel** (`src/panel/`): React conversation UI (isolated session/history/live events/settings); messages render as Markdown (headings/lists/code blocks/tables, sanitized).
- **Protocol**: `protocol.ts` in the `@deepseek-ai/dsh-bridge-browser` workspace package is the single source of truth, shared by both ends through the package's source export.

## Build

```sh
pnpm install
pnpm --filter dsh-browser-extension run build
pnpm --filter dsh-browser-extension run test
```

Run these commands from the repository root; the build outputs `extensions/dsh-browser/dist/`.

## Install and use

The recommended zero-configuration command does not require Git or a local clone:

1. **Build and install the extension**:

   ```sh
   curl -fsSL https://raw.githubusercontent.com/Lum1104/dsh-browser/refs/heads/main/scripts/install.sh | bash
   ```

   The script downloads a managed workspace to `~/.dsh/dsh-browser`, builds the bridge plugin, registers its official bundle in the local dsh `web` profile, builds the extension, copies the output to the stable directory `~/.dsh/browser-extension`, and opens `chrome://extensions`. Enable Developer mode, choose Load unpacked, and select the extension directory. Running the command again updates the managed installation.

   A cloned checkout uses the same installer without downloading or overwriting source files:

   ```sh
   git clone https://github.com/Lum1104/dsh-browser.git
   cd dsh-browser
   ./scripts/install.sh
   ```

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

   Loading or reloading the extension before dsh starts is safe: local discovery waits for the bridge before opening a WebSocket, and opening the side panel triggers another discovery attempt.

3. **Use it**: open a normal `http://` or `https://` page and click the DeepSeek whale icon. The extension auto-discovers local dsh and loopback connections require no address or token; settings are only needed for remote deployment. Chat directly or click "Read page" first.

Pages that were already open before extension installation or reload are instrumented automatically on the first action, so they do not require a manual refresh. Browser-internal and protected pages such as `chrome://` and the Chrome Web Store cannot be read or operated.

For extension-only development, clone the repository, run `pnpm --filter dsh-browser-extension run build` from its root, and load `extensions/dsh-browser/dist/` directly. Rebuild and reload the extension from `chrome://extensions` after code changes.

## Why text-only

- **Snapshot as the view**: the model's entire view of the page is structured text (title/URL/main/numbered elements/forms), budgeted at 12k chars (plugin-configurable, negotiated to the extension via `hello.ok`).
- **Page text is untrusted input**: snapshots and targeted text reads are enclosed in a fresh nonce-bound trust marker and explicitly tell the model never to treat page-authored commands as instructions. This is defense in depth; extension-side action approval is the enforcement boundary.
- **Stable numbering**: element numbers persist across snapshots (WeakMap + `data-dsh-el`), so the model can say "click 7"; a large page change explicitly reports "numbers reindexed".
- **Delta mode**: `browser_snapshot({delta:true})` returns only changed element numbers, saving tokens.
- **Privacy**: password/credit-card values always render as `••••` and never leave the page; accessible names never use a sensitive field's current value.
- **Proportional approval**: the default `auto` mode lets the model read the active tab without an extra prompt; `ask` restores per-read confirmation and `off` blocks reads. In `ask` mode, the read dialog can allow one read or persistently switch back to `auto`, which remains reversible in Settings. State-changing tools still fail closed and show their exact origin plus a redacted action summary. The user may deny, allow once, or trust one origin for the current side-panel session; temporary trust clears when the last panel closes or the service worker restarts. Permanent trust is managed explicitly in Settings. Explicit cross-origin `browser_navigate` calls and unknown history destinations cannot inherit trust, and a closed panel means denial. Caller cancellation or bridge timeout withdraws any open approval before an action can run.
- **Navigation target**: the Settings panel lets you choose where `browser_navigate` opens links — the current tab (default), a new tab, or a new window. Opening in a new tab/window leaves your active page untouched, which is handy when the assistant explores links while you keep reading the current page. The newly created tab becomes the focused target for subsequent snapshot/click tools.

## Permissions

`sidePanel` (sidebar), `storage` (settings), `tabs` + `activeTab` + `scripting` (inject/message the active tab, including lazy recovery for pages opened before install), `webNavigation` (enumerate and bind messages to the active tab's frame documents), `alarms` (SW keepalive), and `http/https` (content-script injection on normal pages). Only the **active tab** of the last-focused window is ever operated; the extension never switches tabs silently.

## Known limitations

- Only one extension connection at a time (a second window replaces the first).
- Accessible cross-origin iframes are snapshotted and operated with stable `(frame, index)` addresses. Restricted or short-lived frames are reported as unavailable without failing the whole page snapshot.
- Captcha/image-only controls cannot be handled — the tool result reports "elements with no accessible name" and asks the user to complete that step manually.
- No automatic token rotation.
- Synthetic `browser_press` events do not trigger browser-native default actions such as Tab focus movement, arrow-key scrolling, or Enter activation; use manual input when a workflow depends on those defaults.
- `browser_wait` considers page load plus a fixed quiet window, but does not observe continuously changing DOM state; a live-updating SPA may be reported as stable.
