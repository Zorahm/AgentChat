/** Artifact card — Claude-style file card. */

import { File } from "@phosphor-icons/react";
import type { Artifact } from "../../types/artifact";

interface ArtifactCardProps {
  artifact: Artifact;
}

export function ArtifactCard({ artifact }: ArtifactCardProps) {
  if (artifact.type === "tool") return null;

  const path = artifact.path ?? "";
  const ext = path.split(".").pop()?.toUpperCase() ?? "";
  const name = artifact.label ?? path.split(/[/\\]/).pop() ?? path;

  const handleOpen = (e: React.MouseEvent) => {
    e.preventDefault();
    if (artifact.path) {
      window.dispatchEvent(new CustomEvent("open-artifact", { detail: artifact.path }));
    }
  };

  return (
    <div className="art-card" onClick={handleOpen}>
      <div className="art-card-icon">
        <File weight="regular" />
      </div>
      <div className="art-card-info">
        <span className="art-card-name">{name}</span>
        {ext && <span className="art-card-ext">{ext}</span>}
      </div>
      <button className="art-card-btn" onClick={handleOpen}>
        Открыть
      </button>
    </div>
  );
}
