/** Parse YAML-ish frontmatter out of a markdown/SKILL.md string.
 *
 * Mirrors the backend `skills.reader._parse_frontmatter`: handles simple
 * `key: value` pairs plus `|` / `>` block scalars. Returns the leftover body so
 * the raw `--- … ---` block isn't dumped into the rendered markdown. */

export interface Frontmatter {
  meta: Record<string, string>;
  body: string;
}

const BLOCK_MARKERS = new Set(["|", ">", "|-", ">-", "|+", ">+"]);

export function parseFrontmatter(text: string): Frontmatter {
  const normalized = text
    .replace(/^﻿/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/^\n+/, "");

  if (!normalized.startsWith("---")) return { meta: {}, body: text };

  const rest = normalized.slice(3).replace(/^\n+/, "");
  const end = rest.indexOf("\n---");
  if (end === -1) return { meta: {}, body: text };

  const fmBlock = rest.slice(0, end);
  const body = rest.slice(end + 4).replace(/^\n+/, "");

  const meta: Record<string, string> = {};
  const lines = fmBlock.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const ci = line.indexOf(":");
    if (ci === -1) continue;
    const key = line.slice(0, ci).trim();
    const val = line.slice(ci + 1).trim();

    if (BLOCK_MARKERS.has(val)) {
      const block: string[] = [];
      i++;
      while (i < lines.length) {
        const nxt = lines[i]!;
        if (!nxt.trim()) {
          block.push("");
          i++;
          continue;
        }
        if (nxt[0] !== " " && nxt[0] !== "\t") break;
        block.push(nxt.trim());
        i++;
      }
      i--; // for-loop will re-increment
      meta[key] = block.filter(Boolean).join(" ").trim();
      continue;
    }

    meta[key] = val.replace(/^["']|["']$/g, "");
  }

  return { meta, body };
}
