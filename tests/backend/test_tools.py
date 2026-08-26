"""Tests for individual tools."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[2] / "backend"
sys.path.insert(0, str(BACKEND_DIR))

from agent.sandbox import SandboxPolicy
from shell import resolve_active_shell
from tools.list_dir import ListDirTool
from tools.present_files import PresentFilesTool
from tools.read_file import ReadFileTool
from tools.show_widget import ShowWidgetTool
from tools.write_file import WriteFileTool, _resolve_write_path

# The shell whose path namespace matches this host: "powershell" on Windows,
# "posix" on Linux/macOS. The tools below are anchored at a real ``tmp_path``
# (``C:\…`` on Windows, ``/tmp/…`` elsewhere) and check_write rejects the other
# namespace outright, so the shell has to follow the host rather than be pinned.
HOST_SHELL = resolve_active_shell("powershell")


class TestBashTool:
    """TODO (Phase 1): mock subprocess, verify WSL command formatting."""

    def test_placeholder(self) -> None:
        assert True


class TestReadFileTool:
    """TODO (Phase 1): temp file + read, verify content."""

    def test_placeholder(self) -> None:
        assert True


def _tool(chat_dir: Path) -> WriteFileTool:
    """A restricted (sandboxed) write tool anchored at *chat_dir*, in the host's
    own namespace so we exercise the local-fs path without needing WSL."""
    tool = WriteFileTool()
    tool.set_policy(SandboxPolicy(chat_dir=str(chat_dir), shell=HOST_SHELL))
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
        tool.set_policy(SandboxPolicy(unrestricted=True, shell=HOST_SHELL))
        target = tmp_path / "anywhere" / "x.txt"
        out = await tool.execute(path=str(target), content="ok")
        assert out.startswith("Created")
        assert target.read_text(encoding="utf-8") == "ok"

    # Pure string resolution, nothing touches disk — so unlike the tests above
    # this one can cover both namespaces regardless of which host it runs on.
    @pytest.mark.parametrize(
        ("shell_mode", "chat_dir", "expected"),
        [
            (
                "powershell",
                "C:\\Users\\ZorahM\\AgentChat\\chats\\c1",
                "C:\\Users\\ZorahM\\AgentChat\\chats\\c1\\x\\y.txt",
            ),
            (
                "posix",
                "/home/zorahm/AgentChat/chats/c1",
                "/home/zorahm/AgentChat/chats/c1/x/y.txt",
            ),
        ],
        ids=["windows", "posix"],
    )
    def test_resolve_relative_against_chat_dir(
        self, shell_mode: str, chat_dir: str, expected: str
    ) -> None:
        pol = SandboxPolicy(chat_dir=chat_dir, shell=shell_mode)
        assert _resolve_write_path("x/y.txt", pol) == expected


def _present_tool(chat_dir: Path) -> PresentFilesTool:
    tool = PresentFilesTool()
    tool.set_policy(SandboxPolicy(chat_dir=str(chat_dir), shell=HOST_SHELL))
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


class TestShowWidgetTool:
    @pytest.mark.asyncio
    async def test_renders_with_title(self) -> None:
        out = await ShowWidgetTool().execute(html="<canvas></canvas>", title="MAU chart")
        assert out == 'Rendered the "MAU chart" widget for the user.'

    @pytest.mark.asyncio
    async def test_renders_without_title(self) -> None:
        out = await ShowWidgetTool().execute(html="<svg></svg>")
        assert out == 'Rendered the "visualization" widget for the user.'

    @pytest.mark.asyncio
    async def test_empty_html_errors(self) -> None:
        out = await ShowWidgetTool().execute(html="   ")
        assert out.startswith("Error")

    @pytest.mark.asyncio
    async def test_oversized_html_warns_but_renders(self) -> None:
        out = await ShowWidgetTool().execute(html="<div>" + "x" * (5 * 1024 * 1024) + "</div>")
        assert out.startswith("Rendered")
        assert "large" in out

    @pytest.mark.asyncio
    async def test_large_but_ok_html_no_warning(self) -> None:
        out = await ShowWidgetTool().execute(html="<div>" + "x" * (512 * 1024) + "</div>")
        assert out == 'Rendered the "visualization" widget for the user.'

    def test_definition_requires_html(self) -> None:
        schema = ShowWidgetTool().get_definition().function
        assert schema.name == "show_widget"
        assert schema.parameters["required"] == ["html"]
        assert set(schema.parameters["properties"]) == {"html", "title"}


def test_show_widget_registered_in_factory(tmp_path: Path) -> None:
    from skills.reader import AgentSkillsReader
    from tools.factory import build_tool_registry

    registry = build_tool_registry(AgentSkillsReader(tmp_path))
    assert registry.get("show_widget") is not None


def _list_tool(chat_dir: Path) -> ListDirTool:
    tool = ListDirTool()
    tool.set_policy(SandboxPolicy(chat_dir=str(chat_dir), shell=HOST_SHELL))
    return tool


class TestListDirTool:
    @pytest.mark.asyncio
    async def test_lists_folders_before_files_with_sizes(self, tmp_path: Path) -> None:
        (tmp_path / "notes.txt").write_text("hello", encoding="utf-8")
        (tmp_path / "src").mkdir()

        out = await _list_tool(tmp_path).execute()

        assert "2 entries" in out
        assert out.index("src/") < out.index("notes.txt")
        assert "5 B" in out

    @pytest.mark.asyncio
    async def test_depth_one_does_not_descend(self, tmp_path: Path) -> None:
        (tmp_path / "src").mkdir()
        (tmp_path / "src" / "main.py").write_text("x", encoding="utf-8")

        assert "main.py" not in await _list_tool(tmp_path).execute()
        assert "main.py" in await _list_tool(tmp_path).execute(depth=2)

    @pytest.mark.asyncio
    async def test_children_are_indented_under_their_folder(self, tmp_path: Path) -> None:
        (tmp_path / "src").mkdir()
        (tmp_path / "src" / "main.py").write_text("x", encoding="utf-8")

        lines = (await _list_tool(tmp_path).execute(depth=2)).splitlines()
        tree = [ln for ln in lines if ln and not ln.startswith("[")]
        assert tree[0] == "src/"
        assert tree[1].startswith("  main.py")

    @pytest.mark.asyncio
    async def test_pattern_filters_and_flattens(self, tmp_path: Path) -> None:
        (tmp_path / "src").mkdir()
        (tmp_path / "src" / "main.py").write_text("x", encoding="utf-8")
        (tmp_path / "README.md").write_text("x", encoding="utf-8")

        out = await _list_tool(tmp_path).execute(depth=2, pattern="*.py")

        assert "src/main.py" in out  # full relative path, not an indented tree
        assert "README.md" not in out

    @pytest.mark.asyncio
    async def test_noise_folders_are_listed_but_not_walked(self, tmp_path: Path) -> None:
        (tmp_path / ".git").mkdir()
        (tmp_path / ".git" / "config").write_text("x", encoding="utf-8")

        out = await _list_tool(tmp_path).execute(depth=3)

        assert ".git/" in out
        assert "config" not in out
        assert "Not descended into: .git" in out

    @pytest.mark.asyncio
    async def test_depth_is_clamped_and_junk_falls_back_to_one(self, tmp_path: Path) -> None:
        (tmp_path / "a").mkdir()
        (tmp_path / "a" / "b").mkdir()
        (tmp_path / "a" / "b" / "deep.txt").write_text("x", encoding="utf-8")

        assert "deep.txt" in await _list_tool(tmp_path).execute(depth=99)
        assert "deep.txt" not in await _list_tool(tmp_path).execute(depth="oops")

    @pytest.mark.asyncio
    async def test_sandbox_refuses_a_path_outside_the_chat_folder(self, tmp_path: Path) -> None:
        chat = tmp_path / "chat"
        chat.mkdir()
        (tmp_path / "secret").mkdir()

        out = await _list_tool(chat).execute(path=str(tmp_path / "secret"))

        assert out.startswith("Error: Sandbox")

    @pytest.mark.asyncio
    async def test_missing_directory_reports_not_found(self, tmp_path: Path) -> None:
        out = await _list_tool(tmp_path).execute(path=str(tmp_path / "nope"))
        assert "not found" in out

    @pytest.mark.asyncio
    async def test_a_file_path_points_at_read_file(self, tmp_path: Path) -> None:
        target = tmp_path / "a.txt"
        target.write_text("x", encoding="utf-8")

        out = await _list_tool(tmp_path).execute(path=str(target))

        assert "not a directory" in out
        assert "read_file" in out

    @pytest.mark.asyncio
    async def test_empty_folder_says_so(self, tmp_path: Path) -> None:
        assert "empty" in await _list_tool(tmp_path).execute()


class TestReadFileOnADirectory:
    @pytest.mark.asyncio
    async def test_read_file_points_at_list_dir(self, tmp_path: Path) -> None:
        """A directory used to come back as an errno or "not a regular file",
        which told the model nothing about what to call instead."""
        tool = ReadFileTool()
        tool.set_policy(SandboxPolicy(chat_dir=str(tmp_path), shell=HOST_SHELL))

        out = await tool.execute(path=str(tmp_path))

        assert "list_dir" in out


class TestWslListing:
    """The WSL branch of host_list_dir. Unreachable from a Windows-path test —
    tmp_path is `C:\\…` — so the `find` command and its output are pinned here."""

    @pytest.mark.asyncio
    async def test_find_command_prunes_noise_but_still_prints_it(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from types import SimpleNamespace

        from agent import wsl_exec

        seen: list[str] = []

        async def fake_run(cmd: str, **_: object) -> SimpleNamespace:
            seen.append(cmd)
            return SimpleNamespace(returncode=0, stdout=b"", stderr=b"")

        monkeypatch.setattr(wsl_exec, "wsl_run", fake_run)
        await wsl_exec.wsl_list_dir("/home/u/chat", depth=3, skip=frozenset({".git"}))

        cmd = seen[0]
        assert "-maxdepth 3" in cmd
        assert "-mindepth 1" in cmd
        # -prune with its own -printf: the folder is listed, just not walked.
        assert "-name .git" in cmd and "-prune -printf" in cmd

    @pytest.mark.asyncio
    async def test_find_output_becomes_entries(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from types import SimpleNamespace

        from agent import wsl_exec

        async def fake_run(_cmd: str, **_kw: object) -> SimpleNamespace:
            out = "d\t4096\tsrc\nf\t812\tsrc/main.py\nf\t0\tempty.txt\n"
            return SimpleNamespace(returncode=0, stdout=out.encode("utf-8"), stderr=b"")

        monkeypatch.setattr(wsl_exec, "wsl_run", fake_run)
        entries = await wsl_exec.wsl_list_dir("/home/u/chat", depth=2)

        assert [(e.rel, e.is_dir, e.size) for e in entries] == [
            ("src", True, 0),  # directories report no size, like the native walk
            ("src/main.py", False, 812),
            ("empty.txt", False, 0),
        ]

    @pytest.mark.asyncio
    async def test_a_missing_directory_raises_not_found(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from types import SimpleNamespace

        from agent import wsl_exec

        async def fake_run(_cmd: str, **_kw: object) -> SimpleNamespace:
            return SimpleNamespace(
                returncode=1, stdout=b"", stderr=b"find: '/nope': No such file or directory"
            )

        monkeypatch.setattr(wsl_exec, "wsl_run", fake_run)
        with pytest.raises(FileNotFoundError):
            await wsl_exec.wsl_list_dir("/nope")

    @pytest.mark.asyncio
    async def test_one_unreadable_subfolder_does_not_lose_the_listing(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """find exits non-zero on a permission error but still prints the rest."""
        from types import SimpleNamespace

        from agent import wsl_exec

        async def fake_run(_cmd: str, **_kw: object) -> SimpleNamespace:
            return SimpleNamespace(
                returncode=1,
                stdout=b"f\t10\ta.txt\n",
                stderr=b"find: '/home/u/chat/priv': Permission denied",
            )

        monkeypatch.setattr(wsl_exec, "wsl_run", fake_run)
        entries = await wsl_exec.wsl_list_dir("/home/u/chat")

        assert [e.rel for e in entries] == ["a.txt"]


def test_list_dir_registered_in_factory(tmp_path: Path) -> None:
    from skills.reader import AgentSkillsReader
    from tools.factory import build_tool_registry

    registry = build_tool_registry(AgentSkillsReader(tmp_path))
    assert registry.get("list_dir") is not None
