/** Collect every file across all chats — uploaded attachments and files the
 * model surfaced (via present_files tool calls). Walks each session's full
 * variant tree (not just the active branch) so nothing is lost when a chat has
 * edited/regenerated turns. */

import type { ChatNode } from "../types/chat";
import type { ChatSession } from "../hooks/useChats";
import { presentedArtifacts } from "./presentedFiles";
import { basename } from "./basename";

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif"]);

export interface GalleryFile {
  name: string;
  path: string;
  ext: string;
  source: "attachment" | "artifact";
  sessionId: string;
  sessionTitle: string;
  /** Timestamp of the message the file came from (for sorting). */
  ts: number;
  isImage: boolean;
  /** Inline data URL for freshly-attached images, when available. */
  dataUrl: string | null;
}

function extOf(name: string): string {
  return name.includes(".") ? (name.split(".").pop() ?? "").toLowerCase() : "";
}

export function collectAllFiles(sessions: ChatSession[]): GalleryFile[] {
  const files: GalleryFile[] = [];
  const seen = new Set<string>(); // sessionId + path/name

  for (const session of sessions) {
    const push = (f: Omit<GalleryFile, "sessionId" | "sessionTitle" | "isImage">) => {
      const key = `${session.id}::${f.path}`;
      if (seen.has(key)) return;
      seen.add(key);
      files.push({
        ...f,
        sessionId: session.id,
        sessionTitle: session.title,
        isImage: IMAGE_EXTS.has(f.ext),
      });
    };

    const walk = (nodes: ChatNode[]) => {
      for (const node of nodes) {
        if (node.role === "user") {
          for (const uv of node.variants) {
            for (const a of uv.attachments ?? []) {
              push({
                name: a.name,
                path: a.path ?? a.name,
                ext: extOf(a.name),
                source: "attachment",
                ts: uv.createdAt,
                dataUrl: a.data_url,
              });
            }
            if (uv.child) walk([uv.child]);
          }
        } else {
          for (const av of node.variants) {
            for (const art of presentedArtifacts(av.toolCalls)) {
              if (!art.path) continue;
              const name = basename(art.path);
              push({
                name,
                path: art.path,
                ext: extOf(name),
                source: "artifact",
                ts: av.createdAt,
                dataUrl: null,
              });
            }
            if (av.children?.length) walk(av.children);
          }
        }
      }
    };

    walk(session.root ?? []);
  }

  // Newest first.
  files.sort((a, b) => b.ts - a.ts);
  return files;
}
