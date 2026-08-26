"""Web fetch tool — fetch a URL and return its readable text content.

Local function-tool backed by ``httpx``. Always registered (no external
backend or API key needed): it issues a GET, follows redirects, and converts
HTML to plain text via the stdlib parser. Non-HTML text (JSON, Markdown,
plain text, XML) is returned verbatim; binary responses are summarised.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from html.parser import HTMLParser
from typing import Any

import httpx

import server_mode
from retry import TOOL_POLICY, with_retry
from tools.arg_coerce import clamp_int
from tools.base import BaseTool, ToolDefinition, ToolSchema
from tools.url_guard import blocked_reason

# Hard cap on returned characters so a huge page can't blow the context window.
DEFAULT_MAX_CHARS = 20_000
HARD_MAX_CHARS = 100_000
# Cap on bytes pulled off the wire before we stop reading the body.
MAX_DOWNLOAD_BYTES = 5_000_000
_TIMEOUT = 20.0
# Followed by hand, so the count is ours to enforce.
_MAX_REDIRECTS = 5


@dataclass(frozen=True)
class _Fetched:
    """What one successful download hands back to the formatting half."""

    raw: bytes
    content_type: str
    final_url: str
    encoding: str | None

# Tags whose textual content is noise — never emit anything inside them.
_SKIP_TAGS = {"script", "style", "noscript", "head", "template", "svg", "iframe"}
# Block-level tags that should force a line break around their content.
_BLOCK_TAGS = {
    "p", "div", "section", "article", "header", "footer", "main", "aside",
    "ul", "ol", "li", "tr", "table", "br", "hr", "blockquote", "pre",
    "h1", "h2", "h3", "h4", "h5", "h6", "figure", "figcaption", "nav",
}


class _TextExtractor(HTMLParser):
    """Collect human-readable text from HTML, dropping scripts/styles/markup."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._parts: list[str] = []
        self._skip_depth = 0
        self.title: str | None = None
        self._in_title = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in _SKIP_TAGS:
            self._skip_depth += 1
        elif tag == "title":
            self._in_title = True
        if tag in _BLOCK_TAGS:
            self._parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in _SKIP_TAGS and self._skip_depth > 0:
            self._skip_depth -= 1
        elif tag == "title":
            self._in_title = False
        if tag in _BLOCK_TAGS:
            self._parts.append("\n")

    def handle_data(self, data: str) -> None:
        # Capture <title> first — it lives inside <head>, which is skipped.
        if self._in_title and self.title is None:
            stripped = data.strip()
            if stripped:
                self.title = stripped
        if self._skip_depth > 0:
            return
        self._parts.append(data)

    def get_text(self) -> str:
        return "".join(self._parts)


def _collapse_whitespace(text: str) -> str:
    """Trim trailing spaces per line and collapse runs of blank lines."""
    lines = [re.sub(r"[ \t ]+", " ", line).strip() for line in text.splitlines()]
    out: list[str] = []
    blank = 0
    for line in lines:
        if line:
            blank = 0
            out.append(line)
        else:
            blank += 1
            if blank <= 1:
                out.append("")
    return "\n".join(out).strip()


def _html_to_text(html: str) -> tuple[str, str | None]:
    """Return (plain_text, title) extracted from an HTML document."""
    parser = _TextExtractor()
    try:
        parser.feed(html)
    except Exception:  # noqa: BLE001 — malformed HTML still yields partial text
        pass
    return _collapse_whitespace(parser.get_text()), parser.title


