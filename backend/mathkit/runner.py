"""Parent side of the math worker: a small pool of warm child processes.

One worker per concurrent math call, kept alive between calls. The pool exists
because of two facts pulling in opposite directions: sympy costs seconds to
import (so spawning per call is out), and a pathological simplification cannot
be interrupted (so running it in-process is out). A warm, killable child settles
both.

A timeout is handled by *killing and replacing* the worker rather than waiting
for it. A process that blew its budget is, by definition, stuck in something
that does not check for cancellation — asking it nicely is how a single bad
expression wedges the pool for the rest of the session.
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import threading
import uuid
from collections import deque
from pathlib import Path
from typing import Any

from mathkit.worker import READY_MARKER

# backend/ — the import root the worker needs on sys.path when running from
# source. In the frozen app the sidecar exe routes `--math-worker` itself.
BACKEND_DIR = Path(__file__).resolve().parents[1]

DEFAULT_TIMEOUT = 25.0
STARTUP_TIMEOUT = 90.0
STDERR_TAIL = 4000


class MathWorkerError(RuntimeError):
    """The worker could not answer. Always a tool ``error``, never a verdict."""


def _worker_argv() -> list[str]:
    if getattr(sys, "frozen", False):
        return [sys.executable, "--math-worker"]
    return [sys.executable, "-X", "utf8", "-m", "mathkit.worker"]


def _spawn_flags() -> dict[str, Any]:
    """Keep the frozen desktop app from flashing a console window per worker."""
    if sys.platform == "win32":
        return {"creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0)}
    return {}


class _Worker:
    """One child process, spoken to through blocking pipes on a worker thread.

    Plain ``subprocess.Popen`` driven by :func:`asyncio.to_thread`, NOT
    ``asyncio.create_subprocess_exec`` — the same choice, for the same reason,
    that :mod:`agent.exec_common` already documents: on Windows the asyncio
    subprocess API only works on a ProactorEventLoop, and uvicorn sometimes
    installs a SelectorEventLoop instead. There it raises ``NotImplementedError``
    **with an empty message**, so every math tool failed with a bare
    "Error: math_plot failed — " and nothing after the dash. `main` sets the
    Proactor policy at import, but the loop belongs to whoever started the
    server, so the runner cannot depend on winning that race.
    """

    def __init__(self) -> None:
        self._process: subprocess.Popen[bytes] | None = None
        self._stderr: deque[str] = deque(maxlen=64)
        self._drain: threading.Thread | None = None

    @property
    def alive(self) -> bool:
        return self._process is not None and self._process.poll() is None

    def _stderr_tail(self) -> str:
        return "".join(self._stderr)[-STDERR_TAIL:]

    async def ensure(self) -> None:
        if self.alive:
            return
        await self.kill()
        try:
            process = await asyncio.to_thread(
                subprocess.Popen,
                _worker_argv(),
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                cwd=str(BACKEND_DIR),
                env=_worker_env(),
                bufsize=0,
                **_spawn_flags(),
            )
        except OSError as exc:
            raise MathWorkerError(f"could not start the math worker: {exc}") from exc

        self._process = process
        self._drain = threading.Thread(target=self._drain_stderr, args=(process,), daemon=True)
        self._drain.start()

        try:
            line = await asyncio.wait_for(self._readline(process), STARTUP_TIMEOUT)
        except asyncio.TimeoutError as exc:
            await self.kill()
            raise MathWorkerError("the math worker did not become ready in time") from exc

        if line.decode("utf-8", "replace").strip() != READY_MARKER:
            detail = self._stderr_tail().strip() or "no diagnostics"
            await self.kill()
            raise MathWorkerError(
                f"the math worker failed to start — {detail}. "
                "SymPy may be missing from this build."
            )

    @staticmethod
    async def _readline(process: "subprocess.Popen[bytes]") -> bytes:
        """One line off the child's stdout, read on a thread.

        The thread stays blocked until the child answers or its stdout closes —
        which is why every timeout path below kills the process: that closes the
        pipe, the read returns empty, and the thread is released.
        """
        stdout = process.stdout
        if stdout is None:
            return b""
        return await asyncio.to_thread(stdout.readline)

    def _drain_stderr(self, process: "subprocess.Popen[bytes]") -> None:
        """Keep the child's stderr moving; a full pipe would deadlock it."""
        stream = process.stderr
        if stream is None:
            return
        try:
            for chunk in iter(stream.readline, b""):
                self._stderr.append(chunk.decode("utf-8", "replace"))
        except (ValueError, OSError):
            return

    async def request(self, job: dict[str, Any], timeout: float) -> dict[str, Any]:
        await self.ensure()
        process = self._process
        if process is None or process.stdin is None:
            raise MathWorkerError("the math worker is not running")

        payload = (json.dumps(job, ensure_ascii=False) + "\n").encode("utf-8")
        try:
            await asyncio.to_thread(_write_line, process, payload)
            line = await asyncio.wait_for(self._readline(process), timeout)
        except asyncio.TimeoutError as exc:
            await self.kill()
            raise MathWorkerError(
                f"the calculation exceeded its {timeout:g}s budget and was stopped"
            ) from exc
        except (BrokenPipeError, ConnectionResetError, ValueError) as exc:
            await self.kill()
            raise MathWorkerError("the math worker died mid-calculation") from exc

        if not line:
            detail = self._stderr_tail().strip()
            await self.kill()
            raise MathWorkerError(
                "the math worker exited without answering" + (f" — {detail}" if detail else "")
            )

        try:
            response = json.loads(line.decode("utf-8", "replace"))
        except json.JSONDecodeError as exc:
            await self.kill()
            raise MathWorkerError(f"the math worker returned malformed output: {exc}") from exc

        if not isinstance(response, dict) or not response.get("ok"):
            message = (response or {}).get("error") if isinstance(response, dict) else None
            raise MathWorkerError(str(message or "the math worker reported a failure"))
        result = response.get("result")
        return result if isinstance(result, dict) else {}

    async def kill(self) -> None:
        process, self._process = self._process, None
        self._drain = None
        if process is None or process.poll() is not None:
            return
        try:
            process.kill()
            await asyncio.to_thread(process.wait)
        except (ProcessLookupError, OSError):
            pass
        finally:
            for stream in (process.stdin, process.stdout, process.stderr):
                try:
                    if stream is not None:
                        stream.close()
                except OSError:
                    pass


