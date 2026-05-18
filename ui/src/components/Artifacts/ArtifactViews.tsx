/** Artifact view sub-components — RenderView, CodeView, CsvTable. */

import { marked } from "marked";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vs } from "react-syntax-highlighter/dist/esm/styles/prism";
import type { Artifact } from "../../types/artifact";
import { getLang } from "../../utils/getLang";
import { API_BASE } from "../../utils/apiBase";

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

  return (
    <div className="art-code-wrap">
      <SyntaxHighlighter
        language={lang}
        style={vs}
        showLineNumbers
        customStyle={{
          margin: 0,
          padding: "14px 0",
          background: "#fff",
          fontSize: "13px",
          lineHeight: "1.65",
          height: "100%",
          overflow: "auto",
          borderRadius: 0,
        }}
        lineNumberStyle={{ color: "#b0aaa0", minWidth: "36px" }}
      >
        {content}
      </SyntaxHighlighter>
    </div>
  );
}
