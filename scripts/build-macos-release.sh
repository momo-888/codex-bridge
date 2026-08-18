#!/usr/bin/env bash
set -euo pipefail
umask 077

OUTPUT_DIRECTORY="${1:-}"
NODE_EXECUTABLE="${2:-}"
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -z "$OUTPUT_DIRECTORY" ]]; then OUTPUT_DIRECTORY="$PROJECT_ROOT/outputs/macos-release"; fi
if [[ "$OUTPUT_DIRECTORY" != /* ]]; then OUTPUT_DIRECTORY="$PROJECT_ROOT/$OUTPUT_DIRECTORY"; fi
if [[ -z "$NODE_EXECUTABLE" ]]; then NODE_EXECUTABLE="$(command -v node || true)"; fi
if [[ -z "$NODE_EXECUTABLE" || ! -x "$NODE_EXECUTABLE" ]]; then
  echo "未找到可执行的 Node.js。" >&2
  exit 1
fi

WORK_ROOT="$OUTPUT_DIRECTORY/work"
PAYLOAD_ROOT="$WORK_ROOT/CodexBridge"
ARCHIVE_PATH="$OUTPUT_DIRECTORY/CodexBridge-macOS-$(uname -m).zip"
if [[ "$WORK_ROOT" == "/" || "$WORK_ROOT" == "$HOME" || "$WORK_ROOT" == "$PROJECT_ROOT" ]]; then
  echo "拒绝使用不安全的工作目录：$WORK_ROOT" >&2
  exit 1
fi
rm -rf "$WORK_ROOT"
mkdir -p "$PAYLOAD_ROOT/runtime" "$PAYLOAD_ROOT/node_modules"

(cd "$PROJECT_ROOT" && npm run build)

copy_tree() {
  local source="$1"
  local destination="$2"
  if [[ ! -e "$source" ]]; then echo "缺少发布文件：$source" >&2; exit 1; fi
  mkdir -p "$(dirname "$destination")"
  /usr/bin/ditto "$source" "$destination"
}

copy_tree "$PROJECT_ROOT/dist" "$PAYLOAD_ROOT/dist"
copy_tree "$PROJECT_ROOT/scripts" "$PAYLOAD_ROOT/scripts"
copy_tree "$PROJECT_ROOT/macos" "$PAYLOAD_ROOT/macos"
for file in LICENSE NOTICE README.md package.json; do cp "$PROJECT_ROOT/$file" "$PAYLOAD_ROOT/$file"; done

ESBUILD="$PROJECT_ROOT/node_modules/.bin/esbuild"
"$ESBUILD" "$PROJECT_ROOT/host/server.ts" --bundle --platform=node --format=esm --target=node22 \
  --external:qrcode --external:ws --external:sharp \
  --outfile="$PAYLOAD_ROOT/runtime/host-server.mjs"
"$ESBUILD" "$PROJECT_ROOT/scripts/packaged-web-server.ts" --bundle --platform=node --format=esm --target=node22 \
  --external:sharp --outfile="$PAYLOAD_ROOT/runtime/web-server.mjs"

DEPENDENCIES=(
  qrcode dijkstrajs pngjs ws react react-dom scheduler ipaddr.js
  sharp detect-libc semver @img/colour @img/sharp-wasm32
)
case "$(uname -m)" in
  arm64)
    DEPENDENCIES+=("@img/sharp-darwin-arm64" "@img/sharp-libvips-darwin-arm64")
    ;;
  x86_64)
    DEPENDENCIES+=("@img/sharp-darwin-x64" "@img/sharp-libvips-darwin-x64")
    ;;
  *)
    echo "暂不支持的 macOS 架构：$(uname -m)" >&2
    exit 1
    ;;
esac
for dependency in "${DEPENDENCIES[@]}"; do
  copy_tree "$PROJECT_ROOT/node_modules/$dependency" "$PAYLOAD_ROOT/node_modules/$dependency"
done

cp "$NODE_EXECUTABLE" "$PAYLOAD_ROOT/runtime/node"
chmod +x "$PAYLOAD_ROOT/runtime/node" "$PAYLOAD_ROOT/scripts/"*.sh "$PAYLOAD_ROOT/macos/supervisor.mjs"

VERSION="$($NODE_EXECUTABLE -p 'require(process.argv[1]).version' "$PROJECT_ROOT/package.json")"
"$NODE_EXECUTABLE" -e '
const fs = require("fs");
const [target, version, nodeVersion, architecture] = process.argv.slice(1);
fs.writeFileSync(target, JSON.stringify({ product: "Codex Bridge", platform: "macOS", version, nodeVersion, architecture, builtAt: new Date().toISOString() }, null, 2) + "\n");
' "$PAYLOAD_ROOT/release.json" "$VERSION" "$($NODE_EXECUTABLE --version)" "$(uname -m)"

mkdir -p "$OUTPUT_DIRECTORY"
rm -f "$ARCHIVE_PATH"
COPYFILE_DISABLE=1 /usr/bin/ditto -c -k --keepParent "$PAYLOAD_ROOT" "$ARCHIVE_PATH"
ARCHIVE_NAME="$(basename "$ARCHIVE_PATH")"
ARCHIVE_HASH="$(/usr/bin/shasum -a 256 "$ARCHIVE_PATH" | awk '{ print tolower($1) }')"
echo "$ARCHIVE_HASH  $ARCHIVE_NAME" >"$OUTPUT_DIRECTORY/SHA256SUMS-macos.txt"
rm -rf "$WORK_ROOT"
echo "macOS 发布包已生成："
echo "$ARCHIVE_PATH"
