"""Agent profile CRUD, plus the editor's variable palette and live preview.

An agent is a persisted persona a chat can be attached to: a name, a gradient
avatar, and a prompt *template* (see ``schemas.agents`` for the mode and
variable semantics). Mirrors the MCP server CRUD pattern — a flat list in
``settings.json``, no separate DB.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from agent.agent_prompt import build_agent_prompt
from agent.prompt import variables
from agent.prompt.registry import TOGGLEABLE_MODULES
from schemas.agents import (
    DEFAULT_AGENT_ID,
    AgentConfig,
    AgentCreate,
    AgentEditorMeta,
    AgentPreviewRequest,
    AgentPreviewResponse,
    AgentUpdate,
    PromptVariable,
)
from shell import resolve_active_shell

router = APIRouter(prefix="/agents", tags=["agents"])


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
