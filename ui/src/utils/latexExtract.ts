/** Lift LaTeX out of a markdown source before the markdown parser sees it.
 *
 * Astryx's <Markdown/> exposes `inlinePlugins`, which looked like the place to
 * put KaTeX. It isn't, and the reason is structural rather than a bug in
 * either side: plugins run against the text nodes the *inline parser has
 * already produced*, and by then a formula has been destroyed twice over.
 *
 *   `$$x \quad\Rightarrow\quad y$$`
 *     → ["$$x ", "quad", "Rightarrow", "quad y$$"]
 *
 * `\X` is markdown's own escape syntax, so every backslash is consumed and the
 * command name is all that survives; and each escape ends the current text run,
 * so one formula is scattered across four nodes. A plugin matching `$$(.+?)$$`
 * within a node cannot fire — the delimiters are in different nodes.
 *
 * So math is extracted here first and replaced by a sentinel built from
 * characters markdown has no opinion about. The parser then carries the
 * sentinel through untouched, and a plugin swaps the rendered formula back in.
 * The latex itself never passes through the parser at all, which is the only
 * arrangement that keeps it byte-for-byte.
 */

/** Private-use codepoints: not markdown syntax, not typeable, and not produced
 *  by any model. The digits between them index into the extracted list. */
const OPEN = "";
const CLOSE = "";

/** Matches one sentinel. Global by necessity, not by preference: Astryx drives
 *  a plugin's pattern with `exec` inside a `while` loop, and a non-global regex
 *  there never advances `lastIndex` — it would hang the render. Sharing one
 *  instance is safe because `applyInlinePlugins` resets `lastIndex` per call. */
export const MATH_SENTINEL_RE = new RegExp(`${OPEN}(\\d+)${CLOSE}`, "g");

export interface ExtractedMath {
  latex: string;
  displayMode: boolean;
}

export interface ExtractResult {
  /** The source with each formula replaced by a sentinel. */
  text: string;
  /** Formulas in the order their sentinels index. */
  math: ExtractedMath[];
}

/** Spans of the source that must be left exactly as they are.
 *
 * A fenced block or a code span is *showing* the source of a formula, not
 * asking for it to be rendered; substituting a sentinel there would print the
 * sentinel to the user instead of the `$$…$$` they asked to see.
 */
function protectedSpans(src: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];

  // Fenced blocks first: a ``` fence can legally contain stray backticks, so
  // inline-code scanning must not look inside one.
  const fence = /^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^[ \t]*\1[^\n]*$|$)/gm;
  for (const m of src.matchAll(fence)) {
    spans.push([m.index, m.index + m[0].length]);
  }

  const inside = (i: number) => spans.some(([s, e]) => i >= s && i < e);

  // Inline code: a run of N backticks closed by a run of N.
  const code = /(`+)(?:[^`]|(?!\1)`)*\1/g;
  for (const m of src.matchAll(code)) {
    if (!inside(m.index)) spans.push([m.index, m.index + m[0].length]);
  }

  return spans;
}

// Display before inline, so `$$a$$` is never half-eaten by the `$…$` rule.
// The bracket forms are listed too: models emit them constantly, and they are
// the shape that fails hardest without this pass, since the delimiters are
// themselves backslash escapes and the parser eats them first.
const PATTERNS: Array<{ re: RegExp; displayMode: boolean }> = [
  { re: /\$\$([\s\S]+?)\$\$/g, displayMode: true },
  { re: /\\\[([\s\S]+?)\\\]/g, displayMode: true },
  { re: /\\\(([\s\S]+?)\\\)/g, displayMode: false },
  // Currency guard: opening `$` not followed by whitespace, body neither
  // starting nor ending with whitespace and holding no newline, closing `$`
  // not followed by a digit — so "$5 and $10" stays prose.
  { re: /\$(?!\s)([^\s$](?:[^$\n]*[^\s$])?)\$(?!\d)/g, displayMode: false },
];

export function extractMath(source: string): ExtractResult {
  if (!source || (!source.includes("$") && !source.includes("\\"))) {
    return { text: source, math: [] };
  }

  const math: ExtractedMath[] = [];
  let text = source;

  for (const { re, displayMode } of PATTERNS) {
    // Recomputed per pattern: earlier passes have already rewritten the string,
    // so offsets from a previous scan no longer describe this one.
    const guarded = protectedSpans(text);
    const isProtected = (i: number) => guarded.some(([s, e]) => i >= s && i < e);

    let out = "";
    let last = 0;
    for (const m of text.matchAll(re)) {
      if (isProtected(m.index)) continue;
      const latex = (m[1] ?? "").trim();
      if (!latex) continue;
      out += text.slice(last, m.index) + OPEN + math.length + CLOSE;
      math.push({ latex, displayMode });
      last = m.index + m[0].length;
    }
    text = out + text.slice(last);
  }

  return { text, math };
}
