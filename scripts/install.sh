#!/bin/bash
# dsh-browser 一键安装：支持远程托管安装和本地 checkout 安装。
# dsh-browser one-command install: supports both managed remote installs and local checkout installs.
# 之后无需任何配置：扩展自动探测本机 dsh 并连接（回环免 token）。
# No further configuration is required: the extension discovers local dsh automatically and loopback connections require no token.
set -euo pipefail

REPOSITORY="ChangeYourWay/dsh-browser"
REMOTE_REF="main"
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
MANAGED_ROOT="$DSH_HOME_DIR/dsh-browser"
MANAGED_MARKER="$MANAGED_ROOT/.managed-by-install-sh"
ARCHIVE_URL="https://github.com/$REPOSITORY/archive/refs/heads/${REMOTE_REF}.tar.gz"
BOOTSTRAP_TMP=""

print_step() {
  printf '\n[%s/4] %s\n' "$1" "$2"
  printf '      %s\n' "$3"
}

print_pair() {
  printf '%s\n' "$1"
  printf '   %s\n' "$2"
}

fail_pair() {
  printf '\n错误：%s\n' "$1" >&2
  printf 'Error: %s\n' "$2" >&2
  exit 1
}

has_workspace() {
  local candidate="$1"
  [ -f "$candidate/package.json" ] &&
    [ -f "$candidate/pnpm-lock.yaml" ] &&
    [ -f "$candidate/extensions/dsh-browser/package.json" ] &&
    [ -f "$candidate/packages/browser/bridge-browser/package.json" ] &&
    [ -f "$candidate/scripts/install.sh" ]
}

workspace_root_from_script() {
  local script_path="${BASH_SOURCE[0]:-}"
  local script_dir
  local candidate

  [ -n "$script_path" ] && [ -f "$script_path" ] || return 1
  script_dir="$(cd "$(dirname "$script_path")" && pwd)"
  candidate="$(cd "$script_dir/.." && pwd)"
  has_workspace "$candidate" || return 1
  printf '%s\n' "$candidate"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail_pair "$2" "$3"
}

is_macos() {
  [ "$(uname -s)" = "Darwin" ]
}

has_display() {
  [ -n "${DISPLAY:-}" ] || [ -n "${WAYLAND_DISPLAY:-}" ]
}

copy_to_clipboard() {
  local text="$1"

  if is_macos; then
    command -v pbcopy >/dev/null 2>&1 || return 1
    printf '%s' "$text" | pbcopy && return 0
    return 1
  fi

  # The X11/Wayland helpers need a display, and they fork a daemon that keeps owning the
  # selection; keep its stdio off the terminal so the installer's own output stays readable.
  has_display || return 1
  if command -v wl-copy >/dev/null 2>&1; then
    printf '%s' "$text" | wl-copy >/dev/null 2>&1 && return 0
  fi
  if command -v xclip >/dev/null 2>&1; then
    printf '%s' "$text" | xclip -selection clipboard >/dev/null 2>&1 && return 0
  fi
  if command -v xsel >/dev/null 2>&1; then
    printf '%s' "$text" | xsel --clipboard --input >/dev/null 2>&1 && return 0
  fi
  return 1
}

# Echoes a launch target for the local Chrome/Chromium install: on macOS an app bundle path
# or a LaunchServices app name (both accepted by `open -a`), on Linux an executable on PATH.
find_browser_target() {
  local name

  if is_macos; then
    local dir app
    for dir in "/Applications" "$HOME/Applications"; do
      for name in "Google Chrome" "Google Chrome Canary" "Chromium"; do
        app="$dir/$name.app"
        if [ -x "$app/Contents/MacOS/$name" ]; then
          printf '%s\n' "$app"
          return 0
        fi
      done
    done

    # Fallback: recognize apps registered with LaunchServices in non-standard locations.
    for name in "Google Chrome" "Google Chrome Canary" "Chromium"; do
      if open -Ra "$name" >/dev/null 2>&1; then
        printf '%s\n' "$name"
        return 0
      fi
    done
    return 1
  fi

  for name in google-chrome google-chrome-stable chromium chromium-browser; do
    if command -v "$name" >/dev/null 2>&1; then
      printf '%s\n' "$name"
      return 0
    fi
  done
  return 1
}

