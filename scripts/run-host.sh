#!/usr/bin/env bash
set -u
umask 077

PROJECT_ROOT=""
API_PORT=43110
WEB_PORT=3000
LISTEN_ADDRESS="127.0.0.1"
PUBLIC_API_URL="http://127.0.0.1:43110"
WEB_URL="http://127.0.0.1:43110"
STOP_SIGNAL=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project-root) PROJECT_ROOT="$2"; shift 2 ;;
    --api-port) API_PORT="$2"; shift 2 ;;
    --web-port) WEB_PORT="$2"; shift 2 ;;
    --listen-address) LISTEN_ADDRESS="$2"; shift 2 ;;
    --public-api-url) PUBLIC_API_URL="$2"; shift 2 ;;
    --web-url) WEB_URL="$2"; shift 2 ;;
    --stop-signal) STOP_SIGNAL="$2"; shift 2 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

if [[ -z "$PROJECT_ROOT" || -z "$STOP_SIGNAL" ]]; then
  echo "run-host.sh 缺少必要参数。" >&2
  exit 2
fi

PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export PATH
export CODEX_BRIDGE_PORT="$API_PORT"
export CODEX_BRIDGE_HOST="$LISTEN_ADDRESS"
export CODEX_BRIDGE_PUBLIC_URL="$PUBLIC_API_URL"
export CODEX_BRIDGE_WEB_URL="$WEB_URL"
export CODEX_BRIDGE_WEB_INTERNAL_URL="http://127.0.0.1:$WEB_PORT"

for CODEX_APP in "/Applications/ChatGPT.app" "$HOME/Applications/ChatGPT.app" "/Applications/Codex.app" "$HOME/Applications/Codex.app"; do
  if [[ -x "$CODEX_APP/Contents/Resources/codex" ]]; then
    export CODEX_BRIDGE_CODEX_BIN="$CODEX_APP/Contents/Resources/codex"
    break
  fi
done

RELAY_CONFIG="$HOME/.codex-bridge/relay.json"
if [[ -f "$RELAY_CONFIG" ]]; then
  RELAY_URL="$(/usr/bin/plutil -extract publicUrl raw "$RELAY_CONFIG" 2>/dev/null || true)"
  RELAY_HOST_TOKEN="$(/usr/bin/plutil -extract hostToken raw "$RELAY_CONFIG" 2>/dev/null || true)"
  RELAY_PHONE_TOKEN="$(/usr/bin/plutil -extract phoneToken raw "$RELAY_CONFIG" 2>/dev/null || true)"
  if [[ -n "$RELAY_URL" && -n "$RELAY_HOST_TOKEN" && -n "$RELAY_PHONE_TOKEN" ]]; then
    export CODEX_BRIDGE_RELAY_URL="$RELAY_URL"
    export CODEX_BRIDGE_RELAY_HOST_TOKEN="$RELAY_HOST_TOKEN"
    export CODEX_BRIDGE_RELAY_PHONE_TOKEN="$RELAY_PHONE_TOKEN"
  fi
fi

if [[ -x "$PROJECT_ROOT/runtime/node" ]]; then NODE="$PROJECT_ROOT/runtime/node"; else NODE="$(command -v node || true)"; fi
NPM="$(command -v npm || true)"
cd "$PROJECT_ROOT" || exit 1

while [[ ! -f "$STOP_SIGNAL" ]]; do
  if [[ -x "$PROJECT_ROOT/runtime/node" && -f "$PROJECT_ROOT/runtime/host-server.mjs" ]]; then
    "$NODE" "$PROJECT_ROOT/runtime/host-server.mjs"
  elif [[ -n "$NPM" ]]; then
    "$NPM" run host
  else
    echo "找不到 Host 运行时。" >&2
    exit 1
  fi
  EXIT_CODE=$?
  if [[ -f "$STOP_SIGNAL" ]]; then break; fi
  echo "Codex Bridge Host 已退出（代码 $EXIT_CODE），2 秒后自动重启。" >&2
  sleep 2
done
