/** Shared markdown renderer.
 *
 * Uses `marked` (GFM enabled — tables, task lists, strikethrough) and pulls
 * fenced code blocks out so they can be syntax-highlighted by CodeBlockView
 * instead of going through raw HTML. With `math` enabled, LaTeX is extracted
 * before marked runs and restored as KaTeX HTML afterwards. Typography lives
 * in `styles/markdown.css` under the `.md` class — every caller picks it up
 * automatically.
 *
 * Extensions: definition lists (marked-definition-lists), footnotes (custom).
 */

import { useMemo } from "react";
import { marked } from "marked";
import { parseCodeBlocks } from "../../utils/parseCodeBlocks";
import { CodeBlockView } from "../Chat/CodeBlockView";
import { extractMath, restoreMathInHtml, restoreMathAsLiteral } from "../../utils/parseMath";
import { renderMathToken } from "../../utils/renderMath";

interface MarkdownProps {
  text: string;
  stripFrontmatter?: boolean;
  breaks?: boolean;
  math?: boolean;
  className?: string;
}

// SKILL.md files routinely start with a BOM and/or a leading blank line before
// the `---` fence (the backend parser strips these too). Normalize first so the
// `startsWith("---")` check below doesn't miss the frontmatter.
function normalizeFrontmatterText(text: string): string {
  return text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/^\n+/, "");
}

function stripFrontmatterBlock(text: string): string {
  const src = normalizeFrontmatterText(text);
  if (!src.startsWith("---")) return text;
  const rest = src.slice(3).replace(/^\n/, "");
  const end = rest.search(/\n---\n?/);
  if (end === -1) return text;
  return rest.slice(end).replace(/^\n---\n?/, "").replace(/^\n+/, "");
}

function extractYamlFrontmatter(text: string): { yaml: string | null; body: string } {
  const src = normalizeFrontmatterText(text);
  if (!src.startsWith("---")) return { yaml: null, body: text };
  const rest = src.slice(3).replace(/^\n/, "");
  const end = rest.search(/\n---\n?/);
  if (end === -1) return { yaml: null, body: text };
  return {
    yaml: rest.slice(0, end),
    body: rest.slice(end).replace(/^\n---\n?/, "").replace(/^\n+/, ""),
  };
}

function preprocessFootnotes(src: string): string {
  const defs: Array<{ id: string; content: string }> = [];
  let text = src.replace(/^\[\^(\w+)\]:\s*(.*?)(?=\n(?:\n|\[\^)|$)/gms, (_, id: string, content: string) => {
    defs.push({ id, content: content.trim() });
    return "";
  });

  if (defs.length === 0) return text;

  text = text.replace(/\[\^(\w+)\]/g, (_, id: string) => {
    const idx = defs.findIndex((d) => d.id === id);
    if (idx === -1) return `[^${id}]`;
    return `<sup class="fn-ref"><a href="#fn-${id}" id="fnref-${id}">${idx + 1}</a></sup>`;
  });

  text += `\n\n<section class="fn-list">\n<ol>\n`;
  for (const def of defs) {
    text += `<li id="fn-${def.id}">${def.content} <a href="#fnref-${def.id}" class="fn-back">↩</a></li>\n`;
  }
  text += `</ol>\n</section>\n`;
  return text;
}

function stripHeadingNumbers(text: string): string {
  return text.replace(/^(#{1,6})(\s*)(?:\d+[\.\)]?\s*)*(¶\s*)?/gm, "$1$2");
}

export function Markdown({
  text,
  stripFrontmatter = false,
  breaks = true,
  math = false,
  className,
}: MarkdownProps) {
  const segments = useMemo(() => {
    let body = text;
    let yamlBlock: string | null = null;

    if (stripFrontmatter) {
      body = stripFrontmatterBlock(body);
    } else {
      const parsed = extractYamlFrontmatter(body);
      yamlBlock = parsed.yaml;
      body = parsed.body;
    }

    body = preprocessFootnotes(body);
    body = stripHeadingNumbers(body);

    const mathResult = math ? extractMath(body) : null;
    if (mathResult) body = mathResult.text;

    let html: string;
    try {
      const out = marked.parse(body, { gfm: true, breaks });
      html = typeof out === "string" ? out : "";
    } catch {
      html = body;
    }

    const segs = parseCodeBlocks(html);

    if (yamlBlock) {
      segs.unshift({
        type: "code",
        language: "yaml",
        code: yamlBlock,
      });
    }

    if (!mathResult) return segs;

    return segs.map((seg) => {
      if (seg.type === "code") {
        return {
          ...seg,
          code: restoreMathAsLiteral(seg.code, mathResult.tokens),
        };
      }
      return {
        ...seg,
        html: restoreMathInHtml(seg.html, mathResult.tokens, renderMathToken),
      };
    });
  }, [text, stripFrontmatter, breaks, math]);

  const cls = className ? `md ${className}` : "md";
  return (
    <div className={cls}>
      {segments.map((seg, i) =>
        seg.type === "code" ? (
          <CodeBlockView key={i} language={seg.language} code={seg.code} />
        ) : seg.html ? (
          <div key={i} dangerouslySetInnerHTML={{ __html: seg.html }} />
        ) : null
      )}
    </div>
  );
}
