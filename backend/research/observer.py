"""Turns one nested agent loop's tool events into progress steps and a source list.

Shared by the lead and every subagent so both timelines are built the same way.

Tool arguments stream in character by character, so a ``web_search`` query is only
whole once the call ends. Each call id's latest value is therefore accumulated and
the step is emitted at ``tool_end`` — emitting earlier would show the user a
truncated prefix of the query.
"""

from __future__ import annotations

from typing import Any

from research.progress import ProgressEmitter
from research.sources import dedupe, extract_urls


class LoopObserver:
    """Feed it an agent loop's events; it emits progress and remembers sources."""

    def __init__(self, emitter: ProgressEmitter, agent_id: str) -> None:
        self._emitter = emitter
        self._agent = agent_id
        self._names: dict[str, str] = {}
        self._queries: dict[str, str] = {}
        self._fetch_urls: dict[str, str] = {}
        self._sources: list[str] = []

    @property
    def sources(self) -> list[str]:
        """Every URL this agent searched up or read, de-duplicated."""
        return dedupe(self._sources)

    def feed(self, event: dict[str, Any]) -> None:
        etype = event.get("type")
        call_id = str(event.get("id", ""))
        if etype in ("tool_start", "tool_input"):
            self._track_args(etype, call_id, event)
        elif etype == "tool_end":
            self._emit_step(call_id, event)

    def _track_args(self, etype: Any, call_id: str, event: dict[str, Any]) -> None:
        name = str(event.get("name", "")) or self._names.get(call_id, "")
        if etype == "tool_start" and name:
            self._names[call_id] = name
        args = event.get("input") or {}
        if not isinstance(args, dict):
            return
        if name == "web_search":
            query = str(args.get("query", "")).strip()
            if query:
                self._queries[call_id] = query
        elif name == "web_fetch":
            url = str(args.get("url", "")).strip()
            if url:
                self._fetch_urls[call_id] = url

    def _emit_step(self, call_id: str, event: dict[str, Any]) -> None:
        name = str(event.get("name", "")) or self._names.get(call_id, "")
        if name == "web_search":
            self._emitter.agent_step(self._agent, "search", self._queries.get(call_id, ""))
            found = extract_urls(str(event.get("output", "")))
            if found:
                self._sources.extend(found)
                self._emitter.agent_sources(self._agent, found)
        elif name == "web_fetch":
            url = self._fetch_urls.get(call_id, "")
            if url:
                self._sources.append(url)
                self._emitter.agent_step(self._agent, "read", url)
