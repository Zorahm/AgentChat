"""Web fetch tool — fetch a URL and return its readable text content.

Local function-tool backed by ``httpx``. Always registered (no external
backend or API key needed): it issues a GET, follows redirects, and converts
HTML to plain text via the stdlib parser. Non-HTML text (JSON, Markdown,
plain text, XML) is returned verbatim; binary responses are summarised.
"""

from __future__ import annotations

import re
from html.parser import HTMLParser
from typing import Any

import httpx

from tools.base import BaseTool, ToolDefinition, ToolSchema

# Hard cap on returned characters so a huge page can't blow the context window.
DEFAULT_MAX_CHARS = 20_000
HARD_MAX_CHARS = 100_000
# Cap on bytes pulled off the wire before we stop reading the body.
MAX_DOWNLOAD_BYTES = 5_000_000
_TIMEOUT = 20.0

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

        cap = max(500, min(int(max_chars), HARD_MAX_CHARS))
        try:
            async with httpx.AsyncClient(
                timeout=_TIMEOUT,
                follow_redirects=True,
                headers={"User-Agent": "AgentChat/1.0 (+web_fetch)"},
            ) as client:
                resp = await client.get(url)
                resp.raise_for_status()
                raw = resp.content[:MAX_DOWNLOAD_BYTES]
        except httpx.HTTPStatusError as exc:
            return f"[web_fetch error] HTTP {exc.response.status_code} for {url}"
        except httpx.HTTPError as exc:
            return f"[web_fetch error] {type(exc).__name__}: {exc}"

        content_type = resp.headers.get("content-type", "").lower()
        final_url = str(resp.url)

        # Binary / non-text payloads: don't dump bytes into the model.
        if not _is_textual(content_type, raw):
            return (
                f"[web_fetch] {final_url}\n"
                f"Content-Type: {content_type or 'unknown'} — "
                f"{len(raw)} bytes of non-text content (not rendered)."
            )

        text = raw.decode(resp.encoding or "utf-8", errors="replace")
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
