#!/usr/bin/env bash
set -euo pipefail
umask 077

NO_START=0
IN_PLACE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-start) NO_START=1; shift ;;
    --in-place) IN_PLACE=1; shift ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "此安装脚本只能在 macOS 上运行。" >&2
  exit 1
fi

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export PATH
if [[ -x "$PROJECT_ROOT/runtime/node" ]]; then NODE="$PROJECT_ROOT/runtime/node"; else NODE="$(command -v node || true)"; fi
if [[ -z "$NODE" ]]; then
  echo "未找到 Node.js 22.13 或更高版本。" >&2
  exit 1
fi

if [[ -f "$PROJECT_ROOT/runtime/host-server.mjs" && "$IN_PLACE" -eq 0 ]]; then
  INSTALL_ROOT="$HOME/Applications/CodexBridge"
  mkdir -p "$INSTALL_ROOT"
  /usr/bin/ditto "$PROJECT_ROOT" "$INSTALL_ROOT"
  INSTALL_ARGUMENTS=(--in-place)
  if [[ "$NO_START" -eq 1 ]]; then INSTALL_ARGUMENTS+=(--no-start); fi
  exec /bin/bash "$INSTALL_ROOT/scripts/install-macos.sh" "${INSTALL_ARGUMENTS[@]}"
fi

if [[ ! -f "$PROJECT_ROOT/runtime/host-server.mjs" ]]; then
  NPM="$(command -v npm || true)"
  if [[ -z "$NPM" ]]; then echo "源码安装需要 npm。" >&2; exit 1; fi
  (cd "$PROJECT_ROOT" && "$NPM" ci && "$NPM" run typecheck && "$NPM" run build)
fi

chmod +x \
  "$PROJECT_ROOT/scripts/start-codex-bridge.sh" \
  "$PROJECT_ROOT/scripts/stop-codex-bridge.sh" \
  "$PROJECT_ROOT/scripts/run-host.sh" \
  "$PROJECT_ROOT/scripts/run-web.sh" \
  "$PROJECT_ROOT/scripts/run-macos.sh" \
  "$PROJECT_ROOT/macos/supervisor.mjs"

CONFIG_DIRECTORY="$HOME/.codex-bridge"
PID_PATH="$CONFIG_DIRECTORY/macos-supervisor.pid"
mkdir -p "$CONFIG_DIRECTORY" "$HOME/Library/LaunchAgents"
chmod 700 "$CONFIG_DIRECTORY"

if [[ -f "$PID_PATH" ]]; then
  PREVIOUS_PID="$(tr -cd '0-9' <"$PID_PATH")"
  if [[ -n "$PREVIOUS_PID" ]] && kill -0 "$PREVIOUS_PID" 2>/dev/null; then
    PREVIOUS_COMMAND="$(ps -p "$PREVIOUS_PID" -o command= 2>/dev/null || true)"
    if [[ "$PREVIOUS_COMMAND" == *"macos/supervisor.mjs"* ]]; then
      kill "$PREVIOUS_PID" 2>/dev/null || true
      sleep 1
    fi
  fi
fi

LABEL="com.codexbridge.macos"
PLIST_PATH="$HOME/Library/LaunchAgents/$LABEL.plist"
TEMPORARY_PLIST="$PLIST_PATH.tmp-$$"
/usr/bin/plutil -create xml1 "$TEMPORARY_PLIST"
/usr/libexec/PlistBuddy -c "Add :Label string $LABEL" "$TEMPORARY_PLIST"
/usr/libexec/PlistBuddy -c "Add :ProgramArguments array" "$TEMPORARY_PLIST"
/usr/libexec/PlistBuddy -c "Add :ProgramArguments:0 string $NODE" "$TEMPORARY_PLIST"
/usr/libexec/PlistBuddy -c "Add :ProgramArguments:1 string $PROJECT_ROOT/macos/supervisor.mjs" "$TEMPORARY_PLIST"
/usr/libexec/PlistBuddy -c "Add :ProgramArguments:2 string --project-root" "$TEMPORARY_PLIST"
/usr/libexec/PlistBuddy -c "Add :ProgramArguments:3 string $PROJECT_ROOT" "$TEMPORARY_PLIST"
/usr/libexec/PlistBuddy -c "Add :ProgramArguments:4 string --no-browser" "$TEMPORARY_PLIST"
/usr/libexec/PlistBuddy -c "Add :WorkingDirectory string $PROJECT_ROOT" "$TEMPORARY_PLIST"
/usr/libexec/PlistBuddy -c "Add :RunAtLoad bool true" "$TEMPORARY_PLIST"
/usr/libexec/PlistBuddy -c "Add :KeepAlive bool true" "$TEMPORARY_PLIST"
/usr/libexec/PlistBuddy -c "Add :ProcessType string Interactive" "$TEMPORARY_PLIST"
/usr/libexec/PlistBuddy -c "Add :LimitLoadToSessionType string Aqua" "$TEMPORARY_PLIST"
/usr/libexec/PlistBuddy -c "Add :StandardOutPath string $CONFIG_DIRECTORY/launch-agent.out.log" "$TEMPORARY_PLIST"
/usr/libexec/PlistBuddy -c "Add :StandardErrorPath string $CONFIG_DIRECTORY/launch-agent.err.log" "$TEMPORARY_PLIST"
/usr/libexec/PlistBuddy -c "Add :EnvironmentVariables dict" "$TEMPORARY_PLIST"
/usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:PATH string $PATH" "$TEMPORARY_PLIST"
/bin/mv "$TEMPORARY_PLIST" "$PLIST_PATH"
chmod 600 "$PLIST_PATH"

DOMAIN="gui/$(id -u)"
/bin/launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
if [[ "$NO_START" -eq 0 ]]; then
  /bin/launchctl bootstrap "$DOMAIN" "$PLIST_PATH"
  /bin/launchctl enable "$DOMAIN/$LABEL"
  sleep 2
  /usr/bin/open "http://127.0.0.1:43109/"
  echo "Codex Bridge macOS 管理服务已启动。"
fi
echo "已安装当前用户的登录启动项：$PLIST_PATH"
