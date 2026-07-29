"""Cost and time rails for a research run.

The model decides *what* to research, how to split it and how deep to go; these
caps only decide how far it may go before it has to write up what it has. Every
number is also stated in the lead's prompt (see :mod:`research.prompts`) so the
model plans inside the rails instead of being cut off by them.
"""

from __future__ import annotations

import time
from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class ResearchBudget:
    """Hard limits for one run. Defaults are the shipped values."""

    max_parallel: int = 4
    max_subagents: int = 8
    max_rounds: int = 3
    lead_iterations: int = 24
    worker_iterations: int = 12
    #: A single subagent that stops making progress is abandoned after this.
    worker_timeout_s: float = 180.0
    #: Soft deadline: past it, no new fan-out round starts and the lead is told
    #: to write up. Never aborts a run that is already synthesizing.
    total_seconds: float = 600.0


class BudgetTracker:
    """Mutable spend counters for one run. Not thread-safe; one run, one loop."""

    def __init__(self, budget: ResearchBudget | None = None) -> None:
        self.budget = budget or ResearchBudget()
        self._started = time.monotonic()
        self.rounds_used = 0
        self.subagents_used = 0

    def seconds_left(self) -> float:
        elapsed = time.monotonic() - self._started
        return max(0.0, self.budget.total_seconds - elapsed)

    def refusal(self) -> str | None:
        """Why another fan-out round can't start, or ``None`` if one can."""
        if self.rounds_used >= self.budget.max_rounds:
            return f"Round limit reached ({self.budget.max_rounds})."
        if self.subagents_used >= self.budget.max_subagents:
            return f"Subagent limit reached ({self.budget.max_subagents})."
        if self.seconds_left() <= 0:
            return "Time budget for this run is spent."
        return None

    def open_round(self, requested: int) -> int:
        """Reserve up to *requested* subagent slots; return how many were granted.

        Granting is all-or-partial on purpose: asking for six when two slots are
        left runs the two rather than failing, and the returned count tells the
        caller to report the trim to the model.
        """
        if self.refusal() is not None:
            return 0
        granted = min(
            max(int(requested), 0),
            self.budget.max_parallel,
            self.budget.max_subagents - self.subagents_used,
        )
        if granted <= 0:
            return 0
        self.rounds_used += 1
        self.subagents_used += granted
        return granted

    def status_line(self) -> str:
        """One line for the model: what is left after the round it just ran."""
        left = int(self.seconds_left())
        return (
            f"Budget: {self.subagents_used}/{self.budget.max_subagents} subagents used, "
            f"{self.rounds_used}/{self.budget.max_rounds} rounds used, "
            f"~{left // 60}m{left % 60:02d}s of time left."
        )