class WebFetchTool(BaseTool):
    """Fetch the contents of a web page or document by URL."""

    name = "web_fetch"
    description = (
        "Fetch a URL and return its readable text content. Use this to read a "
        "specific web page, article, or document the user references or that a "
        "web_search result points to. Accepts an http(s) URL; follows redirects. "
        "HTML is converted to plain text; JSON/Markdown/plain text is returned "
        "as-is. Output is truncated for very large pages — use max_chars to widen."
    )

    def get_definition(self) -> ToolDefinition:
        return ToolDefinition(
            function=ToolSchema(
                name=self.name,
                description=self.description,
                parameters={
                    "type": "object",
                    "properties": {
                        "url": {
                            "type": "string",
                            "description": "The http(s) URL to fetch.",
                        },
                        "max_chars": {
                            "type": "integer",
                            "description": (
                                "Maximum characters of content to return "
                                f"(default {DEFAULT_MAX_CHARS}, max {HARD_MAX_CHARS})."
                            ),
                        },
                    },
                    "required": ["url"],
                },
            )
        )

    async def execute(self, url: str, max_chars: int = DEFAULT_MAX_CHARS, **_: Any) -> str:
        url = (url or "").strip()
        if not re.match(r"^https?://", url, re.IGNORECASE):
            return f"[web_fetch error] Only http(s) URLs are supported — got: {url!r}"

        cap = clamp_int(max_chars, fallback=DEFAULT_MAX_CHARS, low=500, high=HARD_MAX_CHARS)
        # Loopback and the private ranges stay reachable on a desktop, where they
        # are the user's own machine, and are refused on a server-mode host,
        # where they are the operator's private surface — including this
        # backend's own token-guarded API. Link-local is refused either way.
        allow_local = not server_mode.enabled()

        async def download() -> _Fetched | str:
            """One whole attempt. Returns the payload, or a refusal that no
            number of retries could turn into a page."""
            async with httpx.AsyncClient(
                timeout=_TIMEOUT,
                # Redirects are followed by hand so each hop can be checked:
                # letting httpx follow them means only the URL the model typed
                # is ever inspected, and one 302 to 127.0.0.1 undoes the guard.
                follow_redirects=False,
                headers={"User-Agent": "AgentChat/1.0 (+web_fetch)"},
            ) as client:
                target = url
                for _hop in range(_MAX_REDIRECTS + 1):
                    denied = await blocked_reason(target, allow_local=allow_local)
                    if denied:
                        return f"[web_fetch error] refused — {denied}."

                    # Streamed, not `client.get(...).content`: that buffers the
                    # whole body before MAX_DOWNLOAD_BYTES can trim it, so a URL
                    # that turns out to be a disk image is a backend-sized
                    # allocation rather than a tool error. Here the connection is
                    # dropped at the cap.
                    async with client.stream("GET", target) as resp:
                        hop = resp.headers.get("location") if resp.is_redirect else None
                        if hop:
                            target = str(resp.url.join(hop))
                            continue

                        resp.raise_for_status()
                        chunks: list[bytes] = []
                        downloaded = 0
                        async for chunk in resp.aiter_bytes():
                            chunks.append(chunk)
                            downloaded += len(chunk)
                            if downloaded >= MAX_DOWNLOAD_BYTES:
                                break
                        return _Fetched(
                            raw=b"".join(chunks)[:MAX_DOWNLOAD_BYTES],
                            content_type=resp.headers.get("content-type", "").lower(),
                            final_url=str(resp.url),
                            encoding=resp.encoding,
                        )
                return (
                    f"[web_fetch error] more than {_MAX_REDIRECTS} redirects "
                    f"starting at {url}."
                )

        # A flaky link or a 503 gets a few more goes before the model is told the
        # web is broken — but only a few: the turn is stopped dead while we wait,
        # and a model that hears "fetch failed" can pick another source.
        try:
            fetched = await with_retry(download, TOOL_POLICY)
        except httpx.HTTPStatusError as exc:
            return f"[web_fetch error] HTTP {exc.response.status_code} for {url}"
        except httpx.HTTPError as exc:
            return f"[web_fetch error] {type(exc).__name__}: {exc}"
        if isinstance(fetched, str):
            return fetched
        raw, content_type, final_url, encoding = (
            fetched.raw, fetched.content_type, fetched.final_url, fetched.encoding,
        )

        # Binary / non-text payloads: don't dump bytes into the model.
        if not _is_textual(content_type, raw):
            return (
                f"[web_fetch] {final_url}\n"
                f"Content-Type: {content_type or 'unknown'} — "
                f"{len(raw)} bytes of non-text content (not rendered)."
            )

        try:
            text = raw.decode(encoding or "utf-8", errors="replace")
        except LookupError:
            # A server can name a charset Python has never heard of.
            text = raw.decode("utf-8", errors="replace")
        title: str | None = None
        if "html" in content_type or (not content_type and "<html" in text[:2000].lower()):
            text, title = _html_to_text(text)

        truncated = len(text) > cap
        body = text[:cap]

        header = f"[web_fetch] {final_url}"
        if title:
            header += f"\nTitle: {title}"
        if truncated:
            header += (
                f"\n[Truncated to {cap} of {len(text)} chars — "
                "call again with a larger max_chars to read more.]"
            )
        return f"{header}\n\n{body}".rstrip()


def _is_textual(content_type: str, raw: bytes) -> bool:
    """Heuristic: is this response something worth rendering as text?"""
    textual_markers = ("text/", "json", "xml", "html", "javascript", "csv", "markdown")
    if any(marker in content_type for marker in textual_markers):
        return True
    if content_type:  # an explicit non-text type
        return False
    # No content-type header — sniff for a NUL byte (binary signature).
    return b"\x00" not in raw[:1024]
