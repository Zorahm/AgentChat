/** Artifact card — Claude-style file card. */

import { useState } from "react";
import { DownloadSimple, FloppyDisk, SpinnerGap } from "@phosphor-icons/react";
import type { Artifact } from "../../types/artifact";
import { basename } from "../../utils/basename";
import { fileExtIcon, fileExtKind } from "../../utils/toolIcons";
import { API_BASE } from "../../utils/apiBase";
import { downloadAndOpen } from "../../utils/downloadAndOpen";
import { canSaveAs, saveFileAs } from "../../utils/saveFileAs";
import { useTranslation } from "react-i18next";

interface ArtifactCardProps {
  artifact: Artifact;
}

export function ArtifactCard({ artifact }: ArtifactCardProps) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  if (artifact.type === "tool") return null;

  const path = artifact.path ?? "";
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const name = artifact.label ?? basename(path);
  const kindLabel = t(`artifacts.kind.${fileExtKind(ext)}`);

  const handleOpen = () => {
    if (artifact.path) {
      window.dispatchEvent(new CustomEvent("open-artifact", { detail: artifact.path }));
    }
  };

  const run = async (e: React.MouseEvent, action: (url: string, name: string) => Promise<unknown>) => {
    e.stopPropagation();
    if (!artifact.path || busy) return;
    setBusy(true);
    setError(false);
    try {
      const serveUrl = `${API_BASE}/files/serve?path=${encodeURIComponent(artifact.path)}`;
      await action(serveUrl, basename(artifact.path));
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };

  const handleDownload = (e: React.MouseEvent) => run(e, downloadAndOpen);
  const handleSaveAs = (e: React.MouseEvent) => run(e, saveFileAs);

  return (
    <div className="art-card" onClick={handleOpen}>
      <div className="art-card-icon">{fileExtIcon(ext)}</div>
      <div className="art-card-info">
        <span className="art-card-name">{name}</span>
        <span className="art-card-kind">
          {kindLabel}{ext && <> · {ext.toUpperCase()}</>}
        </span>
      </div>
      <div className="art-card-actions">
        {canSaveAs() && (
          <button
            className="art-card-btn art-card-btn--icon"
            onClick={handleSaveAs}
            disabled={busy}
            title={t("artifacts.saveAs")}
            aria-label={t("artifacts.saveAs")}
          >
            <FloppyDisk weight="bold" />
          </button>
        )}
        <button
          className={`art-card-btn${error ? " art-card-btn--err" : ""}`}
          onClick={handleDownload}
          disabled={busy}
          title={error ? t("artifacts.downloadFailed") : t("artifacts.downloadAndOpen")}
        >
          {busy ? <SpinnerGap className="art-card-btn-spin" weight="bold" /> : <DownloadSimple weight="bold" />}
          <span>{error ? t("artifacts.downloadFailed") : t("artifacts.downloadAndOpen")}</span>
        </button>
      </div>
    </div>
  );
}
