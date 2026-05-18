/** Artifact card — unified art-link design. */

import { ArrowRight } from "@phosphor-icons/react";
import { fileExtIcon } from "../../utils/toolIcons";
import type { Artifact } from "../../types/artifact";

interface ArtifactCardProps {
  artifact: Artifact;
}

export function ArtifactCard({ artifact }: ArtifactCardProps) {
  if (artifact.type === "tool") return null;

  const path = artifact.path ?? "";
  const ext = path.split(".").pop()?.toUpperCase() ?? "?";
  const name = artifact.label ?? path.split("/").pop() ?? path;
  const dir = path.includes("/") ? path.split("/").slice(0, -1).join("/") : "";

  const handleOpen = () => {
    if (artifact.path) {
      window.dispatchEvent(new CustomEvent("open-artifact", { detail: artifact.path }));
    }
  };

  return (
    <a className="art-link" onClick={handleOpen}>
      <span className="art-link-ic">{fileExtIcon(ext.toLowerCase())}</span>
      <div className="art-link-info">
        <span className="art-link-name">{name}</span>
        <span className="art-link-meta">{dir || path}</span>
      </div>
      <span className="art-link-open">Открыть <span className="art-link-arrow"><ArrowRight /></span></span>
    </a>
  );
}
