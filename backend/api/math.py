"""/api/math — re-check a claim, and read the verification history.

``POST /math/recheck`` is the **Re-check** button. It exists because the
deterministic verifier honestly cannot cover everything: a word problem, a
construction, a proof. Rather than pretend, those come back ``inconclusive``,
and this route spends one model call on an independent verifier that reads the
problem and the claim — and never the solution.

The route accepts a claim, not a message id, for exactly that reason. Looking
the solution up from the chat here would be one convenient line, and it would
quietly destroy the independence the whole contour is built on.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request

from llm.client import LLMClient
from llm.model_tag import retag_model_for_litellm
from mathkit.subagent import VerifierModel, verify_with_subagent
from schemas.math import RecheckRequest, VerifyOutcome

router = APIRouter(prefix="/math", tags=["math"])


def _endpoint(store: Any, model: str) -> tuple[VerifierModel, LLMClient]:
    """Resolve the verifier's provider the same way the chat path does."""
    resolved = model or store.default_model
    if not resolved:
        raise HTTPException(
            status_code=400,
            detail="No model is configured — set a default model in Settings first.",
        )
    provider = store.get_provider(resolved)
    api_key = provider.api_key if provider else None
    lite_model, api_key = retag_model_for_litellm(provider, resolved, api_key)
    api_base = provider.api_base if provider else None
    extra_headers = provider.extra_headers if provider else None
    return (
        VerifierModel(
            model=lite_model, api_key=api_key, api_base=api_base, extra_headers=extra_headers
        ),
        LLMClient(api_base=api_base, api_key=api_key, extra_headers=extra_headers),
    )


@router.post("/recheck")
async def recheck(request: Request, body: RecheckRequest) -> dict[str, Any]:
    """Run the independent verifier over one claim and record the result."""
    app_state = request.app.state
    endpoint, llm = _endpoint(app_state.settings_store, "")

    outcome: VerifyOutcome = await verify_with_subagent(
        llm=llm,
        endpoint=endpoint,
        pool=app_state.math_pool,
        kind=body.kind,
        problem=body.problem,
        claim=body.claim,
        seed=body.seed,
        # A manual re-check is never the automatic second attempt — it is a
        # separate opinion, and numbering it 2 would make the history read as
        # though the model had rewritten its answer.
        attempt=1,
        metadata={
            "chat_id": body.chat_id,
            "message_id": body.message_id,
            "canonical_model": app_state.settings_store.default_model,
            "context": "math_recheck",
        },
    )

    if body.message_id:
        try:
            app_state.verification_store.record(
                chat_id=body.chat_id, message_id=body.message_id, outcome=outcome
            )
        except Exception:  # noqa: BLE001 — history must not fail the re-check
            pass

    return outcome.model_dump(mode="json")


@router.get("/verifications/{message_id}")
async def for_message(request: Request, message_id: str) -> dict[str, Any]:
    """Every attempt recorded for one turn, oldest first.

    Oldest first is load-bearing: a refuted first attempt followed by a verified
    second one is the honest history, and showing only the winner is how the
    badge turns into decoration.
    """
    rows = request.app.state.verification_store.for_message(message_id)
    return {"message_id": message_id, "verifications": rows}


@router.get("/summary")
async def summary(request: Request) -> dict[str, Any]:
    """Counts per status — how much the badge is actually saying overall."""
    return {"counts": request.app.state.verification_store.summary()}
