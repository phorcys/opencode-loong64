#!/usr/bin/env bash
# loong64 native dependencies setup for opencode builds on LoongArch64.
#
# The vite build for the embedded web UI runs under system node (v24) and
# resolves native packages through bun's isolated cache-link layout, which
# misses loong64 bindings. This script installs the missing packages and
# links them into the cache-link scopes so node resolution works.
#
# Run from the repo root:  bash script/loong64-setup.sh
#
# IMPORTANT: build the opencode binary with the source-built bun 1.4.x from
# ~/work/src/bun/build/release-la64v10/bun. The 1.3.14-canary bun that ships in
# ~/.bun/bin crashes the TUI on loong64 (JSC worker-thread segfault in opentui
# 0.4.5); 1.4.0 (loong64: update WebKit prebuilt) fixes it.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

export PATH="$HOME/.bun/bin:$PATH"

# Cross-platform installs (bun skips these on loong64 due to os/cpu fields)
bun install --os="*" --cpu="*" @opentui/core@$(node -p "require('./packages/opencode/package.json').dependencies['@opentui/core']" 2>/dev/null || echo catalog:) || true
bun install --os="*" --cpu="*" @parcel/watcher@$(node -p "require('./packages/opencode/package.json').dependencies['@parcel/watcher']") 2>/dev/null || true
bun install --os="*" --cpu="*" @ff-labs/fff-bun@$(node -p "require('./packages/opencode/package.json').dependencies['@ff-labs/fff-bun']") || true
bun install --os="*" --cpu="*" @esbuild/linux-loong64@0.25.12 || true
bun install --os="*" --cpu="*" @tailwindcss/oxide-wasm32-wasi@4.1.11 || true

# bun refuses to place oxide-wasm32-wasi (cpu wasm32); install it manually.
if [ ! -d node_modules/@tailwindcss/oxide-wasm32-wasi ]; then
  mkdir -p /tmp/oxide-wasm
  curl -sL -o /tmp/oxide-wasm/pkg.tgz https://registry.npmjs.org/@tailwindcss/oxide-wasm32-wasi/-/oxide-wasm32-wasi-4.1.11.tgz
  tar -xzf /tmp/oxide-wasm/pkg.tgz -C /tmp/oxide-wasm
  mkdir -p node_modules/@tailwindcss/oxide-wasm32-wasi
  cp -r /tmp/oxide-wasm/package/* node_modules/@tailwindcss/oxide-wasm32-wasi/
fi

# Link native packages into the cache-link scopes so real-node resolution works.
for d in "$HOME"/.bun/install/cache/links/rollup@4.60.4-*/; do
  [ -d "$d" ] || continue
  mkdir -p "$d/node_modules/@rollup"
  ln -sfn "$ROOT/node_modules/@rollup/rollup-linux-loong64-gnu" "$d/node_modules/@rollup/rollup-linux-loong64-gnu"
done
for d in "$HOME"/.bun/install/cache/links/@tailwindcss+oxide@4.1.11-*/; do
  [ -d "$d" ] || continue
  mkdir -p "$d/node_modules/@tailwindcss"
  ln -sfn "$ROOT/node_modules/@tailwindcss/oxide-wasm32-wasi" "$d/node_modules/@tailwindcss/oxide-wasm32-wasi"
done

echo "loong64 native dependencies ready."
