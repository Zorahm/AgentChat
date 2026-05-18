/** Artifact (file, code, url) types for side panel rendering. */

export type ArtifactType = "file" | "code" | "url" | "tool";
export type RenderMode = "render" | "code";

export interface Artifact {
  type: ArtifactType;
  path?: string;
  label?: string;
  [key: string]: string | undefined;
}

export interface ArtifactFile {
  path: string;
  label: string;
  content: string;
}

export interface LiveFile {
  id: string;
  path: string;
  content: string;
  done: boolean;
}

export const RENDERABLE_EXTS: ReadonlySet<string> = new Set([
  "md", "html", "svg", "png", "jpg", "jpeg", "gif", "webp", "pdf", "json", "csv",
]);
