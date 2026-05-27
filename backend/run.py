"""PyInstaller / direct-run entry point for the AgentChat backend."""
import multiprocessing
import os
import sys
import traceback
from pathlib import Path

# Point tiktoken to bundled encoding files before any imports touch it
if getattr(sys, "frozen", False):
    _tiktoken_cache = os.path.join(sys._MEIPASS, "tiktoken_cache")  # type: ignore[attr-defined]
    os.environ.setdefault("TIKTOKEN_CACHE_DIR", _tiktoken_cache)


def _crash_log_path() -> Path:
    base = os.environ.get("APPDATA") or os.path.expanduser("~")
    log_dir = Path(base) / "AgentChat"
    log_dir.mkdir(parents=True, exist_ok=True)
    return log_dir / "backend-error.log"


def _log_crash(exc: BaseException) -> None:
    try:
        with _crash_log_path().open("a", encoding="utf-8") as fp:
            import datetime
            fp.write(f"\n--- {datetime.datetime.now().isoformat()} ---\n")
            fp.write(f"frozen={getattr(sys, 'frozen', False)} executable={sys.executable}\n")
            fp.write("".join(traceback.format_exception(type(exc), exc, exc.__traceback__)))
    except Exception:
        pass


if __name__ == "__main__":
    multiprocessing.freeze_support()
    try:
        import uvicorn
        from main import app

        # Bind to all interfaces only when remote access is enabled, so the
        # backend stays localhost-only by default. AGENTCHAT_HOST overrides.
        host = os.environ.get("AGENTCHAT_HOST")
        if not host:
            store = getattr(app.state, "settings_store", None)
            host = "0.0.0.0" if (store and store.remote_access_enabled) else "127.0.0.1"
        port = int(os.environ.get("AGENTCHAT_PORT", "8787"))
        uvicorn.run(app, host=host, port=port, log_level="warning")
    except BaseException as exc:
        _log_crash(exc)
        traceback.print_exc()
        sys.exit(1)
