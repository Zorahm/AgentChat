#!/usr/bin/env bash
# Install AgentChat as a backend service on a Linux server (VDS/VPS).
#
# The server runs the backend; your PC, laptop and phone connect to it with a
# URL and a token (Settings → Paths → Server mode). Every shell command, file
# read and tool call the agent makes then happens HERE, on this machine, under
# the service user created below.
#
#   curl -fsSL <raw-url>/scripts/install-server.sh | sudo bash -s -- --domain chat.example.com
#   sudo bash scripts/install-server.sh --update
#
# Non-interactive by design (flags only, no prompts) so it also works unattended
# and inside a container image.
set -euo pipefail

REPO_URL="${AGENTCHAT_REPO:-https://github.com/Zorahm/AgentChat.git}"
BRANCH="master"
APP_DIR="/opt/agentchat"
DATA_DIR="/var/lib/agentchat"
ENV_FILE="/etc/agentchat/agentchat.env"
SERVICE_USER="agentchat"
PORT="8787"
DOMAIN=""
UPDATE_ONLY=0

usage() {
    cat <<'EOF'
Usage: install-server.sh [options]

  --domain <fqdn>   Serve over HTTPS on this domain via Caddy (Let's Encrypt).
                    Without it the backend listens on 0.0.0.0 over plain HTTP.
  --port <n>        Backend port (default 8787).
  --dir <path>      Install directory (default /opt/agentchat).
  --data-dir <path> Chats, settings and databases (default /var/lib/agentchat).
  --user <name>     Service user to create and run as (default agentchat).
  --branch <ref>    Git branch or tag to install (default master).
  --update          Pull, rebuild and restart an existing install.
  -h, --help        This message.
EOF
}

while [ $# -gt 0 ]; do
    case "$1" in
        --domain) DOMAIN="$2"; shift 2 ;;
        --port) PORT="$2"; shift 2 ;;
        --dir) APP_DIR="$2"; shift 2 ;;
        --data-dir) DATA_DIR="$2"; shift 2 ;;
        --user) SERVICE_USER="$2"; shift 2 ;;
        --branch) BRANCH="$2"; shift 2 ;;
        --update) UPDATE_ONLY=1; shift ;;
        -h|--help) usage; exit 0 ;;
        *) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
    esac
done

[ "$(id -u)" -eq 0 ] || { echo "Run as root (sudo)." >&2; exit 1; }

log() { printf '==> %s\n' "$*"; }
warn() { printf '!!  %s\n' "$*" >&2; }

# ---------------------------------------------------------------------------
# packages
# ---------------------------------------------------------------------------

install_packages() {
    # Node is needed to build ui/dist — the backend serves that build to remote
    # clients, and the phone/PWA has nothing to load without it.
    if command -v apt-get >/dev/null 2>&1; then
        export DEBIAN_FRONTEND=noninteractive
        apt-get update -qq
        apt-get install -y -qq git curl ca-certificates python3 python3-venv python3-dev \
            build-essential nodejs npm
    elif command -v dnf >/dev/null 2>&1; then
        dnf install -y -q git curl ca-certificates python3 python3-devel gcc nodejs npm
    elif command -v pacman >/dev/null 2>&1; then
        pacman -Sy --noconfirm --needed git curl ca-certificates python python-virtualenv \
            base-devel nodejs npm
    else
        echo "Unsupported package manager (need apt, dnf or pacman)." >&2
        echo "Install git, python3+venv and nodejs/npm by hand, then re-run." >&2
        exit 1
    fi
}

install_caddy() {
    if command -v caddy >/dev/null 2>&1; then
        return
    fi
    log "Installing Caddy for HTTPS on $DOMAIN..."
    if command -v apt-get >/dev/null 2>&1; then
        apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https
        curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
            | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
        curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
            > /etc/apt/sources.list.d/caddy-stable.list
        apt-get update -qq
        apt-get install -y -qq caddy
    elif command -v dnf >/dev/null 2>&1; then
        dnf install -y -q 'dnf-command(copr)'
        dnf copr enable -y @caddy/caddy
        dnf install -y -q caddy
    elif command -v pacman >/dev/null 2>&1; then
        pacman -S --noconfirm --needed caddy
    fi
}

# ---------------------------------------------------------------------------
# build
# ---------------------------------------------------------------------------

sync_source() {
    if [ -d "$APP_DIR/.git" ]; then
        log "Updating source in $APP_DIR ($BRANCH)..."
        git -C "$APP_DIR" fetch --depth 1 origin "$BRANCH"
        git -C "$APP_DIR" checkout -q -B "$BRANCH" "origin/$BRANCH"
    else
        log "Cloning $REPO_URL into $APP_DIR ($BRANCH)..."
        git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
    fi
}

