/** Skills manager — install, browse, manage skills. */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Plus, MagnifyingGlass, CaretDown, DotsThree, Trash,
  File, Folder, ArrowLeft, LinkSimple,
} from "@phosphor-icons/react";
import { API_BASE } from "../../utils/apiBase";
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

function fmtSize(bytes: number, t?: (key: string, opts?: Record<string, unknown>) => string): string {
  if (bytes < 1024) return `${bytes} ${t ? t("skills.fileSizeBytes") : "B"}`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} ${t ? t("skills.fileSizeKb") : "KB"}`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} ${t ? t("skills.fileSizeMb") : "MB"}`;
}

/* ── Skill Detail View ──────────────────────────────────────────────────── */

interface SkillDetailViewProps {
  name: string;
  onBack: () => void;
}

function SkillDetailView({ name, onBack }: SkillDetailViewProps) {
  const { t } = useTranslation();
  const [skillMd, setSkillMd] = useState<string | null>(null);
  const [files, setFiles] = useState<SkillFileEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      fetch(`${API_BASE}/skills/${encodeURIComponent(name)}/read`).then(async (r) => r.ok ? (await r.json() as { content: string }).content : null),
      fetch(`${API_BASE}/skills/${encodeURIComponent(name)}/files`).then(async (r) => r.ok ? (await r.json() as SkillFileEntry[]) : []),
    ]).then(([md, f]) => {
      setSkillMd(md);
      setFiles(f);
      setLoading(false);
    });
  }, [name]);

  return (
    <div className="sk-detail">
      <div className="sk-detail-head">
        <button className="sk-detail-back" onClick={onBack}>
          <ArrowLeft size={14} /> {t("skills.back")}
        </button>
        <h3>{name}</h3>
      </div>
      <div className="sk-detail-body">
        {/* File tree — left pane */}
        <div className="sk-tree">
          <div className="sk-tree-head">{t("skills.files")}</div>
          <div className="sk-tree-list">
            {files.map((f) => (
              <div
                key={f.path || "root"}
                className={`sk-tree-item${f.is_dir ? " dir" : ""}`}
                style={{ paddingLeft: `${f.depth * 14 + 8}px` }}
              >
                {f.is_dir ? (
                  <Folder size={13} weight="fill" className="sk-tree-ic dir" />
                ) : (
                  <File size={13} className="sk-tree-ic file" />
                )}
                <span className="sk-tree-name">{f.name}</span>
                {!f.is_dir && f.size > 0 && (
                  <span className="sk-tree-size">{fmtSize(f.size, t)}</span>
                )}
                {f.is_dir && f.size > 0 && (
                  <span className="sk-tree-size">{f.size}</span>
                )}
              </div>
            ))}
            {files.length === 0 && !loading && (
              <div className="sk-tree-empty">{t("skills.noFiles")}</div>
            )}
          </div>
        </div>

        {/* SKILL.md render — right pane */}
        <div className="sk-render">
          <div className="sk-render-head">{t("skills.skillMd")}</div>
          <div className="sk-render-body">
            {loading ? (
              <div className="sk-render-loading">{t("skills.loading")}</div>
            ) : skillMd ? (
              <Markdown text={skillMd} />
            ) : (
              <div className="sk-render-empty">{t("skills.skillMdNotFound")}</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

interface SkillContent {
  name: string;
  content: string;
}

function fmtFileSize(bytes: number, t?: (key: string, opts?: Record<string, unknown>) => string): string {
  if (bytes < 1024) return `${bytes} ${t ? t("skills.fileSizeBytes") : "B"}`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} ${t ? t("skills.fileSizeKb") : "KB"}`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} ${t ? t("skills.fileSizeMb") : "MB"}`;
}

function fileExtClass(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (name === "SKILL.md" || ext === "md") return "md";
  if (ext === "py") return "py";
  return "";
}

function pluralRu(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

const BADGE_COLORS = ["bg-1", "bg-2", "bg-3", "bg-4", "bg-5", "bg-6"];

function getBadgeColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return BADGE_COLORS[Math.abs(h) % BADGE_COLORS.length]!;
}

function fmtSource(name: string): string | null {
  const parts = name.split("/");
  if (parts.length === 2) return name;
  return null;
}

function SkillTree({ files, t }: { files: SkillFileEntry[]; t?: (key: string, opts?: Record<string, unknown>) => string }) {
  if (files.length === 0) {
    return <div className="st2-sk-tree"><div className="ln" style={{ color: "var(--faint)" }}>{t ? t("skills.emptyTree") : "Пусто"}</div></div>;
  }
  return (
    <div className="st2-sk-tree">
      {files.map((f) => {
        const indents = Array.from({ length: f.depth });
        const cls = f.is_dir ? "dir" : fileExtClass(f.name);
        return (
          <div className="ln" key={f.path || `__root__/${f.name}`} title={f.path || f.name}>
            {indents.map((_, i) => <span className="indent" key={i} />)}
            <span className={`ic ${cls}`}>{f.is_dir ? "▾" : cls === "md" ? "¶" : "·"}</span>
            <span className={`nm ${cls}`}>{f.name}{f.is_dir ? "/" : ""}</span>
            {!f.is_dir && f.size > 0 && <span className="sz">{fmtFileSize(f.size, t)}</span>}
            {f.is_dir && f.size > 0 && <span className="sz">{f.size} {t ? t("skills.fileCount", { count: f.size }) : `${f.size} файлов`}</span>}
          </div>
        );
      })}
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
  const [skillsDir, setSkillsDir] = useState<string>("C:\\Users\\ZorahM\\.agents\\skills");
  const [source, setSource] = useState("");
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [menuOpen, setMenuOpen] = useState<string | null>(null);
  const [contents, setContents] = useState<Map<string, string>>(new Map());
  const [files, setFiles] = useState<Map<string, SkillFileEntry[]>>(new Map());
  const [isDragging, setIsDragging] = useState(false);
  const dragDepth = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchSkills = useCallback(async () => {
    try {
      const [skillsRes, locationRes] = await Promise.all([
        fetch(`${API_BASE}/skills`),
        fetch(`${API_BASE}/skills/location`),
      ]);
      if (skillsRes.ok) setSkills((await skillsRes.json()) as SkillInfo[]);
      if (locationRes.ok) {
        const location = (await locationRes.json()) as { skills_dir: string };
        setSkillsDir(location.skills_dir);
      }
    } catch { /* */ }
  }, []);

  useEffect(() => { fetchSkills(); }, [fetchSkills]);

  useEffect(() => {
    if (!menuOpen) return;
    const h = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest(".st2-sk-menu")) setMenuOpen(null);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [menuOpen]);

  const isUrlValid = (v: string): boolean => {
    return /github\.com|^[\w-]+\/[\w.-]+$|\.skill$|^https?:\/\//.test(v);
  };

  const uploadSkillFile = async (f: File) => {
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
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail ?? t("skills.installFailed"));
      }
      await fetchSkills();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setInstalling(false);
    }
  };

  const handleDragEnter = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    dragDepth.current += 1;
    setIsDragging(true);
  };
  const handleDragLeave = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setIsDragging(false);
  };
  const handleDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  };
  const handleDrop = async (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    dragDepth.current = 0;
    setIsDragging(false);
    const dropped = Array.from(e.dataTransfer.files);
    const f = dropped.find((x) => /\.(skill|zip)$/i.test(x.name)) ?? dropped[0];
    if (f) await uploadSkillFile(f);
  };

  const handleInstall = async (sourceOverride?: string) => {
    const trimmed = (sourceOverride ?? source).trim();
    if (!trimmed) return;
    setInstalling(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/skills/install`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: trimmed }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail ?? t("skills.installFailed"));
      }
      if (!sourceOverride) setSource("");
      await fetchSkills();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setInstalling(false);
    }
  };

  const handleUninstall = async (name: string) => {
    setError(null);
    setMenuOpen(null);
    try {
      await fetch(`${API_BASE}/skills/${encodeURIComponent(name)}`, { method: "DELETE" });
      setContents((prev) => { const m = new Map(prev); m.delete(name); return m; });
      setFiles((prev) => { const m = new Map(prev); m.delete(name); return m; });
      await fetchSkills();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  };

  const handleExpand = async (name: string) => {
    if (expanded === name) {
      setExpanded(null);
      return;
    }
    setExpanded(name);
    const needContent = !contents.has(name);
    const needFiles = !files.has(name);
    const enc = encodeURIComponent(name);
    await Promise.all([
      needContent ? fetch(`${API_BASE}/skills/${enc}/read`).then(async (res) => {
        if (res.ok) {
          const data: SkillContent = await res.json();
          setContents((prev) => { const m = new Map(prev); m.set(name, data.content); return m; });
        }
      }).catch(() => {}) : Promise.resolve(),
      needFiles ? fetch(`${API_BASE}/skills/${enc}/files`).then(async (res) => {
        if (res.ok) {
          const data: SkillFileEntry[] = await res.json();
          setFiles((prev) => { const m = new Map(prev); m.set(name, data); return m; });
        }
      }).catch(() => {}) : Promise.resolve(),
    ]);
  };

  const filtered = skills.filter((s) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q);
  });

  const valid = !!source.trim() && isUrlValid(source.trim()) && source.trim().length > 3;

  return (
    <div
      className={`st2-main${isDragging ? " is-dragging" : ""}`}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {isDragging && (
        <div className="st2-sk-drop-overlay">
          <div className="st2-sk-drop-card">
            <div className="st2-sk-drop-icon"><Plus /></div>
            <div className="st2-sk-drop-title">{t("skills.dropToInstall")}</div>
            <div className="st2-sk-drop-hint">{t("skills.dropHint")}</div>
          </div>
        </div>
      )}
      <input
        ref={fileInputRef}
        type="file"
        accept=".skill,.zip,application/zip"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) uploadSkillFile(f);
          e.target.value = "";
        }}
      />
      {onClose && (
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
          <button className="st2-back" onClick={onClose}>{t("skills.backNav")}</button>
        </div>
      )}
      <h3 className="st2-h">{t("skills.title")}</h3>
      <p className="st2-sub">
        {t("skills.description")}
      </p>
      <div className="st2-path" style={{ marginBottom: 18 }}>
        <Folder /> {skillsDir}
      </div>

      {/* 01 Добавить скилл */}
      <section>
        <div className="st2-mh">
          <span className="st2-mn">01</span>
          <h2>{t("skills.addSkill")}</h2>
        </div>
        <p className="st2-md">
          {t("skills.installDescription")}
        </p>

        <div className="st2-sk-install">
          <div className={`st2-sk-input${valid ? " detected" : ""}`}>
            <span className="lead"><LinkSimple size={14} weight="bold" /></span>
            <input
              ref={inputRef}
              type="text"
              placeholder={t("skills.installPlaceholder")}
              value={source}
              onChange={(e) => setSource(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !installing && valid && handleInstall()}
              disabled={installing}
            />
            <span className="ok">✓ {t("skills.urlFound")}</span>
          </div>
          <button
            className="st2-sk-install-btn primary"
            onClick={() => handleInstall()}
            disabled={installing || !valid}
          >
            <Plus /> {t("skills.install")}
          </button>
        </div>

        <div className="st2-sk-hints">
          <span>{t("skills.hintOwner")}</span>
          <span><b>https://github.com/…</b></span>
          <button
            type="button"
            className="st2-sk-hint-btn"
            onClick={() => fileInputRef.current?.click()}
            disabled={installing}
          >
            {t("skills.orSelectFile")}
          </button>
          <span>{t("skills.dragHere")}</span>
        </div>

        <div className="st2-sk-preset">
          <div className="st2-sk-preset-info">
          <div className="st2-sk-preset-title">{t("skills.presetTitle")}</div>
          <div className="st2-sk-preset-desc">
            {t("skills.presetDescription")}
            </div>
          </div>
          <button
            className="st2-sk-install-btn"
            onClick={() => handleInstall("anthropics/skills")}
            disabled={installing}
          >
            {installing ? <span>{t("skills.installingPreset")}…</span> : <><Plus /> {t("skills.installPreset")}</>}
          </button>
        </div>

        {installing && (
          <div className="st2-sk-error" style={{ marginTop: 12 }}>{t("skills.installing")}…</div>
        )}
        {error && <div className="st2-sk-error">{error}</div>}
      </section>

      {/* 02 Установленные */}
      <section>
        <div className="st2-mh">
          <span className="st2-mn">02</span>
          <h2>{t("skills.installedTitle")}</h2>
        </div>
        <p className="st2-md">
          {t("skills.installedDescription")}
        </p>

        <div className="st2-mrows">
          <div className="st2-sk-search">
            <div className="fld">
              <MagnifyingGlass />
              <input
                placeholder={t("skills.searchPlaceholder")}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <div className="st2-sk-meta">
              <b>{skills.length}</b> {t("skills.installedCount")}
            </div>
          </div>

          {filtered.map((s) => {
            const isExpanded = expanded === s.name;
            const src = fmtSource(s.name);
            const content = contents.get(s.name);
            const tree = files.get(s.name);
            return (
              <div key={s.name}>
                <div
                  className={`st2-sk-item${isExpanded ? " open" : ""}`}
                  onClick={() => handleExpand(s.name)}
                >
                  <div className={`st2-sk-badge ${getBadgeColor(s.name)}`}>
                    {s.name[0]?.toUpperCase() ?? "?"}
                  </div>
                  <div className="st2-sk-info">
                    <div className="st2-sk-name">
                      {s.name}
                      {s.version && <span className="v">v{s.version}</span>}
                    </div>
                    {s.description && <div className="st2-sk-desc">{s.description}</div>}
                  </div>
                  <div
                    className="st2-sk-menu"
                    onClick={(e) => {
                      e.stopPropagation();
                      setMenuOpen(menuOpen === s.name ? null : s.name);
                    }}
                  >
                    <DotsThree />
                    {menuOpen === s.name && (
                      <div className="st2-sk-popover">
                          <div className="pitem" onClick={(e) => { e.stopPropagation(); handleUninstall(s.name); }}>
                            <Trash /> {t("skills.uninstall")}
                        </div>
                      </div>
                    )}
                  </div>
                  <span className="st2-sk-chev"><CaretDown /></span>
                </div>

                {isExpanded && (
                  <div className="st2-sk-body">
                    <div className="grid">
                      <div>
                        <h6 className="col-label">
                          {t("skills.structure")}
                          <span className="src">{s.path || `${skillsDir}\\${s.name}`}</span>
                        </h6>
                        {tree ? (
                          <SkillTree files={tree} t={t} />
                        ) : (
                          <div className="st2-sk-tree"><div className="ln" style={{ color: "var(--faint)" }}>{t("skills.loadingFiles")}</div></div>
                        )}
                      </div>
                      <div>
                        <h6 className="col-label">
                          {t("skills.skillMdColumn")}
                          {src && <span className="src">· {src}</span>}
                        </h6>
                        {content ? (
                          <Markdown
                            text={content}
                            className="st2-sk-readme"
                            stripFrontmatter
                            breaks={false}
                          />
                        ) : (
                          <div className="st2-sk-readme" style={{ color: "var(--faint)" }}>{t("skills.loadingContent")}</div>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          {filtered.length === 0 && (
            <div className="st2-sk-empty">
              {search ? t("skills.emptySearch") : t("skills.emptyAll")}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
