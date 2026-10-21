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

say() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m警告:\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31m错误:\033[0m %s\n' "$*" >&2; exit 1; }

stop_service() {
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
}

if [[ "${1:-}" == "--uninstall" ]]; then
  say "停止并移除本地翻译服务"
  stop_service
  rm -f "$PLIST"
  rm -rf "$APP_DIR"
  say "已卸载。Chrome 扩展请在 chrome://extensions 中移除；扩展文件夹 $EXT_DIR 可直接删除。"
  say "下载的模型在 ~/.cache/huggingface，可按需删除。"
  exit 0
fi

[[ "$(uname -s)" == "Darwin" ]] || die "只支持 macOS。"
[[ "$(uname -m)" == "arm64" ]] || die "本地翻译模型需要 Apple Silicon（M 系列芯片）的 Mac。"

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
(cd "$SERVICE_DIR" && uv sync --frozen --no-dev --python 3.12)

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
  if ps -o command= -p "$pid" | grep -q web-translator; then
    say "停止占用端口 $PORT 的旧版翻译服务（进程 ${pid}）"
    kill "$pid" 2>/dev/null || true
    sleep 1
  else
    warn "端口 $PORT 被其他程序占用：$(ps -o command= -p "$pid")"
  fi
done
launchctl bootstrap "gui/$(id -u)" "$PLIST"

# Ready = our service answers (token-era versions report authorized: false).
ready() { curl -fsS -m 2 "http://127.0.0.1:$PORT/health" 2>/dev/null | grep -q '"authorized":true'; }
for _ in $(seq 1 30); do
  ready && break
  sleep 1
done
ready \
  && say "本地翻译服务已运行：http://127.0.0.1:$PORT" \
  || warn "服务还没就绪，日志在 $LOG_DIR/translator.log"

# --- Chrome extension ------------------------------------------------------------------
say "放置 Chrome 扩展到 $EXT_DIR"
rm -rf "$EXT_DIR"
mkdir -p "$EXT_DIR"
unzip -q "$TMP/extension.zip" -d "$EXT_DIR"

cat <<DONE

✅ 安装完成。最后一步，在 Chrome 中加载扩展（只需做一次，之后重新运行安装命令即可更新）：
   1. 地址栏打开 chrome://extensions
   2. 打开右上角「开发者模式」
   3. 点「加载已解压的扩展程序」，选择文件夹：
      $EXT_DIR
   （已经加载过的话，点扩展卡片上的刷新按钮即可。）

翻译服务会在登录 Mac 时自动启动。卸载：
   curl -fsSL $BASE_URL/install.sh | bash -s -- --uninstall
DONE

open "$HOME/LocaLingo" 2>/dev/null || true
open -a "Google Chrome" "chrome://extensions" 2>/dev/null || true