build_backend() {
    log "Installing Python dependencies..."
    python3 -m venv "$APP_DIR/.venv"
    "$APP_DIR/.venv/bin/pip" install --quiet --upgrade pip
    "$APP_DIR/.venv/bin/pip" install --quiet -r "$APP_DIR/backend/requirements.txt"
}

build_ui() {
    log "Building the UI (this is what remote clients load)..."
    # `npm ci` needs the lockfile; fall back to install so a source tarball
    # without one still produces a usable build.
    if [ -f "$APP_DIR/ui/package-lock.json" ]; then
        (cd "$APP_DIR/ui" && npm ci --silent)
    else
        (cd "$APP_DIR/ui" && npm install --silent)
    fi
    (cd "$APP_DIR/ui" && npm run build)
    [ -f "$APP_DIR/ui/dist/index.html" ] || {
        echo "ui/dist/index.html missing after build — clients would get a blank page." >&2
        exit 1
    }
}

# ---------------------------------------------------------------------------
# service
# ---------------------------------------------------------------------------

ensure_user() {
    if ! id "$SERVICE_USER" >/dev/null 2>&1; then
        log "Creating service user $SERVICE_USER..."
        # Home is the data dir: the agent's per-chat working folders live under
        # ~/AgentChat/chats, and they belong with the rest of this install's state.
        useradd --system --create-home --home-dir "$DATA_DIR" --shell /bin/bash "$SERVICE_USER"
    fi
    mkdir -p "$DATA_DIR"
    chown -R "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR" "$APP_DIR"
}

write_env_file() {
    mkdir -p "$(dirname "$ENV_FILE")"
    if [ -f "$ENV_FILE" ]; then
        log "Keeping the existing token in $ENV_FILE"
        return
    fi
    log "Generating an access token..."
    local token
    token="$(head -c 32 /dev/urandom | base64 | tr -d '=+/' | cut -c1-43)"
    # 0600 from creation: this token is equivalent to shell access on this box.
    touch "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    cat >"$ENV_FILE" <<EOF
# AgentChat server configuration. This file holds a secret — keep it 0600.
AGENTCHAT_SERVER_MODE=1
AGENTCHAT_REMOTE_TOKEN=$token
AGENTCHAT_DATA_DIR=$DATA_DIR
AGENTCHAT_PORT=$PORT
# Behind Caddy the backend only needs loopback; without a domain it has to
# accept connections directly, so the installer sets 0.0.0.0 instead.
AGENTCHAT_HOST=$([ -n "$DOMAIN" ] && echo 127.0.0.1 || echo 0.0.0.0)
EOF
}

write_service() {
    log "Writing the systemd unit..."
    cat >/etc/systemd/system/agentchat.service <<EOF
[Unit]
Description=AgentChat backend
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$APP_DIR/backend
EnvironmentFile=$ENV_FILE
ExecStart=$APP_DIR/.venv/bin/python run.py
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    systemctl enable --now agentchat.service
}

write_caddyfile() {
    log "Configuring Caddy for $DOMAIN..."
    cat >/etc/caddy/Caddyfile <<EOF
$DOMAIN {
	reverse_proxy 127.0.0.1:$PORT
}
EOF
    systemctl enable --now caddy
    systemctl reload caddy || systemctl restart caddy
}

# ---------------------------------------------------------------------------
# run
# ---------------------------------------------------------------------------

if [ "$UPDATE_ONLY" -eq 1 ]; then
    [ -d "$APP_DIR/.git" ] || { echo "No install found at $APP_DIR." >&2; exit 1; }
    sync_source
    build_backend
    build_ui
    chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_DIR"
    systemctl restart agentchat.service
    log "Updated. systemctl status agentchat"
    exit 0
fi

install_packages
sync_source
build_backend
build_ui
ensure_user
write_env_file
write_service

if [ -n "$DOMAIN" ]; then
    install_caddy
    write_caddyfile
    BASE_URL="https://$DOMAIN"
else
    BASE_URL="http://$(hostname -I 2>/dev/null | awk '{print $1}'):$PORT"
fi

TOKEN="$(grep '^AGENTCHAT_REMOTE_TOKEN=' "$ENV_FILE" | cut -d= -f2-)"

echo
log "AgentChat is running."
echo
echo "  In the app: Settings → Paths → Server mode"
echo "    URL:   $BASE_URL"
echo "    Token: $TOKEN"
echo
if [ -z "$DOMAIN" ]; then
    warn "No domain given, so this is plain HTTP: the token and everything you"
    warn "type crosses the network in the clear. Re-run with --domain <fqdn> for"
    warn "automatic HTTPS, or reach the server over Tailscale / an SSH tunnel."
fi
echo "  Logs:  journalctl -u agentchat -f"
echo "  Token: $ENV_FILE"
