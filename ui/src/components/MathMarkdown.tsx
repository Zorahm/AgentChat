/** Astryx's <Markdown/> with LaTeX that actually survives the parser.
 *
 * Rendering math takes two steps that must not be separated: lift the formulas
 * out of the source (`extractMath`), then hand the *rewritten* text to
 * <Markdown/> along with plugins built from those formulas
 * (`makeLatexPlugins`). Pairing them by hand at each call site is a standing
 * invitation to eventually pass the original text with the new plugins — which
 * fails silently, showing raw `$$…$$` with the backslashes eaten, exactly the
 * bug this replaced. So the pairing lives here and nowhere else.
 */

import { useMemo } from "react";
import { Markdown } from "@astryxdesign/core/Markdown";
import { extractMath } from "../utils/latexExtract";
import { makeLatexPlugins } from "../utils/latexPlugins";

export interface MathMarkdownProps {
  children: string;
  className?: string;
  display?: "block" | "inline";
  isStreaming?: boolean;
}

export function MathMarkdown({ children, className, display, isStreaming }: MathMarkdownProps) {
  // Memoised on the source: a streaming reply re-renders on every token, and
  // re-scanning the whole message each time is the one place this pass could
  // become expensive.
  const { text, math } = useMemo(() => extractMath(children), [children]);
  const plugins = useMemo(() => makeLatexPlugins(math), [math]);

  return (
    <Markdown display={display} isStreaming={isStreaming} className={className} inlinePlugins={plugins}>
      {text}
    </Markdown>
  );
}
