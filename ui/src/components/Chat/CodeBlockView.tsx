/** Code block with language header, sticky copy button, and syntax highlighting. */

import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Copy, Check } from "@phosphor-icons/react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { atomDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import { getLang } from "../../utils/getLang";

interface CodeBlockViewProps {
  language: string;
  code: string;
}

const LANG_LABELS: Record<string, string> = {
  ts: "TypeScript", tsx: "TSX", js: "JavaScript", jsx: "JSX",
  py: "Python", rs: "Rust", go: "Go", rb: "Ruby",
  css: "CSS", scss: "SCSS", html: "HTML", xml: "XML",
  json: "JSON", yaml: "YAML", yml: "YAML", toml: "TOML",
  md: "Markdown", mdx: "MDX",
  sql: "SQL", sh: "Shell", bash: "Bash", zsh: "Zsh",
  dockerfile: "Dockerfile", docker: "Dockerfile",
  graphql: "GraphQL", proto: "Protobuf",
  c: "C", cpp: "C++", h: "C", java: "Java", kt: "Kotlin",
  swift: "Swift", scala: "Scala", php: "PHP",
  lua: "Lua", r: "R", dart: "Dart", elm: "Elm",
};

export function CodeBlockView({ language, code }: CodeBlockViewProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const lang = getLang(language) || language;
  const label = LANG_LABELS[language] ?? language;

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
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>
      <div className="cb-body">
        <SyntaxHighlighter
          language={lang}
          style={atomDark}
          customStyle={{
            margin: 0,
            padding: "8px 16px",
            background: "transparent",
            fontSize: "12px",
            lineHeight: "1.6",
          }}
        >
          {code}
        </SyntaxHighlighter>
      </div>
    </div>
  );
}
