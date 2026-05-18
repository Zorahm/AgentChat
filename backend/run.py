"""PyInstaller / direct-run entry point for the AgentChat backend."""
import multiprocessing
import os
import sys

# Point tiktoken to bundled encoding files before any imports touch it
if getattr(sys, "frozen", False):
    _tiktoken_cache = os.path.join(sys._MEIPASS, "tiktoken_cache")  # type: ignore[attr-defined]
    os.environ.setdefault("TIKTOKEN_CACHE_DIR", _tiktoken_cache)

if __name__ == "__main__":
    # Required for PyInstaller --onefile on Windows to avoid recursive spawning
    multiprocessing.freeze_support()
    import uvicorn
    from main import app  # import object directly — string import fails in frozen exe
    uvicorn.run(app, host="127.0.0.1", port=8787, log_level="warning")
