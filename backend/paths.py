"""Filesystem locations and process identity — the single source of truth for
where AgentChat keeps its data and who / where it is running.

Leaf module: depends only on the standard library, so both the app factory
(``main``) and the API route handlers can import it without any import cycle.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

# Build version — stamped into the frozen sidecar by scripts/build-backend.ps1
# from tauri.conf.json (the single version source). Lets the Tauri shell tell
# its own freshly-built backend apart from a leftover sidecar of a previous
# version still squatting on port 8787 after an update. Absent in dev/source.
try:
    from _buildstamp import BUILD_VERSION  # type: ignore[import-not-found]
except Exception:  # noqa: BLE001 — any failure just means "not a release build"
    BUILD_VERSION = "dev"


if getattr(sys, "frozen", False):
    # Running as a PyInstaller bundle — keep user data in APPDATA, not the temp
    # extraction dir.
    BASE_DIR = Path(sys.executable).parent
    AGENTS_DIR = Path(os.environ.get("APPDATA", Path.home())) / "AgentChat" / ".agents"
else:
    BASE_DIR = Path(__file__).resolve().parent
    AGENTS_DIR = BASE_DIR.parent / ".agents"

SETTINGS_FILE = AGENTS_DIR / "settings.json"
CHAT_DB_FILE = AGENTS_DIR / "agentchat.db"
PROJECT_DB_FILE = AGENTS_DIR / "projects.db"
# Cross-agent shared locations per the Agent Skills convention.
USER_AGENTS_DIR = Path.home() / ".agents"
USER_AGENTS_SKILLS_DIR = USER_AGENTS_DIR / "skills"
# Backwards-compatible name used by older code paths; always points at the
# canonical user-global skills directory, never at app-local/AppData storage.
AGENTS_SKILLS_DIR = USER_AGENTS_SKILLS_DIR

USER_NAME = os.environ.get("USER", os.environ.get("USERNAME", "")) or os.getlogin()
USER_HOME = os.path.expanduser("~")
WSL_USER_HOME = f"/home/{USER_NAME.lower()}" if USER_NAME else "/home/user"

# Web search backends. Tavily key enables the "litellm" local backend; the
# SearXNG URL (env or settings) enables the self-hosted backend.
TAVILY_API_KEY = os.environ.get("TAVILY_API_KEY") or None
SEARXNG_URL_ENV = os.environ.get("SEARXNG_URL") or None

# Tauri bundle identifier — keeps Local AppData/com.zorahm.agentchat off-limits
# to the model alongside the agents settings/db folder.
TAURI_LOCAL_DIR = Path(os.environ.get("LOCALAPPDATA", USER_HOME)) / "com.zorahm.agentchat"


def resolve_ui_dist() -> Path | None:
    """Locate the built UI (ui/dist) to serve to remote/phone clients.

    The installed app passes the bundled path via ``AGENTCHAT_UI_DIST``; in dev
    we fall back to the repo's ``ui/dist`` (present after ``npm run build``).
    Returns ``None`` when no built UI exists, in which case static serving is
    skipped (dev runs the UI from Vite, the desktop webview from its own bundle).
    """
    candidates: list[Path] = []
    env = os.environ.get("AGENTCHAT_UI_DIST")
    if env:
        candidates.append(Path(env))
    # PyInstaller --onefile extracts bundled data under sys._MEIPASS (see
    # build-backend.ps1: --add-data "...;ui_dist").
    meipass = getattr(sys, "_MEIPASS", None)
    if meipass:
        candidates.append(Path(meipass) / "ui_dist")
    candidates.append(BASE_DIR.parent / "ui" / "dist")
    for candidate in candidates:
        if (candidate / "index.html").is_file():
            return candidate
    return None


def _wsl_form(win_path: Path) -> str:
    """Translate ``C:\\foo\\bar`` to ``/mnt/c/foo/bar`` for WSL-side comparisons."""
    s = str(win_path)
    if len(s) >= 2 and s[1] == ":":
        drive = s[0].lower()
        rest = s[2:].replace("\\", "/").lstrip("/")
        return f"/mnt/{drive}/{rest}" if rest else f"/mnt/{drive}"
    return s


def get_blocked_read_prefixes() -> tuple[str, ...]:
    """Paths the model is forbidden to read in restricted mode.

    Both Windows and WSL-mount forms are returned so checks work whichever
    path style the model passes in.
    """
    blocks: list[str] = []
    for win in (AGENTS_DIR, TAURI_LOCAL_DIR):
        blocks.append(str(win))
        blocks.append(_wsl_form(win))
    return tuple(blocks)


def get_allowed_read_prefixes() -> tuple[str, ...]:
    """Paths the model may read even in restricted mode."""
    return (str(USER_AGENTS_DIR), _wsl_form(USER_AGENTS_DIR))
