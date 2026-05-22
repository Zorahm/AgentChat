/** Skills manager — redesigned. */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowsClockwise, FolderOpen, MagnifyingGlass, Trash,
  Plus, Package, ArrowSquareOut, X, CheckCircle, Warning, ArrowClockwise,
} from "@phosphor-icons/react";
import { API_BASE } from "../../utils/apiBase";

interface SkillInfo {
  name: string;
  description: string;
  version: string;
  author: string;
}

const BADGE_COLORS = [
  "sk2-badge--a", "sk2-badge--b", "sk2-badge--c",
  "sk2-badge--d", "sk2-badge--e", "sk2-badge--f",
];

function getBadgeColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return BADGE_COLORS[Math.abs(h) % BADGE_COLORS.length]!;
}

/** Fetch the version string from the first SKILL.md found in anthropics/skills on GitHub. */
async function fetchAnthropicPackVersion(): Promise<string | null> {
  try {
    const url =
      "https://raw.githubusercontent.com/anthropics/skills/main/SKILL.md";
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    const text = await res.text();
    const m = text.match(/^version:\s*["']?([^\s"'\n]+)/m);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

type PackState =
  | { kind: "unknown" }
  | { kind: "not-installed" }
  | { kind: "up-to-date"; version: string }
  | { kind: "outdated"; installed: string; latest: string }
  | { kind: "installed-no-version" };

interface SkillsManagerProps {
  onClose?: () => void;
}

export function SkillsManager({ onClose }: SkillsManagerProps) {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [source, setSource] = useState("");
  const [installing, setInstalling] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [packState, setPackState] = useState<PackState>({ kind: "unknown" });
  const inputRef = useRef<HTMLInputElement>(null);

  const fetchSkills = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/skills`);
      if (res.ok) {
        const list: SkillInfo[] = await res.json();
        setSkills(list);
        return list;
      }
    } catch { /* offline */ }
    return null;
  }, []);

  /** Derive Anthropic Pack state from the installed list + optional GitHub check. */
  const refreshPackState = useCallback(async (list: SkillInfo[] | null) => {
    const current = list ?? skills;
    const anthropicSkills = current.filter(
      (s) =>
        s.author?.toLowerCase().includes("anthropic") ||
        s.name.toLowerCase().includes("docx") ||
        s.name.toLowerCase().includes("xlsx") ||
        s.name.toLowerCase().includes("pptx") ||
        s.name.toLowerCase().includes("pdf"),
    );

    if (anthropicSkills.length === 0) {
      setPackState({ kind: "not-installed" });
      return;
    }

    // Pick the most recent version string among installed anthropic skills
    const installedVersion = anthropicSkills
      .map((s) => s.version)
      .filter(Boolean)
      .sort()
      .at(-1) ?? "";

    if (!installedVersion) {
      setPackState({ kind: "installed-no-version" });
      return;
    }

    // Try to compare with GitHub — silently skip if offline
    const latest = await fetchAnthropicPackVersion();
    if (!latest) {
      setPackState({ kind: "up-to-date", version: installedVersion });
      return;
    }

    if (latest !== installedVersion) {
      setPackState({ kind: "outdated", installed: installedVersion, latest });
    } else {
      setPackState({ kind: "up-to-date", version: installedVersion });
    }
  }, [skills]);

  useEffect(() => {
    fetchSkills().then(refreshPackState);
  }, [fetchSkills, refreshPackState]);

  const doInstall = useCallback(async (src: string) => {
    const trimmed = src.trim();
    if (!trimmed) return;
    setInstalling(trimmed);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/skills/install`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: trimmed }),
      });
      if (!res.ok) {
        const err = await res.json() as { detail?: string };
        throw new Error(err.detail ?? "Install failed");
      }
      setSource("");
      const list = await fetchSkills();
      await refreshPackState(list);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setInstalling(null);
    }
  }, [fetchSkills, refreshPackState]);

  const handleUninstall = useCallback(async (name: string) => {
    setError(null);
    try {
      await fetch(`${API_BASE}/skills/${encodeURIComponent(name)}`, { method: "DELETE" });
      const list = await fetchSkills();
      await refreshPackState(list);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }, [fetchSkills, refreshPackState]);

  const filtered = skills.filter((s) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q);
  });

  return (
    <div className="sk2">

      {/* ── Header ── */}
      <div className="sk2-head">
        <div className="sk2-head-left">
          {onClose && (
            <button className="sk2-back" onClick={onClose}>← Назад</button>
          )}
          <div>
            <h2 className="sk2-title">
              Скиллы
              {skills.length > 0 && <span className="sk2-count">{skills.length}</span>}
            </h2>
            <p className="sk2-lede">Расширяют возможности модели. Манифест пересобирается при изменениях.</p>
          </div>
        </div>
        <div className="sk2-head-actions">
          <button
            className="sk2-btn"
            onClick={() => fetchSkills().then(refreshPackState)}
            title="Обновить список"
          >
            <ArrowsClockwise size={14} />
            Обновить
          </button>
          <button className="sk2-btn" title="Открыть папку скиллов">
            <FolderOpen size={14} />
            Папка
          </button>
        </div>
      </div>

      <div className="sk2-body">

        {/* ── Anthropic Pack status ── */}
        {packState.kind !== "unknown" && (
          <PackStatusBanner
            state={packState}
            installing={installing === "anthropics/skills"}
            onInstall={() => doInstall("anthropics/skills")}
          />
        )}

        {/* ── Install input ── */}
        <div className="sk2-install-wrap">
          <div className="sk2-install-row">
            <div className={`sk2-install-field${installing && installing === source.trim() ? " sk2-install-field--loading" : ""}`}>
              <ArrowSquareOut size={15} className="sk2-install-icon" />
              <input
                ref={inputRef}
                className="sk2-install-input"
                placeholder="github.com/owner/repo, https://…, path/to/skill.zip"
                value={source}
                onChange={(e) => setSource(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && !installing && doInstall(source)}
                disabled={!!installing}
              />
              {source && (
                <button className="sk2-install-clear" onClick={() => setSource("")}>
                  <X size={12} weight="bold" />
                </button>
              )}
            </div>
            <button
              className="sk2-install-btn"
              onClick={() => doInstall(source)}
              disabled={!!installing || !source.trim()}
            >
              {installing && installing === source.trim()
                ? <><span className="sk2-spin" /> Установка…</>
                : <><Plus size={14} weight="bold" /> Установить</>
              }
            </button>
          </div>
          <div className="sk2-install-hints">
            <span>owner/repo</span>
            <span>·</span>
            <span>https://github.com/…</span>
            <span>·</span>
            <span>.skill</span>
            <span>·</span>
            <span>.zip</span>
          </div>
          {error && (
            <div className="sk2-error">
              <X size={13} weight="bold" /> {error}
            </div>
          )}
        </div>

        {/* ── Installed ── */}
        <div className="sk2-section sk2-section--installed">
          <div className="sk2-section-head">
            <Package size={12} weight="fill" className="sk2-section-ic" />
            <span className="sk2-section-label">Установленные</span>
            <span className="sk2-installed-count">{skills.length}</span>
            <div className="sk2-search">
              <MagnifyingGlass size={12} />
              <input
                placeholder="Поиск…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          </div>

          {filtered.length === 0 ? (
            <SkillsEmpty hasSearch={!!search} />
          ) : (
            <div className="sk2-grid">
              {filtered.map((s) => (
                <SkillCard
                  key={s.name}
                  skill={s}
                  expanded={expanded === s.name}
                  onToggle={() => setExpanded(expanded === s.name ? null : s.name)}
                  onUninstall={() => handleUninstall(s.name)}
                />
              ))}
            </div>
          )}
        </div>

      </div>
    </div>
  );
}

