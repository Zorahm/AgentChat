"""The prompt-module registry runner.

A section is no longer a constant hand-joined into a string; it is a
:class:`PromptModule` — a named, optionally-gated render function. Assembly
walks the ordered registry, drops modules whose ``applies`` is false, renders
the rest, and joins them. The result is not just a string: it also carries the
list of active module names and a hash of the cacheable prefix, so a puzzling
model response can be traced back to *exactly* which prompt it saw.
"""

from __future__ import annotations

import hashlib
import logging
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field

from .context import PromptContext

logger = logging.getLogger(__name__)

Renderer = Callable[[PromptContext], str]
Predicate = Callable[[PromptContext], bool]


def _always(_ctx: PromptContext) -> bool:
    return True


@dataclass(frozen=True)
class PromptModule:
    """One prompt section, expressed as data.

    ``render`` is usually ``lambda _c: _SOME_CONST`` but may branch on the
    context. ``cacheable`` marks the module as part of the stable prefix that
    should be identical across requests in a session; ``applies`` gates the
    module on session-stable flags only (never on conversation state).
    """

    name: str
    render: Renderer
    cacheable: bool = True
    applies: Predicate = field(default=_always)


@dataclass(frozen=True)
class PromptBuild:
    """Result of assembling a registry: the text plus its provenance."""

    text: str
    active_modules: tuple[str, ...]
    cache_prefix_hash: str


def _check_unique_names(modules: Sequence[PromptModule]) -> None:
    seen: set[str] = set()
    for mod in modules:
        if mod.name in seen:
            raise ValueError(f"duplicate prompt module name: {mod.name!r}")
        seen.add(mod.name)


def _check_cache_prefix_contiguous(modules: Sequence[PromptModule]) -> None:
    """Enforce the cache invariant on the *declared* module order.

    Prompt caching only pays off when the cacheable content forms one
    uninterrupted prefix: the provider caches the longest identical head of the
    prompt, so a single non-cacheable module (a date, the model id) placed in
    front of cacheable content makes everything after it uncacheable too. We
    check the structural order rather than the rendered output so the failure
    surfaces at startup — a loud crash beats a silent, ongoing cache miss.
    """
    seen_non_cacheable = False
    for mod in modules:
        if mod.cacheable and seen_non_cacheable:
            raise ValueError(
                f"cache invariant violated: cacheable module {mod.name!r} "
                "appears after a non-cacheable one; all cacheable modules must "
                "form a contiguous prefix"
            )
        if not mod.cacheable:
            seen_non_cacheable = True


def assemble(modules: Sequence[PromptModule], ctx: PromptContext) -> PromptBuild:
    """Render the registry against *ctx* into a :class:`PromptBuild`.

    Raises ``ValueError`` on a duplicate module name or a violated cache-prefix
    invariant — both are registry-construction bugs, not runtime conditions.
    """
    _check_unique_names(modules)
    _check_cache_prefix_contiguous(modules)

    rendered: list[str] = []
    active: list[str] = []
    cacheable_parts: list[str] = []
    for mod in modules:
        if not mod.applies(ctx):
            continue
        text = mod.render(ctx)
        if not text:
            continue  # empty render contributes nothing — avoids stray "\n\n"
        rendered.append(text)
        active.append(mod.name)
        if mod.cacheable:
            cacheable_parts.append(text)

    prefix = "\n\n".join(cacheable_parts)
    cache_prefix_hash = hashlib.sha256(prefix.encode("utf-8")).hexdigest()[:16]

    build = PromptBuild(
        text="\n\n".join(rendered),
        active_modules=tuple(active),
        cache_prefix_hash=cache_prefix_hash,
    )
    # Logged every request: without the active-module list and the prefix hash,
    # diagnosing "why did the model behave oddly" is pure guesswork.
    logger.info(
        "system prompt assembled: modules=%s cache_prefix=%s",
        ",".join(build.active_modules),
        build.cache_prefix_hash,
    )
    return build
