#!/bin/bash
# Build: compile src/ → lib/. Dual-layout: monorepo checkout (vendor/, packages/) or npm install layout (node_modules/@deepseek-ai/).
# Adapted from dsh-context-imports proven build.sh (skillmcp-gate).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

CHECKOUT="${DSH_CHECKOUT:-}"
if [ -z "$CHECKOUT" ]; then
  for candidate in "$HOME/dsh-harness" "$HOME/dsh" "$HOME/.dsh/dsh-harness"; do
    if [ -d "$candidate/node_modules/@deepseek-ai" ]; then CHECKOUT="$candidate"; break; fi
  done
fi
if [ -z "$CHECKOUT" ]; then
  for candidate in "$HOME/dsh-harness" "$HOME/dsh" "$HOME/.dsh/dsh-harness"; do
    if [ -d "$candidate/packages" ]; then CHECKOUT="$candidate"; break; fi
  done
fi
if [ -z "$CHECKOUT" ]; then
  echo "build: cannot locate the dsh checkout (set DSH_CHECKOUT)" >&2
  exit 1
fi
echo "=== checkout: $CHECKOUT ==="

TSC="./node_modules/.bin/tsc"
if [ ! -x "$TSC" ] && [ ! -f "$TSC.cmd" ]; then TSC="$CHECKOUT/node_modules/.bin/tsc"; fi
if [ ! -x "$TSC" ] && [ ! -f "$TSC.cmd" ]; then
  echo "build: tsc not found (npm install here, or a checkout with typescript)" >&2
  exit 1
fi

link_pkg() {
  local name="$1"; shift
  local target=""
  for cand in "$@"; do
    if [ -e "$CHECKOUT/$cand" ]; then target="$CHECKOUT/$cand"; break; fi
  done
  if [ -z "$target" ]; then
    echo "build: dependency target missing for $name (tried: $*)" >&2
    exit 1
  fi
  node -e "
    const fs = require('fs');
    const path = require('path');
    const link = path.resolve(process.argv[1]);
    const target = path.resolve(process.argv[2]);
    fs.rmSync(link, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  " "node_modules/$name" "$target"
}

echo "=== Linking build dependencies ==="
mkdir -p node_modules/@deepseek-ai
link_pkg @deepseek-ai/cordis vendor/cordis node_modules/@deepseek-ai/cordis
link_pkg @deepseek-ai/schemastery vendor/schemastery node_modules/@deepseek-ai/schemastery
link_pkg @deepseek-ai/dsh-llm packages/llm/llm node_modules/@deepseek-ai/dsh-llm
link_pkg @deepseek-ai/dsh-tools packages/core/tools node_modules/@deepseek-ai/dsh-tools
link_pkg @deepseek-ai/dsh-system-prompt packages/core/system-prompt node_modules/@deepseek-ai/dsh-system-prompt
link_pkg @types/node node_modules/@types/node

echo "=== Compiling src → lib (tsc $("$TSC" --version)) ==="
"$TSC" -p tsconfig.json

echo "=== Build complete ==="
ls -la lib/ lib/types/ 2>/dev/null || true
