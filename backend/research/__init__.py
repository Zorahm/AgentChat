"""Multi-agent research: a lead researcher delegating to parallel subagents.

The public surface is :class:`~research.lead.LeadResearcher` (drives one run) and
:class:`~research.types.ResearchOutcome` (what a run produced). ``tools.research_tool``
is the only caller.
"""

from __future__ import annotations
