/** Artifact card — Claude-style file card. */

import { useState } from "react";
import { DownloadSimple, FloppyDisk } from "@phosphor-icons/react";
import { Button } from "@astryxdesign/core/Button";
import { IconButton } from "@astryxdesign/core/IconButton";
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
          <IconButton
            label={t("artifacts.saveAs")}
            icon={<FloppyDisk weight="bold" />}
            onClick={handleSaveAs}
            isDisabled={busy}
            tooltip={t("artifacts.saveAs")}
            size="sm"
            variant="ghost"
          />
        )}
        <Button
          label={error ? t("artifacts.downloadFailed") : t("artifacts.downloadAndOpen")}
          icon={<DownloadSimple weight="bold" />}
          onClick={handleDownload}
          isDisabled={busy}
          isLoading={busy}
          size="sm"
          variant={error ? "destructive" : "secondary"}
        >
          {error ? t("artifacts.downloadFailed") : t("artifacts.downloadAndOpen")}
        </Button>
      </div>
    </div>
  );
}
