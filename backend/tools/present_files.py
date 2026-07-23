"""present_files tool — surface finished files to the user as chat cards.

Replaces the old ``<artifact>`` text tag. The model writes a file (write_file /
bash_tool) and then calls ``present_files`` with its path; the UI turns each
path into a viewable, downloadable card (inline preview for renderable types,
download button otherwise). A structured tool call is far more reliable than
scraping a tag out of the token stream.
"""

from __future__ import annotations

import shlex
from pathlib import Path

from agent.sandbox import SandboxPolicy
from agent.host_exec import host_run
from tools.base import BaseTool, ToolDefinition, ToolSchema
from tools.write_file import _looks_windows_abs, _resolve_write_path


class PresentFilesTool(BaseTool):
    """Make one or more files viewable / downloadable in the chat UI."""

    name = "present_files"
    description = (
        "Surface finished files to the user as cards in the chat. Pass the paths "
        "(absolute, or relative to the chat folder) of files you created. "
        "Renderable types (.md, .html, .svg, .png/.jpg/.gif/.webp, .pdf, .json, "
        ".csv) preview inline; other types (.docx, .xlsx, .zip, …) show a download "
        "button. Call this for final deliverables the user should see or download "
        "— not for intermediate scripts or helper files."
    )

    def __init__(self) -> None:
        self._policy: SandboxPolicy = SandboxPolicy(unrestricted=True)

    def set_policy(self, policy: SandboxPolicy) -> None:
        self._policy = policy

    def get_definition(self) -> ToolDefinition:
        return ToolDefinition(
            function=ToolSchema(
                name=self.name,
                description=self.description,
                parameters={
                    "type": "object",
                    "properties": {
                        "paths": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": (
                                "Paths of the files to present (absolute, or relative "
                                "to the chat folder)."
                            ),
                        },
                    },
                    "required": ["paths"],
                },
            )
        )

    async def execute(self, paths: list[str] | str) -> str:
        """Validate the paths and confirm what was surfaced to the UI.

        The UI builds the cards from this tool call's ``paths`` argument; this
        method's job is to resolve/validate them and give the model clear
        feedback about anything it got wrong.
        """
        # Models occasionally send a bare string instead of an array.
        if isinstance(paths, str):
            paths = [paths]
        if not isinstance(paths, list) or not paths:
            return "Error: present_files needs a non-empty 'paths' array."

        presented: list[str] = []
        problems: list[str] = []
        for raw in paths:
            p = str(raw)
            resolved = _resolve_write_path(p, self._policy)
            if not resolved or not (resolved.startswith("/") or _looks_windows_abs(resolved)):
                problems.append(f"{p} (could not resolve to an absolute path)")
                continue
            denied = self._policy.check_read(resolved)
            if denied:
                problems.append(f"{p} (outside the sandbox)")
                continue
            if not await self._is_file(resolved):
                problems.append(f"{p} (not found — write it first)")
                continue
            presented.append(resolved)

        if not presented:
            detail = "; ".join(problems) if problems else "no valid paths"
            return f"Error: nothing to present — {detail}."

        names = ", ".join(Path(p).name for p in presented)
        result = f"Presented {len(presented)} file(s) to the user: {names}."
        if problems:
            result += " Skipped: " + "; ".join(problems) + "."
        return result

    async def _is_file(self, path: str) -> bool:
        if path.startswith("/"):
            result = await host_run(f"test -f {shlex.quote(path)}")
            return result.returncode == 0
        return Path(path).is_file()
