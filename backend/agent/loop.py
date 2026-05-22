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


_MATH_RENDERING_ADDENDUM = """## Math rendering
This chat renders LaTeX via KaTeX. Use `$...$` for inline math and `$$...$$`
for display equations on their own line. Prefer display (`$$`) for anything
wider than a few symbols — it scrolls horizontally on narrow screens, while
inline math does not wrap.

Examples:
  Inline: The gradient $\\nabla f$ vanishes at extrema.
  Block:  $$\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}$$

Use a plain `$` for currency (e.g. "$50") — the renderer ignores it when
followed by a digit. Escape with `\\$` if context is ambiguous."""


_FILE_READING_ADDENDUM = """## Reading attached files
When the user attaches a binary file, the message includes its absolute path
(`Файл доступен по пути: ...`). Use `bash_tool` to extract content — do not
parse archives by hand (no zipfile / no XML scraping) unless every tool below
has failed.

Pick the tool by extension:
  .docx .odt .rtf .epub .html .md → `pandoc "<path>" -t plain` (or `-t markdown`
                                     to preserve structure)
  .doc                            → `pandoc` works if the file is well-formed;
                                     otherwise `antiword` or `catdoc`
  .pdf                            → `pdftotext "<path>" -` (layout: add `-layout`)
  .xlsx .ods                      → `python3 -c "import openpyxl; ..."` or
                                     `ssconvert "<path>" /dev/stdout -T Gnumeric_stf:stf_csv`
  .csv .tsv .txt .log .json .yaml → `cat` / `head` / `jq` directly
  .pptx                           → `pandoc` (best-effort) or unzip + read slide XML

Pandoc is preinstalled in WSL. If a command says "command not found", install
it once with `apt-get install -y --no-install-recommends <pkg>` before retrying.
Never claim a file is unreadable until at least one extractor has been tried.

If `apt-get`, `pip`, or `npm` fail with hostname errors ("Could not resolve
host", "Temporary failure in name resolution") — this is a known WSL DNS
breakage. Do NOT try to patch `/etc/resolv.conf` yourself; it is bind-mounted
and your edits will be reverted on next launch. Stop and tell the user:
"DNS в WSL сломан. Открой Settings → Shell или Onboarding и нажми кнопку
«Починить DNS» — она прописывает Cloudflare/Google nameservers и
перезапускает дистрибутив." Then wait for them to fix it before continuing."""


_ARTIFACTS_ADDENDUM = """## Delivering files to the user
The chat UI has a side panel that renders files when you emit an artifact
tag. The tag is the ONLY way to surface a file to the user as a viewable
card — bare text mentioning a path will not open anything.

Workflow: write the file with `bash_tool` (or the `<file>` block / write_file
tool), then emit a self-closing artifact tag on its own line:

  <artifact type="file" path="/absolute/path/to/file.ext" label="Short title" />

Renderable extensions get inline preview in the panel:
  - Images: .png .jpg .jpeg .gif .webp .svg
  - Docs:   .md .html .pdf .json .csv
  - Office: .docx .xlsx .pptx (download hint only)

Use this whenever you produce something for the user to look at or download:
generated charts (matplotlib `savefig` to PNG, then artifact), reports,
diagrams, audio/video, exported spreadsheets. Always save into the chat's
working directory (`pwd` at the start of a turn gives you the chat sandbox)
so the path is stable and viewable. Do NOT base64 image data into chat text
— emit the artifact tag instead.

### Images you can't see
If the user attaches an image and the message says `(модель без vision …)`,
your model has no vision capability — you do NOT see pixel content. That
does NOT mean you can't help. You still have the absolute path and full
filesystem access, so you can:
  - Move / rename / copy the file (`mv`, `cp`)
  - Embed it into a generated document (`python-docx` add_picture, ReportLab
    drawImage, pandoc with `![](path)` markdown)
  - Convert / resize / re-encode (`convert`, `ffmpeg`, PIL)
  - Read metadata (`identify -verbose`, `exiftool`, PIL `Image.open(...).info`)
  - Combine images into PDF / collage / GIF
  - Re-emit as artifact after processing
Never refuse the task just because you can't see the image — ask the user
to describe the content if that's what's blocking you, and otherwise do
whatever file-level work was requested."""


