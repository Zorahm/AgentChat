"""Agent profile CRUD.

An agent is a persisted persona a chat can be attached to: a name, a
gradient avatar, and an optional system-prompt override (see
``api.schemas.agents`` for the override semantics). Mirrors the MCP server
CRUD pattern — a flat list in ``settings.json``, no separate DB.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from agent.system_prompt import build_system_prompt
from api.schemas.agents import DEFAULT_AGENT_ID, AgentConfig, AgentCreate, AgentUpdate
from shell import resolve_active_shell

router = APIRouter(prefix="/agents", tags=["agents"])


@router.get("", response_model=list[AgentConfig])
async def list_agents(request: Request) -> list[AgentConfig]:
    store = request.app.state.settings_store
    return store.list_agents()


@router.get("/default-prompt")
async def get_default_prompt(request: Request) -> dict[str, str]:
    """Live snapshot of the built-in dynamic system prompt.

    Used by the agent editor's "load current default" button so a user
    customizing tone starts from the real tool/sandbox/safety instructions
    instead of blank text.
    """
    store = request.app.state.settings_store
    prompt = build_system_prompt(
        user_name=store.user_name,
        shell=resolve_active_shell(store.shell_preference),
        describe_actions=store.describe_actions,
    )
    return {"prompt": prompt}


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
    return {"status": "ok"}
