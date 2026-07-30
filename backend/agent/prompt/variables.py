"""Template variables available inside an agent's persona prompt.

An agent's prompt is a *template*, not a frozen snapshot. ``{date}`` is
recomputed every request, ``{tools}`` reflects the registry actually assembled
for this call, ``{shell}`` follows the Settings toggle. Before this module an
agent override was captured text: it carried a stale date, a stale shell
dialect, and never learned about tools added after it was written.

Two rules the rest of the prompt package leans on:

* **Only catalog names are substituted.** Anything else inside braces passes
  through byte-for-byte, so a persona holding JSON (``{"k": 1}``) or a code
  template is never mangled — which is also why no escape syntax is needed.
* **Volatile variables are marked.** ``{date}`` / ``{time}`` / ``{model}``
  change between requests within one session, so text containing them can never
  sit in the cacheable prefix (see the cache invariant in
  :mod:`agent.prompt.modules`). :func:`split_volatile` is how the registry keeps
  the stable head of a persona cacheable anyway.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass

from .context import PromptContext

# Resolves ``{base}`` (empty name) and ``{block:<module>}``. Supplied by the
# registry, which owns the module list — keeping this module a leaf that the
# registry can import without a cycle.
BlockLookup = Callable[[str], str]

# ``{name}`` or ``{block:name}``. Deliberately narrow: uppercase, spaces and
# punctuation never match, so prose braces and JSON survive the pass untouched.
_TOKEN_RE = re.compile(r"\{([a-z_][a-z0-9_]*(?::[a-z0-9_]+)?)\}")

_BLOCK_PREFIX = "block:"
_BASE_NAME = "base"


@dataclass(frozen=True)
class VariableSpec:
    """One substitutable name.

    ``volatile`` marks a value that differs between two requests of the same
    session; those force their surrounding text out of the cached prefix.
    """

    name: str
    volatile: bool
    resolve: Callable[[PromptContext], str]


def _spec(name: str, getter: Callable[[PromptContext], str], *, volatile: bool = False) -> VariableSpec:
    return VariableSpec(name=name, volatile=volatile, resolve=getter)


# Session-stable values first, then the three that move per request. Order here
# is also the order the UI palette shows them in.
CATALOG: dict[str, VariableSpec] = {
    v.name: v
    for v in (
        _spec("user", lambda c: c.user_name),
        _spec("agent_name", lambda c: c.agent_name),
        _spec("shell", lambda c: c.shell),
        _spec("os", lambda c: c.os_name),
        _spec("cwd", lambda c: c.cwd),
        _spec("tools", lambda c: c.tools_block),
        _spec("tool_names", lambda c: c.tool_names),
        _spec("skills", lambda c: c.skills_block),
        _spec("mcp", lambda c: c.mcp_block),
        _spec("lang", lambda c: c.lang),
        _spec("user_persona", lambda c: c.user_persona),
        _spec("date", lambda c: c.today, volatile=True),
        _spec("time", lambda c: c.now_time, volatile=True),
        _spec("model", lambda c: c.model, volatile=True),
        # Volatile because the agent rewrites it mid-conversation: the turn
        # after a `remember` call the block differs, and any cached prefix
        # containing it would be invalidated anyway. Marking it here is what
        # lets split_volatile keep the persona's stable head cacheable.
        _spec("memory", lambda c: c.agent_memory, volatile=True),
    )
}

VOLATILE_NAMES: frozenset[str] = frozenset(n for n, s in CATALOG.items() if s.volatile)


def is_known(name: str) -> bool:
    """True for a catalog name, ``base``, or any ``block:<module>`` form.

    ``block:`` is accepted without checking the module exists — an unknown
    module resolves to empty text rather than failing prompt assembly, and the
    editor is what tells the user they typed a name that renders nothing.
    """
    return name in CATALOG or name == _BASE_NAME or name.startswith(_BLOCK_PREFIX)


def used_names(text: str) -> tuple[str, ...]:
    """Catalog names actually referenced by *text*, in first-appearance order."""
    seen: list[str] = []
    for match in _TOKEN_RE.finditer(text):
        name = match.group(1)
        if is_known(name) and name not in seen:
            seen.append(name)
    return tuple(seen)


def unknown_names(text: str) -> tuple[str, ...]:
    """Brace tokens that *look* like variables but aren't in the catalog.

    Not an error anywhere in the backend — these pass through verbatim. The
    editor surfaces them so a typo'd ``{tolls}`` doesn't silently ship.
    """
    seen: list[str] = []
    for match in _TOKEN_RE.finditer(text):
        name = match.group(1)
        if not is_known(name) and name not in seen:
            seen.append(name)
    return tuple(seen)


def is_volatile(text: str) -> bool:
    """True when *text* references a variable that changes between requests."""
    return any(name in VOLATILE_NAMES for name in used_names(text))


def references(text: str, name: str) -> bool:
    """True when *text* actually interpolates the catalog variable *name*.

    Used to let an explicit ``{memory}`` in a persona suppress the block the
    chat route would otherwise append: placed twice, the model reads its own
    memory in two places and treats the second copy as a separate, competing
    set of facts. Goes through :func:`used_names` rather than a substring
    check so prose braces and JSON in a persona never count as a placement.
    """
    return name in used_names(text)


def split_volatile(text: str) -> tuple[str, str]:
    """Split *text* into a cacheable head and a per-request tail.

    The head can still live in the provider's cached prefix; from the first
    ``{date}`` / ``{time}`` / ``{model}`` onward the text is re-billed every
    request. A persona with no volatile reference returns ``(text, "")`` and
    stays wholly cacheable.

    The cut lands on the **paragraph break** before that first reference, never
    mid-sentence: the two halves become separate prompt modules, and
    :func:`agent.prompt.modules.assemble` rejoins modules with a blank line. Cutting
    anywhere else would splice that blank line into the middle of the user's
    prose. Splitting on the exact two-character ``"\\n\\n"`` sequence — rather
    than on a "one or more blank lines" pattern — is what makes the rejoin
    byte-for-byte lossless even inside a longer run of newlines.

    A persona whose *first* paragraph is already volatile has no cacheable head
    and returns ``("", text)``.
    """
    for match in _TOKEN_RE.finditer(text):
        if match.group(1) not in VOLATILE_NAMES:
            continue
        cut = text.rfind("\n\n", 0, match.start())
        if cut == -1:
            return "", text
        return text[:cut], text[cut + 2 :]
    return text, ""


def render(text: str, ctx: PromptContext, *, block_lookup: BlockLookup | None = None) -> str:
    """Substitute catalog names in *text*; leave everything else alone.

    ``{base}`` and ``{block:<module>}`` are delegated to *block_lookup*; without
    one they resolve to empty (the caller had no registry to offer).
    """

    def replace(match: re.Match[str]) -> str:
        name = match.group(1)
        spec = CATALOG.get(name)
        if spec is not None:
            return spec.resolve(ctx)
        if name == _BASE_NAME:
            return block_lookup("") if block_lookup else ""
        if name.startswith(_BLOCK_PREFIX):
            return block_lookup(name[len(_BLOCK_PREFIX) :]) if block_lookup else ""
        return match.group(0)  # unknown — verbatim, never mangled

    return _TOKEN_RE.sub(replace, text)
