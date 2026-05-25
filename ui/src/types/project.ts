/** Project types — a custom prompt + files injected into every chat in the project. */

export type ExtractStatus = "ok" | "failed" | "skipped";

export interface ProjectFileInfo {
  id: string;
  project_id: string;
  name: string;
  size: number;
  mime_type: string;
  extract_status: ExtractStatus;
  text_len: number;
  created_at: number;
}

export interface ProjectSummary {
  id: string;
  name: string;
  instructions: string;
  file_count: number;
  created_at: number;
  updated_at: number;
}

export interface ProjectFull {
  id: string;
  name: string;
  instructions: string;
  created_at: number;
  updated_at: number;
  files: ProjectFileInfo[];
}

export interface ProjectFileText {
  id: string;
  name: string;
  mime_type: string;
  extract_status: ExtractStatus;
  text: string;
}
