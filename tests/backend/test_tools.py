"""Tests for individual tools."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[2] / "backend"
sys.path.insert(0, str(BACKEND_DIR))

from agent.sandbox import SandboxPolicy
from tools.present_files import PresentFilesTool
from tools.write_file import WriteFileTool, _resolve_write_path


class TestBashTool:
    """TODO (Phase 1): mock subprocess, verify WSL command formatting."""

    def test_placeholder(self) -> None:
        assert True


class TestReadFileTool:
    """TODO (Phase 1): temp file + read, verify content."""

    def test_placeholder(self) -> None:
        assert True


def _tool(chat_dir: Path) -> WriteFileTool:
    """A restricted (sandboxed) write tool anchored at *chat_dir*, PowerShell
    namespace so we exercise the Windows local-fs path without needing WSL."""
    tool = WriteFileTool()
    tool.set_policy(SandboxPolicy(chat_dir=str(chat_dir), shell="powershell"))
    return tool


class TestWriteFileTool:
    @pytest.mark.asyncio
    async def test_create_new_file_with_relative_path(self, tmp_path: Path) -> None:
        tool = _tool(tmp_path)
        out = await tool.execute(path="sub/notes.txt", content="hello")
        assert out.startswith("Created")
        assert (tmp_path / "sub" / "notes.txt").read_text(encoding="utf-8") == "hello"

    @pytest.mark.asyncio
    async def test_overwrite_reports_overwrote(self, tmp_path: Path) -> None:
        tool = _tool(tmp_path)
        await tool.execute(path="a.txt", content="one")
        out = await tool.execute(path="a.txt", content="two")
        assert out.startswith("Overwrote")
        assert (tmp_path / "a.txt").read_text(encoding="utf-8") == "two"

    @pytest.mark.asyncio
    async def test_preserves_bom_on_overwrite(self, tmp_path: Path) -> None:
        f = tmp_path / "bom.txt"
        f.write_bytes(b"\xef\xbb\xbfold")
        await _tool(tmp_path).execute(path="bom.txt", content="new")
        assert f.read_bytes() == b"\xef\xbb\xbfnew"

    @pytest.mark.asyncio
    async def test_preserves_crlf_on_overwrite(self, tmp_path: Path) -> None:
        f = tmp_path / "crlf.txt"
        f.write_bytes(b"a\r\nb\r\n")
        await _tool(tmp_path).execute(path="crlf.txt", content="x\ny\n")
        assert f.read_bytes() == b"x\r\ny\r\n"

    @pytest.mark.asyncio
    async def test_new_file_keeps_content_lf(self, tmp_path: Path) -> None:
        await _tool(tmp_path).execute(path="lf.txt", content="x\ny\n")
        assert (tmp_path / "lf.txt").read_bytes() == b"x\ny\n"

    @pytest.mark.asyncio
    async def test_append(self, tmp_path: Path) -> None:
        tool = _tool(tmp_path)
        await tool.execute(path="log.txt", content="a")
        out = await tool.execute(path="log.txt", content="b", append=True)
        assert out.startswith("Appended")
        assert (tmp_path / "log.txt").read_text(encoding="utf-8") == "ab"

    @pytest.mark.asyncio
    async def test_directory_target_errors(self, tmp_path: Path) -> None:
        (tmp_path / "adir").mkdir()
        out = await _tool(tmp_path).execute(path="adir", content="x")
        assert out.startswith("Error")
        assert "directory" in out.lower()

    @pytest.mark.asyncio
    async def test_write_outside_chat_dir_rejected(self, tmp_path: Path) -> None:
        outside = str(tmp_path.parent / "escape.txt")
        out = await _tool(tmp_path).execute(path=outside, content="x")
        assert out.startswith("Error")
        assert "Sandbox" in out

    @pytest.mark.asyncio
    async def test_empty_path_errors(self, tmp_path: Path) -> None:
        out = await _tool(tmp_path).execute(path="   ", content="x")
        assert out.startswith("Error")

    @pytest.mark.asyncio
    async def test_non_string_content_is_coerced(self, tmp_path: Path) -> None:
        out = await _tool(tmp_path).execute(path="n.txt", content=123)  # type: ignore[arg-type]
        assert out.startswith("Created")
        assert (tmp_path / "n.txt").read_text(encoding="utf-8") == "123"

    @pytest.mark.asyncio
    async def test_unrestricted_allows_arbitrary_absolute(self, tmp_path: Path) -> None:
        tool = WriteFileTool()
        tool.set_policy(SandboxPolicy(unrestricted=True, shell="powershell"))
        target = tmp_path / "anywhere" / "x.txt"
        out = await tool.execute(path=str(target), content="ok")
        assert out.startswith("Created")
        assert target.read_text(encoding="utf-8") == "ok"

    def test_resolve_relative_against_chat_dir(self, tmp_path: Path) -> None:
        pol = SandboxPolicy(chat_dir=str(tmp_path), shell="powershell")
        assert _resolve_write_path("x/y.txt", pol) == str(tmp_path / "x" / "y.txt")


def _present_tool(chat_dir: Path) -> PresentFilesTool:
    tool = PresentFilesTool()
    tool.set_policy(SandboxPolicy(chat_dir=str(chat_dir), shell="powershell"))
    return tool


class TestPresentFilesTool:
    @pytest.mark.asyncio
    async def test_present_existing_relative_file(self, tmp_path: Path) -> None:
        (tmp_path / "r.md").write_text("hi", encoding="utf-8")
        out = await _present_tool(tmp_path).execute(paths=["r.md"])
        assert out.startswith("Presented 1 file")
        assert "r.md" in out

    @pytest.mark.asyncio
    async def test_single_string_is_coerced(self, tmp_path: Path) -> None:
        (tmp_path / "a.txt").write_text("x", encoding="utf-8")
        out = await _present_tool(tmp_path).execute(paths="a.txt")  # type: ignore[arg-type]
        assert out.startswith("Presented 1 file")

    @pytest.mark.asyncio
    async def test_missing_file_errors(self, tmp_path: Path) -> None:
        out = await _present_tool(tmp_path).execute(paths=["nope.md"])
        assert out.startswith("Error")
        assert "not found" in out

    @pytest.mark.asyncio
    async def test_outside_sandbox_skipped(self, tmp_path: Path) -> None:
        outside = tmp_path.parent / "escape.md"
        outside.write_text("x", encoding="utf-8")
        out = await _present_tool(tmp_path).execute(paths=[str(outside)])
        assert out.startswith("Error")
        assert "sandbox" in out.lower()

    @pytest.mark.asyncio
    async def test_mixed_present_and_skip(self, tmp_path: Path) -> None:
        (tmp_path / "ok.md").write_text("x", encoding="utf-8")
        out = await _present_tool(tmp_path).execute(paths=["ok.md", "missing.md"])
        assert out.startswith("Presented 1 file")
        assert "Skipped" in out

    @pytest.mark.asyncio
    async def test_empty_paths_errors(self, tmp_path: Path) -> None:
        out = await _present_tool(tmp_path).execute(paths=[])
        assert out.startswith("Error")
