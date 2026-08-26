/** Regression suite for LaTeX surviving the markdown parser.
 *
 * Astryx's <Markdown/> has no math support, so KaTeX is plugged in through its
 * `inlinePlugins` hook. That hook runs on the *text nodes the inline parser has
 * already produced*, and the parser does two things to a math span first:
 *
 *  - `\X` is markdown's escape syntax, so `\frac` becomes the text `frac` —
 *    every backslash in the formula is silently eaten;
 *  - each escape ends the current text run, so one `$$…$$` span is shattered
 *    across several nodes. A plugin matching `$$(.+?)$$` per node can never
 *    fire, because the opening and closing delimiters land in different ones.
 *
 * Together those turned every formula in a reply into mangled plain text
 * (`$$x^2 quadRightarrowquad x_1 = 3$$`). The fix is to lift math out of the
 * source *before* the parser sees it and leave a sentinel behind, so what these
 * tests actually pin is: the latex arrives at KaTeX byte-for-byte, the sentinel
 * survives markdown, and nothing that merely looks like math is captured.
 */

import { extractMath, MATH_SENTINEL_RE } from "../../../ui/src/utils/latexExtract";
import { assert, report, section, test } from "./assert";

section("Math extraction");

test("a display formula keeps every backslash", () => {
  const src = String.raw`$$x^2 - 5x + 6 = 0 \quad\Rightarrow\quad x_1 = 3$$`;
  const { math } = extractMath(src);

  assert(math.length === 1, `expected 1 formula, got ${math.length}`);
  assert(math[0]!.displayMode, "display formula not marked as display");
  assert(
    math[0]!.latex === String.raw`x^2 - 5x + 6 = 0 \quad\Rightarrow\quad x_1 = 3`,
    `latex mangled: ${JSON.stringify(math[0]!.latex)}`,
  );
});

test("what is left behind survives the markdown parser untouched", () => {
  // The sentinel must contain none of markdown's special characters, or the
  // parser will split or escape it exactly like it split the formula.
  const { text } = extractMath(String.raw`$$\frac{a}{b}$$`);

  assert(!/[*_~`\[\]!\\$]/.test(text), `sentinel carries markdown syntax: ${JSON.stringify(text)}`);
  // Fresh regex, not the shared one: MATH_SENTINEL_RE is global, and `.test`
  // on a global regex advances lastIndex, which would leak into other tests.
  assert(
    new RegExp(MATH_SENTINEL_RE.source).test(text),
    `sentinel not matchable: ${JSON.stringify(text)}`,
  );
});

test("inline math is extracted and marked inline", () => {
  const { math } = extractMath(String.raw`Euler: $e^{i\pi} + 1 = 0$ done`);

  assert(math.length === 1, `expected 1 formula, got ${math.length}`);
  assert(!math[0]!.displayMode, "inline formula marked as display");
  assert(math[0]!.latex === String.raw`e^{i\pi} + 1 = 0`, `latex mangled: ${math[0]!.latex}`);
});

test("display math is taken before inline, not half-eaten by it", () => {
  const { math } = extractMath(String.raw`$$a$$ and $b$`);

  assert(math.length === 2, `expected 2 formulas, got ${math.length}`);
  assert(math[0]!.displayMode && math[0]!.latex === "a", "display formula wrong");
  assert(!math[1]!.displayMode && math[1]!.latex === "b", "inline formula wrong");
});

test("a formula spanning several lines is one formula", () => {
  const { math } = extractMath("$$\n\\int_0^1 x\\,dx = \\frac{1}{2}\n$$");

  assert(math.length === 1, `expected 1 formula, got ${math.length}`);
  assert(math[0]!.latex.includes(String.raw`\int_0^1`), `latex mangled: ${math[0]!.latex}`);
});

test("the LaTeX bracket delimiters work too", () => {
  // Models emit these constantly, and they are the shape that fails hardest
  // without this pass: the delimiters are themselves backslash escapes.
  const display = extractMath(String.raw`\[x = 1\]`);
  const inline = extractMath(String.raw`\(y = 2\)`);

  assert(display.math.length === 1 && display.math[0]!.displayMode, "\\[…\\] not display math");
  assert(display.math[0]!.latex === "x = 1", `latex mangled: ${display.math[0]!.latex}`);
  assert(inline.math.length === 1 && !inline.math[0]!.displayMode, "\\(…\\) not inline math");
});

section("What must NOT be treated as math");

test("prices are left alone", () => {
  const src = "It costs $5 and then $10 more";
  const { text, math } = extractMath(src);

  assert(math.length === 0, `a price was read as math: ${JSON.stringify(math)}`);
  assert(text === src, "text changed even though nothing matched");
});

test("math inside a fenced code block stays literal", () => {
  // A code fence is showing the source, not rendering it — replacing the
  // formula with a sentinel would print the sentinel to the user.
  const src = "```latex\n$$\\frac{a}{b}$$\n```";
  const { text, math } = extractMath(src);

  assert(math.length === 0, "math extracted from inside a code fence");
  assert(text === src, "code fence content was rewritten");
});

test("math inside an inline code span stays literal", () => {
  const src = "write `$x$` to get inline math";
  const { text, math } = extractMath(src);

  assert(math.length === 0, "math extracted from inside inline code");
  assert(text === src, "inline code content was rewritten");
});

test("an unclosed delimiter mid-stream is left as text", () => {
  // Tokens arrive one at a time; a half-written formula must not be captured
  // and must not swallow the rest of the message.
  const src = String.raw`the answer is $$\frac{1}{2`;
  const { text, math } = extractMath(src);

  assert(math.length === 0, "an unterminated formula was captured");
  assert(text === src, "text changed on an unterminated formula");
});

test("a message with no math is returned unchanged", () => {
  const src = "Plain prose, nothing to see.";
  const { text, math } = extractMath(src);

  assert(math.length === 0 && text === src, "a plain message was rewritten");
});

section("Round trip");

test("every sentinel maps back to a formula", () => {
  const src = String.raw`First $$a^2$$ then $b_1$ and $$\int c$$`;
  const { text, math } = extractMath(src);

  const found = [...text.matchAll(MATH_SENTINEL_RE)].map((m) => Number(m[1]));
  assert(found.length === 3, `expected 3 sentinels, got ${found.length}`);
  assert(
    found.every((i) => math[i] !== undefined),
    `a sentinel points past the formula list: ${JSON.stringify(found)}`,
  );
  assert(math[found[0]!]!.latex === "a^2", "first sentinel maps to the wrong formula");
  assert(math[found[2]!]!.latex === String.raw`\int c`, "third sentinel maps to the wrong formula");
});

report("latex");
