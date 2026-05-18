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

  // 4. Strip all file markup from displayed text
  const cleanText = text
    .replace(FILE_BLOCK_RE, "")      // complete blocks
    .replace(FILE_OPEN_RE, "")       // lone opening tags (streaming)
    .replace(FILE_CLOSE_RE, "")      // lone closing tags
    .replace(ARTIFACT_RE, "")        // <artifact /> inline tags
    .replace(/\n{3,}/g, "\n\n")      // collapse excess blank lines
    .trim();

  return { cleanText, artifacts };
}
