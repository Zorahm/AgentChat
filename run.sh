#!/usr/bin/env bash
#
# AgentChat Launcher
# Linux / macOS
#

set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── colors ───────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
RESET='\033[0m'

info() {
    printf "${CYAN}[→]${RESET} %s\n" "$*"
}

ok() {
    printf "${GREEN}[✓]${RESET} %s\n" "$*"
}

warn() {
    printf "${YELLOW}[!]${RESET} %s\n" "$*"
}

error() {
    printf "${RED}[✗]${RESET} %s\n" "$*" >&2
}

section() {
    echo ""
    printf "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}\n"
    echo " $1"
    printf "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}\n"
    echo ""
}


# ── backend ──────────────────────────────────────────────────────────

init_backend() {
    cd "$ROOT/backend"

    if [[ -d ".venv" ]]; then
        ok "Virtual environment found"
        source .venv/bin/activate
        return 0
    fi

    info "Creating virtual environment..."

    python3 -m venv .venv || python -m venv .venv || {
        error "Failed to create venv"
        return 1
    }

    source .venv/bin/activate

    info "Installing dependencies..."

    python -m pip install --upgrade pip
    pip install -r requirements.txt || {
        error "Failed installing requirements"
        return 1
    }

    ok "Backend ready"
}


# ── frontend ──────────────────────────────────────────────────────────

init_ui() {
    cd "$ROOT/ui"

    if [[ -d "node_modules" ]]; then
        ok "UI dependencies found"
        return 0
    fi

    info "Installing UI dependencies..."

    npm install || {
        error "npm install failed"
        return 1
    }

    ok "UI ready"
}


# ── runners ──────────────────────────────────────────────────────────

run_backend() {
    cd "$ROOT/backend"
    source .venv/bin/activate

    info "Backend → http://127.0.0.1:8787"

    python -m uvicorn main:app \
        --host 127.0.0.1 \
        --port 8787 \
        --reload
}


run_ui() {
    cd "$ROOT/ui"

    info "UI → http://localhost:5173"

    npm run dev
}


open_backend() {
    CMD="
        cd '$ROOT/backend' &&
        source .venv/bin/activate &&
        python -m uvicorn main:app --host 127.0.0.1 --port 8787 --reload
    "

    if command -v gnome-terminal >/dev/null; then
        gnome-terminal -- bash -c "$CMD; exec bash" &
    elif command -v kitty >/dev/null; then
        kitty bash -c "$CMD; exec bash" &
    elif command -v alacritty >/dev/null; then
        alacritty -e bash -c "$CMD; exec bash" &
    elif command -v xterm >/dev/null; then
        xterm -e bash -c "$CMD; exec bash" &
    else
        warn "No terminal found, running backend in background"
        (run_backend &) 
    fi
}


# ── menu ──────────────────────────────────────────────────────────────

echo ""
echo "╔══════════════════════════════════════╗"
echo "║          AgentChat Launcher           ║"
echo "╚══════════════════════════════════════╝"

section "Choose mode"

echo "1) Backend only"
echo "2) UI only"
echo "3) Backend + UI"
echo "4) Tauri desktop"
echo ""

read -rp "Choice [1-4]: " choice


case "$choice" in
    1)
        init_backend || exit 1
        run_backend
        ;;

    2)
        init_ui || exit 1
        run_ui
        ;;

    3)
        init_backend || exit 1
        init_ui || exit 1

        open_backend
        sleep 2
        run_ui
        ;;

    4)
        cd "$ROOT/src-tauri"
        cargo tauri dev
        ;;

    *)
        error "Invalid choice"
        exit 1
        ;;
esac