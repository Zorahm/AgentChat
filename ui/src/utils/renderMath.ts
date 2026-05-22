/** KaTeX wrapper. Renders a `MathToken` to HTML.
 *
 * Block math is wrapped in `<span class="math-block">` (not `<div>`) so it
 * remains valid inside the `<p>` tags that `marked` produces. CSS gives the
 * span `display: block` and horizontal scroll on overflow.
 */

import katex from "katex";
import type { MathToken } from "./parseMath";

export function renderMathToken(token: MathToken): string {
  const html = katex.renderToString(token.body, {
    displayMode: token.kind === "block",
    throwOnError: false,
    output: "html",
    strict: "ignore",
  });
  const cls = token.kind === "block" ? "math-block" : "math-inline";
  return `<span class="${cls}">${html}</span>`;
}
