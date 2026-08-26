"""What a tool is allowed to pull into the conversation, and what it must refuse.

Every case here is a way a single tool call used to end the turn rather than
report a problem: unbounded output, an unbounded read, a file that isn't text,
or an exception mislabelled as the model's fault.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[2] / "backend"
sys.path.insert(0, str(BACKEND_DIR))

from agent.exec_common import trim_partial_utf8
from agent.sandbox import SandboxPolicy
from agent.untrusted import untrusted_source
from tools import read_file as read_file_mod
from tools.bash_tool import DEFAULT_TIMEOUT, MAX_TIMEOUT, _clamp_timeout, _format_result
from tools.base import BaseTool, ToolDefinition, ToolSchema
from tools.output_budget import MAX_TOOL_OUTPUT_CHARS, clamp_output
from tools.shell_exec import ShellResult
from tools.read_file import ReadFileTool
from tools.read_photo import ReadPhotoTool
from tools.read_ledger import ReadLedger
from tools.registry import ToolRegistry
from tools.url_guard import blocked_reason
from tools.write_file import WriteFileTool
from shell import resolve_active_shell

# The shell whose path namespace matches this host — tmp_path is ``C:\…`` on
# Windows and ``/tmp/…`` elsewhere, and check_write rejects the other outright.
HOST_SHELL = resolve_active_shell("powershell")


def _reader() -> ReadFileTool:
    tool = ReadFileTool()
    tool.set_policy(SandboxPolicy(unrestricted=True))
    return tool


class TestClampOutput:
    def test_output_under_the_limit_is_untouched(self) -> None:
        assert clamp_output("short") == "short"

    def test_both_ends_survive_the_cut(self) -> None:
        text = "HEAD" + ("x" * 50_000) + "TAIL"

        out = clamp_output(text, limit=1_000)

        assert out.startswith("HEAD")
        assert out.endswith("TAIL")

    def test_the_cut_is_announced_with_its_size(self) -> None:
        out = clamp_output("y" * 5_000, limit=1_000)

        assert "4000 characters cut" in out

    def test_the_result_stays_within_a_predictable_bound(self) -> None:
        """The marker adds a fixed prefix; the payload itself never exceeds the
        limit, which is what makes the context cost of a tool call bounded."""
        out = clamp_output("z" * 1_000_000, limit=MAX_TOOL_OUTPUT_CHARS)

        assert len(out) < MAX_TOOL_OUTPUT_CHARS + 500


class TestBashOutputBudget:
    @staticmethod
    def _result(stdout: str, stderr: str = "", code: int = 0) -> ShellResult:
        return ShellResult(stdout=stdout, stderr=stderr, returncode=code)

    def test_a_flood_of_stdout_is_clamped(self) -> None:
        out = _format_result(self._result("a" * 500_000))

        assert len(out) < MAX_TOOL_OUTPUT_CHARS + 500

    def test_the_exit_code_survives_a_flood(self) -> None:
        """Clamped per stream, so stdout can never push out the two markers the
        loop reads to decide the call failed (see agent.tool_outcome)."""
        out = _format_result(self._result("a" * 500_000, "boom", code=2))

        assert "[exit code: 2]" in out
        assert "[stderr]\nboom" in out


class TestBashTimeout:
    def test_the_default_applies_when_unset(self) -> None:
        assert _clamp_timeout(None) == DEFAULT_TIMEOUT

    def test_a_string_from_the_model_still_works(self) -> None:
        assert _clamp_timeout("45") == 45

    def test_nonsense_falls_back_rather_than_raising(self) -> None:
        assert _clamp_timeout("soon") == DEFAULT_TIMEOUT

    def test_the_ceiling_holds(self) -> None:
        assert _clamp_timeout(99_999) == MAX_TIMEOUT

    def test_zero_is_lifted_to_a_second(self) -> None:
        """A 0s timeout would kill every command instantly."""
        assert _clamp_timeout(0) == 1


class TestTrimPartialUtf8:
    def test_ascii_is_untouched(self) -> None:
        assert trim_partial_utf8(b"hello") == b"hello"

    def test_a_complete_sequence_is_kept(self) -> None:
        assert trim_partial_utf8("привет".encode("utf-8")) == "привет".encode("utf-8")

    def test_a_dangling_lead_byte_is_dropped(self) -> None:
        raw = "привет".encode("utf-8")[:-1]  # cuts the last 2-byte char in half

        assert trim_partial_utf8(raw).decode("utf-8") == "приве"

    def test_a_dangling_four_byte_sequence_is_dropped(self) -> None:
        raw = "a😀".encode("utf-8")[:-2]

        assert trim_partial_utf8(raw).decode("utf-8") == "a"


class TestReadFileRefusesNonText:
    @pytest.mark.asyncio
    async def test_a_binary_file_names_the_tool_that_can_read_it(self, tmp_path: Path) -> None:
        """Only the Windows-local branch used to notice; WSL and native POSIX
        decode leniently and returned a screen of mojibake as if it worked."""
        target = tmp_path / "logo.png"
        target.write_bytes(b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR" + b"\x00" * 200)

        out = await _reader().execute(path=str(target))

        assert out.startswith("Error:")
        assert "read_photo" in out

    @pytest.mark.asyncio
    async def test_a_non_utf8_text_file_says_so(self, tmp_path: Path) -> None:
        target = tmp_path / "legacy.txt"
        target.write_bytes("Привет, мир".encode("cp1251"))

        out = await _reader().execute(path=str(target))

        assert out.startswith("Error:")
        assert "iconv" in out

    @pytest.mark.asyncio
    async def test_a_utf8_bom_is_stripped_not_shown(self, tmp_path: Path) -> None:
        target = tmp_path / "bom.txt"
        target.write_bytes(b"\xef\xbb\xbfhello")

        assert await _reader().execute(path=str(target)) == "hello"


class TestReadFileSizeCeiling:
    @pytest.mark.asyncio
    async def test_a_huge_file_is_clipped_and_says_where_to_go(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(read_file_mod, "HARD_READ_BYTES", 100)
        target = tmp_path / "big.log"
        target.write_text("line\n" * 500, encoding="utf-8")

        out = await _reader().execute(path=str(target))

        assert "larger than 100 bytes" in out
        assert "bash_tool" in out
        assert len(out) < 1_000  # the other 2400 bytes never entered the process

    @pytest.mark.asyncio
    async def test_the_clip_notice_survives_offset_and_limit(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Appending it to the content would have put it on the last line —
        exactly the part a windowed read cuts off."""
        monkeypatch.setattr(read_file_mod, "HARD_READ_BYTES", 100)
        target = tmp_path / "big.log"
        target.write_text("line\n" * 500, encoding="utf-8")

        out = await _reader().execute(path=str(target), offset=2, limit=3)

        assert "larger than 100 bytes" in out

    @pytest.mark.asyncio
    async def test_a_string_offset_does_not_raise(self, tmp_path: Path) -> None:
        target = tmp_path / "a.txt"
        target.write_text("one\ntwo\nthree\n", encoding="utf-8")

        out = await _reader().execute(path=str(target), offset="2", limit="1")  # type: ignore[arg-type]

        assert "two" in out
        assert "one" not in out