open_chrome_extensions() {
  local url="chrome://extensions"
  local target
  local pid

  target="$(find_browser_target)" || target=""

  if is_macos; then
    if [ -n "$target" ]; then
      open -a "$target" "$url" >/dev/null 2>&1 && return 0
    fi
    open -b com.google.Chrome "$url" >/dev/null 2>&1 && return 0
    return 1
  fi

  has_display || return 1
  if [ -n "$target" ]; then
    # Launch detached: a first run starts a foreground browser process that would otherwise
    # block the installer until the user quits it.
    "$target" "$url" >/dev/null 2>&1 </dev/null &
    pid=$!
    # Forwarding the URL to a running instance exits almost immediately; a fresh window keeps
    # running. Wait briefly so a browser that fails to start is reported as such.
    sleep 1
    if kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
    wait "$pid" && return 0
  fi
  if command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$url" >/dev/null 2>&1 </dev/null && return 0
  fi
  return 1
}

print_browser_install_hint() {
  if is_macos; then
    if command -v brew >/dev/null 2>&1; then
      print_pair "请手动安装：brew install --cask google-chrome" "Install it manually: brew install --cask google-chrome"
    else
      print_pair "请手动安装 Google Chrome：https://www.google.com/chrome/" "Install Google Chrome manually: https://www.google.com/chrome/"
    fi
  elif command -v apt-get >/dev/null 2>&1; then
    print_pair "请手动安装：sudo apt-get update && sudo apt-get install -y chromium-browser（或 chromium）" "Install it manually: sudo apt-get update && sudo apt-get install -y chromium-browser (or chromium)"
  elif command -v dnf >/dev/null 2>&1; then
    print_pair "请手动安装：sudo dnf install -y chromium" "Install it manually: sudo dnf install -y chromium"
  elif command -v yum >/dev/null 2>&1; then
    print_pair "请手动安装：sudo yum install -y chromium" "Install it manually: sudo yum install -y chromium"
  elif command -v zypper >/dev/null 2>&1; then
    print_pair "请手动安装：sudo zypper --non-interactive install chromium" "Install it manually: sudo zypper --non-interactive install chromium"
  elif command -v pacman >/dev/null 2>&1; then
    print_pair "请手动安装：sudo pacman -S --noconfirm chromium" "Install it manually: sudo pacman -S --noconfirm chromium"
  else
    print_pair "未找到可用的软件包管理器，请手动安装 Chrome 或 Chromium。" "No supported package manager was found; install Chrome or Chromium manually."
  fi
}

install_browser() {
  local sudo_cmd=""

  if is_macos; then
    if command -v brew >/dev/null 2>&1; then
      brew install --cask google-chrome || true
    else
      print_browser_install_hint
    fi
    return 0
  fi

  if [ "$(id -u)" -ne 0 ]; then
    if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
      sudo_cmd="sudo"
    else
      print_pair "需要管理员权限才能安装浏览器。" "Administrator rights are required to install a browser."
      print_browser_install_hint
      return 0
    fi
  fi

  if command -v apt-get >/dev/null 2>&1; then
    $sudo_cmd apt-get update || true
    $sudo_cmd apt-get install -y chromium-browser || $sudo_cmd apt-get install -y chromium || true
  elif command -v dnf >/dev/null 2>&1; then
    $sudo_cmd dnf install -y chromium || true
  elif command -v yum >/dev/null 2>&1; then
    $sudo_cmd yum install -y chromium || true
  elif command -v zypper >/dev/null 2>&1; then
    $sudo_cmd zypper --non-interactive install chromium || true
  elif command -v pacman >/dev/null 2>&1; then
    $sudo_cmd pacman -S --noconfirm chromium || true
  else
    print_browser_install_hint
  fi
  return 0
}

