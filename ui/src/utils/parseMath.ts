/** Extract LaTeX math from text before markdown parsing.
 *
 * Markdown parsers mangle math: `_x_` becomes italic, `^` becomes special.
 * We pull math out, replace with placeholders, let `marked` run, then swap
 * KaTeX HTML back in. Placeholders use Unicode Private Use Area code points
 * so they never collide with real text and survive HTML escaping.
 *
 * Delimiters:
 *   $$...$$  — display math (block)
 *   $...$    — inline math, with currency guards:
 *              - opening `$` must NOT be followed by whitespace or a digit
 *              - closing `$` must NOT be preceded by whitespace
 *              - closing `$` must NOT be immediately followed by a digit
 *              - no newlines inside
 *   \$       — literal dollar, passes through
 *
 * Math inside fenced (```...```) and inline (`...`) code is left alone.
 */

export interface MathToken {
  kind: "inline" | "block";
  body: string;
}

export interface ExtractResult {
  text: string;
  tokens: MathToken[];
}

const OPEN = "";
const CLOSE = "";

export const PLACEHOLDER_RE = /(\d+)/g;

export function extractMath(text: string): ExtractResult {
  const tokens: MathToken[] = [];
  let out = "";
  let i = 0;
  const n = text.length;

  while (i < n) {
    if (text.startsWith("```", i)) {
      const end = text.indexOf("```", i + 3);
      const stop = end === -1 ? n : end + 3;
      out += text.slice(i, stop);
      i = stop;
      continue;
    }

    if (text[i] === "`") {
      let j = i + 1;
      while (j < n && text[j] !== "`" && text[j] !== "\n") j++;
      if (j < n && text[j] === "`") {
        out += text.slice(i, j + 1);
        i = j + 1;
        continue;
      }
    }

    if (text[i] === "\\" && text[i + 1] === "$") {
      out += "\\$";
      i += 2;
      continue;
    }

    if (text[i] === "$" && text[i + 1] === "$") {
      const end = text.indexOf("$$", i + 2);
      if (end !== -1 && end > i + 2) {
        const body = text.slice(i + 2, end).trim();
        tokens.push({ kind: "block", body });
        out += `${OPEN}${tokens.length - 1}${CLOSE}`;
        i = end + 2;
        continue;
      }
    }

    if (text[i] === "$") {
      const end = findInlineEnd(text, i);
      if (end !== -1) {
        const body = text.slice(i + 1, end);
        tokens.push({ kind: "inline", body });
        out += `${OPEN}${tokens.length - 1}${CLOSE}`;
        i = end + 1;
        continue;
      }
    }

    out += text[i];
    i++;
  }

  return { text: out, tokens };
}

function findInlineEnd(text: string, start: number): number {
  const after = text[start + 1];
  if (!after || /\s/.test(after) || /\d/.test(after)) return -1;

  const n = text.length;
  let j = start + 1;
  while (j < n) {
    const c = text[j];
    if (c === "\n") return -1;
    if (c === "\\" && text[j + 1] === "$") {
      j += 2;
      continue;
    }
    if (c === "$") {
      const prev = text[j - 1];
      const next = text[j + 1];
      if (prev && /\s/.test(prev)) return -1;
      if (next && /\d/.test(next)) return -1;
      return j;
    }
    j++;
  }
  return -1;
}

/** Replace placeholders in HTML with `render(token)` output. */
export function restoreMathInHtml(
  html: string,
  tokens: MathToken[],
  render: (token: MathToken) => string,
): string {
  return html.replace(PLACEHOLDER_RE, (_, idxStr: string) => {
    const idx = Number(idxStr);
    const token = tokens[idx];
    if (!token) return "";
    return render(token);
  });
}

/** Replace placeholders in plain text with the original `$...$` syntax.
 *  Used inside code blocks where math should stay literal. */
export function restoreMathAsLiteral(text: string, tokens: MathToken[]): string {
  return text.replace(PLACEHOLDER_RE, (_, idxStr: string) => {
    const idx = Number(idxStr);
    const token = tokens[idx];
    if (!token) return "";
    return token.kind === "block" ? `$$${token.body}$$` : `$${token.body}$`;
  });
}