def _write_line(process: "subprocess.Popen[bytes]", payload: bytes) -> None:
    if process.stdin is None:
        raise BrokenPipeError("the math worker has no stdin")
    process.stdin.write(payload)
    process.stdin.flush()


def _worker_env() -> dict[str, str]:
    """A minimal, deterministic environment for the child.

    ``PYTHONHASHSEED`` is pinned because set iteration order leaks into SymPy's
    output ordering, and a verifier whose report changes between runs is a
    verifier nobody trusts.
    """
    keep = ("PATH", "SYSTEMROOT", "TEMP", "TMP", "HOME", "LANG", "LC_ALL", "PYTHONPATH")
    env = {name: os.environ[name] for name in keep if name in os.environ}
    env.update(
        {
            "PYTHONIOENCODING": "utf-8",
            "PYTHONUNBUFFERED": "1",
            "PYTHONHASHSEED": "0",
            "PYTHONDONTWRITEBYTECODE": "1",
            "MPLBACKEND": "Agg",
        }
    )
    return env


class MathWorkerPool:
    """A bounded set of warm workers, handed out one job at a time."""

    def __init__(self, size: int = 2, timeout: float = DEFAULT_TIMEOUT) -> None:
        self._size = max(1, size)
        self._timeout = timeout
        self._idle: asyncio.Queue[_Worker] | None = None
        self._all: list[_Worker] = []
        self._lock = asyncio.Lock()

    async def _pool(self) -> "asyncio.Queue[_Worker]":
        async with self._lock:
            if self._idle is None:
                self._idle = asyncio.Queue()
                for _ in range(self._size):
                    worker = _Worker()
                    self._all.append(worker)
                    self._idle.put_nowait(worker)
            return self._idle

    async def submit(
        self, op: str, payload: dict[str, Any], *, timeout: float | None = None
    ) -> dict[str, Any]:
        """Run one job on a free worker. Raises :class:`MathWorkerError` on failure."""
        pool = await self._pool()
        worker = await pool.get()
        try:
            return await worker.request(
                {"id": uuid.uuid4().hex, "op": op, "payload": payload},
                timeout if timeout is not None else self._timeout,
            )
        finally:
            # Returned even when it was just killed: `ensure()` respawns it on
            # the next job, so a dead worker costs one restart rather than
            # permanently shrinking the pool.
            pool.put_nowait(worker)

    async def shutdown(self) -> None:
        for worker in self._all:
            await worker.kill()
        self._all.clear()
        self._idle = None
