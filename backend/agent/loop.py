"""Agent loop — LLM → tools → LLM → … → answer."""

from __future__ import annotations

import json
import time
from collections.abc import AsyncGenerator
from typing import Any

from agent.config import AgentConfig
from agent.sandbox import SandboxPolicy
from agent.types import ToolCall, ToolResult
from agent.write_file_stream import emit_tool_call_progress
from llm.client import LLMClient
from tools.registry import ToolRegistry


# Provider error fragments that mean "this model can't accept image input".
# We require an image/vision *subject* together with a *negation* so unrelated
# failures that merely mention "image" don't trip the fallback.
_VISION_SUBJECT_MARKERS: tuple[str, ...] = (
    "image",
    "vision",
    "multimodal",
    "image_url",
)
_VISION_NEGATION_MARKERS: tuple[str, ...] = (
    "not support",
    "does not support",
    "doesn't support",
    "do not support",
    "unsupported",
    "cannot",
    "can't",
    "invalid",
    "no vision",
    "not a valid",
    "only support",
    "text-only",
    "text only",
    "not allowed",
    "not multimodal",
)


def _is_vision_rejection(message: str) -> bool:
    """Heuristic: does this provider error read like an image/vision rejection?"""
    s = message.lower()
    return any(k in s for k in _VISION_SUBJECT_MARKERS) and any(
        k in s for k in _VISION_NEGATION_MARKERS
    )


