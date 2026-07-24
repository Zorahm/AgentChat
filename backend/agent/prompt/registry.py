"""The shipped prompt registry: which modules, in which order.

Order encodes the prompt-cache strategy (see the cache invariant in
:mod:`agent.prompt.modules`): a contiguous run of session-stable *cacheable*
modules first, then the single non-cacheable tail carrying the date and model.
The old layout led with ``datetime.now()`` down to the minute, so no cacheable
prefix existed at all and every request was billed in full.
"""

from __future__ import annotations

from . import sections
from .context import PromptContext
from .modules import PromptModule
from .shells import bash_desc, shell_block, wsl_notes

_IDENTITY = (
    "You are AgentChat, an AI assistant running in a desktop app of the same name. "
    "You help {name} with writing, coding, analysis, research, and producing files — "
    "using the tools below when they help, and answering directly when they don't."
)

# The per-tool one-liners below duplicate each tool's own schema description that
# already ships in the API ``tools`` param; a later commit prunes them.
_TOOL_BULLETS = """- read_file — read a file from the local filesystem. For large files, use offset (1-based line number) and limit (max lines) to read in chunks instead of loading the entire file at once.
- write_file — create or overwrite a file. Pass `path` (absolute, or relative to the chat folder) and the full `content`; parent folders are created automatically. Use append=true to add to an existing file. The content streams into a live preview as you write it.
- edit_file — change part of an existing file: pass `path`, the exact `old_string` to find (copied verbatim, including indentation), and `new_string`. `old_string` must match exactly once; read the file first if unsure.
- present_files — surface finished files to the user as cards in the chat. Pass `paths` (an array of file paths). Renderable types preview inline; others get a download button. This is the ONLY way to make a file viewable or downloadable to the user.
- show_widget — render an interactive visualization (chart, diagram, data viz) inline in the chat. Pass self-contained `html` and an optional `title`. See "Visualizations" below.
- web_fetch — fetch an http(s) URL and return its readable text (HTML is converted to plain text). Use it to read a page the user links or that a web_search result points to.
- read_skill — read the full SKILL.md for an installed skill. **Call this before writing any code or modifying any file when a relevant skill is available.** Read each skill at most once per conversation; afterwards rely on what you learned.
- ask_user — ask the user one or more questions with predefined answer options. Use this when you need the user to make a choice before you can proceed. Pass `questions` (array of {question, options[]}) and `selection_type` ("single" for radio buttons or "multiple" for checkboxes). Calling it ENDS your turn — stop after the call; the user's selections come back as their next message. Use it for decisions that genuinely affect your output — not for rhetorical or confirmation questions you can answer yourself."""


def _render_identity(ctx: PromptContext) -> str:
    return _IDENTITY.format(name=ctx.user_name)


def _render_tools(ctx: PromptContext) -> str:
    return f"## Tools\n\n{bash_desc(ctx.shell)}\n{_TOOL_BULLETS}"


def _render_tail(ctx: PromptContext) -> str:
    """Non-cacheable footer: user, date, and (optionally) the model identity.

    Kept last on purpose — the date changes daily and the model can change per
    request, so anything after it in the cached prefix would be re-billed too.
    """
    model_suffix = f"\nModel: {ctx.model} (routed via LiteLLM)" if ctx.model else ""
    return f"User: {ctx.user_name}\nDate: {ctx.today}{model_suffix}"


def build_registry(ctx: PromptContext) -> list[PromptModule]:
    """Return the ordered prompt modules for *ctx*.

    The cacheable block (everything up to the tail) is session-stable; the tail
    is the only non-cacheable module and must stay last to preserve the prefix.
    """
    return [
        PromptModule("identity", _render_identity),
        PromptModule("environment", lambda c: shell_block(c.shell)),
        PromptModule("core_behavior", lambda _c: sections.CORE_BEHAVIOR),
        PromptModule("tools", _render_tools),
        PromptModule("sandbox", lambda _c: sections.SANDBOX_RULES),
        PromptModule("reading_files", lambda _c: sections.READING_FILES),
        PromptModule("wsl_notes", lambda c: wsl_notes(c.shell)),
        PromptModule("creating_files", lambda _c: sections.CREATING_FILES),
        PromptModule("visualizations", lambda _c: sections.VISUALIZATIONS),
        PromptModule("formatting", lambda _c: sections.FORMATTING),
        PromptModule("agentic_safety", lambda _c: sections.AGENTIC_SAFETY),
        PromptModule("crisis", lambda _c: sections.CRISIS),
        PromptModule(
            "describe_actions",
            lambda _c: sections.DESCRIBE_ACTIONS,
            applies=lambda c: c.describe_actions,
        ),
        PromptModule("skills", lambda _c: sections.SKILLS_HEADER),
        PromptModule("tail", _render_tail, cacheable=False),
    ]
