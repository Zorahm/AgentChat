"""Tests for the .skill / .zip archive-tree builder."""

from __future__ import annotations

import io
import sys
import zipfile
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[2] / "backend"
sys.path.insert(0, str(BACKEND_DIR))

from api.files import _zip_tree


def _zip(files: dict[str, str]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, data in files.items():
            zf.writestr(name, data)
    return buf.getvalue()


def test_strips_single_wrapper_and_orders_dirs_first() -> None:
    data = _zip({
        "myskill/SKILL.md": "x",
        "myskill/scripts/run.py": "y",
        "myskill/examples/a.txt": "z",
    })
    tree = _zip_tree(data)

    # The lone wrapping "myskill/" dir is stripped — contents sit at the root,
    # dirs first (alphabetical), then files.
    root = [(e.name, e.is_dir) for e in tree if e.depth == 0]
    assert root == [("examples", True), ("scripts", True), ("SKILL.md", False)]

    nested = next(e for e in tree if e.path == "scripts/run.py")
    assert nested.depth == 1 and not nested.is_dir


def test_no_wrapper_when_multiple_top_level_entries() -> None:
    data = _zip({"SKILL.md": "x", "a.txt": "y"})
    tree = _zip_tree(data)
    names = sorted(e.name for e in tree if e.depth == 0)
    assert names == ["SKILL.md", "a.txt"]


def test_archive_file_endpoint_reads_member_through_wrapper(tmp_path: Path) -> None:
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from api.files import router

    arc = tmp_path / "myskill.skill"
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("wrap/SKILL.md", "---\nname: X\n---\nhello world\n")
    arc.write_bytes(buf.getvalue())

    app = FastAPI()
    app.include_router(router)
    client = TestClient(app)

    # Tree-relative member "SKILL.md" maps back to "wrap/SKILL.md".
    r = client.get("/files/archive-file", params={"path": str(arc), "member": "SKILL.md"})
    assert r.status_code == 200, r.text
    assert "hello world" in r.text

    r2 = client.get("/files/archive-file", params={"path": str(arc), "member": "nope.txt"})
    assert r2.status_code == 404
