/** Skills manager — master-detail: installed list (left) + detail / add (right). */

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  Plus, MagnifyingGlass, DotsThree, Trash, CaretRight,
  Folder, LinkSimple, CheckCircle, FileDoc, FileXls, FilePpt, FilePdf, PaintBrush, Sparkle,
} from "@phosphor-icons/react";
import { API_BASE } from "../../utils/apiBase";
import { playNotificationSound } from "../../utils/notify";
import { Markdown } from "../Markdown/Markdown";
import { useTranslation } from "react-i18next";

interface SkillInfo {
  name: string;
  description: string;
  version: string;
  author: string;
  path: string;
}

interface SkillFileEntry {
  path: string;
  name: string;
  depth: number;
  is_dir: boolean;
  size: number;
}

type Tx = (key: string, opts?: Record<string, unknown>) => string;

/* ── Curated Anthropic catalog (presentation only; backend owns the source) ── */

interface CatalogItem {
  key: string;
  icon: ReactNode;
  // Tools the skill's scripts need at runtime. Shown as a "requires" line so the
  // user knows to install them (Settings → Terminal) before running the skill.
  requires?: string;
}

const CATALOG: CatalogItem[] = [
  { key: "agentchat", icon: <Sparkle size={20} weight="duotone" /> },
  { key: "docx", icon: <FileDoc size={20} weight="duotone" />, requires: "Python (python-docx); optional pandoc, LibreOffice" },
  { key: "xlsx", icon: <FileXls size={20} weight="duotone" />, requires: "Python (openpyxl, pandas); optional LibreOffice" },
  { key: "pptx", icon: <FilePpt size={20} weight="duotone" />, requires: "Python (python-pptx); optional LibreOffice, poppler" },
  { key: "pdf", icon: <FilePdf size={20} weight="duotone" />, requires: "Python (pypdf, pdfplumber, reportlab), poppler" },
  { key: "frontend-design", icon: <PaintBrush size={20} weight="duotone" /> },
];

function basename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}

function fmtFileSize(bytes: number, t: Tx): string {
  if (bytes < 1024) return `${bytes} ${t("skills.fileSizeBytes")}`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} ${t("skills.fileSizeKb")}`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} ${t("skills.fileSizeMb")}`;
}

function fileExtClass(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (name === "SKILL.md" || ext === "md") return "md";
  if (ext === "py") return "py";
  return "";
}

const BADGE_COLORS = ["bg-1", "bg-2", "bg-3", "bg-4", "bg-5", "bg-6"];

function getBadgeColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return BADGE_COLORS[Math.abs(h) % BADGE_COLORS.length]!;
}

/* ── File tree ──────────────────────────────────────────────────────────── */

function SkillTree({ files, t }: { files: SkillFileEntry[]; t: Tx }) {
  if (files.length === 0) {
    return <div className="sk2-tree"><div className="ln faint">{t("skills.emptyTree")}</div></div>;
  }
  return (
    <div className="sk2-tree">
      {files.map((f) => {
        const cls = f.is_dir ? "dir" : fileExtClass(f.name);
        return (
          <div className="ln" key={f.path || `__root__/${f.name}`} title={f.path || f.name}>
            {Array.from({ length: f.depth }).map((_, i) => <span className="indent" key={i} />)}
            <span className={`ic ${cls}`}>{f.is_dir ? "▾" : cls === "md" ? "¶" : "·"}</span>
            <span className={`nm ${cls}`}>{f.name}{f.is_dir ? "/" : ""}</span>
            {!f.is_dir && f.size > 0 && <span className="sz">{fmtFileSize(f.size, t)}</span>}
            {f.is_dir && f.size > 0 && <span className="sz">{t("skills.fileCount", { count: f.size })}</span>}
          </div>
        );
      })}
    </div>
  );
}

/* ── Detail pane ────────────────────────────────────────────────────────── */

interface SkillDetailPaneProps {
  skill: SkillInfo;
  content: string | undefined;
  files: SkillFileEntry[] | undefined;
  onUninstall: (name: string) => void;
}