ensure_chrome() {
  if find_browser_target >/dev/null 2>&1; then
    return 0
  fi

  print_pair "未检测到 Chrome/Chromium 浏览器。" "No Chrome/Chromium browser was detected."

  # Installing a browser system-wide is a surprising side effect for a one-line installer,
  # so it stays opt-in and never runs sudo on its own.
  if [ "${DSH_INSTALL_BROWSER:-0}" != "1" ]; then
    print_browser_install_hint
    print_pair "安装后重新运行本脚本；或设置 DSH_INSTALL_BROWSER=1 让脚本尝试自动安装。" "Install it and rerun this script, or set DSH_INSTALL_BROWSER=1 to let the installer attempt it."
    return 1
  fi

  print_pair "DSH_INSTALL_BROWSER=1，尝试自动安装……" "DSH_INSTALL_BROWSER=1 is set; attempting to install…"
  install_browser

  if find_browser_target >/dev/null 2>&1; then
    return 0
  fi
  print_pair "自动安装未完成，本次安装会继续，但需要你手动安装浏览器后再加载扩展。" "Automatic browser installation did not complete; continuing, but install a browser manually before loading the extension."
  return 1
}

cleanup_bootstrap() {
  if [ -n "$BOOTSTRAP_TMP" ] && [ -d "$BOOTSTRAP_TMP" ]; then
    rm -rf -- "$BOOTSTRAP_TMP"
  fi
}

bootstrap_remote_install() {
  local archive
  local source_dir
  local temp_base="${TMPDIR:-/tmp}"

  require_command curl "未找到 curl；请先安装 curl。" "curl was not found; install curl first."
  require_command tar "未找到 tar；请先安装 tar。" "tar was not found; install tar first."
  require_command rsync "未找到 rsync；请先安装 rsync。" "rsync was not found; install rsync first."

  if [ -d "$MANAGED_ROOT" ] && [ ! -f "$MANAGED_MARKER" ] && [ -n "$(ls -A "$MANAGED_ROOT" 2>/dev/null)" ]; then
    fail_pair \
      "$MANAGED_ROOT 已存在且不是脚本托管的安装目录；为避免覆盖，请移动该目录或在其中运行 ./scripts/install.sh。" \
      "$MANAGED_ROOT already exists and is not managed by this installer; move it or run ./scripts/install.sh inside it to avoid overwriting it."
  fi

  print_pair "未检测到完整的本地 checkout，切换到免 clone 安装。" "No complete local checkout was detected; switching to the clone-free install."
  print_pair "正在从 $REPOSITORY 的 $REMOTE_REF 分支下载安装文件……" "Downloading installation files from $REPOSITORY at ${REMOTE_REF}…"

  BOOTSTRAP_TMP="$(mktemp -d "$temp_base/dsh-browser-install.XXXXXX")"
  trap cleanup_bootstrap EXIT HUP INT TERM
  archive="$BOOTSTRAP_TMP/source.tar.gz"
  source_dir="$BOOTSTRAP_TMP/source"
  mkdir -p "$source_dir"

  curl --fail --location --silent --show-error --retry 3 "$ARCHIVE_URL" --output "$archive"
  tar -xzf "$archive" -C "$source_dir" --strip-components=1
  has_workspace "$source_dir" || fail_pair \
    "下载内容不完整，未修改现有安装。" \
    "The download is incomplete; the existing installation was not changed."

  mkdir -p "$MANAGED_ROOT"
  touch "$MANAGED_MARKER"
  rsync -a --delete-after \
    --exclude 'node_modules/' \
    --exclude '.managed-by-install-sh' \
    "$source_dir/" "$MANAGED_ROOT/"

  cleanup_bootstrap
  trap - EXIT HUP INT TERM
  print_pair "安装文件已同步到 ${MANAGED_ROOT}。" "Installation files are ready in $MANAGED_ROOT."
  exec /bin/bash "$MANAGED_ROOT/scripts/install.sh"
}

