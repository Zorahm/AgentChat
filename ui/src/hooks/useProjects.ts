/** Project CRUD + file management, backed by the /api/projects endpoints. */

import { useCallback, useEffect, useState } from "react";
import { API_BASE } from "../utils/apiBase";
import type { ProjectFileInfo, ProjectFileText, ProjectFull, ProjectSummary } from "../types/project";

export interface UseProjectsResult {
  projects: ProjectSummary[];
  loading: boolean;
  refresh: () => Promise<void>;
  createProject: (name: string, instructions?: string) => Promise<ProjectFull | null>;
  getProject: (id: string) => Promise<ProjectFull | null>;
  updateProject: (id: string, patch: { name?: string; instructions?: string }) => Promise<ProjectFull | null>;
  deleteProject: (id: string) => Promise<void>;
  uploadFiles: (id: string, files: File[]) => Promise<ProjectFileInfo[]>;
  deleteFile: (id: string, fileId: string) => Promise<void>;
  getFileText: (id: string, fileId: string) => Promise<ProjectFileText | null>;
}

export function useProjects(): UseProjectsResult {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${API_BASE}/projects`);
      if (r.ok) setProjects((await r.json()) as ProjectSummary[]);
    } catch {
      /* offline — keep last known list */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const createProject = useCallback(
    async (name: string, instructions = ""): Promise<ProjectFull | null> => {
      try {
        const r = await fetch(`${API_BASE}/projects`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, instructions }),
        });
        if (!r.ok) return null;
        const proj = (await r.json()) as ProjectFull;
        await refresh();
        return proj;
      } catch {
        return null;
      }
    },
    [refresh],
  );

  const getProject = useCallback(async (id: string): Promise<ProjectFull | null> => {
    try {
      const r = await fetch(`${API_BASE}/projects/${encodeURIComponent(id)}`);
      if (!r.ok) return null;
      return (await r.json()) as ProjectFull;
    } catch {
      return null;
    }
  }, []);

  const updateProject = useCallback(
    async (id: string, patch: { name?: string; instructions?: string }): Promise<ProjectFull | null> => {
      try {
        const r = await fetch(`${API_BASE}/projects/${encodeURIComponent(id)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        if (!r.ok) return null;
        const proj = (await r.json()) as ProjectFull;
        await refresh();
        return proj;
      } catch {
        return null;
      }
    },
    [refresh],
  );

  const deleteProject = useCallback(
    async (id: string): Promise<void> => {
      try {
        await fetch(`${API_BASE}/projects/${encodeURIComponent(id)}`, { method: "DELETE" });
      } catch {
        /* no-op */
      }
      await refresh();
    },
    [refresh],
  );

  const uploadFiles = useCallback(
    async (id: string, files: File[]): Promise<ProjectFileInfo[]> => {
      const form = new FormData();
      for (const f of files) form.append("files", f);
      try {
        const r = await fetch(`${API_BASE}/projects/${encodeURIComponent(id)}/files`, {
          method: "POST",
          body: form,
        });
        if (!r.ok) return [];
        const result = (await r.json()) as ProjectFileInfo[];
        await refresh();
        return result;
      } catch {
        return [];
      }
    },
    [refresh],
  );

  const deleteFile = useCallback(
    async (id: string, fileId: string): Promise<void> => {
      try {
        await fetch(
          `${API_BASE}/projects/${encodeURIComponent(id)}/files/${encodeURIComponent(fileId)}`,
          { method: "DELETE" },
        );
      } catch {
        /* no-op */
      }
      await refresh();
    },
    [refresh],
  );

  const getFileText = useCallback(
    async (id: string, fileId: string): Promise<ProjectFileText | null> => {
      try {
        const r = await fetch(
          `${API_BASE}/projects/${encodeURIComponent(id)}/files/${encodeURIComponent(fileId)}/text`,
        );
        if (!r.ok) return null;
        return (await r.json()) as ProjectFileText;
      } catch {
        return null;
      }
    },
    [],
  );

  return {
    projects,
    loading,
    refresh,
    createProject,
    getProject,
    updateProject,
    deleteProject,
    uploadFiles,
    deleteFile,
    getFileText,
  };
}
