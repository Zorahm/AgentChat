#!/usr/bin/env bash
# Build the Python backend into a single ELF sidecar for Tauri (Linux).
# Output: src-tauri/binaries/agentchat-backend-x86_64-unknown-linux-gnu
#
# Linux counterpart of scripts/build-backend.ps1 — same PyInstaller flags, but
# POSIX --add-data uses ':' (not ';') as the src:dest separator and the output
# is renamed to the Linux Tauri target triple.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="$ROOT/src-tauri/binaries"

echo "==> Installing build dependencies..."
pip install pyinstaller --quiet

echo "==> Pre-downloading tiktoken encoding files..."
TIKTOKEN_CACHE="$ROOT/build/tiktoken-cache"
rm -rf "$TIKTOKEN_CACHE"
mkdir -p "$TIKTOKEN_CACHE"
export TIKTOKEN_CACHE_DIR="$TIKTOKEN_CACHE"
python -c "import tiktoken; [tiktoken.get_encoding(e) for e in ('cl100k_base','p50k_base','r50k_base','o200k_base')]"
echo "==> tiktoken cache: $TIKTOKEN_CACHE"

echo "==> Ensuring built UI (ui/dist) to bundle for remote/phone serving..."
UI_DIST="$ROOT/ui/dist"
if [ ! -f "$UI_DIST/index.html" ]; then
    echo "    ui/dist missing — running 'npm run build'..."
    (cd "$ROOT/ui" && npm run build)
fi
if [ ! -f "$UI_DIST/index.html" ]; then
    echo "ui/dist/index.html not found after build — cannot bundle UI into backend." >&2
    exit 1
fi

echo "==> Stamping build version (single source: tauri.conf.json)..."
# main.py imports _buildstamp so PyInstaller bundles it; the Tauri shell compares
# it against /api/health to detect a stale sidecar on 8787 after an update.
VER="$(python -c "import json,sys; print(json.load(open('$ROOT/src-tauri/tauri.conf.json'))['version'])")"
printf 'BUILD_VERSION = "%s"\n' "$VER" > "$ROOT/backend/_buildstamp.py"
echo "    BUILD_VERSION = $VER"

echo "==> Running PyInstaller..."
cd "$ROOT/backend"
pyinstaller run.py \
    --onefile \
    --name agentchat-backend \
    --distpath "$ROOT/src-tauri/binaries" \
    --workpath "$ROOT/build/pyinstaller-work" \
    --specpath "$ROOT/build/pyinstaller-spec" \
    --noconfirm \
    --collect-all litellm \
    --collect-all tiktoken \
    --collect-all tiktoken_ext \
    --collect-all watchdog \
    --collect-data certifi \
    --hidden-import uvicorn.logging \
    --hidden-import uvicorn.loops \
    --hidden-import uvicorn.loops.auto \
    --hidden-import uvicorn.protocols \
    --hidden-import uvicorn.protocols.http \
    --hidden-import uvicorn.protocols.http.auto \
    --hidden-import uvicorn.lifespan \
    --hidden-import uvicorn.lifespan.on \
    --hidden-import uvicorn.lifespan.off \
    --hidden-import anyio._backends._asyncio \
    --hidden-import python_multipart \
    --add-data "${TIKTOKEN_CACHE}:tiktoken_cache" \
    --add-data "${UI_DIST}:ui_dist"

cd "$ROOT"

echo "==> Renaming to Tauri target triple..."
SRC="$BIN_DIR/agentchat-backend"
DST="$BIN_DIR/agentchat-backend-x86_64-unknown-linux-gnu"
rm -f "$DST"
mv "$SRC" "$DST"
chmod +x "$DST"

echo "==> Done: $DST"