class TestReadPhotoFormats:
    @pytest.mark.asyncio
    async def test_svg_points_at_read_file_instead_of_failing_the_request(self) -> None:
        """SVG was advertised as supported and sent as a data URL, which no
        vision API decodes — the provider rejected the whole request."""
        tool = ReadPhotoTool()
        tool.set_policy(SandboxPolicy(unrestricted=True))

        out = await tool.execute(path="/tmp/diagram.svg")

        assert out.startswith("Error:")
        assert "read_file" in out

    @pytest.mark.asyncio
    async def test_bmp_names_the_conversion(self) -> None:
        tool = ReadPhotoTool()
        tool.set_policy(SandboxPolicy(unrestricted=True))

        out = await tool.execute(path="/tmp/scan.bmp")

        assert "PNG" in out


class _Exploding(BaseTool):
    """A tool whose *body* raises TypeError, with a signature that binds fine."""

    name = "exploding"
    description = "raises"

    def get_definition(self) -> ToolDefinition:
        return ToolDefinition(function=ToolSchema(name=self.name, description=self.description))

    async def execute(self, value: str = "") -> str:
        return "x" + 1  # type: ignore[operator]


class TestRegistryErrorAttribution:
    @pytest.mark.asyncio
    async def test_an_internal_typeerror_is_not_blamed_on_the_arguments(self) -> None:
        """Reporting it as bad arguments sent the model to fix a call that was
        correct — and the retry failed identically."""
        registry = ToolRegistry()
        registry.register(_Exploding())

        out = await registry.execute("exploding", {"value": "ok"})

        assert "invalid arguments" not in out
        assert "TypeError" in out

    @pytest.mark.asyncio
    async def test_genuinely_wrong_arguments_still_say_so(self) -> None:
        registry = ToolRegistry()
        registry.register(_Exploding())

        out = await registry.execute("exploding", {"nope": 1})

        assert "invalid arguments" in out

    @pytest.mark.asyncio
    async def test_the_tool_never_raises_into_the_loop(self) -> None:
        registry = ToolRegistry()
        registry.register(_Exploding())

        assert (await registry.execute("exploding", {})).startswith("Error:")


class TestWriteFileReporting:
    """The overwrite path now inspects only the head of an existing file, so the
    two things it inspects for have to keep working."""

    @staticmethod
    def _writer(chat: Path) -> WriteFileTool:
        tool = WriteFileTool()
        tool.set_policy(SandboxPolicy(chat_dir=str(chat), shell=HOST_SHELL))
        return tool

    @pytest.mark.asyncio
    async def test_an_existing_bom_survives_an_overwrite(self, tmp_path: Path) -> None:
        target = tmp_path / "bom.txt"
        target.write_bytes(b"\xef\xbb\xbfold\r\n")

        await self._writer(tmp_path).execute(path=str(target), content="new\n")

        assert target.read_bytes().startswith(b"\xef\xbb\xbf")

    @pytest.mark.asyncio
    async def test_existing_crlf_endings_survive_an_overwrite(self, tmp_path: Path) -> None:
        target = tmp_path / "crlf.txt"
        target.write_bytes(b"one\r\ntwo\r\n")

        await self._writer(tmp_path).execute(path=str(target), content="three\nfour\n")

        assert target.read_bytes() == b"three\r\nfour\r\n"

    @pytest.mark.asyncio
    async def test_append_reports_the_bytes_it_added(self, tmp_path: Path) -> None:
        """Not the file's total size: a model splitting a long file across
        appends read that back as proof it had written far more than it had."""
        target = tmp_path / "log.txt"
        target.write_text("x" * 1000, encoding="utf-8")

        out = await self._writer(tmp_path).execute(
            path=str(target), content="tail", append=True
        )

        assert "4 bytes" in out


