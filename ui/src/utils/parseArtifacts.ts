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

  // 1. Collect file artifacts from complete <file>...</file> blocks
  let m: RegExpExecArray | null;
  FILE_BLOCK_RE.lastIndex = 0;
  while ((m = FILE_BLOCK_RE.exec(text)) !== null) {
    const path = m[1]!;
    artifacts.push({
      type: "file",
      path,
      label: path.split("/").pop() ?? path,
    });
  }

  // 2. Collect file artifacts from lone opening tags (content still streaming)
  //    Only add if not already added from a complete block
  const completePaths = new Set(artifacts.map((a) => a.path));
  FILE_OPEN_RE.lastIndex = 0;
  while ((m = FILE_OPEN_RE.exec(text)) !== null) {
    const path = m[1]!;
    if (!completePaths.has(path)) {
      artifacts.push({
        type: "file",
        path,
        label: path.split("/").pop() ?? path,
      });
      completePaths.add(path);
    }
  }

  // 3. Collect <artifact /> tags
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
    // Skip if we already have this path from a <file> block
    if (!artifact.path || !completePaths.has(artifact.path)) {
      artifacts.push(artifact);
      if (artifact.path) completePaths.add(artifact.path);
    }
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
