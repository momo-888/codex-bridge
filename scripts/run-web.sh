#!/usr/bin/env bash
set -u
umask 077

PROJECT_ROOT=""
WEB_PORT=3000
API_PORT=43110
LISTEN_ADDRESS="127.0.0.1"
STOP_SIGNAL=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project-root) PROJECT_ROOT="$2"; shift 2 ;;
    --web-port) WEB_PORT="$2"; shift 2 ;;
    --api-port) API_PORT="$2"; shift 2 ;;
    --listen-address) LISTEN_ADDRESS="$2"; shift 2 ;;
    --stop-signal) STOP_SIGNAL="$2"; shift 2 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

if [[ -z "$PROJECT_ROOT" || -z "$STOP_SIGNAL" ]]; then
  echo "run-web.sh 缺少必要参数。" >&2
  exit 2
fi

PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export PATH
export CODEX_BRIDGE_UPSTREAM="http://127.0.0.1:$API_PORT"
if [[ "$LISTEN_ADDRESS" == "127.0.0.1" ]]; then WEB_HOSTNAME="127.0.0.1"; else WEB_HOSTNAME="0.0.0.0"; fi
if [[ -x "$PROJECT_ROOT/runtime/node" ]]; then NODE="$PROJECT_ROOT/runtime/node"; else NODE="$(command -v node || true)"; fi
NPM="$(command -v npm || true)"
cd "$PROJECT_ROOT" || exit 1

while [[ ! -f "$STOP_SIGNAL" ]]; do
  if [[ -x "$PROJECT_ROOT/runtime/node" && -f "$PROJECT_ROOT/runtime/web-server.mjs" ]]; then
    "$NODE" "$PROJECT_ROOT/runtime/web-server.mjs" "$WEB_PORT" "$WEB_HOSTNAME"
  elif [[ -n "$NPM" ]]; then
    "$NPM" run start -- --port "$WEB_PORT" --hostname "$WEB_HOSTNAME"
  else
    echo "找不到 Web 运行时。" >&2
    exit 1
  fi
  EXIT_CODE=$?
  if [[ -f "$STOP_SIGNAL" ]]; then break; fi
  echo "Codex Bridge Web 已退出（代码 $EXIT_CODE），2 秒后自动重启。" >&2
  sleep 2
done
