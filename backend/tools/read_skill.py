"""Read skill tool — loads SKILL.md on demand."""

from __future__ import annotations

from pathlib import Path

from skills.reader import AgentSkillsReader
from tools.base import BaseTool, ToolDefinition, ToolSchema


def _to_wsl_path(p: Path) -> str:
    """Convert a Windows absolute path to WSL /mnt/<drive>/ form."""
    posix = p.resolve().as_posix()
    if len(posix) >= 2 and posix[1] == ":":
        drive = posix[0].lower()
        return f"/mnt/{drive}{posix[2:]}"
    return posix


_TREE_SKIP_DIRS = frozenset({
    ".git", "__pycache__", "node_modules", ".venv", "venv", "dist", "build",
})
_TREE_MAX_ENTRIES = 80


def _build_tree(root: Path) -> str:
    """Build a compact tree listing of files under *root*, excluding SKILL.md.

    Returns a string like:
        scripts/
          crossword_core.py
          render.py
          suggest.py
          validator.py
        examples/
          space.json
          space_render.txt
        README.md
    """
    lines: list[str] = []
    count = 0

    def walk(d: Path, depth: int) -> bool:
        nonlocal count
        try:
            children = sorted(d.iterdir(), key=lambda p: (p.is_file(), p.name.lower()))
        except OSError:
            return True
        for c in children:
            if count >= _TREE_MAX_ENTRIES:
                lines.append("  " * depth + f"... ({_TREE_MAX_ENTRIES}+ entries — truncated)")
                return False
            if c.name == "SKILL.md" and depth == 0:
                continue
            if c.is_dir():
                if c.name in _TREE_SKIP_DIRS or c.name.startswith("."):
                    continue
                lines.append("  " * depth + f"{c.name}/")
                count += 1
                if not walk(c, depth + 1):
                    return False
            else:
                lines.append("  " * depth + c.name)
                count += 1
        return True

    walk(root, 0)
    return "\n".join(lines) if lines else "(only SKILL.md)"


class ReadSkillTool(BaseTool):
    """Read the full SKILL.md instructions for an installed skill.

    The LLM sees only skill descriptions in the system prompt (to save tokens).
    When it needs the detailed instructions, it calls this tool.
    """

    name = "read_skill"
    description = (
        "Read the full instructions for a skill. Use this when a task matches "
        "a skill's description and you need its detailed workflow."
    )

    def __init__(self, reader: AgentSkillsReader) -> None:
        self._reader = reader

    def get_definition(self) -> ToolDefinition:
        return ToolDefinition(
            function=ToolSchema(
                name=self.name,
                description=self.description,
                parameters={
                    "type": "object",
                    "properties": {
                        "name": {
                            "type": "string",
                            "description": "Name of the skill to read (e.g. 'crossword-skill').",
                        }
                    },
                    "required": ["name"],
                },
            )
        )

    async def execute(self, name: str) -> str:
        entry = self._reader.get(name)
        if entry is None:
            available = self._reader.list_names()
            if not available:
                return f"Skill '{name}' not found. No skills are currently installed."
            return f"Skill '{name}' not found. Available: {', '.join(available)}"

        skill_md = entry.path / "SKILL.md"
        try:
            content = skill_md.read_text("utf-8")
        except OSError as exc:
            return f"Error reading skill '{name}': {exc}"

        win_dir = str(entry.path.resolve())
        wsl_dir = _to_wsl_path(entry.path)
        tree = _build_tree(entry.path)

        header = (
            f"# Skill: {name}\n\n"
            f"Skill directory (Windows): {win_dir}\n"
            f"Skill directory (WSL/bash): {wsl_dir}\n"
            f"All paths in the SKILL.md below are relative to this directory. "
            f"When using bash_tool, prefix commands with "
            f"`cd {wsl_dir} && ...` or pass absolute paths. "
            f"When using read_file/write_file, prefix paths with `{win_dir}\\`.\n\n"
            f"## Files in this skill\n\n"
            f"```\n{tree}\n```\n\n"
        )
        return header + content
