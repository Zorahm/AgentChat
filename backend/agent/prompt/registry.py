"""The shipped prompt registry: which modules, in which order.

Order encodes the prompt-cache strategy (see the cache invariant in
:mod:`agent.prompt.modules`): a contiguous run of session-stable *cacheable*
modules first, then the non-cacheable tail carrying the date and model. The old
layout led with ``datetime.now()`` down to the minute, so no cacheable prefix
existed at all and every request was billed in full.

An agent persona joins as two slots rather than one — see :func:`_persona_modules`.
"""

from __future__ import annotations

from . import sections, variables
from .context import PromptContext
from .model_family import detect_family, family_quirks
from .modules import PromptModule, assemble
from .shells import bash_desc, shell_block, wsl_notes

_IDENTITY = (
    "You are AgentChat, an AI assistant running in a desktop app of the same name. "
    "You help {name} with writing, coding, analysis, research, and producing files — "
    "using the tools below when they help, and answering directly when they don't."
)

# Built-in modules an agent is allowed to switch off: self-contained prose whose
# absence only changes how the model writes, never what the runtime hands it.
#
# Everything else is excluded for one of two reasons. Identity, environment,
# tools, sandbox and tail carry the contract that makes tool calls work at all,
# so dropping them yields an agent that looks configured while misusing the
# filesystem. And `describe_actions` / `skills` are only *half* prompt: the
# first is paired with the `activity` field injected into every tool schema
# (tools.registry.inject_activity_field), the second with the skills manifest
# the loop appends separately. Switching off either half alone leaves the model
# holding a field — or a skill list — it was never told how to use, so both stay
# where their runtime half is configured: Settings → Appearance and the Skills
# tab respectively.
TOGGLEABLE_MODULES: tuple[str, ...] = (
    "core_behavior",
    "reading_files",
    "creating_files",
    "visualizations",
    "math_verification",
    "formatting",
    "agentic_safety",
    "crisis",
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


def _core_modules(ctx: PromptContext) -> list[PromptModule]:
    """The built-in prompt: everything except the persona and the tail.

    This is exactly what ``{base}`` expands to, which is why the tail is not in
    it — a replace-mode persona decides for itself where (and whether) the date
    and model belong.
    """
    disabled = ctx.disabled_modules
    modules = [
        PromptModule("identity", _render_identity),
        PromptModule("environment", lambda c: shell_block(c.shell)),
        PromptModule("core_behavior", lambda _c: sections.CORE_BEHAVIOR),
        PromptModule("tools", _render_tools),
        PromptModule("sandbox", lambda _c: sections.SANDBOX_RULES),
        PromptModule("reading_files", lambda _c: sections.READING_FILES),
        PromptModule("wsl_notes", lambda c: wsl_notes(c.shell)),
        PromptModule("creating_files", lambda _c: sections.CREATING_FILES),
        PromptModule(
            "visualizations",
            lambda _c: sections.VISUALIZATIONS,
            applies=lambda c: c.show_widget,
        ),
        # Short on purpose. The detailed rules — when verification is mandatory,
        # how a solution is laid out — live in the `math` skill, which only
        # loads when the conversation is actually about mathematics. Putting
        # them here instead would have every chat that mentions a number
        # reaching for the verifier.
        PromptModule(
            "math_verification",
            lambda _c: sections.MATH_VERIFICATION,
            applies=lambda c: c.has_math_verify,
        ),
        PromptModule("formatting", lambda _c: sections.FORMATTING),
        PromptModule("agentic_safety", lambda _c: sections.AGENTIC_SAFETY),
        PromptModule("crisis", lambda _c: sections.CRISIS),
        PromptModule(
            "describe_actions",
            lambda _c: sections.DESCRIBE_ACTIONS,
            applies=lambda c: c.describe_actions,
        ),
        PromptModule(
            "skills",
            lambda _c: sections.SKILLS_HEADER,
            applies=lambda c: c.has_skills,
        ),
        # Right after skills, because a plugin is mostly a *source* of them —
        # the roster the loop appends ties the two lists together, and reading
        # this section before the skills contract would explain provenance for
        # something not yet introduced.
        PromptModule(
            "plugins",
            lambda _c: sections.PLUGINS_HEADER,
            applies=lambda c: c.has_plugins,
        ),
        # Last of the static block: per-model-family corrections. Cacheable —
        # for a given model it's constant; switching model families is expected
        # to change the cache key anyway. Renders "" (and is skipped) for
        # families with no quirk and for an unknown/empty model.
        PromptModule("model_family", lambda c: family_quirks(detect_family(c.model))),
    ]
    return [m for m in modules if m.name not in disabled]


def _block_lookup(ctx: PromptContext) -> variables.BlockLookup:
    """Resolve ``{base}`` and ``{block:<module>}`` against the core registry.

    Recursion is impossible by construction: the lookup renders
    :func:`_core_modules`, which never contains a persona module.
    """

    def lookup(name: str) -> str:
        core = _core_modules(ctx)
        if not name:
            return assemble(core, ctx).text
        for mod in core:
            if mod.name == name and mod.applies(ctx):
                return mod.render(ctx)
        return ""  # unknown or gated-off module contributes nothing

    return lookup


def _persona_modules(ctx: PromptContext) -> list[PromptModule]:
    """The agent's persona, split across a cacheable and a non-cacheable slot.

    A persona referencing ``{date}``/``{time}``/``{model}`` cannot live in the
    cached prefix, but the text *before* its first volatile reference still can.
    Splitting there means "you are a pirate … today is {date}" keeps almost all
    of its caching, while a persona opening with ``{time}`` honestly gets none.
    Exactly one of the two slots is usually non-empty; both render nothing when
    the agent has no persona at all.
    """
    text = ctx.persona.strip()
    if not text:
        return []
    stable, volatile = variables.split_volatile(text)
    lookup = _block_lookup(ctx)
    return [
        PromptModule("persona", lambda c: variables.render(stable, c, block_lookup=lookup)),
        PromptModule(
            "persona_volatile",
            lambda c: variables.render(volatile, c, block_lookup=lookup),
            cacheable=False,
        ),
    ]


def build_registry(ctx: PromptContext) -> list[PromptModule]:
    """Return the ordered prompt modules for *ctx*.

    In replace mode the persona *is* the prompt — no identity, no tail — because
    that is what "replace" has always meant here; a persona wanting the date or
    the built-in sections pulls them in with ``{date}`` and ``{base}``.

    Otherwise the persona is appended after the built-in modules: last word for
    the model, and the last cacheable module, so editing it leaves everything
    before it still matching the provider's cached prefix.
    """
    if ctx.replaces_base:
        return _persona_modules(ctx)
    return [
        *_core_modules(ctx),
        *_persona_modules(ctx),
        PromptModule("tail", _render_tail, cacheable=False),
    ]
