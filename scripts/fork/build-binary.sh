#!/usr/bin/env bash
# Fork-only: build the UI (single-file + code-split) and compile the CLI.
#
#   scripts/fork/build-binary.sh                 # -> dist/plannotator-fork (this machine's platform)
#   scripts/fork/build-binary.sh --target bun-linux-x64-baseline --out dist/plannotator-linux
#   scripts/fork/build-binary.sh --install user@host   # also scp to host:~/.local/bin/plannotator-fork
set -euo pipefail

cd "$(dirname "$0")/../.."

TARGET=""
OUT="dist/plannotator-fork"
INSTALL_HOST=""
while [ $# -gt 0 ]; do
  case "$1" in
    --target) TARGET="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --install) INSTALL_HOST="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

# bun 1.3.12 produced macOS binaries that are SIGKILLed on launch (#541);
# release builds use >= 1.3.14.
BUN_VERSION="$(bun --version)"
if [ "$(printf '%s\n1.3.14\n' "$BUN_VERSION" | sort -V | head -1)" != "1.3.14" ]; then
  echo "bun $BUN_VERSION is older than 1.3.14; run 'bun upgrade' first." >&2
  exit 1
fi

VERSION="$(node -p "require('./package.json').version" 2>/dev/null || bun -e "console.log(require('./package.json').version)")"
FORK_VERSION="${VERSION}-fork.$(git rev-parse --short HEAD)"

bun install --frozen-lockfile >/dev/null
bun run --cwd apps/review build
bun run build:hook

mkdir -p "$(dirname "$OUT")"
bun build apps/hook/server/index.ts --compile --no-compile-autoload-bunfig \
  ${TARGET:+--target="$TARGET"} \
  --define "__CLI_VERSION__=\"$FORK_VERSION\"" \
  --outfile "$OUT"
echo "built $OUT ($FORK_VERSION)"

if [ -n "$INSTALL_HOST" ]; then
  ssh "$INSTALL_HOST" 'mkdir -p ~/.local/bin'
  # Copy to a temp name and rename, so a running session never sees a half-written binary.
  scp "$OUT" "$INSTALL_HOST:.local/bin/plannotator-fork.new"
  ssh "$INSTALL_HOST" 'chmod +x ~/.local/bin/plannotator-fork.new && mv ~/.local/bin/plannotator-fork.new ~/.local/bin/plannotator-fork && ~/.local/bin/plannotator-fork --version'
fi
