/** LaTeX support for Astryx's <Markdown/>, which has no math rendering of its own.
 *
 * The delimiters are NOT matched here. They can't be: `inlinePlugins` runs on
 * the text nodes the inline parser has already produced, and by then markdown
 * has eaten every backslash as an escape and split the formula across several
 * nodes, so a `$$…$$` pattern never matches. See `latexExtract.ts` for the
 * evidence and the way around it.
 *
 * What this file does instead is render the sentinels that pass left behind.
 * The latex has never touched the markdown parser, so it reaches KaTeX exactly
 * as the model wrote it. The two steps have to be used together — call
 * `extractMath` on the source, hand the text to <Markdown/> and the formulas to
 * `makeLatexPlugins`.
 */

import katex from "katex";
import type { MarkdownInlinePlugin } from "@astryxdesign/core/Markdown";
import { MATH_SENTINEL_RE, type ExtractedMath } from "./latexExtract";

function renderKatex(latex: string, displayMode: boolean): string {
  return katex.renderToString(latex, {
    displayMode,
    throwOnError: false,
    output: "html",
    strict: "ignore",
  });
}

/** Build the plugin list for one rendered message.
 *
 * Per message rather than shared, because the plugin closes over that message's
 * own formulas — the sentinel carries an index into this list and nothing else.
 */
export function makeLatexPlugins(math: ExtractedMath[]): MarkdownInlinePlugin[] {
  if (math.length === 0) return [];
  return [
    {
      pattern: MATH_SENTINEL_RE,
      render: (match, key) => {
        const found = math[Number(match[1])];
        // A sentinel with no formula behind it cannot happen from `extractMath`,
        // but rendering nothing is the safe answer if it ever does: the
        // alternative is throwing inside a render and blanking the message.
        if (!found) return <span key={key} />;
        return (
          <span
            key={key}
            className={found.displayMode ? "math-block" : "math-inline"}
            dangerouslySetInnerHTML={{
              __html: renderKatex(found.latex, found.displayMode),
            }}
          />
        );
      },
    },
  ];
}