/* ── Pack Status Banner ──────────────────────────────────────────────────── */

interface PackStatusBannerProps {
  state: PackState;
  installing: boolean;
  onInstall: () => void;
}

function PackStatusBanner({ state, installing, onInstall }: PackStatusBannerProps) {
  if (state.kind === "not-installed") {
    return (
      <div className="sk2-pack sk2-pack--suggest">
        <div className="sk2-pack-icon sk2-pack-icon--suggest">📦</div>
        <div className="sk2-pack-text">
          <div className="sk2-pack-title">Рекомендуем Anthropic Pack</div>
          <div className="sk2-pack-sub">
            Официальная коллекция для работы с файлами — Word, Excel, PowerPoint, PDF.
            Любая модель будет лучше читать и создавать документы.
          </div>
        </div>
        <button
          className="sk2-pack-btn sk2-pack-btn--primary"
          onClick={onInstall}
          disabled={installing}
        >
          {installing ? <><span className="sk2-spin" /> Установка…</> : "Установить"}
        </button>
      </div>
    );
  }

  if (state.kind === "outdated") {
    return (
      <div className="sk2-pack sk2-pack--warn">
        <div className="sk2-pack-icon sk2-pack-icon--warn">
          <Warning size={18} weight="fill" />
        </div>
        <div className="sk2-pack-text">
          <div className="sk2-pack-title">Anthropic Pack устарел</div>
          <div className="sk2-pack-sub">
            Установлен <code>v{state.installed}</code>, доступен <code>v{state.latest}</code> — рекомендуем обновить.
          </div>
        </div>
        <button
          className="sk2-pack-btn sk2-pack-btn--warn"
          onClick={onInstall}
          disabled={installing}
        >
          {installing
            ? <><span className="sk2-spin sk2-spin--sm" /> Обновление…</>
            : <><ArrowClockwise size={13} weight="bold" /> Обновить</>
          }
        </button>
      </div>
    );
  }

  if (state.kind === "up-to-date") {
    return (
      <div className="sk2-pack sk2-pack--ok">
        <div className="sk2-pack-icon sk2-pack-icon--ok">
          <CheckCircle size={18} weight="fill" />
        </div>
        <div className="sk2-pack-text">
          <div className="sk2-pack-title">Anthropic Pack установлен</div>
          <div className="sk2-pack-sub">
            Версия <code>v{state.version}</code> — всё актуально.
          </div>
        </div>
      </div>
    );
  }

  if (state.kind === "installed-no-version") {
    return (
      <div className="sk2-pack sk2-pack--ok">
        <div className="sk2-pack-icon sk2-pack-icon--ok">
          <CheckCircle size={18} weight="fill" />
        </div>
        <div className="sk2-pack-text">
          <div className="sk2-pack-title">Anthropic Pack установлен</div>
          <div className="sk2-pack-sub">Скиллы активны и готовы к работе.</div>
        </div>
        <button
          className="sk2-pack-btn sk2-pack-btn--ghost"
          onClick={onInstall}
          disabled={installing}
          title="Переустановить для получения последней версии"
        >
          {installing
            ? <><span className="sk2-spin sk2-spin--sm" /> …</>
            : <><ArrowClockwise size={13} weight="bold" /> Обновить</>
          }
        </button>
      </div>
    );
  }

  return null;
}

