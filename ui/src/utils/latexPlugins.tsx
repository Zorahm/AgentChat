/** LaTeX support for Astryx's <Markdown/> — it has no built-in math rendering,
 *  so `$...$` / `$$...$$` render as raw text unless we plug KaTeX in via its
 *  `inlinePlugins` extension point (a Lexical-style TextMatchTransformer).
 *
 *  Block math is checked first so `$$x$$` isn't half-consumed by the inline
 *  pattern first (overlapping matches resolve by array order, see Astryx's
 *  Markdown `applyInlinePlugins`).
 */

import katex from "katex";
import type { MarkdownInlinePlugin } from "@astryxdesign/core/Markdown";

function renderKatex(latex: string, displayMode: boolean): string {
  return katex.renderToString(latex, {
    displayMode,
    throwOnError: false,
    output: "html",
    strict: "ignore",
  });
}

const blockMathPlugin: MarkdownInlinePlugin = {
  pattern: /\$\$([\s\S]+?)\$\$/g,
  render: (match, key) => (
    <span
      key={key}
      className="math-block"
      dangerouslySetInnerHTML={{ __html: renderKatex(match[1] ?? "", true) }}
    />
  ),
};

const inlineMathPlugin: MarkdownInlinePlugin = {
  // Currency guard mirrors the old parseMath.ts heuristics: opening `$` not
  // followed by whitespace, body can't start/end with whitespace or contain
  // a newline, closing `$` not immediately followed by a digit — so
  // "$5 and $10" stays plain text instead of being read as inline math.
  pattern: /\$(?!\s)([^\s$](?:[^$\n]*[^\s$])?)\$(?!\d)/g,
  render: (match, key) => (
    <span
      key={key}
      className="math-inline"
      dangerouslySetInnerHTML={{ __html: renderKatex(match[1] ?? "", false) }}
    />
  ),
};

/** Pass as `inlinePlugins` to every Astryx <Markdown/> instance that should
 *  render LaTeX. */
export const latexMarkdownPlugins: MarkdownInlinePlugin[] = [blockMathPlugin, inlineMathPlugin];
