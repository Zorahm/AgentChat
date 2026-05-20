"""Agent loop — LLM → tools → LLM → … → answer."""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import AsyncGenerator
from pathlib import Path
from typing import Any

from agent.config import AgentConfig
from agent.file_tag_interceptor import FileTagInterceptor
from agent.sandbox import SandboxPolicy
from agent.types import ToolCall, ToolResult
from agent.write_file_stream import emit_write_file_chunks
from agent.wsl_exec import wsl_read_text, wsl_write_bytes
from llm.client import LLMClient
from tools.registry import ToolRegistry


async def _write_file_from_tag(event: dict[str, Any], policy: SandboxPolicy) -> None:
    """Write file to disk from a completed <file> tag event. Mutates event in-place."""
    path: str = event.pop("_path")
    content: str = event.pop("_content")

    denied = policy.check_write(path)
    if denied:
        event["output"] = f"Error: {denied}"
        event["success"] = False
        return

    try:
        size = len(content.encode("utf-8"))
        if path.startswith("/"):
            await wsl_write_bytes(path, content.encode("utf-8"))
        else:
            p = Path(path)
            await asyncio.to_thread(p.parent.mkdir, parents=True, exist_ok=True)
            await asyncio.to_thread(p.write_text, content, "utf-8")
        event["output"] = f"Written {size} bytes to {path}"
        event["success"] = True
    except OSError as exc:
        event["output"] = f"Error: {exc}"
        event["success"] = False


async def _edit_file_from_tag(event: dict[str, Any], policy: SandboxPolicy) -> None:
    """Perform an in-place replacement from a completed <edit /> tag event.

    Semantics match Claude Code's Edit tool:
      - old must appear EXACTLY once
      - 0 matches → error (model gave wrong context)
      - 2+ matches → error (ambiguous, model must add more context)
    """
    path: str = event.pop("_edit_path")
    old: str = event.pop("_edit_old")
    new: str = event.pop("_edit_new")

    denied = policy.check_write(path)
    if denied:
        event["output"] = f"Edit refused: {denied}"
        event["success"] = False
        return

    try:
        if not path:
            raise ValueError("missing path")
        if not old:
            raise ValueError("empty 'old' string — use <file> to create or overwrite")

        if path.startswith("/"):
            original = await wsl_read_text(path)
        else:
            p = Path(path)
            if not p.exists():
                raise FileNotFoundError(f"file not found: {path}")
            original = await asyncio.to_thread(p.read_text, "utf-8")

        count = original.count(old)
        if count == 0:
            raise ValueError(
                "'old' string not found in file — check exact whitespace and indentation"
            )
        if count > 1:
            raise ValueError(
                f"'old' string matches {count} times — add surrounding context to make it unique"
            )

        updated = original.replace(old, new, 1)

        if path.startswith("/"):
            await wsl_write_bytes(path, updated.encode("utf-8"))
        else:
            await asyncio.to_thread(Path(path).write_text, updated, "utf-8")

        size_diff = len(updated.encode("utf-8")) - len(original.encode("utf-8"))
        event["output"] = f"Edited {path} ({size_diff:+d} bytes)"
        event["success"] = True
    except (OSError, ValueError) as exc:
        event["output"] = f"Edit failed: {exc}"
        event["success"] = False


