"""Agent loop — LLM → tools → LLM → … → answer."""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import AsyncGenerator
from typing import Any

from agent.config import AgentConfig
from agent.reasoning_split import REASONING, ThinkTagSplitter
from agent.sandbox import SandboxPolicy
from agent.types import ToolCall, ToolResult
from agent.untrusted import untrusted_source, wrap_untrusted
from agent.write_file_stream import emit_tool_call_progress
from llm.client import LLMClient
from llm.token_breakdown import estimate_prompt_breakdown
from tools.registry import ToolRegistry
from tools.write_file import _resolve_write_path


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
    # Some providers (DeepSeek, other text-only OpenAI-compatible APIs) reject
    # images not with a prose "no vision" message but a JSON-schema deserialize
    # error, e.g. "unknown variant `image_url`, expected `text`". Paired with the
    # hard `image_url` subject marker these stay specific to image rejections.
    "unknown variant",
    "expected `text`",
    "deserialize",
)


def _is_vision_rejection(message: str) -> bool:
    """Heuristic: does this provider error read like an image/vision rejection?"""
    s = message.lower()
    return any(k in s for k in _VISION_SUBJECT_MARKERS) and any(
        k in s for k in _VISION_NEGATION_MARKERS
    )


def _is_bad_request(exc: Exception) -> bool:
    """True when the provider rejected the request itself (a 4xx), as opposed to a
    network/stream/5xx failure.

    Used as a provider-agnostic backstop for image rejection: models reached
    through an Anthropic-compatible (or any other) gateway phrase "no vision" in
    wording we can't enumerate, but they all answer a non-vision model's image
    with a 4xx. litellm/openai errors carry a numeric ``status_code``; fall back
    to the class name for wrappers that don't expose one."""
    code = getattr(exc, "status_code", None)
    if isinstance(code, int) and 400 <= code < 500:
        return True
    return "badrequest" in type(exc).__name__.lower()


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
        chat_id: str = "",
        usage_metadata: dict[str, Any] | None = None,
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
        self._project_context_text: str = ""
        self._chat_id: str = chat_id
        # Forwarded to every LiteLLM call as `metadata=` so the usage/cost
        # logging callback (llm/usage_logging.py) can attribute the call to a
        # chat + message + context without parsing the response. See
        # docs/agentchat-usage-tracking-design.md.
        self._usage_metadata: dict[str, Any] | None = usage_metadata

    def set_policy(self, policy: SandboxPolicy) -> None:
        self._policy = policy

    def _absolutize_tool_paths(self, name: str, args: dict[str, Any]) -> dict[str, Any]:
        """Rewrite a file tool's path arg(s) from chat-relative to absolute.

        Models routinely pass paths relative to the chat folder (e.g.
        ``report.docx``). The artifact panel and the ``/files`` endpoints resolve
        paths independently and can't find a relative one — that's the "file not
        found / download does nothing" desync. Resolving here means the emitted
        and persisted tool input always carries an absolute path the UI can use.
        """
        def fix(p: Any) -> Any:
            if isinstance(p, str) and p.strip():
                return _resolve_write_path(p, self._policy) or p
            return p

        if name == "present_files":
            raw = args.get("paths", args.get("path"))
            items = raw if isinstance(raw, list) else [raw] if isinstance(raw, str) else []
            resolved = [fix(p) for p in items if isinstance(p, str) and p.strip()]
            if resolved:
                rest = {k: v for k, v in args.items() if k != "path"}
                return {**rest, "paths": resolved}
        elif name in ("write_file", "edit_file", "read_file") and isinstance(args.get("path"), str):
            return {**args, "path": fix(args["path"])}
        return args

    # ------------------------------------------------------------------
    # public API
    # ------------------------------------------------------------------

    async def run_stream(self, user_input: str | list[dict[str, Any]]) -> AsyncGenerator[dict[str, Any], None]:
        """Streaming agent loop — yields token / tool_start / tool_chunk / tool_end / done events."""
        self.messages.append({"role": "user", "content": user_input})

        tool_defs = self.tools.to_openai_schema(describe_actions=self.config.describe_actions)
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
            # Some providers (MiniMax M2/M3, other open reasoning models) stream
            # their thoughts as literal <think>…</think> inside delta.content
            # rather than in delta.reasoning_content. Split those out so they
            # feed the same reasoning pipeline instead of leaking into the answer.
            splitter = ThinkTagSplitter()
            tool_call_state: dict[int, dict[str, Any]] = {}
            progress_state: dict[str, dict[str, Any]] = {}

            built_messages = self._build_messages()
            call_metadata = self._usage_metadata
            if call_metadata is not None:
                cwd_line = (
                    f"Current working directory: {self._policy.chat_dir}"
                    if self._policy.chat_dir else ""
                )
                breakdown = estimate_prompt_breakdown(
                    model=self.config.model,
                    system_prompt=(
                        f"{self.config.system_prompt}\n\n{cwd_line}"
                        if cwd_line else self.config.system_prompt
                    ),
                    project_context=self._project_context_text,
                    skills_manifest=self._manifest_text,
                    tools=tool_defs_or_none,
                    history=self.messages,
                    new_user_message=(iteration_idx == 0),
                )
                call_metadata = {**call_metadata, "breakdown": breakdown}

            stream = self.llm.completion_stream(
                model=self.config.model,
                messages=built_messages,
                tools=tool_defs_or_none,
                extra_body=self.config.extra_body,
                metadata=call_metadata,
            )
            try:
                async for chunk in stream:
                    delta = chunk.choices[0].delta  # type: ignore[union-attr]

                    if getattr(delta, "reasoning_content", None):
                        chunk_text: str = delta.reasoning_content
                        accumulated_reasoning += chunk_text
                        yield {"type": "reasoning", "content": chunk_text}

                    if delta.content:
                        for kind, seg in splitter.feed(delta.content):
                            if kind == REASONING:
                                accumulated_reasoning += seg
                                yield {"type": "reasoning", "content": seg}
                            else:
                                accumulated_content += seg
                                yield {"type": "token", "content": seg}

                    if delta.tool_calls:
                        self._accumulate_tool_call_chunks(delta.tool_calls, tool_call_state)
                        for event in emit_tool_call_progress(tool_call_state, progress_state):
                            yield event
            except Exception as exc:
                # Model without vision rejected an image block. Either the error
                # text reads like a vision rejection, or — for providers whose
                # wording we can't predict (Anthropic-compatible gateways, other
                # labs) — it's a 4xx while the request still carries image blocks.
                # Swap the pixels for the provider's error and retry the pass in
                # text so the model can keep going instead of failing the request.
                # _strip_image_blocks only fires when images are present, so this
                # is one-shot: a second failure has no images left to strip and
                # propagates normally (no masking of unrelated 4xx errors).
                if (_is_vision_rejection(str(exc)) or _is_bad_request(exc)) and (
                    _strip_image_blocks(self.messages, str(exc))
                ):
                    retrying_vision = True
                    continue
                raise
            finally:
                # Always close the upstream HTTP stream, including the vision
                # retry path where we abandon it mid-flight.
                await stream.aclose()

            # Flush any <think> text the splitter was still buffering at EOF
            # (e.g. an unterminated thought, or a held-back partial tag).
            for kind, seg in splitter.flush():
                if kind == REASONING:
                    accumulated_reasoning += seg
                    yield {"type": "reasoning", "content": seg}
                else:
                    accumulated_content += seg
                    yield {"type": "token", "content": seg}

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

            # Set if a tool in this batch ends the turn to wait for the user
            # (e.g. ask_user). We still run every tool in the batch, then stop.
            pause_for_user = False

            for tc in tool_calls:
                name: str = tc["function"]["name"]
                call_id: str = tc["id"]
                args_raw: str = tc["function"]["arguments"]

                try:
                    args = json.loads(args_raw) if args_raw else {}
                except json.JSONDecodeError:
                    args = {}

                # Resolve chat-relative file paths to absolute so the artifact
                # panel / cards / badges and the /files endpoints can locate them.
                args = self._absolutize_tool_paths(name, args)

                skill_md_path = ""
                if name == "read_skill" and args.get("name"):
                    p = self.tools.get_skill_md_path(str(args["name"]))
                    skill_md_path = str(p) if p else ""

                # tool_start was already emitted during streaming (every tool now
                # gets an early start the moment its name is known).
                already_started = progress_state.get(call_id, {}).get("started", False)
                if not already_started:
                    yield {"type": "tool_start", "id": call_id, "name": name, "input": args}
                elif name == "write_file":
                    # The early start streamed the (often relative) path; refresh
                    # it to the absolute path so opening the file from its badge
                    # hits the right location.
                    if isinstance(args.get("path"), str) and args["path"]:
                        yield {"type": "tool_input", "id": call_id, "input": {"path": args["path"]}}
                else:
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
                tool_obj = self.tools.get(name)

                # Tools that wait for user input (e.g. ask_user) end the turn:
                # emit a user_question event so the UI can render the question
                # card, and flag the turn to stop after this batch. The tool
                # itself returns instantly; the user's answers come back as a
                # brand-new user message that starts the next turn.
                if getattr(tool_obj, "waits_for_input", False):
                    pause_for_user = True
                    yield {
                        "type": "user_question",
                        "id": call_id,
                        "chat_id": self._chat_id,
                        "questions": args.get("questions", []),
                        "selection_type": args.get("selection_type", "single"),
                    }

                if getattr(tool_obj, "streams_progress", False):
                    # The tool publishes structured progress events while it runs
                    # (e.g. the research tool's plan/search/sources/done). Run it
                    # as a task and forward each queued event as tool_progress for
                    # this call until the task finishes. Purely additive — every
                    # other tool takes the plain await path in the else branch.
                    queue: asyncio.Queue[dict[str, Any]] = tool_obj.progress_queue  # type: ignore[union-attr]
                    exec_task = asyncio.create_task(self.tools.execute(name, args))
                    # Hold a single pending getter across iterations instead of
                    # creating+cancelling one each loop. Cancelling a fresh
                    # queue.get() every pass can drop an item the getter already
                    # dequeued (lost progress event); reusing one getter avoids
                    # that and is cheaper.
                    pending_get: asyncio.Task[dict[str, Any]] | None = None
                    while not exec_task.done():
                        if pending_get is None:
                            pending_get = asyncio.ensure_future(queue.get())
                        await asyncio.wait(
                            {exec_task, pending_get}, return_when=asyncio.FIRST_COMPLETED
                        )
                        if pending_get.done():
                            yield {"type": "tool_progress", "id": call_id, "event": pending_get.result()}
                            pending_get = None
                    # Task finished. Recover an in-flight getter if it already
                    # resolved; otherwise cancel it cleanly before draining.
                    if pending_get is not None:
                        if pending_get.done() and not pending_get.cancelled():
                            yield {"type": "tool_progress", "id": call_id, "event": pending_get.result()}
                        else:
                            pending_get.cancel()
                            try:
                                await pending_get
                            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                                pass
                    while not queue.empty():
                        yield {"type": "tool_progress", "id": call_id, "event": queue.get_nowait()}
                    try:
                        output = exec_task.result()
                        success = True
                    except Exception as exc:
                        output = str(exc)
                        success = False
                else:
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

            # A waits_for_input tool ran this batch — end the turn and wait for
            # the user's answer (delivered as their next message), instead of
            # looping back to the model.
            if pause_for_user:
                yield {"type": "done"}
                return

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

    def set_project_context(self, text: str) -> None:
        """Update the project instructions + extracted-file block.

        Kept separate from ``config.system_prompt`` (rather than folded in by
        the caller) so the usage breakdown can attribute it to its own
        "memory files" bucket — the AgentChat analogue of Claude Code's
        CLAUDE.md context. Call before ``run()``.
        """
        self._project_context_text = text

    # ------------------------------------------------------------------
    # internal helpers
    # ------------------------------------------------------------------

    def _build_messages(self) -> list[dict[str, Any]]:
        """Prepend the system prompt (+ project context + skills manifest +
        cwd) to the history.

        The full prompt body now lives in ``build_system_prompt``; here we only
        append the per-request dynamic tails: project instructions, the
        installed-skills manifest, and the chat's working directory.
        """
        result: list[dict[str, Any]] = []
        prompt = self.config.system_prompt
        if self._project_context_text:
            prompt = f"{prompt}\n\n{self._project_context_text}"
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

        # Fence content that came from outside the trust boundary (web pages,
        # uploaded files) so the model sees a prompt-injection marker at the
        # exact point it reads the bytes. The UI still shows the raw text.
        llm_content = output
        if success and isinstance(output, str):
            source = untrusted_source(name, args)
            if source is not None:
                llm_content = wrap_untrusted(source, output)

        # Store result as a tool message for the LLM
        self.messages.append({
            "role": "tool",
            "tool_call_id": call_id,
            "content": llm_content,
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
