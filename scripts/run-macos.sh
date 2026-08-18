#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export PATH
if [[ -x "$PROJECT_ROOT/runtime/node" ]]; then NODE="$PROJECT_ROOT/runtime/node"; else NODE="$(command -v node || true)"; fi
if [[ -z "$NODE" ]]; then
  echo "未找到 Node.js 22.13 或更高版本。" >&2
  exit 1
fi
exec "$NODE" "$PROJECT_ROOT/macos/supervisor.mjs" --project-root "$PROJECT_ROOT" "$@"
