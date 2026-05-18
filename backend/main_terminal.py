"""Terminal test — agent loop + Skills 2.0.

Usage:
    set OPENAI_API_KEY=sk-...
    python main_terminal.py
"""

from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from agent.config import AgentConfig
from agent.loop import AgentLoop
from llm.client import LLMClient
from skills.reader import AgentSkillsReader
from tools.bash_tool import BashTool
from tools.read_file import ReadFileTool
from tools.read_skill import ReadSkillTool
from tools.registry import ToolRegistry
from tools.write_file import WriteFileTool

AGENTS_SKILLS_DIR = Path(__file__).resolve().parent.parent / ".agents" / "skills"
USER_AGENTS_SKILLS_DIR = Path.home() / ".agents" / "skills"

SYSTEM_PROMPT = """\
You are an AI assistant running in a desktop application called "AgentChat".

You have access to tools:
- bash_tool — execute bash commands inside WSL (Linux environment)
- read_file — read a file from the local filesystem
- write_file — write content to a file on the local filesystem
- read_skill — read detailed instructions for an installed skill

Available skills are listed below. Each skill has a description — when a task matches,
call read_skill to get the detailed workflow before proceeding.

Guidelines:
- Use tools when they help answer the user's question.
- For skill-related tasks, always read the skill first with read_skill.
- When you create a file, tell the user the absolute path you wrote to."""


async def main() -> None:
    model = os.environ.get("AGENT_MODEL", "gpt-4o")

    config = AgentConfig(
        model=model,
        system_prompt=SYSTEM_PROMPT,
        api_key=os.environ.get("OPENAI_API_KEY"),
        api_base=os.environ.get("OPENAI_API_BASE"),
    )

    AGENTS_SKILLS_DIR.mkdir(parents=True, exist_ok=True)
    reader = AgentSkillsReader([AGENTS_SKILLS_DIR, USER_AGENTS_SKILLS_DIR])
    reader.rebuild()

    registry = ToolRegistry()
    registry.register(BashTool())
    registry.register(ReadFileTool())
    registry.register(WriteFileTool())
    registry.register(ReadSkillTool(reader))

    llm = LLMClient(api_base=config.api_base, api_key=config.api_key)
    agent = AgentLoop(config=config, tools=registry, llm=llm)
    agent.set_manifest(reader.render_prompt())

    installed = reader.list_names()

    print("=" * 60)
    print("  AgentChat — Terminal")
    print(f"  Model : {model}")
    print("  Tools : bash_tool, read_file, write_file, read_skill")
    print(f"  Skills: {installed if installed else '(none installed)'}")
    print("  Type  : exit | reset | skills | <your message>")
    print("=" * 60)
    print()

    while True:
        try:
            user_input = input("You: ")
        except (EOFError, KeyboardInterrupt):
            print("\nGoodbye!")
            break

        if not user_input.strip():
            continue

        cmd = user_input.lower()

        if cmd == "exit":
            print("Goodbye!")
            break

        if cmd == "reset":
            agent.reset()
            reader.rebuild()
            agent.set_manifest(reader.render_prompt())
            print("[History cleared]\n")
            continue

        if cmd == "skills":
            reader.rebuild()
            names = reader.list_names()
            if names:
                for name in names:
                    entry = reader.get(name)
                    assert entry is not None
                    version_str = f" v{entry.version}" if entry.version else ""
                    print(f"  - {name}{version_str}")
                    if entry.description:
                        print(f"    {entry.description}")
            else:
                print("  (no skills installed)")
            print()
            continue

        print()
        try:
            reader.rebuild()
            agent.set_manifest(reader.render_prompt())
            response = await agent.run(user_input)
        except Exception as exc:
            print(f"Error: {exc}\n")
            continue

        for step in agent.steps:
            tc = step["tool_call"]
            tr = step["result"]
            status = "v" if tr.success else "x"
            args_preview = tc.function.arguments[:80]
            print(f"  [{status} {tc.function.name}] {args_preview}")
            if tr.output:
                preview = tr.output[:200].replace("\n", "\n    ")
                print(f"    -> {preview}")

        agent.steps.clear()
        print(f"\nAssistant: {response}\n")


if __name__ == "__main__":
    asyncio.run(main())
