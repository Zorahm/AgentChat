"""The verification history table.

Append-only and ordered oldest-first, because the pair that matters is a refuted
first attempt followed by a verified rewrite. Keeping only the winner is exactly
how a verification badge turns into theatre.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[2] / "backend"
sys.path.insert(0, str(BACKEND_DIR))

from schemas.math import VerifyOutcome  # noqa: E402
from store.verification_store import VerificationStore  # noqa: E402


@pytest.fixture()
def store(tmp_path: Path) -> VerificationStore:
    return VerificationStore(tmp_path / "verifications.db")


def outcome(status: str, attempt: int = 1, **over: object) -> VerifyOutcome:
    return VerifyOutcome(
        status=status,  # type: ignore[arg-type]
        kind="root",
        problem="x^2 - 5x + 6 = 0",
        claim={"roots": ["2", "3"]},
        detail=f"{status} detail",
        attempt=attempt,
        **over,  # type: ignore[arg-type]
    )


def test_a_verdict_round_trips(store: VerificationStore) -> None:
    store.record(chat_id="c1", message_id="m1", outcome=outcome("verified"))
    rows = store.for_message("m1")
    assert len(rows) == 1
    assert rows[0]["status"] == "verified"
    assert rows[0]["claim"] == {"roots": ["2", "3"]}
    assert rows[0]["result"]["detail"] == "verified detail"


def test_both_attempts_survive_and_stay_in_order(store: VerificationStore) -> None:
    store.record(chat_id="c1", message_id="m1", outcome=outcome("refuted", attempt=1))
    store.record(chat_id="c1", message_id="m1", outcome=outcome("verified", attempt=2))

    rows = store.for_message("m1")
    assert [r["status"] for r in rows] == ["refuted", "verified"]
    assert [r["attempt"] for r in rows] == [1, 2]


def test_messages_are_kept_apart(store: VerificationStore) -> None:
    store.record(chat_id="c1", message_id="m1", outcome=outcome("verified"))
    store.record(chat_id="c1", message_id="m2", outcome=outcome("refuted"))
    assert len(store.for_message("m1")) == 1
    assert store.for_message("m2")[0]["status"] == "refuted"


def test_a_chats_history_can_be_read_back(store: VerificationStore) -> None:
    store.record(chat_id="c1", message_id="m1", outcome=outcome("verified"))
    store.record(chat_id="c2", message_id="m2", outcome=outcome("refuted"))
    assert len(store.for_chat("c1")) == 1


def test_the_subagent_verdict_is_distinguishable(store: VerificationStore) -> None:
    """Which verifier spoke is part of what the badge is claiming."""
    store.record(
        chat_id="c1", message_id="m1", outcome=outcome("verified", verifier="subagent")
    )
    assert store.for_message("m1")[0]["verifier"] == "subagent"


def test_summary_counts_by_status(store: VerificationStore) -> None:
    store.record(chat_id="c1", message_id="m1", outcome=outcome("verified"))
    store.record(chat_id="c1", message_id="m2", outcome=outcome("verified"))
    store.record(chat_id="c1", message_id="m3", outcome=outcome("inconclusive"))
    assert store.summary() == {"verified": 2, "inconclusive": 1}


def test_deleting_a_chat_purges_its_history(store: VerificationStore) -> None:
    """History lives in its own database, so the chat row going away leaves it."""
    store.record(chat_id="c1", message_id="m1", outcome=outcome("verified"))
    store.record(chat_id="c2", message_id="m2", outcome=outcome("verified"))

    assert store.delete_chat("c1") == 1
    assert store.for_message("m1") == []
    assert len(store.for_message("m2")) == 1


def test_deleting_nothing_is_harmless(store: VerificationStore) -> None:
    assert store.delete_chat("") == 0
    assert store.delete_chat("never-existed") == 0


def test_reopening_the_database_keeps_the_rows(tmp_path: Path) -> None:
    path = tmp_path / "verifications.db"
    first = VerificationStore(path)
    first.record(chat_id="c1", message_id="m1", outcome=outcome("verified"))
    first.close()

    assert len(VerificationStore(path).for_message("m1")) == 1