class AgentLoop:
    """Orchestrates the agentic loop: call LLM, execute tools, repeat.

    Lifecycle:
      1. Append user message
      2. Loop until terminal response or max iterations:
         a. Call LiteLLM with tools
         b. If model returns text only → done
         c. If model returns tool calls → execute them, feed results back
    """

    def __init__(
        self,
        config: AgentConfig,
        tools: ToolRegistry,
        llm: LLMClient,
        policy: SandboxPolicy | None = None,
    ) -> None:
        self.config = config
        self.tools = tools
        self.llm = llm
        # Default policy is unrestricted — api/chat.py overrides per request.
        self._policy: SandboxPolicy = policy or SandboxPolicy(unrestricted=True)
        self.messages: list[dict[str, Any]] = []
        self.steps: list[dict[str, Any]] = []
        self._manifest_text: str = ""

    def set_policy(self, policy: SandboxPolicy) -> None:
        self._policy = policy

    # ------------------------------------------------------------------
    # public API
    # ------------------------------------------------------------------

    async def run(self, user_input: str) -> str:
        """Execute the full agent loop for one user message.

        Returns the final text response from the model.
        Side effect: populates ``self.steps`` with tool call records.
        """
        self.messages.append({"role": "user", "content": user_input})

        tool_defs = self.tools.to_openai_schema()
        tool_defs_or_none = tool_defs if tool_defs else None

        for _ in range(self.config.max_iterations):
            response = await self.llm.completion(
                model=self.config.model,
                messages=self._build_messages(),
                tools=tool_defs_or_none,
                extra_body=self.config.extra_body,
            )

            choice = response.choices[0]
            msg = choice.message

            # Build assistant message
            assistant_msg: dict[str, Any] = {"role": "assistant"}
            if msg.content:
                assistant_msg["content"] = msg.content

            if msg.tool_calls:
                # ── model requested tool calls ──
                tool_call_dicts = self._normalize_tool_calls(msg.tool_calls)
                assistant_msg["tool_calls"] = tool_call_dicts
                self.messages.append(assistant_msg)

                for tc_raw in msg.tool_calls:
                    await self._execute_and_record(tc_raw)
                # loop continues — tool results are now in messages
            else:
                # ── terminal response (no tool calls) ──
                self.messages.append(assistant_msg)
                return msg.content or ""

        return "Agent stopped: maximum iterations reached."

    async def run_stream(self, user_input: str | list[dict[str, Any]]) -> AsyncGenerator[dict[str, Any], None]:
        """Streaming agent loop — yields token / tool_start / tool_chunk / tool_end / done events."""
        self.messages.append({"role": "user", "content": user_input})

        tool_defs = self.tools.to_openai_schema()
        tool_defs_or_none = tool_defs if tool_defs else None

        for iteration_idx in range(self.config.max_iterations):
            if iteration_idx > 0:
                yield {"type": "reasoning_break"}
            accumulated_content = ""
            accumulated_reasoning = ""
            tool_call_state: dict[int, dict[str, Any]] = {}
            wf_state: dict[str, dict[str, Any]] = {}
            interceptor = FileTagInterceptor()

            async for chunk in self.llm.completion_stream(
                model=self.config.model,
                messages=self._build_messages(),
                tools=tool_defs_or_none,
                extra_body=self.config.extra_body,
            ):
                delta = chunk.choices[0].delta  # type: ignore[union-attr]

                if getattr(delta, "reasoning_content", None):
                    chunk_text: str = delta.reasoning_content
                    accumulated_reasoning += chunk_text
                    yield {"type": "reasoning", "content": chunk_text}

                if delta.content:
                    for event in interceptor.feed(delta.content):
                        if event["type"] == "token":
                            accumulated_content += event["content"]
                        elif event["type"] == "tool_end":
                            if "_path" in event:
                                await _write_file_from_tag(event, self._policy)
                            elif "_edit_path" in event:
                                await _edit_file_from_tag(event, self._policy)
                        yield event

                if delta.tool_calls:
                    self._accumulate_tool_call_chunks(delta.tool_calls, tool_call_state)
                    for event in emit_write_file_chunks(tool_call_state, wf_state):
                        yield event

            # Flush any text buffered at stream end
            for event in interceptor.flush():
                accumulated_content += event.get("content", "")
                yield event

            # Build final tool calls list (sorted by index)
            tool_calls = [tool_call_state[i] for i in sorted(tool_call_state)]

            if not tool_calls:
                # ── terminal response ──
                msg: dict[str, Any] = {"role": "assistant", "content": accumulated_content}
                if accumulated_reasoning:
                    msg["reasoning_content"] = accumulated_reasoning
                self.messages.append(msg)
                yield {"type": "done"}
                return

            # ── tool calls phase ──
            assistant_msg: dict[str, Any] = {
                "role": "assistant",
                "content": accumulated_content or None,
                "tool_calls": tool_calls,
            }
            if accumulated_reasoning:
                assistant_msg["reasoning_content"] = accumulated_reasoning
            self.messages.append(assistant_msg)

            for tc in tool_calls:
                name: str = tc["function"]["name"]
                call_id: str = tc["id"]
                args_raw: str = tc["function"]["arguments"]

                try:
                    args = json.loads(args_raw) if args_raw else {}
                except json.JSONDecodeError:
                    args = {}

                # write_file: tool_start was already emitted during streaming
                already_started = name == "write_file" and wf_state.get(call_id, {}).get("started", False)
                if not already_started:
                    yield {"type": "tool_start", "id": call_id, "name": name, "input": args}

                # write_file: flush any content that wasn't emitted during streaming
                if name == "write_file" and call_id in wf_state:
                    full_content: str = args.get("content", "")
                    emitted: int = wf_state[call_id]["emitted_len"]
                    if len(full_content) > emitted:
                        yield {"type": "tool_chunk", "id": call_id, "content": full_content[emitted:]}

                t0 = time.perf_counter()
                try:
                    output = await self.tools.execute(name, args)
                    success = True
                except Exception as exc:
                    output = str(exc)
                    success = False
                duration_ms = round((time.perf_counter() - t0) * 1000, 1)

                self.messages.append({"role": "tool", "tool_call_id": call_id, "content": output})

                yield {
                    "type": "tool_end", "id": call_id, "name": name,
                    "output": output, "duration_ms": duration_ms, "success": success,
                }

                self.steps.append({
                    "tool_call": ToolCall(id=call_id, function={"name": name, "arguments": args_raw}),
                    "result": ToolResult(
                        tool_call_id=call_id, name=name,
                        success=success, output=output, duration_ms=duration_ms,
                    ),
                })

        yield {"type": "done"}

    def reset(self) -> None:
        """Clear conversation history for a new session."""
        self.messages.clear()
        self.steps.clear()

    def set_manifest(self, text: str) -> None:
        """Update the skills manifest injected into the system prompt.

        Call before ``run()`` to reflect the latest installed skills.
        """
        self._manifest_text = text

    # ------------------------------------------------------------------
    # internal helpers
    # ------------------------------------------------------------------

    def _build_messages(self) -> list[dict[str, Any]]:
        """Prepend system prompt (with optional skills manifest) to the message history."""
        result: list[dict[str, Any]] = []
        prompt = self.config.system_prompt
        if self._manifest_text:
            prompt = f"{prompt}\n\n{self._manifest_text}"
        if prompt:
            result.append({"role": "system", "content": prompt})
        result.extend(self.messages)
        return result

    async def _execute_and_record(self, tc_raw: Any) -> None:
        """Execute a single tool call, store result in messages and steps."""
        name: str = tc_raw.function.name
        args_raw: str = tc_raw.function.arguments
        call_id: str = tc_raw.id

        try:
            args = json.loads(args_raw) if args_raw else {}
        except json.JSONDecodeError:
            args = {}

        t0 = time.perf_counter()
        try:
            output = await self.tools.execute(name, args)
            success = True
        except Exception as exc:
            output = str(exc)
            success = False
        duration_ms = round((time.perf_counter() - t0) * 1000, 1)

        # Store result as a tool message for the LLM
        self.messages.append({
            "role": "tool",
            "tool_call_id": call_id,
            "content": output,
        })

        # Store structured step for UI / debugging
        self.steps.append({
            "tool_call": ToolCall(
                id=call_id,
                function={"name": name, "arguments": args_raw},
            ),
            "result": ToolResult(
                tool_call_id=call_id,
                name=name,
                success=success,
                output=output,
                duration_ms=duration_ms,
            ),
        })

    @staticmethod
    def _normalize_tool_calls(raw: Any) -> list[dict[str, Any]]:
        """Convert LiteLLM tool call objects to plain dicts for message history."""
        result: list[dict[str, Any]] = []
        for tc in raw:
            result.append({
                "id": tc.id,
                "type": "function",
                "function": {
                    "name": tc.function.name,
                    "arguments": tc.function.arguments,
                },
            })
        return result

    @staticmethod
    def _accumulate_tool_call_chunks(
        delta_tool_calls: Any,
        state: dict[int, dict[str, Any]],
    ) -> None:
        """Merge streaming tool-call delta chunks into *state* keyed by index.

        LiteLLM / OpenAI stream tool calls in multiple chunks per tool.  Each
        chunk carries an ``index`` that identifies which tool it belongs to.
        This helper accumulates ``id``, ``function.name``, and
        ``function.arguments`` across chunks.
        """
        for tc_delta in delta_tool_calls:
            idx: int = tc_delta.index
            if idx not in state:
                state[idx] = {
                    "id": "",
                    "type": "function",
                    "function": {"name": "", "arguments": ""},
                }
            entry = state[idx]
            if tc_delta.id:
                entry["id"] = tc_delta.id
            if tc_delta.function:
                if tc_delta.function.name:
                    entry["function"]["name"] += tc_delta.function.name
                if tc_delta.function.arguments:
                    entry["function"]["arguments"] += tc_delta.function.arguments
