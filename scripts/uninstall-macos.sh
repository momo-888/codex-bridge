#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.codexbridge.macos"
PLIST_PATH="$HOME/Library/LaunchAgents/$LABEL.plist"
PID_PATH="$HOME/.codex-bridge/macos-supervisor.pid"
DOMAIN="gui/$(id -u)"

/bin/launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
rm -f "$PLIST_PATH"

if [[ -f "$PID_PATH" ]]; then
  SUPERVISOR_PID="$(tr -cd '0-9' <"$PID_PATH")"
  if [[ -n "$SUPERVISOR_PID" ]] && kill -0 "$SUPERVISOR_PID" 2>/dev/null; then
    SUPERVISOR_COMMAND="$(ps -p "$SUPERVISOR_PID" -o command= 2>/dev/null || true)"
    if [[ "$SUPERVISOR_COMMAND" == *"macos/supervisor.mjs"* ]]; then kill "$SUPERVISOR_PID" 2>/dev/null || true; fi
  fi
fi
rm -f "$PID_PATH"
/bin/bash "$PROJECT_ROOT/scripts/stop-codex-bridge.sh"
echo "macOS 管理服务和登录启动项已移除。项目文件、Codex 历史和配对令牌没有删除。"
