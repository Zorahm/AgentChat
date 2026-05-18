"""PyInstaller / direct-run entry point for the AgentChat backend."""
import multiprocessing

if __name__ == "__main__":
    # Required for PyInstaller --onefile on Windows to avoid recursive spawning
    multiprocessing.freeze_support()
    import uvicorn
    uvicorn.run("main:app", host="127.0.0.1", port=8787, log_level="warning")
