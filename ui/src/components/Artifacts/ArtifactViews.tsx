/** Artifact view sub-components — RenderView, CodeView, CsvTable. */

import { useEffect, useState } from "react";
import { marked } from "marked";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vs, vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";
import type { Artifact } from "../../types/artifact";
import { getLang } from "../../utils/getLang";
import { API_BASE } from "../../utils/apiBase";
import { useDarkMode } from "../../hooks/useDarkMode";
import { useTranslation } from "react-i18next";

/** Office preview: convert the file to PDF on the backend (LibreOffice) and show
 * it in an iframe. Falls back to a download hint when LibreOffice is missing or
 * the conversion fails (HTTP 503/5xx). */
function OfficePreview({ path, ext }: { path: string; ext: string }) {
  const { t } = useTranslation();
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  const src = `${API_BASE}/files/preview?path=${encodeURIComponent(path)}`;

  // Probe the conversion first (so we can show a helpful fallback on failure),
  // then render the resulting PDF from the same URL — the backend caches it by
  // source mtime, so the iframe load is an instant cache hit.
  useEffect(() => {
    let alive = true;
    setState("loading");
    fetch(src, { method: "GET" })
      .then((r) => {
        if (!alive) return;
        setState(r.ok ? "ok" : "error");
      })
      .catch(() => alive && setState("error"));
    return () => {
      alive = false;
    };
  }, [src]);

  if (state === "loading") {
    return <div className="art-state">{t("artifacts.convertingPreview")}</div>;
  }
  if (state === "error") {
    return (
      <div className="art-state">
        {t("artifacts.previewUnavailable")} {ext.toUpperCase()}
        <small>{t("artifacts.officePreviewHint")}</small>
      </div>
    );
  }
  return <iframe className="art-render-iframe" src={src} title="Office preview" />;
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
  const { t } = useTranslation();
  const ext = artifact.path?.split(".").pop()?.toLowerCase() ?? "";

  if (loading) return <div className="art-state">{t("artifacts.loading")}</div>;

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

  if (["docx", "doc", "pptx", "ppt", "xlsx", "xls", "odt", "odp", "ods", "rtf"].includes(ext)) {
    return <OfficePreview path={artifact.path ?? ""} ext={ext} />;
  }

  if (content === null) {
    return (
      <div className="art-state">
        {t("artifacts.fileNotAvailable")}
        <small>{t("artifacts.refreshHint")}</small>
      </div>
    );
  }

  if (ext === "md") {
    const html = marked.parse(content) as string;
    return (
      <div
        className="art-render-md md"
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
    return <CsvTable content={content} t={t} />;
  }

  return <pre className="art-render-pre">{content}</pre>;
}

function CsvTable({ content, t }: { content: string; t?: (key: string) => string }) {
  const rows = content
    .trim()
    .split("\n")
    .map((line) => line.split(",").map((c) => c.trim().replace(/^"|"$/g, "")));

  if (rows.length === 0) return <div className="art-state">{t ? t("artifacts.emptyFile") : "Empty file"}</div>;
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
  const { t } = useTranslation();
  const isDark = useDarkMode();

  if (loading) return <div className="art-state">{t("artifacts.loading")}</div>;
  if (content === null) {
    return (
      <div className="art-state">
        {t("artifacts.fileNotAvailable")}
        <small>{t("artifacts.refreshHint")}</small>
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