def _strip_image_blocks(messages: list[dict[str, Any]], error: str) -> bool:
    """Replace image content with a text note explaining the model can't see it.

    Returns True if any image block was found and replaced. Used to recover when
    a provider rejects image input on a model without vision: we swap the pixels
    for the provider's own error so the model can keep going in text (e.g. open
    the file via bash) instead of crashing the request."""
    note = (
        "[Image could not be read — this model has no vision. "
        f"Provider error: {error}. The file is still on disk; "
        "use bash_tool to inspect it (identify, exiftool, pdftotext, etc.).]"
    )
    found = False
    for m in messages:
        content = m.get("content")
        if not isinstance(content, list):
            continue
        if not any(
            isinstance(b, dict) and b.get("type") == "image_url" for b in content
        ):
            continue
        found = True
        if m.get("role") == "tool":
            # The whole tool result was image content → replace with the note.
            m["content"] = note
            continue
        new_blocks: list[dict[str, Any]] = []
        noted = False
        for b in content:
            if isinstance(b, dict) and b.get("type") == "image_url":
                if not noted:
                    new_blocks.append({"type": "text", "text": note})
                    noted = True
            else:
                new_blocks.append(b)
        m["content"] = new_blocks
    return found


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
        extra_tools: list[dict[str, Any]] | None = None,
    ) -> None:
        self.config = config
        self.tools = tools
        self.llm = llm
        # Default policy is unrestricted — api/chat.py overrides per request.
        self._policy: SandboxPolicy = policy or SandboxPolicy(unrestricted=True)
        # Provider-side tools (e.g. native web search) appended verbatim to the
        # LiteLLM tools array. The provider executes these; the loop never does.
        self._extra_tools: list[dict[str, Any]] = extra_tools or []
        self.messages: list[dict[str, Any]] = []
        self.steps: list[dict[str, Any]] = []
        self._manifest_text: str = ""

    def set_policy(self, policy: SandboxPolicy) -> None:
        self._policy = policy

    # ------------------------------------------------------------------
    # public API
    # ------------------------------------------------------------------

    async def run_stream(self, user_input: str | list[dict[str, Any]]) -> AsyncGenerator[dict[str, Any], None]:
        """Streaming agent loop — yields token / tool_start / tool_chunk / tool_end / done events."""
        self.messages.append({"role": "user", "content": user_input})

        tool_defs = self.tools.to_openai_schema()
        if self._extra_tools:
            tool_defs = tool_defs + self._extra_tools
        tool_defs_or_none = tool_defs if tool_defs else None

        # Set when we transparently retried a pass after stripping image blocks
        # the model couldn't read — suppresses the reasoning break for the retry.
        retrying_vision = False
        for iteration_idx in range(self.config.max_iterations):
            if iteration_idx > 0 and not retrying_vision:
                yield {"type": "reasoning_break"}
            retrying_vision = False
            accumulated_content = ""
            accumulated_reasoning = ""
            tool_call_state: dict[int, dict[str, Any]] = {}
            progress_state: dict[str, dict[str, Any]] = {}

            stream = self.llm.completion_stream(
                model=self.config.model,
                messages=self._build_messages(),
                tools=tool_defs_or_none,
                extra_body=self.config.extra_body,
            )
            try:
                async for chunk in stream:
                    delta = chunk.choices[0].delta  # type: ignore[union-attr]

                    if getattr(delta, "reasoning_content", None):
                        chunk_text: str = delta.reasoning_content
                        accumulated_reasoning += chunk_text
                        yield {"type": "reasoning", "content": chunk_text}

                    if delta.content:
                        accumulated_content += delta.content
                        yield {"type": "token", "content": delta.content}

                    if delta.tool_calls:
                        self._accumulate_tool_call_chunks(delta.tool_calls, tool_call_state)
                        for event in emit_tool_call_progress(tool_call_state, progress_state):
                            yield event
            except Exception as exc:
                # Model without vision rejected an image block. Swap the pixels
                # for the provider's error and retry the pass in text, so the
                # model can keep going instead of failing the whole request.
                if _is_vision_rejection(str(exc)) and _strip_image_blocks(
                    self.messages, str(exc)
                ):
                    retrying_vision = True
                    continue
                raise
            finally:
                # Always close the upstream HTTP stream, including the vision
                # retry path where we abandon it mid-flight.
                await stream.aclose()

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

                skill_md_path = ""
                if name == "read_skill" and args.get("name"):
                    p = self.tools.get_skill_md_path(str(args["name"]))
                    skill_md_path = str(p) if p else ""

                # tool_start was already emitted during streaming (every tool now
                # gets an early start the moment its name is known).
                already_started = progress_state.get(call_id, {}).get("started", False)
                if not already_started:
                    yield {"type": "tool_start", "id": call_id, "name": name, "input": args}
                elif name != "write_file":
                    # The early start carried only the partial primary arg. Now
                    # that args are fully parsed, refresh the block with the
                    # complete input (e.g. read_file offset/limit, full command).
                    yield {"type": "tool_input", "id": call_id, "input": args}

                # write_file: flush any content that wasn't emitted during streaming
                if name == "write_file" and call_id in progress_state:
                    full_content: str = args.get("content", "")
                    emitted: int = progress_state[call_id]["emitted_len"]
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

                # Tools may return a plain string or an OpenAI content list (e.g. image blocks).
                # The LLM sees the list directly; the UI gets a human-readable summary string.
                if isinstance(output, list):
                    display_output = f"[image: {args.get('path', '?')}]"
                    self.messages.append({"role": "tool", "tool_call_id": call_id, "content": output})
                else:
                    display_output = output
                    self.messages.append({"role": "tool", "tool_call_id": call_id, "content": output})

                yield {
                    "type": "tool_end", "id": call_id, "name": name,
                    "output": display_output, "duration_ms": duration_ms, "success": success,
                    **({"file_path": skill_md_path} if name == "read_skill" and skill_md_path else {}),
                }

                self.steps.append({
                    "tool_call": ToolCall(id=call_id, function={"name": name, "arguments": args_raw}),
                    "result": ToolResult(
                        tool_call_id=call_id, name=name,
                        success=success, output=display_output, duration_ms=duration_ms,
                    ),
                })

        yield {"type": "iterations_exhausted", "count": self.config.max_iterations}
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
        """Prepend the system prompt (+ skills manifest + cwd) to the history.

        The full prompt body now lives in ``build_system_prompt``; here we only
        append the two per-request dynamic tails: the installed-skills manifest
        and the chat's working directory.
        """
        result: list[dict[str, Any]] = []
        prompt = self.config.system_prompt
        if self._manifest_text:
            prompt = f"{prompt}\n\n{self._manifest_text}"
        if self._policy.chat_dir:
            prompt = f"{prompt}\n\nCurrent working directory: {self._policy.chat_dir}"
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

        display_output = f"[image: {args.get('path', '?')}]" if isinstance(output, list) else output

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
                output=display_output,
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
