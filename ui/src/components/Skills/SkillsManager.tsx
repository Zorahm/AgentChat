/** Skills manager — master-detail: installed list (left) + detail / add (right). */

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  Plus, MagnifyingGlass, DotsThree, Trash, CaretRight, CaretLeft,
  Folder, LinkSimple, CheckCircle,
  FileDoc, FileXls, FilePpt, FilePdf, FileCode, FileText, File,
  PaintBrush, Sparkle,
} from "@phosphor-icons/react";
import { Button } from "@astryxdesign/core/Button";
import { IconButton } from "@astryxdesign/core/IconButton";
import { TextInput } from "@astryxdesign/core/TextInput";
import { ClickableCard } from "@astryxdesign/core/ClickableCard";
import { Badge } from "@astryxdesign/core/Badge";
import { MoreMenu } from "@astryxdesign/core/MoreMenu";
import { TreeList } from "@astryxdesign/core/TreeList";
import type { TreeListItemData } from "@astryxdesign/core/TreeList";
import { Markdown } from "@astryxdesign/core/Markdown";
import { latexMarkdownPlugins } from "../../utils/latexPlugins";
import { parseFrontmatter } from "../../utils/frontmatter";
import { FrontmatterCard } from "../FrontmatterCard";
import { API_BASE } from "../../utils/apiBase";
import { playNotificationSound } from "../../utils/notify";
import { basename } from "../../utils/basename";
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
  // Matches the `author` this skill's SKILL.md actually installs with (see
  // backend/skills/catalog.py + installer.py's _ensure_author_field): "AgentChat"
  // for our own bundled/adapted skills, "Anthropic" for the one installed
  // unmodified from GitHub.
  author: string;
}

const CATALOG: CatalogItem[] = [
  { key: "agentchat", icon: <Sparkle size={20} weight="duotone" />, author: "AgentChat" },
  { key: "docx", icon: <FileDoc size={20} weight="duotone" />, requires: "Python (python-docx); optional pandoc, LibreOffice", author: "AgentChat" },
  { key: "xlsx", icon: <FileXls size={20} weight="duotone" />, requires: "Python (openpyxl, pandas); optional LibreOffice", author: "AgentChat" },
  { key: "pptx", icon: <FilePpt size={20} weight="duotone" />, requires: "Python (python-pptx); optional LibreOffice, poppler", author: "AgentChat" },
  { key: "pdf", icon: <FilePdf size={20} weight="duotone" />, requires: "Python (pypdf, pdfplumber, reportlab), poppler", author: "AgentChat" },
  { key: "frontend-design", icon: <PaintBrush size={20} weight="duotone" />, author: "Anthropic" },
];

function fmtFileSize(bytes: number, t: Tx): string {
  if (bytes < 1024) return `${bytes} ${t("skills.fileSizeBytes")}`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} ${t("skills.fileSizeKb")}`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} ${t("skills.fileSizeMb")}`;
}

const BADGE_COLORS = ["bg-1", "bg-2", "bg-3", "bg-4", "bg-5", "bg-6"];

function getBadgeColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return BADGE_COLORS[Math.abs(h) % BADGE_COLORS.length]!;
}

/* ── File tree ──────────────────────────────────────────────────────────── */

function fileIcon(name: string, isDir: boolean): ReactNode {
  if (isDir) return <Folder size={14} weight="duotone" />;
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (name === "SKILL.md" || ext === "md") return <FileDoc size={14} weight="duotone" />;
  if (ext === "py") return <FileCode size={14} weight="duotone" />;
  if (ext === "json" || ext === "yaml" || ext === "yml" || ext === "toml") return <FileText size={14} weight="duotone" />;
  if (ext === "ts" || ext === "tsx" || ext === "js" || ext === "jsx") return <FileCode size={14} weight="duotone" />;
  if (ext === "xlsx" || ext === "xls" || ext === "csv") return <FileXls size={14} weight="duotone" />;
  if (ext === "pptx" || ext === "ppt") return <FilePpt size={14} weight="duotone" />;
  if (ext === "pdf") return <FilePdf size={14} weight="duotone" />;
  if (ext === "docx" || ext === "doc") return <FileDoc size={14} weight="duotone" />;
  return <File size={14} weight="duotone" />;
}

function buildTreeItems(entries: SkillFileEntry[], t: Tx): TreeListItemData[] {
  if (entries.length === 0) return [];

  const root: TreeListItemData[] = [];
  const stack: TreeListItemData[] = [];

  for (const f of entries) {
    const item: TreeListItemData = {
      id: f.path || `__root__/${f.name}`,
      label: f.name,
      startContent: fileIcon(f.name, f.is_dir),
      endContent: !f.is_dir && f.size > 0
        ? <span style={{ fontSize: 11, opacity: 0.5, fontFamily: "var(--font-mono)" }}>{fmtFileSize(f.size, t)}</span>
        : f.is_dir && f.size > 0
          ? <span style={{ fontSize: 11, opacity: 0.5 }}>{t("skills.fileCount", { count: f.size })}</span>
          : undefined,
    };

    while (stack.length > f.depth) stack.pop();

    if (stack.length === 0) {
      root.push(item);
    } else {
      const parent = stack[stack.length - 1]!;
      if (!parent.children) parent.children = [];
      parent.children.push(item);
    }

    if (f.is_dir) stack.push(item);
  }

  return root;
}