if ROOT="$(workspace_root_from_script)"; then
  :
else
  bootstrap_remote_install
fi

EXT="$ROOT/extensions/dsh-browser"
PLUGIN="$ROOT/packages/browser/bridge-browser"
WEB_PROFILE_MANIFEST="$DSH_HOME_DIR/profiles/web/package.json"
LEGACY_PLUGIN="@deepseek-ai/dsh-bridge-browser"

profile_has_dependency() {
  local manifest="$1"
  local package_name="$2"

  [ -f "$manifest" ] || return 1
  node -e '
    const manifest = require(process.argv[1]);
    process.exit(Object.hasOwn(manifest.dependencies ?? {}, process.argv[2]) ? 0 : 1);
  ' "$manifest" "$package_name"
}

require_command pnpm "未找到 pnpm；请先启用 Corepack 或安装 pnpm。" "pnpm was not found; enable Corepack or install pnpm first."
require_command node "未找到 Node.js；请先安装受支持的 Node.js 版本。" "Node.js was not found; install a supported Node.js version first."
require_command rsync "未找到 rsync；请先安装 rsync。" "rsync was not found; install rsync first."

print_step 1 "构建浏览器桥" "Build the browser bridge"
(cd "$ROOT" && pnpm install --frozen-lockfile >/dev/null 2>&1)
(cd "$ROOT" && pnpm --filter @yuxianglin/dsh-bridge-browser run build >/dev/null 2>&1)

print_step 2 "注册到本机 web profile" "Register with the local web profile"
if profile_has_dependency "$WEB_PROFILE_MANIFEST" "$LEGACY_PLUGIN"; then
  (cd "$ROOT" && pnpm exec dsh plugin --profile web remove "$LEGACY_PLUGIN" >/dev/null)
fi
(cd "$ROOT" && pnpm exec dsh plugin --profile web add -w "@yuxianglin/dsh-bridge-browser@link:$PLUGIN" >/dev/null)

print_step 3 "构建 Chrome 扩展" "Build the Chrome extension"
(cd "$ROOT" && pnpm --filter dsh-browser-extension run build >/dev/null 2>&1)

print_step 4 "准备扩展并打开 Chrome" "Prepare the extension and open Chrome"
ensure_chrome || true
DIST_DIR="$DSH_HOME_DIR/browser-extension"
if [ -f "$DIST_DIR/manifest.json" ]; then
  IS_UPDATE=1
else
  IS_UPDATE=0
fi
mkdir -p "$DIST_DIR"
rsync -a --delete-after "$EXT/dist/" "$DIST_DIR/"
if [ -f "$ROOT/.managed-by-install-sh" ]; then
  INSTALL_MODE="managed"
else
  INSTALL_MODE="checkout"
fi
node -e '
  const { writeFileSync } = require("node:fs");
  const [filename, mode, sourceRoot] = process.argv.slice(1);
  const info = {
    schemaVersion: 1,
    mode,
    ...(mode === "checkout" ? { sourceRoot } : {}),
  };
  writeFileSync(filename, `${JSON.stringify(info, null, 2)}\n`);
' "$DIST_DIR/install-info.json" "$INSTALL_MODE" "$ROOT"
if copy_to_clipboard "$DIST_DIR"; then
  CLIPBOARD_READY=1
else
  CLIPBOARD_READY=0
fi

if open_chrome_extensions; then
  CHROME_OPENED=1
else
  CHROME_OPENED=0
fi
printf '\n'
if [ "$CHROME_OPENED" -ne 1 ]; then
  print_pair "无法自动打开 Chrome，请手动打开浏览器并在地址栏输入 chrome://extensions。" "Could not open Chrome automatically; open the browser and type chrome://extensions in the address bar."