class TestUrlGuard:
    """web_fetch is the one tool whose target can be named by the content it
    just read, which is what makes it the SSRF surface."""

    @pytest.mark.asyncio
    async def test_cloud_metadata_is_refused_even_on_a_desktop(self) -> None:
        denied = await blocked_reason(
            "http://169.254.169.254/latest/meta-data/", allow_local=True
        )

        assert denied is not None
        assert "link-local" in denied

    @pytest.mark.asyncio
    async def test_loopback_is_allowed_on_a_desktop(self) -> None:
        """'Read what my dev server is serving' is a real request on the machine
        the user is sitting at."""
        assert await blocked_reason("http://127.0.0.1:3000/", allow_local=True) is None

    @pytest.mark.asyncio
    async def test_loopback_is_refused_in_server_mode(self) -> None:
        """There, loopback is the backend's own token-guarded API."""
        assert await blocked_reason("http://127.0.0.1:8787/api/settings", allow_local=False)

    @pytest.mark.asyncio
    async def test_private_ranges_are_refused_in_server_mode(self) -> None:
        assert await blocked_reason("http://192.168.1.1/", allow_local=False)

    @pytest.mark.asyncio
    async def test_an_ipv6_mapped_loopback_does_not_slip_through(self) -> None:
        assert await blocked_reason("http://[::ffff:127.0.0.1]/", allow_local=False)

    @pytest.mark.asyncio
    async def test_ordinary_public_hosts_pass(self) -> None:
        assert await blocked_reason("https://example.com/page", allow_local=False) is None


class TestUploadLedger:
    """Overwriting a user's attachment unread destroys the only copy."""

    @staticmethod
    def _pair(chat: Path) -> tuple[ReadFileTool, WriteFileTool]:
        ledger = ReadLedger()
        policy = SandboxPolicy(chat_dir=str(chat), shell=HOST_SHELL)
        reader, writer = ReadFileTool(), WriteFileTool()
        for tool in (reader, writer):
            tool.set_policy(policy)
            tool.set_ledger(ledger)  # type: ignore[attr-defined]
        return reader, writer

    @pytest.mark.asyncio
    async def test_an_unread_upload_is_not_overwritten(self, tmp_path: Path) -> None:
        uploads = tmp_path / "uploads"
        uploads.mkdir()
        target = uploads / "contract.md"
        target.write_text("the user's original", encoding="utf-8")
        _, writer = self._pair(tmp_path)

        out = await writer.execute(path=str(target), content="replaced")

        assert out.startswith("Error:")
        assert target.read_text(encoding="utf-8") == "the user's original"

    @pytest.mark.asyncio
    async def test_reading_it_first_unlocks_the_write(self, tmp_path: Path) -> None:
        uploads = tmp_path / "uploads"
        uploads.mkdir()
        target = uploads / "contract.md"
        target.write_text("the user's original", encoding="utf-8")
        reader, writer = self._pair(tmp_path)

        await reader.execute(path=str(target))
        await writer.execute(path=str(target), content="replaced")

        assert target.read_text(encoding="utf-8") == "replaced"

    @pytest.mark.asyncio
    async def test_a_new_file_beside_an_upload_is_not_blocked(self, tmp_path: Path) -> None:
        uploads = tmp_path / "uploads"
        uploads.mkdir()
        _, writer = self._pair(tmp_path)

        out = await writer.execute(path=str(uploads / "summary.md"), content="new")

        assert out.startswith("Created")

    @pytest.mark.asyncio
    async def test_the_agents_own_workspace_stays_friction_free(self, tmp_path: Path) -> None:
        """The rule is scoped to uploads/ on purpose: making the agent re-read
        its own draft before every rewrite costs a round trip and prevents
        nothing."""
        draft = tmp_path / "report.md"
        draft.write_text("draft one", encoding="utf-8")
        _, writer = self._pair(tmp_path)

        out = await writer.execute(path=str(draft), content="draft two")

        assert out.startswith("Overwrote")


class TestUntrustedSources:
    def test_web_search_results_are_fenced(self) -> None:
        """Titles and snippets are written by whoever owns the page — the same
        boundary web_fetch crosses, reached without the model picking a URL."""
        assert untrusted_source("web_search", {"query": "x"}) is not None

    def test_agent_generated_output_is_not_fenced(self) -> None:
        assert untrusted_source("bash_tool", {"command": "ls"}) is None
