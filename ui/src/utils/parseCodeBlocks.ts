/** Extract fenced code blocks from marked HTML output, split into segments. */

export interface CodeSegment {
  language: string;
  code: string;
}

export type ContentSegment =
  | { type: "html"; html: string }
  | { type: "code"; language: string; code: string };

const PRE_RE = /<pre><code(?:\s+class="language-([^"]*)")?>([\s\S]*?)<\/code><\/pre>/g;

function unescapeHtml(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

export function parseCodeBlocks(html: string): ContentSegment[] {
  const segments: ContentSegment[] = [];
  let lastIndex = 0;
  let m: RegExpExecArray | null;

  PRE_RE.lastIndex = 0;
  while ((m = PRE_RE.exec(html)) !== null) {
    const before = html.slice(lastIndex, m.index);
    if (before) segments.push({ type: "html", html: before });

    const lang = m[1] ?? "text";
    const code = unescapeHtml(m[2] ?? "").trim();
    segments.push({ type: "code", language: lang, code });

    lastIndex = PRE_RE.lastIndex;
  }

  const remainder = html.slice(lastIndex);
  if (remainder) segments.push({ type: "html", html: remainder });

  if (segments.length === 0) segments.push({ type: "html", html });
  return segments;
}
