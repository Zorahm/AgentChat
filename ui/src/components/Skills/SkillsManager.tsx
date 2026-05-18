/** Skills manager — v2 wireframe design. Install, browse, manage skills. */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowsClockwise, FolderOpen, Plus, MagnifyingGlass,
  CaretDown, CaretUp, DotsThree, Trash, ArrowUp,
} from "@phosphor-icons/react";
import { API_BASE } from "../../utils/apiBase";

interface SkillInfo {
  name: string;
  description: string;
  version: string;
  author: string;
}

type InstallMode = "github" | "file" | "url" | "dir";

const BADGE_COLORS = [
  "bg-h-1", "bg-h-2", "bg-h-3", "bg-h-4", "bg-h-5", "bg-h-6",
];

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

interface SkillsManagerProps {
  onClose?: () => void;
}

export function SkillsManager({ onClose }: SkillsManagerProps) {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [source, setSource] = useState("");
  const [installMode, setInstallMode] = useState<InstallMode>("github");
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [menuOpen, setMenuOpen] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const fetchSkills = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/skills`);
      if (res.ok) setSkills(await res.json());
    } catch { /* */ }
  }, []);

  useEffect(() => { fetchSkills(); }, [fetchSkills]);

  useEffect(() => {
    if (!menuOpen) return;
    const h = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest(".skc-menu")) setMenuOpen(null);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [menuOpen]);

  const handleInstall = async () => {
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
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail ?? "Install failed");
      }
      setSource("");
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
      await fetchSkills();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  };

  const filtered = skills.filter((s) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q);
  });

  const installTitle = {
    github: "github.com /",
    file: "file://",
    url: "https://",
    dir: "~/",
  }[installMode];

  return (
    <div className="sk">
      {/* Header */}
      <div className="sk-top">
        {onClose && (
          <button className="sk-back" onClick={onClose}>← Назад</button>
        )}
        <div>
          <h3>
            Скиллы
            <span className="count">{skills.length} установлено</span>
          </h3>
          <p className="lede">
            Расширяют возможности модели. Манифест пересобирается автоматически.
          </p>
        </div>
        <div className="actions">
          <button className="pill-btn" onClick={fetchSkills} title="Обновить">
            <ArrowsClockwise /> Обновить
          </button>
          <button className="pill-btn" title="Папка">
            <FolderOpen /> Папка
          </button>
        </div>
      </div>

      {/* Install zone */}
      <div className="sk-install">
        <div className="sk-segmented">
          {(["github", "file", "url", "dir"] as InstallMode[]).map((m) => (
            <span
              key={m}
              className={`sk-seg${m === installMode ? " active" : ""}`}
              onClick={() => setInstallMode(m)}
            >
              {m === "github" ? "● GitHub" : m === "file" ? "⤓ Файл" : m === "url" ? "⚭ URL" : "◩ Папка"}
            </span>
          ))}
        </div>

        <div className="sk-source">
          <div className="sk-source-input">
            <span className="lead">{installTitle}</span>
            <input
              ref={inputRef}
              type="text"
              placeholder="owner/repo"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !installing && handleInstall()}
              disabled={installing}
            />
          </div>
          <button
            className="pill-btn primary"
            onClick={handleInstall}
            disabled={installing || !source.trim()}
          >
            <Plus /> Установить
          </button>
        </div>

        {installing && (
          <div className="sk-progress">
            <span className="sk-spin" />
            <span className="sk-steps">Установка…</span>
          </div>
        )}

        {error && <div className="sk-error">{error}</div>}
      </div>

      {/* Toolbar */}
      <div className="sk-tools">
        <div className="sk-search">
          <MagnifyingGlass />
          <input
            placeholder="Поиск по названию, описанию…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      {/* List */}
      <div className="sk-list">
        {filtered.map((s) => {
          const isExpanded = expanded === s.name;
          const src = fmtSource(s.name);
          return (
            <div
              key={s.name}
              className={`sk-card${isExpanded ? " expanded" : ""}`}
            >
              <div
                className="skc-head"
                onClick={() => setExpanded(isExpanded ? null : s.name)}
              >
                <div className={`skc-badge ${getBadgeColor(s.name)}`}>
                  {s.name[0]?.toUpperCase() ?? "?"}
                </div>
                <div className="skc-info">
                  <div className="skc-name">
                    {s.name}
                    {s.version && <span className="version">v{s.version}</span>}
                    {s.author && <span className="author">· {s.author}</span>}
                  </div>
                  {s.description && <div className="skc-desc">{s.description}</div>}
                </div>
                {src && (
                  <a className="skc-source" title={src}>
                    <span className="gh">●</span> {src} ↗
                  </a>
                )}
                <div
                  className="skc-menu"
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenuOpen(menuOpen === s.name ? null : s.name);
                  }}
                >
                  <DotsThree />
                  {menuOpen === s.name && (
                    <div className="skc-popover">
                      <div className="pop-item" onClick={(e) => { e.stopPropagation(); handleUninstall(s.name); }}>
                        <span className="ic"><Trash /></span>Удалить
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {isExpanded && (
                <div className="skc-body">
                  <div>
                    <h6>SKILL.md · превью</h6>
                    <div className="skc-readme">
                      <p>{s.description || "Описание недоступно."}</p>
                      <span className="more">Показать всё →</span>
                    </div>
                  </div>
                  <div>
                    <h6>Мета</h6>
                    <div className="skc-stat">
                      <span className="key">Версия</span>
                      <span className="val">{s.version ? `v${s.version}` : "—"}</span>
                    </div>
                    <div className="skc-stat">
                      <span className="key">Автор</span>
                      <span className="val">{s.author || "—"}</span>
                    </div>
                    {src && (
                      <div className="skc-stat">
                        <span className="key">Источник</span>
                        <span className="val linked">{src} ↗</span>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}

        {filtered.length === 0 && (
          <div className="sk-empty">
            {search ? "Ничего не найдено" : "Нет установленных скиллов"}
          </div>
        )}
      </div>
    </div>
  );
}