fi
if [ "$IS_UPDATE" -eq 1 ]; then
  print_pair "检测到已有扩展目录，文件已安全更新。" "Existing extension directory detected; its files were updated safely."
  print_pair "打开 Google Chrome（注意不是 Edge/Firefox）：" "Open Google Chrome (not Edge/Firefox):"
  printf '\n'
  print_pair "    地址栏输入 chrome://extensions" "    Type chrome://extensions in the address bar"
  printf '\n'
  print_pair "如果页面上已有“dsh 浏览器助手”卡片：" "If the “dsh Browser Assistant” card is already listed:"
  print_pair "  点击卡片上的“重新加载”按钮，让扩展加载新文件。" "  Click “Reload” on that card so it picks up the updated files."
  printf '\n'
  print_pair "如果没有该卡片（例如从未加载过）：" "If the card is not listed (e.g. it was never loaded):"
  print_pair "  打开右上角 “开发者模式”" "  Enable “Developer mode” in the upper-right corner"
  print_pair "  点左上角 “加载已解压的扩展程序”" "  Click “Load unpacked” in the upper-left corner"
  print_pair "  选择这个目录：" "  Select this directory:"
  printf '   %s\n' "$DIST_DIR"
  printf '\n'
  print_pair "出现 “dsh 浏览器助手” 卡片即成功。" "When the “dsh Browser Assistant” card appears, it is loaded."
else
  if [ "$CHROME_OPENED" -eq 1 ]; then
    print_pair "Chrome 扩展管理页已打开，请完成以下操作：" "Chrome Extensions is open. Complete these steps:"
  else
    print_pair "请在 Chrome 扩展管理页完成以下操作：" "Complete these steps on the Chrome Extensions page:"
  fi
  printf '\n'
  print_pair "1. 开启右上角的“开发者模式”" "Enable “Developer mode” in the upper-right corner"
  print_pair "2. 点击“加载已解压的扩展程序”" "Click “Load unpacked”"
  if is_macos; then
    if [ "$CLIPBOARD_READY" -eq 1 ]; then
      print_pair "3. 按 Cmd+Shift+G，粘贴以下路径（已复制到剪贴板）：" "Press Cmd+Shift+G and paste this path (already copied):"
    else
      print_pair "3. 按 Cmd+Shift+G，粘贴以下路径：" "Press Cmd+Shift+G and paste this path:"
    fi
  else
    if [ "$CLIPBOARD_READY" -eq 1 ]; then
      print_pair "3. 粘贴以下路径（已复制到剪贴板）：" "Paste this path (already copied):"
    else
      print_pair "3. 复制并粘贴以下路径：" "Copy and paste this path:"
    fi
  fi
  printf '   %s\n' "$DIST_DIR"
fi

printf '\n'
print_pair "加载完成后：" "After loading the extension:"
print_pair "• 点击工具栏中的 DeepSeek 鲸鱼图标，打开侧边栏" "Click the DeepSeek whale icon in the toolbar to open the side panel"
print_pair "• 扩展会自动发现本机 dsh，无需填写地址或 token" "The extension discovers local dsh automatically; no address or token is required"
printf '• 启动固定版本：cd %q && pnpm start\n' "$ROOT"
printf '   Start the pinned version: cd %q && pnpm start\n' "$ROOT"
print_pair "• 或直接启动固定 npm 版本：npx @deepseek-ai/dsh@0.1.2-rc.1 web" "Or start the pinned npm version directly: npx @deepseek-ai/dsh@0.1.2-rc.1 web"
printf '\n'
print_pair "如果用得顺手，欢迎在 GitHub 点个 Star 支持我们：https://github.com/ChangeYourWay/dsh-browser" "If dsh-browser is useful to you, we'd appreciate a Star on GitHub: https://github.com/ChangeYourWay/dsh-browser"