async def _write_file_from_tag(event: dict[str, Any], policy: SandboxPolicy) -> None:
    """Write file to disk from a completed <file> tag event. Mutates event in-place.

    Catches every exception (not just OSError) so that one malformed write
    can't take down the SSE stream — we always come back with a structured
    tool_end the UI can render.
    """
    path: str = event.pop("_path", "")
    content: str = event.pop("_content", "")

    if not path:
        event["output"] = "Error: <file> tag had no path attribute."
        event["success"] = False
        return

    denied = policy.check_write(path)
    if denied:
        event["output"] = f"Error: {denied}"
        event["success"] = False
        return

    try:
        size = len(content.encode("utf-8"))
        # Choose the write backend by path namespace (not by configured shell):
        # the model is free to write either a WSL or a Windows path as long as
        # the sandbox allowed it, and we want both to actually land on disk.
        if path.startswith("/"):
            await wsl_write_bytes(path, content.encode("utf-8"))
        else:
            p = Path(path)
            await asyncio.to_thread(p.parent.mkdir, parents=True, exist_ok=True)
            await asyncio.to_thread(p.write_text, content, "utf-8")
        event["output"] = f"Written {size} bytes to {path}"
        event["success"] = True
    except FileNotFoundError as exc:
        event["output"] = (
            f"Error: cannot write to {path}: {exc}. "
            "Parent directory may be missing on a read-only mount, or wsl.exe "
            "is unavailable (try switching to PowerShell in Settings → Терминал)."
        )
        event["success"] = False
    except PermissionError as exc:
        event["output"] = f"Error: permission denied writing to {path}: {exc}"
        event["success"] = False
    except OSError as exc:
        event["output"] = f"Error: writing to {path} failed: {exc}"
        event["success"] = False
    except Exception as exc:  # noqa: BLE001 — last-resort guard for the SSE stream
        event["output"] = f"Error: unexpected failure writing {path}: {exc!r}"
        event["success"] = False


async def _edit_file_from_tag(event: dict[str, Any], policy: SandboxPolicy) -> None:
    """Perform an in-place replacement from a completed <edit> tag event.

    Semantics match Claude Code's Edit tool:
      - old must appear EXACTLY once
      - 0 matches → error (model gave wrong context)
      - 2+ matches → error (ambiguous, model must add more context)

    Works for both syntactic forms (self-closing attribute-based and block
    with nested <old>/<new>). Catches every exception so SSE keeps flowing.
    """
    path: str = event.pop("_edit_path", "")
    old: str = event.pop("_edit_old", "")
    new: str = event.pop("_edit_new", "")

    if not path:
        event["output"] = "Edit failed: missing path attribute on <edit>."
        event["success"] = False
        return

    denied = policy.check_write(path)
    if denied:
        event["output"] = f"Edit refused: {denied}"
        event["success"] = False
        return

    try:
        if not old:
            raise ValueError("empty 'old' string — use <file> to create or overwrite a whole file")

        if path.startswith("/"):
            original = await wsl_read_text(path)
        else:
            p = Path(path)
            if not p.exists():
                raise FileNotFoundError(f"file not found: {path}")
            original = await asyncio.to_thread(p.read_text, "utf-8")

        count = original.count(old)
        if count == 0:
            # Help the model see the gap. Show the first ~80 chars of old and
            # whether a normalised version (CRLF→LF, trimmed trailing spaces)
            # would have matched — common breakage from copy-pasted snippets.
            preview = old.replace("\n", "\\n")[:80]
            hint = ""
            if "\r\n" in original and old.replace("\n", "\r\n") in original:
                hint = " (file uses CRLF line endings; emit old with literal CRLF)"
            elif _normalise_ws(original).count(_normalise_ws(old)) == 1:
                hint = " (only whitespace differs — match exact indentation)"
            raise ValueError(
                f"'old' string not found in {path}. Tried to match {preview!r}.{hint}"
            )
        if count > 1:
            raise ValueError(
                f"'old' string matches {count} times in {path} — add surrounding "
                "context (line above/below) to make it unique"
            )

        updated = original.replace(old, new, 1)

        if path.startswith("/"):
            await wsl_write_bytes(path, updated.encode("utf-8"))
        else:
            await asyncio.to_thread(Path(path).write_text, updated, "utf-8")

        size_diff = len(updated.encode("utf-8")) - len(original.encode("utf-8"))
        line_delta = updated.count("\n") - original.count("\n")
        event["output"] = f"Edited {path} ({size_diff:+d} bytes, {line_delta:+d} lines)"
        event["success"] = True
    except FileNotFoundError as exc:
        event["output"] = f"Edit failed: {exc}"
        event["success"] = False
    except (OSError, ValueError) as exc:
        event["output"] = f"Edit failed: {exc}"
        event["success"] = False
    except Exception as exc:  # noqa: BLE001 — last-resort guard for the SSE stream
        event["output"] = f"Edit failed: unexpected error in {path}: {exc!r}"
        event["success"] = False


def _normalise_ws(s: str) -> str:
    """Collapse all whitespace runs to a single space and trim per-line edges.

    Used only as a diagnostic when an <edit> can't match — tells the model
    "only whitespace differs" so it doesn't keep retrying the same string.
    Differs from a strict normalise: we want to ignore tabs-vs-spaces and
    indent depth so a near-match still trips the hint.
    """
    import re as _re
    return _re.sub(r"\s+", " ", s.replace("\r\n", "\n")).strip()


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
        addenda = (
            f"{_MATH_RENDERING_ADDENDUM}\n\n"
            f"{_FILE_READING_ADDENDUM}\n\n"
            f"{_ARTIFACTS_ADDENDUM}"
        )
        prompt = f"{prompt}\n\n{addenda}" if prompt else addenda
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
