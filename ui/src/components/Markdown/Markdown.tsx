/** Shared markdown renderer.
 *
 * Uses `marked` (GFM enabled — tables, task lists, strikethrough) and pulls
 * fenced code blocks out so they can be syntax-highlighted by CodeBlockView
 * instead of going through raw HTML. With `math` enabled, LaTeX is extracted
 * before marked runs and restored as KaTeX HTML afterwards. Typography lives
 * in `styles/markdown.css` under the `.md` class — every caller picks it up
 * automatically.
 */

import { useMemo } from "react";
import { marked } from "marked";
import { parseCodeBlocks } from "../../utils/parseCodeBlocks";
import { CodeBlockView } from "../Chat/CodeBlockView";
import { extractMath, restoreMathInHtml, restoreMathAsLiteral } from "../../utils/parseMath";
import { renderMathToken } from "../../utils/renderMath";

interface MarkdownProps {
  text: string;
  /** Strip YAML frontmatter from the top (`--- ... ---`). */
  stripFrontmatter?: boolean;
  /** Convert single newlines to <br>. Useful for chat messages where each
   * line should stand alone; turn off for documents (SKILL.md, READMEs). */
  breaks?: boolean;
  /** Render LaTeX math via KaTeX. Default off — opt-in for chat. */
  math?: boolean;
  /** Extra class names merged with the base `md`. */
  className?: string;
}

function stripFrontmatterBlock(text: string): string {
  if (!text.startsWith("---")) return text;
  const rest = text.slice(3).replace(/^\r?\n/, "");
  const end = rest.search(/\r?\n---\r?\n?/);
  if (end === -1) return text;
  const after = rest.slice(end).replace(/^\r?\n---\r?\n?/, "");
  return after.replace(/^\r?\n+/, "");
}

export function Markdown({
  text,
  stripFrontmatter = false,
  breaks = true,
  math = false,
  className,
}: MarkdownProps) {
  const segments = useMemo(() => {
    let body = stripFrontmatter ? stripFrontmatterBlock(text) : text;
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