/* ── Skill Card ─────────────────────────────────────────────────────────── */

function SkillCard({ skill, expanded, onToggle, onUninstall }: {
  skill: SkillInfo;
  expanded: boolean;
  onToggle: () => void;
  onUninstall: () => void;
}) {
  const color = getBadgeColor(skill.name);
  const initial = skill.name[0]?.toUpperCase() ?? "?";

  return (
    <div className={`sk2-card${expanded ? " sk2-card--open" : ""}`}>
      <div className="sk2-card-head" onClick={onToggle}>
        <div className={`sk2-badge ${color}`}>{initial}</div>
        <div className="sk2-card-info">
          <div className="sk2-card-name">
            {skill.name}
            {skill.version && <span className="sk2-card-ver">v{skill.version}</span>}
          </div>
          {skill.description && (
            <div className="sk2-card-desc">{skill.description}</div>
          )}
        </div>
        <button
          className="sk2-card-del"
          onClick={(e) => { e.stopPropagation(); onUninstall(); }}
          title="Удалить скилл"
        >
          <Trash size={13} />
        </button>
      </div>

      {expanded && (
        <div className="sk2-card-body">
          <div className="sk2-card-meta">
            {skill.version && <div className="sk2-meta-row"><span>Версия</span><span>v{skill.version}</span></div>}
            {skill.author && <div className="sk2-meta-row"><span>Автор</span><span>{skill.author}</span></div>}
          </div>
          {skill.description && (
            <p className="sk2-card-full-desc">{skill.description}</p>
          )}
        </div>
      )}
    </div>
  );
}

/* ── Empty State ────────────────────────────────────────────────────────── */

function SkillsEmpty({ hasSearch }: { hasSearch: boolean }) {
  return (
    <div className="sk2-empty">
      <div className="sk2-empty-icon">
        {hasSearch ? <MagnifyingGlass size={32} weight="duotone" /> : <Package size={32} weight="duotone" />}
      </div>
      <p className="sk2-empty-title">
        {hasSearch ? "Ничего не найдено" : "Нет установленных скиллов"}
      </p>
      <p className="sk2-empty-sub">
        {hasSearch
          ? "Попробуй другой запрос"
          : "Установи скилл через поле выше или найди на GitHub"}
      </p>
    </div>
  );
}