function SkillDetailPane({ skill, content, files, onUninstall }: SkillDetailPaneProps) {
  const { t } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);

  useEffect(() => {
    setMenuOpen(false);
    setFilesOpen(false);
  }, [skill.name]);

  useEffect(() => {
    if (!menuOpen) return;
    const h = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest(".sk2-menu")) setMenuOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [menuOpen]);

  return (
    <div className="sk2-detail-scroll">
      <div className="sk2-detail-head">
        <div className="sk2-detail-title">
          <h3>{skill.name}</h3>
          {skill.version && <span className="v">v{skill.version}</span>}
        </div>
        <div className="sk2-menu" onClick={() => setMenuOpen((v) => !v)}>
          <DotsThree size={20} weight="bold" />
          {menuOpen && (
            <div className="sk2-popover">
              <div className="pitem" onClick={(e) => { e.stopPropagation(); onUninstall(skill.name); }}>
                <Trash size={14} /> {t("skills.uninstall")}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="sk2-meta">
        {skill.author && <span><b>{t("skills.metaAuthor")}</b> {skill.author}</span>}
        {skill.path && <span className="src"><Folder size={12} /> {skill.path}</span>}
      </div>

      {skill.description && <p className="sk2-desc">{skill.description}</p>}

      <button className="sk2-files-toggle" onClick={() => setFilesOpen((v) => !v)}>
        <CaretRight size={12} weight="bold" className={filesOpen ? "open" : ""} />
        {t("skills.files")}{files ? ` · ${files.length}` : ""}
      </button>
      {filesOpen && (
        files ? <SkillTree files={files} t={t} />
              : <div className="sk2-tree"><div className="ln faint">{t("skills.loadingFiles")}</div></div>
      )}

      <div className="sk2-render">
        {content !== undefined ? (
          <Markdown text={content} className="sk2-readme" stripFrontmatter breaks={false} />
        ) : (
          <div className="sk2-readme faint">{t("skills.loadingContent")}</div>
        )}
      </div>
    </div>
  );
}

/* ── Add pane ───────────────────────────────────────────────────────────── */

interface AddSkillPaneProps {
  installedKeys: Set<string>;
  installingKey: string | null;
  onInstallCatalog: (key: string) => void;
  source: string;
  setSource: (v: string) => void;
  installing: boolean;
  onInstallUrl: () => void;
  onPickFile: () => void;
  error: string | null;
}

function AddSkillPane({
  installedKeys, installingKey, onInstallCatalog,
  source, setSource, installing, onInstallUrl, onPickFile, error,
}: AddSkillPaneProps) {
  const { t } = useTranslation();
  const valid = !!source.trim() && /github\.com|^[\w-]+\/[\w.-]+$|\.skill$|^https?:\/\//.test(source.trim()) && source.trim().length > 3;

  return (
    <div className="sk2-detail-scroll">
      <h3 className="sk2-add-title">{t("skills.addTitle")}</h3>

      <div className="sk2-add-section">{t("skills.anthropicTitle")}</div>
      <p className="sk2-add-sub">{t("skills.anthropicSubtitle")}</p>
      <div className="sk2-cat-grid">
        {CATALOG.map((c) => {
          const installed = installedKeys.has(c.key);
          const busy = installingKey === c.key;
          return (
            <div className={`sk2-cat-card${installed ? " installed" : ""}`} key={c.key}>
              <div className="sk2-cat-ic">{c.icon}</div>
              <div className="sk2-cat-body">
                <div className="sk2-cat-label">{t(`skills.catalog.${c.key}.label`)}</div>
                <div className="sk2-cat-desc">{t(`skills.catalog.${c.key}.desc`)}</div>
                {c.requires && (
                  <div className="sk2-cat-req">
                    <span className="sk2-cat-req-lbl">{t("skills.requires")}:</span> {c.requires}
                    {" · "}
                    <button
                      className="sk2-cat-req-link"
                      onClick={() => window.dispatchEvent(new CustomEvent("navigate", { detail: "settings:terminal" }))}
                    >
                      {t("skills.requiresInstall")}
                    </button>
                  </div>
                )}
              </div>
              <button
                className={`sk2-cat-btn${installed ? " done" : ""}`}
                disabled={installed || busy}
                onClick={() => onInstallCatalog(c.key)}
              >
                {installed
                  ? <><CheckCircle size={14} weight="fill" /> {t("skills.installed")}</>
                  : busy
                    ? `${t("skills.installing")}`
                    : <><Plus size={14} weight="bold" /> {t("skills.install")}</>}
              </button>
            </div>
          );
        })}
      </div>

      <div className="sk2-add-section">{t("skills.fromGithub")}</div>
      <p className="sk2-add-sub">{t("skills.installDescription")}</p>
      <div className="sk2-url-row">
        <div className={`sk2-url${valid ? " detected" : ""}`}>
          <span className="lead"><LinkSimple size={14} weight="bold" /></span>
          <input
            type="text"
            placeholder={t("skills.installPlaceholder")}
            value={source}
            onChange={(e) => setSource(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !installing && valid && onInstallUrl()}
            disabled={installing}
          />
          <span className="ok">{t("skills.urlFound")}</span>
        </div>
        <button className="sk2-url-btn" onClick={onInstallUrl} disabled={installing || !valid}>
          <Plus size={14} weight="bold" /> {t("skills.install")}
        </button>
      </div>
      <div className="sk2-add-hints">
        <span>{t("skills.hintOwner")}</span>
        <button type="button" className="sk2-link-btn" onClick={onPickFile} disabled={installing}>
          {t("skills.orSelectFile")}
        </button>
        <span>{t("skills.dragHere")}</span>
      </div>

      {installing && <div className="sk2-error info">{t("skills.installing")}</div>}
      {error && <div className="sk2-error">{error}</div>}
    </div>
  );
}

/* ── Skills Manager ─────────────────────────────────────────────────────── */

interface SkillsManagerProps {
  onClose?: () => void;
}

export function SkillsManager({ onClose }: SkillsManagerProps) {
  const { t } = useTranslation();
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [source, setSource] = useState("");
  const [installing, setInstalling] = useState(false);
  const [installingKey, setInstallingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [contents, setContents] = useState<Map<string, string>>(new Map());
  const [files, setFiles] = useState<Map<string, SkillFileEntry[]>>(new Map());
  const [isDragging, setIsDragging] = useState(false);
  const dragDepth = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const didAutoSelect = useRef(false);

  const fetchSkills = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/skills`);
      if (res.ok) setSkills((await res.json()) as SkillInfo[]);
    } catch { /* offline */ }
  }, []);

  useEffect(() => { fetchSkills(); }, [fetchSkills]);

  // Select the first skill the first time the list populates (Claude-Desktop
  // feel). After that, a null selection means the user chose the Add pane.
  useEffect(() => {
    if (!didAutoSelect.current && skills.length > 0) {
      didAutoSelect.current = true;
      setSelected(skills[0]!.name);
    }
  }, [skills]);

  // Lazy-load SKILL.md + file tree for the selected skill.
  useEffect(() => {
    if (selected === null) return;
    const enc = encodeURIComponent(selected);
    if (!contents.has(selected)) {
      fetch(`${API_BASE}/skills/${enc}/read`).then(async (r) => {
        if (r.ok) {
          const d = (await r.json()) as { content: string };
          setContents((prev) => new Map(prev).set(selected, d.content));
        }
      }).catch(() => {});
    }
    if (!files.has(selected)) {
      fetch(`${API_BASE}/skills/${enc}/files`).then(async (r) => {
        if (r.ok) {
          const d = (await r.json()) as SkillFileEntry[];
          setFiles((prev) => new Map(prev).set(selected, d));
        }
      }).catch(() => {});
    }
  }, [selected, contents, files]);

  const installedKeys = new Set<string>();
  for (const s of skills) {
    installedKeys.add(s.name);
    installedKeys.add(basename(s.path));
  }

  const installCatalog = async (key: string) => {
    setInstallingKey(key);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/skills/install-catalog`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key }),
      });
      if (!res.ok) throw new Error((await res.json()).detail ?? t("skills.installFailed"));
      const installed = (await res.json()) as SkillInfo[];
      await fetchSkills();
      playNotificationSound();
      if (installed[0]) setSelected(installed[0].name);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setInstallingKey(null);
    }
  };

  const installUrl = async () => {
    const trimmed = source.trim();
    if (!trimmed) return;
    setInstalling(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/skills/install`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: trimmed }),
      });
      if (!res.ok) throw new Error((await res.json()).detail ?? t("skills.installFailed"));
      const installed = (await res.json()) as SkillInfo[];
      setSource("");
      await fetchSkills();
      playNotificationSound();
      if (installed[0]) setSelected(installed[0].name);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setInstalling(false);
    }
  };

  const uploadFile = useCallback(async (f: File) => {
    if (!/\.(skill|zip)$/i.test(f.name)) {
      setError(t("skills.invalidFileType"));
      return;
    }
    setInstalling(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", f);
      const res = await fetch(`${API_BASE}/skills/install-file`, { method: "POST", body: form });
      if (!res.ok) throw new Error((await res.json()).detail ?? t("skills.installFailed"));
      const installed = (await res.json()) as SkillInfo[];
      await fetchSkills();
      playNotificationSound();
      if (installed[0]) setSelected(installed[0].name);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setInstalling(false);
    }
  }, [fetchSkills, t]);

  const uninstall = async (name: string) => {
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/skills/${encodeURIComponent(name)}`, { method: "DELETE" });
      if (!res.ok) throw new Error((await res.json()).detail ?? t("skills.installFailed"));
      setContents((prev) => { const m = new Map(prev); m.delete(name); return m; });
      setFiles((prev) => { const m = new Map(prev); m.delete(name); return m; });
      if (selected === name) setSelected(null);
      await fetchSkills();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  };

  const handleDrag = (active: boolean) => (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    if (active) { dragDepth.current += 1; setIsDragging(true); }
    else { dragDepth.current = Math.max(0, dragDepth.current - 1); if (dragDepth.current === 0) setIsDragging(false); }
  };
  const handleDrop = async (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    dragDepth.current = 0;
    setIsDragging(false);
    const dropped = Array.from(e.dataTransfer.files);
    const f = dropped.find((x) => /\.(skill|zip)$/i.test(x.name)) ?? dropped[0];
    if (f) { setSelected(null); await uploadFile(f); }
  };

  const filtered = skills.filter((s) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q);
  });

  const activeSkill = selected !== null ? skills.find((s) => s.name === selected) ?? null : null;

  return (
    <div
      className={`sk2-root${isDragging ? " is-dragging" : ""}`}
      onDragEnter={handleDrag(true)}
      onDragLeave={handleDrag(false)}
      onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } }}
      onDrop={handleDrop}
    >
      {isDragging && (
        <div className="sk2-drop-overlay">
          <div className="sk2-drop-card">
            <div className="sk2-drop-icon"><Plus /></div>
            <div className="sk2-drop-title">{t("skills.dropToInstall")}</div>
            <div className="sk2-drop-hint">{t("skills.dropHint")}</div>
          </div>
        </div>
      )}
      <input
        ref={fileInputRef}
        type="file"
        accept=".skill,.zip,application/zip"
        style={{ display: "none" }}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) { setSelected(null); uploadFile(f); } e.target.value = ""; }}
      />

      {/* Left rail — installed list */}
      <aside className="sk2-list">
        <div className="sk2-list-head">
          {onClose && <button className="sk2-back" onClick={onClose} title={t("skills.back")}>‹</button>}
          <span className="sk2-list-title">{t("skills.title")}</span>
          <button
            className={`sk2-add-btn${selected === null ? " active" : ""}`}
            onClick={() => { setSelected(null); setError(null); }}
            title={t("skills.addTitle")}
          >
            <Plus size={16} weight="bold" />
          </button>
        </div>
        <div className="sk2-search">
          <MagnifyingGlass size={13} />
          <input
            placeholder={t("skills.searchPlaceholder")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="sk2-list-scroll">
          {filtered.map((s) => (
            <button
              key={s.name}
              className={`sk2-row${selected === s.name ? " active" : ""}`}
              onClick={() => setSelected(s.name)}
            >
              <span className={`sk2-row-badge ${getBadgeColor(s.name)}`}>{s.name[0]?.toUpperCase() ?? "?"}</span>
              <span className="sk2-row-info">
                <span className="sk2-row-name">{s.name}</span>
                {s.description && <span className="sk2-row-desc">{s.description}</span>}
              </span>
            </button>
          ))}
          {filtered.length === 0 && (
            <div className="sk2-list-empty">{search ? t("skills.emptySearch") : t("skills.emptyAll")}</div>
          )}
        </div>
        <div className="sk2-list-foot"><b>{skills.length}</b> {t("skills.installedCount")}</div>
      </aside>

      {/* Right pane — detail or add */}
      <section className="sk2-detail">
        {activeSkill ? (
          <SkillDetailPane
            skill={activeSkill}
            content={contents.get(activeSkill.name)}
            files={files.get(activeSkill.name)}
            onUninstall={uninstall}
          />
        ) : (
          <AddSkillPane
            installedKeys={installedKeys}
            installingKey={installingKey}
            onInstallCatalog={installCatalog}
            source={source}
            setSource={setSource}
            installing={installing}
            onInstallUrl={installUrl}
            onPickFile={() => fileInputRef.current?.click()}
            error={error}
          />
        )}
      </section>
    </div>
  );
}
