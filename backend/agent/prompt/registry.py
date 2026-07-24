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

def _render_identity(ctx: PromptContext) -> str:
    return _IDENTITY.format(name=ctx.user_name)


def _render_tools(ctx: PromptContext) -> str:
    """Only bash_tool needs prose here.

    Every other tool's one-liner merely restated its own schema ``description``,
    which already ships in the API ``tools`` param — so those are gone (single
    source of truth). What a schema *can't* carry is bash's cross-cutting
    contract: the chat working directory, "each call is a fresh shell", and the
    shell dialect. The extra semantics for the file/widget/ask_user tools live
    in their dedicated sections below, not as a duplicated roster here.
    """
    return f"## Tools\n\n{bash_desc(ctx.shell)}"


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
