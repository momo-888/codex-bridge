#!/usr/bin/env bash
set -euo pipefail
umask 077

API_PORT=43110
WEB_PORT=3000
LISTEN_ADDRESS="127.0.0.1"
PUBLIC_URL=""
PUBLIC_HOST=""
NO_BROWSER=0
LISTEN_ADDRESS_SET=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --api-port) API_PORT="$2"; shift 2 ;;
    --web-port) WEB_PORT="$2"; shift 2 ;;
    --listen-address) LISTEN_ADDRESS="$2"; LISTEN_ADDRESS_SET=1; shift 2 ;;
    --public-url) PUBLIC_URL="$2"; shift 2 ;;
    --public-host) PUBLIC_HOST="$2"; shift 2 ;;
    --no-browser) NO_BROWSER=1; shift ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOGS_DIRECTORY="$PROJECT_ROOT/.logs"
CONFIG_DIRECTORY="$HOME/.codex-bridge"
RUNTIME_PATH="$CONFIG_DIRECTORY/runtime.json"
LAUNCHER_CONFIG="$CONFIG_DIRECTORY/launcher.json"
STOP_SIGNAL="$CONFIG_DIRECTORY/stop.requested"
PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export PATH
mkdir -p "$LOGS_DIRECTORY" "$CONFIG_DIRECTORY"
chmod 700 "$CONFIG_DIRECTORY"
rm -f "$STOP_SIGNAL"

if [[ -x "$PROJECT_ROOT/runtime/node" ]]; then
  NODE="$PROJECT_ROOT/runtime/node"
else
  NODE="$(command -v node || true)"
fi
if [[ -z "$NODE" ]]; then
  echo "未找到 Node.js 22.13 或更高版本。" >&2
  exit 1
fi

if [[ ! -f "$PROJECT_ROOT/dist/server/index.js" && ! -f "$PROJECT_ROOT/runtime/web-server.mjs" ]]; then
  NPM="$(command -v npm || true)"
  if [[ -z "$NPM" ]]; then
    echo "首次运行需要 npm 构建手机网页。" >&2
    exit 1
  fi
  echo "首次运行：正在构建手机端…"
  (cd "$PROJECT_ROOT" && "$NPM" run build)
fi

if [[ -n "$PUBLIC_URL" && -n "$PUBLIC_HOST" ]]; then
  echo "--public-url 和 --public-host 不能同时使用。" >&2
  exit 2
fi

read_config_value() {
  local key="$1"
  if [[ -f "$LAUNCHER_CONFIG" ]]; then
    /usr/bin/plutil -extract "$key" raw "$LAUNCHER_CONFIG" 2>/dev/null || true
  fi
}

if [[ "$LISTEN_ADDRESS_SET" -eq 0 ]]; then
  SAVED_LISTEN="$(read_config_value listenAddress)"
  if [[ -n "$SAVED_LISTEN" ]]; then LISTEN_ADDRESS="$SAVED_LISTEN"; fi
fi
if [[ -n "$PUBLIC_HOST" ]]; then PUBLIC_URL="http://$PUBLIC_HOST:$API_PORT"; fi
if [[ -z "$PUBLIC_URL" ]]; then PUBLIC_URL="$(read_config_value publicUrl)"; fi
if [[ -z "$PUBLIC_URL" ]]; then
  if [[ "$LISTEN_ADDRESS" == "127.0.0.1" ]]; then
    PUBLIC_URL="http://127.0.0.1:$API_PORT"
  else
    PUBLIC_URL="http://$(hostname):$API_PORT"
  fi
fi

PUBLIC_URL="$($NODE -e '
const value = process.argv[1];
const url = new URL(value);
if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || (url.pathname && url.pathname !== "/") || url.search || url.hash) process.exit(2);
process.stdout.write(url.origin);
' "$PUBLIC_URL")" || {
  echo "手机连接地址必须是完整的 HTTP/HTTPS 站点根地址。" >&2
  exit 2
}

if [[ "$LISTEN_ADDRESS" != "127.0.0.1" && "$LISTEN_ADDRESS" != "0.0.0.0" ]]; then
  echo "监听地址只能是 127.0.0.1 或 0.0.0.0。" >&2
  exit 2
fi

"$NODE" -e '
const fs = require("fs");
const [target, publicUrl, apiPort, webPort, listenAddress] = process.argv.slice(1);
const temporary = `${target}.tmp-${process.pid}`;
fs.writeFileSync(temporary, JSON.stringify({ publicUrl, apiPort: Number(apiPort), webPort: Number(webPort), listenAddress }, null, 2) + "\n", { mode: 0o600 });
fs.renameSync(temporary, target);
' "$LAUNCHER_CONFIG" "$PUBLIC_URL" "$API_PORT" "$WEB_PORT" "$LISTEN_ADDRESS"

port_is_listening() {
  /usr/sbin/lsof -nP -iTCP:"$1" -sTCP:LISTEN -t >/dev/null 2>&1
}

HOST_PID=""
WEB_PID=""
if ! port_is_listening "$API_PORT"; then
  nohup /bin/bash "$PROJECT_ROOT/scripts/run-host.sh" \
    --project-root "$PROJECT_ROOT" \
    --api-port "$API_PORT" \
    --web-port "$WEB_PORT" \
    --listen-address "$LISTEN_ADDRESS" \
    --public-api-url "$PUBLIC_URL" \
    --web-url "$PUBLIC_URL" \
    --stop-signal "$STOP_SIGNAL" \
    >>"$LOGS_DIRECTORY/host.out.log" 2>>"$LOGS_DIRECTORY/host.err.log" &
  HOST_PID=$!
else
  echo "电脑端口 $API_PORT 已有服务监听，跳过重复启动。"
fi

if ! port_is_listening "$WEB_PORT"; then
  nohup /bin/bash "$PROJECT_ROOT/scripts/run-web.sh" \
    --project-root "$PROJECT_ROOT" \
    --web-port "$WEB_PORT" \
    --api-port "$API_PORT" \
    --listen-address "$LISTEN_ADDRESS" \
    --stop-signal "$STOP_SIGNAL" \
    >>"$LOGS_DIRECTORY/web.out.log" 2>>"$LOGS_DIRECTORY/web.err.log" &
  WEB_PID=$!
else
  echo "手机端口 $WEB_PORT 已有服务监听，跳过重复启动。"
fi

"$NODE" -e '
const fs = require("fs");
const [target, apiPort, webPort, hostPid, webPid] = process.argv.slice(1);
const value = { apiPort: Number(apiPort), webPort: Number(webPort), hostLauncherPid: hostPid ? Number(hostPid) : null, webLauncherPid: webPid ? Number(webPid) : null, startedAt: new Date().toISOString() };
fs.writeFileSync(target, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
' "$RUNTIME_PATH" "$API_PORT" "$WEB_PORT" "$HOST_PID" "$WEB_PID"

sleep 2
echo "Codex Bridge 已启动"
echo "手机页面：$PUBLIC_URL"
echo "电脑配对页：http://127.0.0.1:$API_PORT/setup"
if [[ "$NO_BROWSER" -eq 0 ]]; then /usr/bin/open "http://127.0.0.1:$API_PORT/setup"; fi
