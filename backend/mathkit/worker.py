"""The math worker process: one job per line in, one result per line out.

Runs as a *child of the backend*, not inside it, for three reasons that all
matter and none of which a thread can give you:

* **A timeout has to be enforceable.** ``simplify`` on a pathological
  expression does not check for interrupts, and Windows has no ``SIGALRM``. A
  process can be killed; a thread cannot.
* **The import cost is paid once, off the request path.** sympy takes a second
  or two to import. A warm worker answers subsequent jobs in milliseconds, which
  is what lets ``math_verify`` sit in the base tool set without being a tax on
  every chat that mentions a number.
* **A runaway calculation cannot take the server with it.** Memory and CPU stay
  in a process the parent is willing to lose.

The protocol is deliberately dull: UTF-8 JSON, one object per line, no framing,
no pickling. Nothing but results may ever be written to stdout — a stray
``print`` in a dependency would desynchronise the stream, so diagnostics go to
stderr, which the parent drains separately.
"""

from __future__ import annotations

import json
import sys
from typing import Any

# Written to stdout once the heavy imports are resolved. The parent waits for it
# before handing over the first job, so a slow sympy import shows up as startup
# latency rather than as a mysterious first-call timeout.
READY_MARKER = "__mathkit_ready__"


def _warm() -> None:
    """Resolve the expensive imports before announcing readiness."""
    import sympy  # noqa: F401
    import mpmath  # noqa: F401

    from mathkit import parsing  # noqa: F401
    from mathkit.verifiers import registry  # noqa: F401


def handle(job: dict[str, Any]) -> dict[str, Any]:
    """Dispatch one job. Returns a payload dict; never raises."""
    op = str(job.get("op") or "")
    payload = job.get("payload") if isinstance(job.get("payload"), dict) else {}

    try:
        if op == "verify":
            from mathkit.verifiers.registry import run_verification

            return {"ok": True, "result": run_verification(payload)}

        if op == "eval":
            from mathkit.pysandbox import SandboxError, run_script

            try:
                result = run_script(str(payload.get("code") or ""))
            except SandboxError as exc:
                return {"ok": True, "result": {"stdout": "", "result": None, "error": str(exc)}}
            return {
                "ok": True,
                "result": {
                    "stdout": result.stdout,
                    "result": result.result,
                    "error": result.error,
                },
            }

        if op == "plot":
            from mathkit.plot.render import render_plot

            return {"ok": True, "result": render_plot(payload)}

        if op == "ping":
            return {"ok": True, "result": {"pong": True}}

    except Exception as exc:  # noqa: BLE001 — the loop must survive any job
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"[:600]}

    return {"ok": False, "error": f"unknown op {op!r}"}


def main() -> None:
    """Serve jobs until stdin closes."""
    try:
        _warm()
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write(f"mathkit worker failed to start: {type(exc).__name__}: {exc}\n")
        sys.stderr.flush()
        raise SystemExit(2)

    sys.stdout.write(READY_MARKER + "\n")
    sys.stdout.flush()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            job = json.loads(line)
        except json.JSONDecodeError as exc:
            response: dict[str, Any] = {"ok": False, "error": f"bad job envelope: {exc}"}
        else:
            response = handle(job if isinstance(job, dict) else {})
            response["id"] = (job or {}).get("id") if isinstance(job, dict) else None
        sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
