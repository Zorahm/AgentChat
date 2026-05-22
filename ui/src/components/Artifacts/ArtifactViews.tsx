/** Artifact view sub-components — RenderView, CodeView, CsvTable. */

import { useState, useEffect } from "react";
import { marked } from "marked";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vs, vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";
import type { Artifact } from "../../types/artifact";
import { getLang } from "../../utils/getLang";
import { API_BASE } from "../../utils/apiBase";

function useDarkMode(): boolean {
  const [isDark, setIsDark] = useState(
    () => document.documentElement.getAttribute("data-theme") === "dark",
  );
  useEffect(() => {
    const obs = new MutationObserver(() => {
      setIsDark(document.documentElement.getAttribute("data-theme") === "dark");
    });
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
  }, []);
  return isDark;
}

export function RenderView({
  artifact,
  content,
  loading,
}: {
  artifact: Artifact;
  content: string | null;
  loading: boolean;
}) {
  const ext = artifact.path?.split(".").pop()?.toLowerCase() ?? "";

  if (loading) return <div className="art-state">Loading…</div>;

  if (["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) {
    const src = `${API_BASE}/files/serve?path=${encodeURIComponent(artifact.path ?? "")}`;
    return (
      <div className="art-render-center">
        <img src={src} alt={artifact.label ?? artifact.path ?? ""} />
      </div>
    );
  }

  if (ext === "pdf") {
    const src = `${API_BASE}/files/serve?path=${encodeURIComponent(artifact.path ?? "")}`;
    return <iframe className="art-render-iframe" src={src} title="PDF preview" />;
  }

  if (["docx", "doc", "pptx", "ppt", "xlsx", "xls"].includes(ext)) {
    return (
      <div className="art-state">
        Превью недоступно для {ext.toUpperCase()}
        <small>нажмите «Скачать», чтобы открыть в нативном приложении</small>
      </div>
    );
  }

  if (content === null) {
    return (
      <div className="art-state">
        File not available
        <small>click ↺ to refresh</small>
      </div>
    );
  }

  if (ext === "md") {
    const html = marked.parse(content) as string;
    return (
      <div
        className="art-render-md"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }

  if (ext === "html") {
    return (
      <iframe
        className="art-render-iframe"
        srcDoc={content}
        sandbox="allow-scripts allow-same-origin"
        title="HTML preview"
      />
    );
  }

  if (ext === "svg") {
    return (
      <div
        className="art-render-svg"
        dangerouslySetInnerHTML={{ __html: content }}
      />
    );
  }

  if (ext === "json") {
    let pretty = content;
    try { pretty = JSON.stringify(JSON.parse(content), null, 2); } catch { /* keep raw */ }
    return <pre className="art-render-pre">{pretty}</pre>;
  }

  if (ext === "csv") {
    return <CsvTable content={content} />;
  }

  return <pre className="art-render-pre">{content}</pre>;
}

function CsvTable({ content }: { content: string }) {
  const rows = content
    .trim()
    .split("\n")
    .map((line) => line.split(",").map((c) => c.trim().replace(/^"|"$/g, "")));

  if (rows.length === 0) return <div className="art-state">Empty file</div>;
  const [header, ...body] = rows;

  return (
    <div className="art-render-table-wrap">
      <table className="art-render-table">
        <thead>
          <tr>{header!.map((cell, i) => <th key={i}>{cell}</th>)}</tr>
        </thead>
        <tbody>
          {body.map((row, ri) => (
            <tr key={ri}>{row.map((cell, ci) => <td key={ci}>{cell}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function CodeView({
  artifact,
  content,
  loading,
}: {
  artifact: Artifact;
  content: string | null;
  loading: boolean;
}) {
  const isDark = useDarkMode();

  if (loading) return <div className="art-state">Loading…</div>;
  if (content === null) {
    return (
      <div className="art-state">
        File not available
        <small>click ↺ to refresh</small>
      </div>
    );
  }

  const lang = getLang(artifact.path ?? "");
  const hlStyle = isDark ? vscDarkPlus : vs;
  const bgColor = isDark ? "#1e1e1e" : "#ffffff";
  const lineNumColor = isDark ? "#5a5a5a" : "#b0aaa0";

  return (
    <div className="art-code-wrap">
      <SyntaxHighlighter
        language={lang}
        style={hlStyle}
        showLineNumbers
        customStyle={{
          margin: 0,
          padding: "14px 0",
          background: bgColor,
          fontSize: "13px",
          lineHeight: "1.65",
          height: "100%",
          overflow: "auto",
          borderRadius: 0,
        }}
        lineNumberStyle={{ color: lineNumColor, minWidth: "36px" }}
      >
        {content.trim()}
      </SyntaxHighlighter>
    </div>
  );
}