function SkillTree({ files, t }: { files: SkillFileEntry[]; t: Tx }) {
  if (files.length === 0) {
    return <div className="sk2-tree"><div className="ln faint">{t("skills.emptyTree")}</div></div>;
  }
  const items = buildTreeItems(files, t);
  return (
    <div className="sk2-tree">
      <TreeList items={items} density="compact" />
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
  const [filesOpen, setFilesOpen] = useState(false);

  useEffect(() => {
    setFilesOpen(false);
  }, [skill.name]);

  return (
    <div className="sk2-detail-scroll">
      <div className="sk2-detail-head">
        <div className="sk2-detail-title">
          <h3>{skill.name}</h3>
          {skill.version && <span className="v">v{skill.version}</span>}
        </div>
        <MoreMenu
          label={t("skills.actions")}
          items={[
            {
              label: t("skills.uninstall"),
              icon: <Trash size={14} />,
              onClick: () => onUninstall(skill.name),
            },
          ]}
        />
      </div>

      <div className="sk2-meta">
        {skill.author && <span><b>{t("skills.metaAuthor")}</b> {skill.author}</span>}
        {skill.path && <span className="src"><Folder size={12} /> {skill.path}</span>}
      </div>

      {skill.description && <p className="sk2-desc">{skill.description}</p>}

      <Button
        label={`${t("skills.files")}${files ? ` · ${files.length}` : ""}`}
        variant="ghost"
        icon={<CaretRight size={12} weight="bold" className={filesOpen ? "open" : ""} />}
        onClick={() => setFilesOpen((v) => !v)}
        className="sk2-files-toggle"
      />
      {filesOpen && (
        files ? <SkillTree files={files} t={t} />
              : <div className="sk2-tree"><div className="ln faint">{t("skills.loadingFiles")}</div></div>
      )}

      <div className="sk2-render">
        {content !== undefined ? (
          <SkillReadme content={content} />
        ) : (
          <div className="sk2-readme faint">{t("skills.loadingContent")}</div>
        )}
      </div>
    </div>
  );
}

/* ── Readme ─────────────────────────────────────────────────────────────── */

interface SkillReadmeProps {
  content: string;
}

/** SKILL.md body with its YAML frontmatter rendered as a card instead of a raw
 * `--- … ---` block. The pane header already shows name/description (h3 +
 * sk2-desc), so those keys are dropped and the card degrades to a chips-only
 * row of the remaining fields (license, allowed-tools, …). */
function SkillReadme({ content }: SkillReadmeProps) {
  const { meta, body } = parseFrontmatter(content);
  const rest = Object.fromEntries(
    Object.entries(meta).filter(([k]) => k !== "name" && k !== "description"),
  );
  return (
    <>
      {Object.keys(rest).length > 0 && <FrontmatterCard meta={rest} />}
      <Markdown className="sk2-readme" inlinePlugins={latexMarkdownPlugins}>{body}</Markdown>
    </>
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

      <div className="sk2-add-section">{t("skills.catalogTitle")}</div>
      <p className="sk2-add-sub">{t("skills.catalogSubtitle")}</p>
      <div className="sk2-cat-grid">
        {CATALOG.map((c) => {
          const installed = installedKeys.has(c.key);
          const busy = installingKey === c.key;
          const tooltip = [
            t("skills.catalogAuthor", { author: c.author }),
            c.requires ? `${t("skills.requires")}: ${c.requires}` : null,
          ].filter(Boolean).join(" · ");
          return (
            // ClickableCard's BaseProps deliberately omits `title` (Astryx calls it
            // a footgun) — wrap it so the author/requires hint is still a native
            // hover tooltip instead of permanent on-card text.
            <div key={c.key} title={tooltip}>
              <ClickableCard
                label={`${t(`skills.catalog.${c.key}.label`)} — ${installed ? t("skills.installed") : t("skills.install")}`}
                onClick={() => onInstallCatalog(c.key)}
                isDisabled={installed || busy}
                className={`sk2-cat-card${installed ? " installed" : ""}`}
              >
                <div className="sk2-cat-ic">{c.icon}</div>
                <div className="sk2-cat-body">
                  <div className="sk2-cat-label">{t(`skills.catalog.${c.key}.label`)}</div>
                  <div className="sk2-cat-desc">{t(`skills.catalog.${c.key}.desc`)}</div>
                </div>
                <div className="sk2-cat-status">
                  {installed
                    ? <CheckCircle size={16} weight="fill" />
                    : busy
                      ? <span className="sk2-cat-spin">⟳</span>
                      : <Plus size={14} weight="bold" />}
                </div>
              </ClickableCard>
            </div>
          );
        })}
      </div>

      <div className="sk2-add-section">{t("skills.fromGithub")}</div>
      <p className="sk2-add-sub">{t("skills.installDescription")}</p>
      <div className="sk2-url-row">
        <div className={`sk2-url${valid ? " detected" : ""}`}>
          <TextInput
            label={t("skills.installPlaceholder")}
            isLabelHidden
            type="text"
            placeholder={t("skills.installPlaceholder")}
            value={source}
            onChange={(v) => setSource(v)}
            isDisabled={installing}
            startIcon={<LinkSimple size={14} weight="bold" />}
            className="sk2-url-input"
          />
          {valid && <span className="ok">{t("skills.urlFound")}</span>}
        </div>
        <Button
          label={t("skills.install")}
          variant="primary"
          icon={<Plus size={14} weight="bold" />}
          onClick={onInstallUrl}
          isDisabled={installing || !valid}
          isLoading={installing}
          className="sk2-url-btn"
        />
      </div>
      <div className="sk2-add-hints">
        <span>{t("skills.hintOwner")}</span>
        <Button
          label={t("skills.orSelectFile")}
          variant="ghost"
          onClick={onPickFile}
          isDisabled={installing}
          className="sk2-link-btn"
        />
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
  // Mobile only: which of the two master-detail panes is showing full-screen.
  // Irrelevant on desktop (both panes are always visible there; see CSS).
  const [view, setView] = useState<"list" | "detail">("list");
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
      if (installed[0]) { setSelected(installed[0].name); setView("detail"); }
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
      if (installed[0]) { setSelected(installed[0].name); setView("detail"); }
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
      if (installed[0]) { setSelected(installed[0].name); setView("detail"); }
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
      if (selected === name) { setSelected(null); setView("list"); }
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
    if (f) { setSelected(null); setView("detail"); await uploadFile(f); }
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
      data-mview={view}
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
        onChange={(e) => { const f = e.target.files?.[0]; if (f) { setSelected(null); setView("detail"); uploadFile(f); } e.target.value = ""; }}
      />

      {/* Left rail — installed list */}
      <aside className="sk2-list">
        <div className="sk2-list-head">
          {onClose && <IconButton
            label={t("skills.back")}
            icon={<span>‹</span>}
            variant="ghost"
            onClick={onClose}
            className="sk2-back"
          />}
          <span className="sk2-list-title">{t("skills.title")}</span>
          <IconButton
            label={t("skills.addTitle")}
            icon={<Plus size={16} weight="bold" />}
            variant={selected === null ? "primary" : "secondary"}
            onClick={() => { setSelected(null); setError(null); setView("detail"); }}
            className={`sk2-add-btn${selected === null ? " active" : ""}`}
          />
        </div>
        <div className="sk2-search">
          <TextInput
            label={t("skills.searchPlaceholder")}
            isLabelHidden
            placeholder={t("skills.searchPlaceholder")}
            value={search}
            onChange={(v) => setSearch(v)}
            startIcon={<MagnifyingGlass size={13} />}
            className="sk2-search-input"
          />
        </div>
        <div className="sk2-list-scroll">
          {filtered.map((s) => (
            <Button
              key={s.name}
              label={s.name}
              variant={selected === s.name ? "primary" : "ghost"}
              onClick={() => { setSelected(s.name); setView("detail"); }}
              className={`sk2-row${selected === s.name ? " active" : ""}`}
              width="100%"
            >
              <span className="sk2-row-content">
                <Badge
                  label={s.name[0]?.toUpperCase() ?? "?"}
                  variant="blue"
                  className={`sk2-row-badge ${getBadgeColor(s.name)}`}
                />
                <span className="sk2-row-info">
                  <span className="sk2-row-name">{s.name}</span>
                  {s.description && <span className="sk2-row-desc">{s.description}</span>}
                </span>
              </span>
            </Button>
          ))}
          {filtered.length === 0 && (
            <div className="sk2-list-empty">{search ? t("skills.emptySearch") : t("skills.emptyAll")}</div>
          )}
        </div>
        <div className="sk2-list-foot"><b>{skills.length}</b> {t("skills.installedCount")}</div>
      </aside>

      {/* Right pane — detail or add. On mobile it's swapped in over the list
          (see CSS) rather than stacked underneath it, with its own back bar. */}
      <section className="sk2-detail">
        <div className="sk2-detail-mobbar">
          <IconButton
            label={t("skills.back")}
            icon={<CaretLeft size={20} weight="bold" />}
            variant="ghost"
            onClick={() => setView("list")}
            className="sk2-mob-back"
          />
          <span className="sk2-detail-mobbar-title">{activeSkill ? activeSkill.name : t("skills.addTitle")}</span>
        </div>
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
