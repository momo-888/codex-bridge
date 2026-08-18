#!/usr/bin/env bash
set -euo pipefail
umask 077

CONFIG_DIRECTORY="$HOME/.codex-bridge"
RUNTIME_PATH="$CONFIG_DIRECTORY/runtime.json"
LAUNCHER_CONFIG="$CONFIG_DIRECTORY/launcher.json"
STOP_SIGNAL="$CONFIG_DIRECTORY/stop.requested"
mkdir -p "$CONFIG_DIRECTORY"
touch "$STOP_SIGNAL"

read_value() {
  local file="$1"
  local key="$2"
  if [[ -f "$file" ]]; then /usr/bin/plutil -extract "$key" raw "$file" 2>/dev/null || true; fi
}

API_PORT="$(read_value "$RUNTIME_PATH" apiPort)"
WEB_PORT="$(read_value "$RUNTIME_PATH" webPort)"
HOST_PID="$(read_value "$RUNTIME_PATH" hostLauncherPid)"
WEB_PID="$(read_value "$RUNTIME_PATH" webLauncherPid)"
if [[ -z "$API_PORT" ]]; then API_PORT="$(read_value "$LAUNCHER_CONFIG" apiPort)"; fi
if [[ -z "$WEB_PORT" ]]; then WEB_PORT="$(read_value "$LAUNCHER_CONFIG" webPort)"; fi

TARGETS=()
for port in "$API_PORT" "$WEB_PORT"; do
  if [[ "$port" =~ ^[0-9]+$ ]] && (( port >= 1 && port <= 65535 )); then
    while IFS= read -r pid; do [[ -n "$pid" ]] && TARGETS+=("$pid"); done < <(/usr/sbin/lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true)
  fi
done
for pid in "$HOST_PID" "$WEB_PID"; do
  if [[ "$pid" =~ ^[0-9]+$ ]]; then TARGETS+=("$pid"); fi
done

UNIQUE_TARGETS="$(printf '%s\n' "${TARGETS[@]:-}" | awk 'NF && !seen[$0]++')"
while IFS= read -r pid; do
  [[ -z "$pid" ]] && continue
  if kill -0 "$pid" 2>/dev/null; then
    echo "停止进程 $pid"
    kill "$pid" 2>/dev/null || true
  fi
done <<<"$UNIQUE_TARGETS"

sleep 1
while IFS= read -r pid; do
  [[ -z "$pid" ]] && continue
  if kill -0 "$pid" 2>/dev/null; then kill -9 "$pid" 2>/dev/null || true; fi
done <<<"$UNIQUE_TARGETS"

rm -f "$RUNTIME_PATH"
echo "Codex Bridge 已停止。配对令牌和排队消息仍保留。"
