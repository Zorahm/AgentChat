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
  // Office binaries — no inline preview, but Render tab shows a download hint
  // (otherwise both tabs would be hidden and the user would see an empty pane).
  "docx", "doc", "pptx", "ppt", "xlsx", "xls",
]);

/** Binary / office formats whose raw bytes are useless as source code.
 * Code tab is hidden for these — only Render (where supported) + Download. */
export const BINARY_EXTS: ReadonlySet<string> = new Set([
  "pdf", "docx", "doc", "pptx", "ppt", "xlsx", "xls",
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico",
  "zip", "tar", "gz", "7z", "rar",
  "mp3", "mp4", "wav", "avi", "mov", "webm",
  "ttf", "otf", "woff", "woff2",
]);
