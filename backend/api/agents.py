"""Agent profile CRUD, plus the editor's variable palette and live preview.

An agent is a persisted persona a chat can be attached to: a name, a gradient
avatar, and a prompt *template* (see ``schemas.agents`` for the mode and
variable semantics). Mirrors the MCP server CRUD pattern — a flat list in
``settings.json``, no separate DB.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from pydantic import ValidationError

from agent.agent_prompt import build_agent_prompt, render_agent_text
from agent.prompt import variables
from agent.prompt.registry import TOGGLEABLE_MODULES
from schemas.agents import (
    DEFAULT_AGENT_ID,
    AgentConfig,
    AgentCreate,
    AgentEditorMeta,
    AgentGreeting,
    AgentPreviewRequest,
    AgentPreviewResponse,
    AgentUpdate,
    PromptVariable,
)
from schemas.memory import MemoryCreate, MemoryFact, MemoryUpdate
from shell import resolve_active_shell
from store.settings_store import SettingsStore

router = APIRouter(prefix="/agents", tags=["agents"])


def _require_agent(store: SettingsStore, agent_id: str) -> AgentConfig:
    """Resolve *agent_id* or 404.

    Every memory route goes through this: without it a typo'd id would quietly
    open a fresh, permanent shelf of facts belonging to no agent at all.
    """
    agent = store.get_agent(agent_id)
    if agent is None:
        raise HTTPException(status_code=404, detail=f"Unknown agent: {agent_id}")
    return agent


@router.get("", response_model=list[AgentConfig])
async def list_agents(request: Request) -> list[AgentConfig]:
    store = request.app.state.settings_store
    return store.list_agents()


@router.get("/variables", response_model=AgentEditorMeta)
async def editor_meta() -> AgentEditorMeta:
    """The variable palette and the switchable prompt sections.

    ``volatile`` tells the UI which variables cost prompt caching. ``{base}``
    and ``{block:<module>}`` are absent from the catalog because they're
    structural rather than values — the editor offers those separately, and
    only in replace mode where they mean anything.
    """
    return AgentEditorMeta(
        variables=[
            PromptVariable(name=spec.name, volatile=spec.volatile)
            for spec in variables.CATALOG.values()
        ],
        toggleable_modules=list(TOGGLEABLE_MODULES),
    )


@router.post("/preview", response_model=AgentPreviewResponse)
async def preview_prompt(request: Request, body: AgentPreviewRequest) -> AgentPreviewResponse:
    """Assemble the prompt an unsaved draft would produce, right now.

    Replaces the old "load the current default into the textarea" button, whose
    output was a snapshot: it froze the date and shell dialect into the agent
    and drifted from the real prompt on the very next app update. Preview reads
    the same assembly path the chat route uses, so what's shown is what runs —
    modulo the per-chat working directory, which only exists once a chat does.
    """
    store = request.app.state.settings_store
    draft = AgentConfig(
        id="preview",
        name=body.name or "Preview",
        system_prompt=body.system_prompt,
        prompt_mode=body.prompt_mode,
        disabled_modules=body.disabled_modules,
        user_persona=body.user_persona,
    )
    build = build_agent_prompt(
        agent=draft,
        user_name=store.user_name,
        shell=resolve_active_shell(store.shell_preference),
        model=body.model or store.default_model,
        describe_actions=store.describe_actions,
        registry=request.app.state.tool_registry,
        skills_block=request.app.state.skill_reader.render_prompt(),
    )
    return AgentPreviewResponse(
        prompt=build.text,
        active_modules=list(build.active_modules),
        used_variables=list(variables.used_names(body.system_prompt)),
        unknown_variables=list(variables.unknown_names(body.system_prompt)),
        cacheable=not variables.is_volatile(body.system_prompt),
    )


@router.post("", response_model=AgentConfig)
async def add_agent(request: Request, body: AgentCreate) -> AgentConfig:
    store = request.app.state.settings_store
    try:
        return store.add_agent(body)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.put("/{agent_id}", response_model=AgentConfig)
async def update_agent(request: Request, agent_id: str, body: AgentUpdate) -> AgentConfig:
    store = request.app.state.settings_store
    try:
        return store.update_agent(agent_id, body)
    except PermissionError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    # ValidationError subclasses ValueError, so it must be caught first — a
    # patch the merged record rejects is a bad request, not a missing agent.
    except ValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.delete("/{agent_id}")
async def delete_agent(request: Request, agent_id: str) -> dict[str, str]:
    store = request.app.state.settings_store
    if agent_id == DEFAULT_AGENT_ID:
        raise HTTPException(status_code=400, detail="The default agent cannot be deleted")
    try:
        store.remove_agent(agent_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    # Facts outlive the chats they came from, but not the agent that holds
    # them: ids are user-chosen, so re-creating a deleted one would otherwise
    # inherit a stranger's recollections.
    request.app.state.memory_store.delete_agent(agent_id)
    return {"status": "ok"}


@router.post("/{agent_id}/greeting", response_model=AgentGreeting)
async def agent_greeting(request: Request, agent_id: str) -> AgentGreeting:
    """The agent's opening line, variables resolved.

    A POST because it renders rather than reads: the result depends on the
    current user name and shell, and caching it would be wrong.
    """
    store = request.app.state.settings_store
    agent = _require_agent(store, agent_id)
    return AgentGreeting(
        text=render_agent_text(
            agent.greeting,
            agent=agent,
            user_name=store.user_name,
            shell=resolve_active_shell(store.shell_preference),
            lang=store.language,
        )
    )


# ── memory ───────────────────────────────────────────────────────────────
# Facts are addressed as /agents/{id}/memory/{fact_id} and every store call is
# scoped to the agent in the path, so a mismatched pair reads as "no such
# fact" (404) rather than reaching into another agent's shelf.


@router.get("/{agent_id}/memory", response_model=list[MemoryFact])
async def list_memory(request: Request, agent_id: str) -> list[MemoryFact]:
    _require_agent(request.app.state.settings_store, agent_id)
    return request.app.state.memory_store.list_facts(agent_id)


@router.post("/{agent_id}/memory", response_model=MemoryFact)
async def add_memory(request: Request, agent_id: str, body: MemoryCreate) -> MemoryFact:
    _require_agent(request.app.state.settings_store, agent_id)
    return request.app.state.memory_store.add(agent_id, body)


@router.put("/{agent_id}/memory/{fact_id}", response_model=MemoryFact)
async def update_memory(
    request: Request, agent_id: str, fact_id: int, body: MemoryUpdate
) -> MemoryFact:
    _require_agent(request.app.state.settings_store, agent_id)
    fact = request.app.state.memory_store.update(agent_id, fact_id, body)
    if fact is None:
        raise HTTPException(status_code=404, detail=f"No fact #{fact_id} for '{agent_id}'")
    return fact


@router.delete("/{agent_id}/memory/{fact_id}")
async def delete_memory(request: Request, agent_id: str, fact_id: int) -> dict[str, str]:
    _require_agent(request.app.state.settings_store, agent_id)
    if not request.app.state.memory_store.delete(agent_id, fact_id):
        raise HTTPException(status_code=404, detail=f"No fact #{fact_id} for '{agent_id}'")
    return {"status": "ok"}
