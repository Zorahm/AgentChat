"""Inputs to system-prompt assembly, as one immutable record.

Everything a :class:`PromptModule` may branch on lives here — the values that
used to be scattered function arguments (``user_name``, ``shell``, ``model``,
``describe_actions``), the session-stable capability flags that gate optional
sections, the runtime facts an agent persona can interpolate, and the persona
itself. Frozen so a module can never mutate the context mid-build.
"""

from __future__ import annotations

from dataclasses import dataclass, field

# An agent's persona text is either folded into the built-in prompt or replaces
# it wholesale. "append" is the safe default: the tool contract, sandbox rules
# and safety rules survive, and the persona is just the last word on top.
APPEND_MODE = "append"
REPLACE_MODE = "replace"


@dataclass(frozen=True)
class AgentSpec:
    """The persona half of a :class:`PromptContext`, as one argument.

    Grouped so callers assembling a prompt for a configured agent pass one
    record instead of four loose keywords.
    """

    name: str = ""
    persona: str = ""
    prompt_mode: str = APPEND_MODE
    disabled_modules: frozenset[str] = field(default_factory=frozenset)


@dataclass(frozen=True)
class RuntimeFacts:
    """Runtime values a persona can interpolate, resolved by the caller.

    All plain text: the caller owns the tool registry, the MCP manager and the
    sandbox, and this package must stay a leaf that imports none of them.
    """

    os_name: str = ""
    cwd: str = ""
    tools_block: str = ""
    tool_names: str = ""
    skills_block: str = ""
    plugins_block: str = ""
    mcp_block: str = ""
    lang: str = ""
    # Who the user is playing, from the agent record. Session-stable.
    user_persona: str = ""
    # The rendered core-memory block. Changes the moment the agent remembers
    # something, so the {memory} variable that exposes it is marked volatile.
    agent_memory: str = ""


@dataclass(frozen=True)
class PromptContext:
    """Immutable snapshot of everything the prompt registry renders from.

    Fields fall into three groups:

    * **Session-stable** — safe for the cached prefix, because they cannot
      change between two requests of one chat (see the cache invariant in
      :func:`agent.prompt.modules.assemble`).
    * **Per-request** — ``model``, ``today`` and ``now_time``. These live in the
      non-cacheable tail, and any persona text referencing them is split out of
      the cached prefix by :func:`agent.prompt.variables.split_volatile`.
    * **Agent** — the persona template and its module toggles.
    """

    user_name: str = ""
    shell: str = "wsl"
    model: str = ""
    describe_actions: bool = False
    # Session-stable capability flags — never derived from conversation state,
    # so toggling them cannot shift the cache prefix mid-conversation.
    show_widget: bool = True
    has_skills: bool = True
    # Whether any Agent Plugin is installed and enabled. Gates the section that
    # explains what a plugin is: with none installed the prose describes a
    # concept the model will never meet in this session.
    has_plugins: bool = False
    # Whether `math_verify` is in this request's registry. Session-stable: it
    # depends on the agent's tool policy and whitelist, not on what has been
    # said in the chat, so gating on it cannot shift the cache prefix mid-turn.
    has_math_verify: bool = True
    # Pre-formatted current day (e.g. "24 July 2026"). Injected by the caller so
    # the pure registry stays clock-free and testable; lives in the tail only.
    today: str = ""

    # ── runtime facts, exposed to personas as template variables ──────────
    # Resolved by the caller (which owns the tool registry, the MCP manager and
    # the sandbox) and passed in as plain text, so this package stays a leaf
    # that imports nothing from the app. Empty is always a valid value.
    os_name: str = ""
    cwd: str = ""
    tools_block: str = ""
    tool_names: str = ""
    skills_block: str = ""
    plugins_block: str = ""
    mcp_block: str = ""
    lang: str = ""
    user_persona: str = ""
    # Clock time down to the minute. Poison for the cache prefix by design —
    # only ever reachable through the {time} variable, never rendered by a
    # built-in module.
    now_time: str = ""
    # Same deal as now_time: reachable only through the volatile {memory}
    # variable. When a persona doesn't place it, api.chat appends the block
    # after the assembled prompt instead — see AgentLoop.set_agent_memory.
    agent_memory: str = ""

    # ── agent persona ─────────────────────────────────────────────────────
    agent_name: str = ""
    persona: str = ""
    prompt_mode: str = APPEND_MODE
    # Names of built-in modules the agent switched off. Only entries in
    # ``registry.TOGGLEABLE_MODULES`` have any effect.
    disabled_modules: frozenset[str] = field(default_factory=frozenset)

    @property
    def replaces_base(self) -> bool:
        """True when the persona stands in for the built-in prompt entirely."""
        return self.prompt_mode == REPLACE_MODE and bool(self.persona.strip())
