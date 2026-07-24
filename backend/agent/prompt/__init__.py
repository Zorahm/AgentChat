"""System-prompt assembly as a module registry.

Public surface: :class:`PromptContext` (the inputs), :class:`PromptModule` /
:class:`PromptBuild` / :func:`assemble` (the registry runner), and
:func:`build_registry` (the shipped module list). The thin, signature-stable
``build_system_prompt`` entry point lives in :mod:`agent.system_prompt`.
"""

from __future__ import annotations

from .context import PromptContext
from .modules import PromptBuild, PromptModule, assemble
from .registry import build_registry

__all__ = [
    "PromptContext",
    "PromptModule",
    "PromptBuild",
    "assemble",
    "build_registry",
]
