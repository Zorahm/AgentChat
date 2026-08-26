/** Settings → Plugins — Agent Plugins (agent-plugins.org) management.
 *
 * A plugin is one unit with one lifecycle: install it, switch it on or off,
 * remove it. Its skills and MCP servers are derived from the package on every
 * load, never copied out — so nothing here edits them individually.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { PuzzlePiece, ArrowsClockwise, Plus } from "@phosphor-icons/react";
import { Button } from "@astryxdesign/core/Button";
import { usePlugins } from "../../../hooks/usePlugins";
import { InstallPluginForm } from "./plugins/InstallPluginForm";
import { PluginCard } from "./plugins/PluginCard";

export function PluginsTab() {
  const { t } = useTranslation();
  const {
    plugins,
    location,
    loading,
    error,
    refresh,
    installFromGithub,
    installLocal,
    installArchive,
    setEnabled,
    remove,
  } = usePlugins();

  const [installing, setInstalling] = useState(false);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  /** Runs one install and keeps the panel open when it fails, so the message
   *  stays next to the field that produced it. */
  const runInstall = async (install: () => Promise<string | null>) => {
    setBusy(true);
    setFormError(null);
    const message = await install();
    setBusy(false);
    if (message) setFormError(message);
    else setInstalling(false);
  };

  const onDelete = async (name: string) => {
    if (!confirm(t("settings.plugins.removeConfirm", { name }))) return;
    const message = await remove(name);
    if (message) setFormError(message);
    if (expanded === name) setExpanded(null);
  };

  return (
    <>
      <div className="st2-row-between">
        <div>
          <h3 className="st2-h">
            <PuzzlePiece size={18} weight="duotone" style={{ verticalAlign: "-3px" }} />{" "}
            {t("settings.plugins.title")}
          </h3>
          <p className="st2-sub">{t("settings.plugins.description")}</p>
        </div>
        <div className="plg-header-actions">
          <Button
            label={t("settings.plugins.install")}
            icon={<Plus size={14} />}
            onClick={() => {
              setFormError(null);
              setInstalling(true);
            }}
            variant="secondary"
            size="sm"
          />
          <Button
            label={loading ? "…" : t("settings.plugins.refresh")}
            icon={<ArrowsClockwise size={14} />}
            onClick={() => void refresh()}
            isDisabled={loading}
            variant="secondary"
            size="sm"
          />
        </div>
      </div>

      {installing && (
        <InstallPluginForm
          busy={busy}
          onClose={() => setInstalling(false)}
          onInstallGithub={(source) => void runInstall(() => installFromGithub(source))}
          onInstallLocal={(path) => void runInstall(() => installLocal(path))}
          onInstallArchive={(file) => void runInstall(() => installArchive(file))}
        />
      )}

      {(formError ?? error) && <div className="st2-error">{formError ?? error}</div>}

      {plugins.length === 0 && !loading && (
        <p className="st2-sub" style={{ color: "var(--muted)", marginTop: 0 }}>
          {t("settings.plugins.empty")}
        </p>
      )}

      <div className="plg-list">
        {plugins.map((plugin) => (
          <PluginCard
            key={plugin.name}
            plugin={plugin}
            open={expanded === plugin.name}
            onToggleOpen={() => setExpanded(expanded === plugin.name ? null : plugin.name)}
            onSetEnabled={(enabled) => void setEnabled(plugin.name, enabled)}
            onDelete={() => void onDelete(plugin.name)}
          />
        ))}
      </div>

      {location && (
        <p className="plg-location">
          {t("settings.plugins.location", { path: location.plugins_dir })}
        </p>
      )}
    </>
  );
}
