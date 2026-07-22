/** Code block wrapper — delegates to @astryxdesign/core/CodeBlock. */

import { CodeBlock } from "@astryxdesign/core/CodeBlock";

interface CodeBlockViewProps {
  language: string;
  code: string;
}

// Markdown fence labels (`ts`, `py`, `sh`, …) → the identifier CodeBlock understands.
// Anything not listed is passed through lowercased; unknown values fall back to `plaintext`.
const LANG_ALIASES: Record<string, string> = {
  ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx",
  py: "python", rb: "ruby", rs: "rust",
  sh: "bash", shell: "bash", zsh: "bash", console: "bash",
  yml: "yaml", md: "markdown", mdx: "markdown",
  "c++": "cpp", "c#": "csharp", cs: "csharp",
  kt: "kotlin", plaintext: "text", txt: "text",
};

export function CodeBlockView({ language, code }: CodeBlockViewProps) {
  const raw = (language || "").toLowerCase();
  const lang = LANG_ALIASES[raw] || raw || "plaintext";

  return (
    <CodeBlock
      code={code}
      language={lang}
      hasCopyButton
      isCollapsible={false}
      size="sm"
      width="100%"
      container="section"
    />
  );
}
