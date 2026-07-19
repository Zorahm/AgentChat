#!/usr/bin/env bash
#
# Build Android APK via Tauri
# Linux / macOS
#
# Requirements:
#   - Android SDK
#   - Android NDK r26+
#   - JDK 17/21
#   - Rust Android target:
#       rustup target add aarch64-linux-android
#
# Output:
#   src-tauri/gen/android/app/build/outputs/apk/
#

set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_TAURI="$ROOT/src-tauri"


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


# ── java ─────────────────────────────────────────────────────────────

setup_java() {
    section "Checking Java"

    if [[ -z "${JAVA_HOME:-}" ]]; then
        if command -v java >/dev/null 2>&1; then
            JAVA_HOME="$(
                java -XshowSettings:properties -version 2>&1 |
                grep "java.home" |
                awk '{print $3}'
            )"
        fi
    fi

    if [[ -z "${JAVA_HOME:-}" ]]; then
        error "JAVA_HOME not found"
        echo "Install JDK and configure JAVA_HOME"
        exit 1
    fi

    export JAVA_HOME
    export PATH="$JAVA_HOME/bin:$PATH"

    ok "JAVA_HOME:"
    echo "    $JAVA_HOME"
}


# ── android sdk ──────────────────────────────────────────────────────

setup_android() {
    section "Checking Android SDK"

    if [[ -z "${ANDROID_HOME:-}" &&
          -z "${ANDROID_SDK_ROOT:-}" ]]; then

        for path in \
            "$HOME/Android/Sdk" \
            "$HOME/Library/Android/sdk"
        do
            if [[ -d "$path" ]]; then
                ANDROID_HOME="$path"
                break
            fi
        done
    fi

    ANDROID_HOME="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"

    if [[ -z "$ANDROID_HOME" ]]; then
        error "Android SDK not found"
        exit 1
    fi

    export ANDROID_HOME
    export ANDROID_SDK_ROOT="$ANDROID_HOME"

    ok "ANDROID_HOME:"
    echo "    $ANDROID_HOME"
}


# ── ndk ──────────────────────────────────────────────────────────────

setup_ndk() {
    section "Checking Android NDK"

    local ndk_dir="$ANDROID_HOME/ndk"
    local version=""
    local current=""

    if [[ ! -d "$ndk_dir" ]]; then
        warn "NDK directory not found: $ndk_dir"
        return 0
    fi

    for dir in "$ndk_dir"/*; do
        [[ -f "$dir/source.properties" ]] || continue

        current="$(basename "$dir")"

        if [[ -z "$version" || "$current" > "$version" ]]; then
            version="$current"
        fi
    done

    if [[ -z "$version" ]]; then
        warn "No valid NDK installation found"
        return 0
    fi

    export NDK_HOME="$ndk_dir/$version"
    export ANDROID_NDK_HOME="$NDK_HOME"
    export ANDROID_NDK_ROOT="$NDK_HOME"

    ok "NDK:"
    echo "    $NDK_HOME"
}


# ── build ────────────────────────────────────────────────────────────

build_apk() {
    section "Building Android APK"

    [[ -d "$SRC_TAURI" ]] || {
        error "src-tauri directory missing"
        exit 1
    }

    cd "$SRC_TAURI"

    info "Running:"
    echo "cargo tauri android build --apk --debug --target aarch64"
    echo ""

    cargo tauri android build \
        --apk \
        --debug \
        --target aarch64
}


# ── output ───────────────────────────────────────────────────────────

show_output() {
    section "APK output"

    local apk_dir="$SRC_TAURI/gen/android/app/build/outputs/apk"

    if [[ ! -d "$apk_dir" ]]; then
        warn "APK directory not found"
        return 0
    fi

    find "$apk_dir" \
        -name "*.apk" \
        -exec ls -lh {} \;
}


# ── main ─────────────────────────────────────────────────────────────

echo ""
echo "╔══════════════════════════════════════╗"
echo "║        Tauri Android Builder          ║"
echo "║        Linux / macOS                  ║"
echo "╚══════════════════════════════════════╝"

ok "Project:"
echo "    $ROOT"


setup_java
setup_android
setup_ndk

# Capture the build result without letting `set -e` abort before the banner.
RESULT=0
build_apk || RESULT=$?

show_output


echo ""

if [[ $RESULT -eq 0 ]]; then
    printf "${GREEN}"
    echo "╔══════════════════════════════════════╗"
    echo "║          BUILD SUCCESS                ║"
    echo "╚══════════════════════════════════════╝"
    printf "${RESET}"
else
    printf "${RED}"
    echo "╔══════════════════════════════════════╗"
    echo "║          BUILD FAILED                 ║"
    echo "╚══════════════════════════════════════╝"
    printf "${RESET}"
fi

echo "Exit code: $RESULT"

exit "$RESULT"