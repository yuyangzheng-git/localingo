#!/bin/bash
# LocaLingo one-click installer for macOS (Apple Silicon).
#
#   curl -fsSL http://101.35.6.63:8083/install.sh | bash
#
# Installs the local translation service (MLX model, starts at login), downloads the
# translation model, and puts the Chrome extension in ~/LocaLingo/chrome-extension.
# Re-run to update. Uninstall: curl -fsSL http://101.35.6.63:8083/install.sh | bash -s -- --uninstall
set -euo pipefail

BASE_URL="${LOCALINGO_BASE_URL:-http://101.35.6.63:8083}"
APP_DIR="$HOME/Library/Application Support/LocaLingo"
SERVICE_DIR="$APP_DIR/translator"
EXT_DIR="$HOME/LocaLingo/chrome-extension"
LOG_DIR="$HOME/Library/Logs/LocaLingo"
LABEL="com.localingo.translator"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
MODEL="ZachacyZ/qwen3-1.7b-web-v3a-merged"
PORT=8765
# Chrome Web Store id once LocaLingo is published there (docs/CHROME_WEB_STORE.md).
# With it, Chrome offers the extension itself on its next start: one click to enable.
STORE_ID="${LOCALINGO_STORE_ID:-}"  # e.g. STORE_ID="${LOCALINGO_STORE_ID:-abcdefghijklmnopabcdefghijklmnop}"
CHROME_PROFILE_DIR="$HOME/Library/Application Support/Google/Chrome"
EXT_ORIGIN="chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

say() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m警告:\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31m错误:\033[0m %s\n' "$*" >&2; exit 1; }

DOMAIN="gui/$(id -u)"

stop_service() {
  # bootout can report an error yet still unload, and returns before launchd has
  # finished: wait until the service and its port are really gone.
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  for _ in $(seq 1 20); do
    launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || break
    sleep 0.5
  done
  for _ in $(seq 1 20); do
    lsof -tiTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 || break
    sleep 0.5
  done
}

start_service() {
  for _ in 1 2 3; do
    launchctl bootstrap "$DOMAIN" "$PLIST" 2>/dev/null && return 0
    stop_service
    sleep 1
  done
  die "无法启动后台翻译服务（launchctl bootstrap 失败）。请重新运行本命令。"
}

if [[ "${1:-}" == "--uninstall" ]]; then
  say "停止并移除本地翻译服务"
  stop_service
  rm -f "$PLIST"
  rm -rf "$APP_DIR"
  [[ -n "$STORE_ID" ]] && rm -f "$CHROME_PROFILE_DIR/External Extensions/$STORE_ID.json"
  say "已卸载。Chrome 扩展请在 chrome://extensions 中移除；扩展文件夹 $EXT_DIR 可直接删除。"
  say "下载的模型在 ~/.cache/huggingface，可按需删除。"
  exit 0
fi

[[ "$(uname -s)" == "Darwin" ]] || die "只支持 macOS。"
[[ "$(uname -m)" == "arm64" ]] || die "本地翻译模型需要 Apple Silicon（M 系列芯片）的 Mac。"
CHROME_APP=""
for app in "/Applications/Google Chrome.app" "$HOME/Applications/Google Chrome.app"; do
  [[ -d "$app" ]] && CHROME_APP="$app" && break
done
[[ -n "$CHROME_APP" ]] || warn "没有找到 Google Chrome。翻译服务照常安装，请装好 Chrome（https://www.google.com/chrome/）后再运行一次本命令。"

# --- uv (Python toolchain) -----------------------------------------------------------
export PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"
if ! command -v uv >/dev/null 2>&1; then
  say "安装 uv（Python 环境管理工具）"
  if command -v brew >/dev/null 2>&1; then
    brew install uv
  else
    curl -LsSf https://astral.sh/uv/install.sh | sh
  fi
fi
command -v uv >/dev/null 2>&1 || die "uv 安装失败，请先手动安装：https://docs.astral.sh/uv/"

# Mainland China: Hugging Face is often unreachable, use the mirror.
HF_ENV=""
if [[ -n "${HF_ENDPOINT:-}" ]]; then
  HF_ENV="$HF_ENDPOINT"
elif ! curl -fsS -m 6 -o /dev/null https://huggingface.co 2>/dev/null; then
  HF_ENV="https://hf-mirror.com"
  say "无法直接访问 Hugging Face，改用镜像 $HF_ENV"
fi

# --- translation service ---------------------------------------------------------------
say "下载本地翻译服务"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -fsSL "$BASE_URL/download/localingo-translator.tar.gz" -o "$TMP/translator.tar.gz"
curl -fsSL "$BASE_URL/download/localingo-extension.zip" -o "$TMP/extension.zip"

stop_service
mkdir -p "$SERVICE_DIR" "$LOG_DIR"
# Keep the virtualenv across updates; replace the code.
find "$SERVICE_DIR" -mindepth 1 -maxdepth 1 ! -name .venv -exec rm -rf {} +
tar -xzf "$TMP/translator.tar.gz" -C "$SERVICE_DIR"

say "安装 Python 依赖（首次需要几分钟）"
(cd "$SERVICE_DIR" && uv sync --frozen --no-dev --python 3.12) \
  || die "Python 依赖安装失败（多为网络问题），请检查网络后重新运行本命令。"

if [[ ! -d "$HOME/models/qwen3-1.7b-web-v3a-mlx" ]]; then
  say "下载翻译模型 ${MODEL}（约 3–4 GB，只需一次）"
  if ! (cd "$SERVICE_DIR" && HF_ENDPOINT="${HF_ENV:-https://huggingface.co}" .venv/bin/python -c "from huggingface_hub import snapshot_download; snapshot_download('$MODEL')"); then
    warn "模型下载未完成，服务会在第一次翻译时继续下载。"
  fi
fi

say "设置开机自动启动"
mkdir -p "$(dirname "$PLIST")"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$SERVICE_DIR/.venv/bin/web-translator</string></array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>WEB_TRANSLATOR_PORT</key><string>$PORT</string>
$( [[ -n "$HF_ENV" ]] && printf '    <key>HF_ENDPOINT</key><string>%s</string>\n' "$HF_ENV" )
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$LOG_DIR/translator.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/translator.log</string>
</dict>
</plist>
PLIST
# An older translator started by hand (e.g. `uv run web-translator`) would keep the
# port, and the extension would keep talking to it.
for pid in $(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null); do
  if [[ "$(ps -o command= -p "$pid")" == *web-translator* ]]; then
    say "停止占用端口 $PORT 的旧版翻译服务（进程 ${pid}）"
    kill "$pid" 2>/dev/null || true
    sleep 1
  else
    warn "端口 $PORT 被其他程序占用：$(ps -o command= -p "$pid")"
  fi
done
start_service

# Ready = our service answers (token-era versions report authorized: false).
ready() { [[ "$(curl -fsS -m 2 "http://127.0.0.1:$PORT/health" 2>/dev/null)" == *'"authorized":true'* ]]; }
for _ in $(seq 1 30); do
  ready && break
  sleep 1
done
ready || die "翻译服务没有启动，日志：$LOG_DIR/translator.log
$(tail -n 15 "$LOG_DIR/translator.log" 2>/dev/null)"

# Load the model now with a real translation, so the first page isn't slow and a
# broken model download shows up here rather than in the browser.
say "加载模型并试译一句（首次约需半分钟到几分钟）"
SAMPLE="$(curl -fsS -m 900 -X POST "http://127.0.0.1:$PORT/translate" \
  -H "Content-Type: application/json" -H "Origin: $EXT_ORIGIN" \
  -d '{"texts":["Reading is a good way to learn new words."]}' 2>/dev/null || true)"
RESULT="$(printf '%s' "$SAMPLE" | "$SERVICE_DIR/.venv/bin/python" -c 'import json, sys; print(json.load(sys.stdin)["translations"][0])' 2>/dev/null || true)"
if [[ -n "$RESULT" ]]; then
  say "模型运行正常：$RESULT"
else
  die "模型没能完成试译（多为模型下载中断）。重新运行本命令会继续下载。日志：$LOG_DIR/translator.log
$(tail -n 15 "$LOG_DIR/translator.log" 2>/dev/null)"
fi

# --- Chrome extension ------------------------------------------------------------------
say "放置 Chrome 扩展到 $EXT_DIR"
rm -rf "$EXT_DIR"
mkdir -p "$EXT_DIR"
unzip -q "$TMP/extension.zip" -d "$EXT_DIR"

if [[ -n "$STORE_ID" ]]; then
  # Chrome Web Store build: register it as an external extension. On its next start
  # Chrome shows "LocaLingo 已添加" with an Enable button.
  mkdir -p "$CHROME_PROFILE_DIR/External Extensions"
  printf '{"external_update_url": "https://clients2.google.com/service/update2/crx"}\n' \
    > "$CHROME_PROFILE_DIR/External Extensions/$STORE_ID.json"
  cat <<DONE

✅ 安装完成。最后一步：重新打开 Chrome，在弹出的「LocaLingo 已添加」提示中点「启用扩展」。
   翻译服务会在登录 Mac 时自动启动。
   卸载：curl -fsSL $BASE_URL/install.sh | bash -s -- --uninstall
DONE
  [[ -n "$CHROME_APP" ]] && osascript -e 'quit app "Google Chrome"' >/dev/null 2>&1 && sleep 2 && open -a "$CHROME_APP" || true
  exit 0
fi

# Unpacked build: Chrome only lets the user load it (Developer mode). Find copies that
# are already loaded so updating needs just the reload button, and stale copies from
# other folders don't run twice.
LOADED="$("$SERVICE_DIR/.venv/bin/python" - "$CHROME_PROFILE_DIR" <<'PY' 2>/dev/null || true
import json, pathlib, sys
seen = set()
for prefs in pathlib.Path(sys.argv[1]).glob("*/Secure Preferences"):
    try:
        settings = json.loads(prefs.read_text())["extensions"]["settings"]
    except Exception:
        continue
    for ext in settings.values():
        path = ext.get("path", "")
        manifest = pathlib.Path(path, "manifest.json")
        try:
            if path.startswith("/") and json.loads(manifest.read_text()).get("name") == "LocaLingo":
                seen.add(path)
        except Exception:
            pass
print("\n".join(sorted(seen)))
PY
)"
printf '%s' "$EXT_DIR" | pbcopy 2>/dev/null || true

if [[ "$LOADED" == *"$EXT_DIR"* ]]; then
  STEP="Chrome 已经加载了这个文件夹：在 chrome://extensions 的 LocaLingo 卡片上点刷新按钮 ↻ 即可更新。"
else
  STEP="在 Chrome 中加载扩展（只需一次）：
   1. 已为你打开 chrome://extensions，打开右上角「开发者模式」
   2. 把 Finder 中选中的 chrome-extension 文件夹拖进这个页面
      （或点「加载已解压的扩展程序」，按 ⌘⇧G 粘贴路径——路径已复制到剪贴板）"
fi
OTHERS="$(printf '%s\n' "$LOADED" | grep -vxF "$EXT_DIR" | grep -v '^$' || true)"

cat <<DONE

✅ 翻译服务和模型已就绪，会在登录 Mac 时自动启动。

$STEP
DONE
if [[ -n "$OTHERS" ]]; then
  warn "Chrome 还加载着其他位置的 LocaLingo，会和新版同时运行，请在 chrome://extensions 中移除：
$OTHERS"
fi
cat <<DONE

卸载：curl -fsSL $BASE_URL/install.sh | bash -s -- --uninstall
DONE

open -R "$EXT_DIR" 2>/dev/null || true
[[ -n "$CHROME_APP" ]] && open -a "$CHROME_APP" "chrome://extensions" 2>/dev/null || true
