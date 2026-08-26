/** The three install sources, in one panel.
 *
 * Agent Plugins leaves distribution entirely to the client, so there is no
 * registry to browse — a source is a repository, a folder, or a zip.
 */

import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { X, Upload } from "@phosphor-icons/react";
import { Button } from "@astryxdesign/core/Button";
import { IconButton } from "@astryxdesign/core/IconButton";

type Source = "github" | "local" | "archive";

export interface InstallPluginFormProps {
  busy: boolean;
  onClose: () => void;
  onInstallGithub: (source: string) => void;
  onInstallLocal: (path: string) => void;
  onInstallArchive: (file: File) => void;
}

export function InstallPluginForm({
  busy,
  onClose,
  onInstallGithub,
  onInstallLocal,
  onInstallArchive,
}: InstallPluginFormProps) {
  const { t } = useTranslation();
  const [source, setSource] = useState<Source>("github");
  const [repo, setRepo] = useState("");
  const [path, setPath] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  const tabs: Array<{ id: Source; label: string }> = [
    { id: "github", label: t("settings.plugins.sourceGithub") },
    { id: "local", label: t("settings.plugins.sourceLocal") },
    { id: "archive", label: t("settings.plugins.sourceArchive") },
  ];

  return (
    <div className="plg-add-form">
      <div className="plg-add-form-head">
        <span>{t("settings.plugins.installTitle")}</span>
        <IconButton
          label={t("common.close")}
          icon={<X size={14} />}
          onClick={onClose}
          variant="ghost"
          size="sm"
        />
      </div>

      <div className="plg-tabs">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={`plg-tab${source === tab.id ? " plg-tab--active" : ""}`}
            onClick={() => setSource(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {source === "github" && (
        <label className="plg-field">
          {t("settings.plugins.githubLabel")}
          <input
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            placeholder="owner/repo"
            spellCheck={false}
          />
          <span className="plg-hint">{t("settings.plugins.githubHint")}</span>
        </label>
      )}

      {source === "local" && (
        <label className="plg-field">
          {t("settings.plugins.localLabel")}
          <input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder={t("settings.plugins.localPlaceholder")}
            spellCheck={false}
          />
          <span className="plg-hint">{t("settings.plugins.localHint")}</span>
        </label>
      )}

      {source === "archive" && (
        <div className="plg-field">
          {t("settings.plugins.archiveLabel")}
          <input
            ref={fileInput}
            type="file"
            accept=".zip"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) onInstallArchive(file);
              e.target.value = "";
            }}
            hidden
          />
          <Button
            label={t("settings.plugins.chooseFile")}
            icon={<Upload size={14} />}
            onClick={() => fileInput.current?.click()}
            variant="secondary"
            size="sm"
            isDisabled={busy}
          />
          <span className="plg-hint">{t("settings.plugins.archiveHint")}</span>
        </div>
      )}

      {source !== "archive" && (
        <div className="plg-actions">
          <Button
            label={busy ? t("settings.plugins.installing") : t("settings.plugins.install")}
            onClick={() =>
              source === "github" ? onInstallGithub(repo.trim()) : onInstallLocal(path.trim())
            }
            isDisabled={busy || !(source === "github" ? repo.trim() : path.trim())}
            size="sm"
          />
        </div>
      )}
    </div>
  );
}
