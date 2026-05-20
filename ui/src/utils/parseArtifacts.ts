/** Parse <artifact /> tags and <file>...</file> blocks from streamed text. */

import type { Artifact } from "../types/artifact";

interface ParseResult {
  cleanText: string;
  artifacts: Artifact[];
}

// <artifact type="..." path="..." label="..." />
const ARTIFACT_RE = /<artifact\s+([^>]+?)\s*\/>/g;
const ATTR_RE = /(\w+)="([^"]*)"/g;

// <file path="...">...</file>  — complete block
const FILE_BLOCK_RE = /<file\s+path="([^"]+)"[^>]*>[\s\S]*?<\/file>/g;

// <file path="..."> — opening tag alone (content still streaming)
const FILE_OPEN_RE = /<file\s+path="([^"]+)"[^>]*>/g;

// Closing tag
const FILE_CLOSE_RE = /<\/file>/g;

// <edit path="..." old="..." new="..." />  — self-closing form
const EDIT_SELF_RE = /<edit\s+[^>]*?\/>/g;

// <edit path="...">...</edit>  — complete block form with <old>/<new>.
// The negative lookbehind keeps this from also matching self-closing edits
// (where the `>` is preceded by `/`). The `[^>]` body is fine because
// attribute values are quoted; `/` inside a value (e.g. path="/foo") does
// not terminate the open tag.
const EDIT_BLOCK_RE = /<edit\s+[^>]*?(?<!\/)>[\s\S]*?<\/edit>/g;

// <edit path="..."> — opening tag of block form while streaming (no slash)
const EDIT_OPEN_RE = /<edit\s+[^>]*?(?<!\/)>/g;

// Closing block-edit tag
const EDIT_CLOSE_RE = /<\/edit>/g;

export function parseArtifacts(text: string): ParseResult {
  const artifacts: Artifact[] = [];

  // Collect artifacts ONLY from explicit <artifact /> tags.
  // <file> blocks are stripped from display text but do NOT create cards on their own.
  let m: RegExpExecArray | null;
  ARTIFACT_RE.lastIndex = 0;
  while ((m = ARTIFACT_RE.exec(text)) !== null) {
    const artifact: Artifact = { type: "file" };
    ATTR_RE.lastIndex = 0;
    let attr: RegExpExecArray | null;
    while ((attr = ATTR_RE.exec(m[1]!)) !== null) {
      const key = attr[1]!;
      const value = attr[2]!;
      if (key === "type") artifact.type = value as Artifact["type"];
      else (artifact as Record<string, string>)[key] = value;
    }
    artifacts.push(artifact);
  }

  // 4. Strip all file/edit markup from displayed text. The backend emits the
  // raw tag bytes as tokens so they survive in history (model can self-recall
  // what it wrote), but we don't want the user staring at them in the chat.
  // Order matters: strip complete blocks first, then leftover open/close tags
  // from in-flight streaming.
  const cleanText = text
    .replace(FILE_BLOCK_RE, "")      // complete <file>...</file> blocks
    .replace(FILE_OPEN_RE, "")       // lone opening <file ...> (streaming)
    .replace(FILE_CLOSE_RE, "")      // lone closing </file>
    .replace(EDIT_BLOCK_RE, "")      // complete <edit>...</edit> blocks
    .replace(EDIT_SELF_RE, "")       // self-closing <edit ... />
    .replace(EDIT_OPEN_RE, "")       // lone block-edit open (streaming)
    .replace(EDIT_CLOSE_RE, "")      // lone </edit>
    .replace(ARTIFACT_RE, "")        // <artifact /> inline tags
    .replace(/\n{3,}/g, "\n\n")      // collapse excess blank lines
    .trim();

  return { cleanText, artifacts };
}
