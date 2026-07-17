/** Artifact view sub-components — RenderView, CodeView, CsvTable. */

import { useEffect, useState } from "react";
import { Folder, FileText } from "@phosphor-icons/react";
import { marked } from "marked";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vs, vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";
import type { Artifact } from "../../types/artifact";
import { getLang } from "../../utils/getLang";
import { API_BASE, withToken } from "../../utils/apiBase";
import { useDarkMode } from "../../hooks/useDarkMode";
import { useTranslation } from "react-i18next";
import { parseFrontmatter } from "../../utils/frontmatter";
import { basename } from "../../utils/basename";

/** Office preview: convert the file to PDF on the backend (LibreOffice) and show
 * it in an iframe. Falls back to a download hint when LibreOffice is missing or
 * the conversion fails (HTTP 503/5xx). */
function OfficePreview({ path, ext }: { path: string; ext: string }) {
  const { t } = useTranslation();
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  const src = withToken(`${API_BASE}/files/preview?path=${encodeURIComponent(path)}`);

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
    const src = withToken(`${API_BASE}/files/serve?path=${encodeURIComponent(artifact.path ?? "")}`);
    return (
      <div className="art-render-center">
        <img src={src} alt={artifact.label ?? artifact.path ?? ""} />
      </div>
    );
  }

  if (ext === "pdf") {
    const src = withToken(`${API_BASE}/files/serve?path=${encodeURIComponent(artifact.path ?? "")}`);
    return <iframe className="art-render-iframe" src={src} title="PDF preview" />;
  }

  if (["docx", "doc", "pptx", "ppt", "xlsx", "xls", "odt", "odp", "ods", "rtf"].includes(ext)) {
    return <OfficePreview path={artifact.path ?? ""} ext={ext} />;
  }

  if (ext === "skill" || ext === "zip") {
    return <ArchiveTreeView path={artifact.path ?? ""} />;
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
    const { meta, body } = parseFrontmatter(content);
    const html = marked.parse(body) as string;
    return (
      <div className="art-render-md md">
        {Object.keys(meta).length > 0 && <FrontmatterCard meta={meta} />}
        <div dangerouslySetInnerHTML={{ __html: html }} />
      </div>
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

interface ArchiveEntry {
  path: string;
  name: string;
  depth: number;
  is_dir: boolean;
  size: number;
}

/** File tree for a .skill / .zip archive (own Claude-style design). Clicking a
 * file opens a mini-artifact below: Preview/Code for .md, Code only otherwise. */
function ArchiveTreeView({ path }: { path: string }) {
  const { t } = useTranslation();
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  const [files, setFiles] = useState<ArchiveEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setState("loading");
    setSelected(null);
    fetch(`${API_BASE}/files/archive-tree?path=${encodeURIComponent(path)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((d: ArchiveEntry[]) => {
        if (!alive) return;
        setFiles(d);
        setState("ok");
        // Default to SKILL.md, else the first file.
        const fileEntries = d.filter((f) => !f.is_dir);
        const def =
          fileEntries.find((f) => f.name.toLowerCase() === "skill.md") ?? fileEntries[0];
        setSelected(def ? def.path : null);
      })
      .catch(() => alive && setState("error"));
    return () => {
      alive = false;
    };
  }, [path]);

  if (state === "loading") return <div className="art-state">{t("artifacts.archiveLoading")}</div>;
  if (state === "error") return <div className="art-state">{t("artifacts.archiveError")}</div>;

  return (
    <div className="az">
      <div className="az-tree">
        {files.map((f) => {
          const isSel = !f.is_dir && f.path === selected;
          return (
            <button
              key={f.path}
              type="button"
              className={`az-row${f.is_dir ? " az-row--dir" : ""}${isSel ? " az-row--sel" : ""}`}
              style={{ paddingLeft: 10 + f.depth * 16 }}
              onClick={() => !f.is_dir && setSelected(f.path)}
              disabled={f.is_dir}
              title={f.path}
            >
              <span className="az-ic">{f.is_dir ? <Folder weight="fill" /> : <FileText />}</span>
              <span className="az-nm">{f.name}</span>
            </button>
          );
        })}
      </div>
      <div className="az-preview">
        {selected ? (
          <ArchiveMember path={path} member={selected} />
        ) : (
          <div className="art-state">{t("artifacts.selectFile")}</div>
        )}
      </div>
    </div>
  );
}

/** Mini-artifact for one archive member: Preview/Code tabs for .md, Code only
 * for everything else. */
function ArchiveMember({ path, member }: { path: string; member: string }) {
  const { t } = useTranslation();
  const isDark = useDarkMode();
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const name = basename(member);
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const isMd = ext === "md";
  const [tab, setTab] = useState<"render" | "code">(isMd ? "render" : "code");

  useEffect(() => {
    setTab(isMd ? "render" : "code");
  }, [isMd, member]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setContent(null);
    fetch(`${API_BASE}/files/archive-file?path=${encodeURIComponent(path)}&member=${encodeURIComponent(member)}`)
      .then((r) => (r.ok ? r.text() : Promise.reject(r.status)))
      .then((txt) => {
        if (!alive) return;
        setContent(txt);
        setLoading(false);
      })
      .catch(() => {
        if (!alive) return;
        setContent(null);
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [path, member]);

  return (
    <div className="azm">
      <div className="azm-head">
        <span className="azm-name">{name}</span>
        {isMd && (
          <div className="azm-tabs">
            <button
              type="button"
              className={`azm-tab${tab === "render" ? " active" : ""}`}
              onClick={() => setTab("render")}
            >
              {t("artifacts.preview")}
            </button>
            <button
              type="button"
              className={`azm-tab${tab === "code" ? " active" : ""}`}
              onClick={() => setTab("code")}
            >
              {t("artifacts.code")}
            </button>
          </div>
        )}
      </div>
      <div className="azm-body">
        {loading ? (
          <div className="art-state">{t("artifacts.loading")}</div>
        ) : content === null ? (
          <div className="art-state">{t("artifacts.archiveError")}</div>
        ) : isMd && tab === "render" ? (
          <MarkdownBody content={content} />
        ) : (
          <MemberCode name={name} content={content} isDark={isDark} />
        )}
      </div>
    </div>
  );
}

/** Markdown body with formatted frontmatter — shared by the archive preview. */
function MarkdownBody({ content }: { content: string }) {
  const { meta, body } = parseFrontmatter(content);
  const html = marked.parse(body) as string;
  return (
    <div className="art-render-md md azm-md">
      {Object.keys(meta).length > 0 && <FrontmatterCard meta={meta} />}
      <div dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

function MemberCode({ name, content, isDark }: { name: string; content: string; isDark: boolean }) {
  return (
    <SyntaxHighlighter
      language={getLang(name)}
      style={isDark ? vscDarkPlus : vs}
      showLineNumbers
      customStyle={{
        margin: 0,
        padding: "12px 0",
        background: isDark ? "#1e1e1e" : "#ffffff",
        fontSize: "12.5px",
        lineHeight: "1.6",
        height: "100%",
        overflow: "auto",
        borderRadius: 0,
      }}
      lineNumberStyle={{ color: isDark ? "#5a5a5a" : "#b0aaa0", minWidth: "34px" }}
    >
      {content.trim()}
    </SyntaxHighlighter>
  );
}

/** Formatted YAML frontmatter (name + description + remaining fields) — shown
 * above the rendered markdown body instead of dumping the raw `--- … ---`. */
function FrontmatterCard({ meta }: { meta: Record<string, string> }) {
  const { t } = useTranslation();
  const { name, description, ...rest } = meta;
  const restEntries = Object.entries(rest).filter(([, v]) => v.trim().length > 0);

  return (
    <div className="fm-card">
      {name && <div className="fm-name">{name}</div>}
      {description && (
        <div className="fm-field">
          <div className="fm-label">{t("artifacts.description")}</div>
          <div className="fm-desc">{description}</div>
        </div>
      )}
      {restEntries.length > 0 && (
        <div className="fm-chips">
          {restEntries.map(([k, v]) => (
            <span key={k} className="fm-chip">
              <span className="fm-chip-key">{k}</span>
              <span className="fm-chip-val">{v}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
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
