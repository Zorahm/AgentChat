/** Code block with language header, sticky copy button, and syntax highlighting. */

import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Copy, Check } from "@phosphor-icons/react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { atomDark } from "react-syntax-highlighter/dist/esm/styles/prism";

interface CodeBlockViewProps {
  language: string;
  code: string;
}

// Markdown fence labels (`ts`, `py`, `sh`, …) → the identifier Prism understands.
// Anything not listed is passed through lowercased (Prism already knows `json`,
// `css`, `go`, `java`, …); unknown values fall back to `text`.
const PRISM_ALIASES: Record<string, string> = {
  ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx",
  py: "python", rb: "ruby", rs: "rust",
  sh: "bash", shell: "bash", zsh: "bash", console: "bash",
  yml: "yaml", md: "markdown", mdx: "markdown",
  "c++": "cpp", "c#": "csharp", cs: "csharp",
  kt: "kotlin", plaintext: "text", txt: "text",
};

const LANG_LABELS: Record<string, string> = {
  typescript: "TypeScript", tsx: "TSX", javascript: "JavaScript", jsx: "JSX",
  python: "Python", rust: "Rust", go: "Go", ruby: "Ruby",
  css: "CSS", scss: "SCSS", html: "HTML", xml: "XML",
  json: "JSON", yaml: "YAML", toml: "TOML",
  markdown: "Markdown", sql: "SQL", bash: "Shell",
  dockerfile: "Dockerfile", graphql: "GraphQL", proto: "Protobuf",
  c: "C", cpp: "C++", csharp: "C#", java: "Java", kotlin: "Kotlin",
  swift: "Swift", scala: "Scala", php: "PHP",
  lua: "Lua", r: "R", dart: "Dart", elm: "Elm",
};

export function CodeBlockView({ language, code }: CodeBlockViewProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const raw = (language || "").toLowerCase();
  const lang = PRISM_ALIASES[raw] || raw || "text";
  const label = LANG_LABELS[lang] ?? (language || lang);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = code;
      ta.style.position = "fixed"; ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [code]);

  return (
    <div className="cb" ref={containerRef}>
      <div className="cb-head">
        <span className="cb-lang">{label}</span>
        <button className="cb-copy" onClick={handleCopy} title={copied ? t("chat.copied") : t("chat.copy")}>
          {copied ? <Check size={18} weight="bold" /> : <Copy size={18} />}
        </button>
      </div>
      <div className="cb-body">
        <SyntaxHighlighter
          language={lang}
          style={atomDark}
          customStyle={{
            margin: 0,
            padding: "10px 16px",
            background: "transparent",
            fontSize: "12px",
            lineHeight: "1.6",
          }}
          codeTagProps={{ style: { background: "transparent", padding: 0, display: "block" } }}
        >
          {code}
        </SyntaxHighlighter>
      </div>
    </div>
  );
}
