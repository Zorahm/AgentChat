/** Formatted YAML frontmatter (name + description + remaining fields) — shown
 * above a rendered markdown body instead of dumping the raw `--- … ---` block.
 * Shared by the artifact markdown views and the Skills manager readme pane;
 * callers that already display name/description elsewhere pass a pre-filtered
 * `meta` so the card degrades to a chips-only row. Styles: panels.css (fm-*). */

import { useTranslation } from "react-i18next";

export interface FrontmatterCardProps {
  meta: Record<string, string>;
}

export function FrontmatterCard({ meta }: FrontmatterCardProps) {
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
