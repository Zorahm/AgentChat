/** Files panel — all attachments + artifacts for the current chat. */

import type { ChatMessage } from "../../types/chat";
import type { Artifact } from "../../types/artifact";
import { parseArtifacts } from "../../utils/parseArtifacts";
import { fileExtIcon } from "../../utils/toolIcons";

interface FilesPanelProps {
  messages: ChatMessage[];
  onOpenFile: (path: string) => void;
}

interface FileEntry {
  name: string;
  path: string;
  size: number;
  ext: string;
  source: "attachment" | "artifact";
}

function collectFiles(messages: ChatMessage[]): FileEntry[] {
  const seen = new Set<string>();
  const files: FileEntry[] = [];

  for (const msg of messages) {
    // User attachments
    if (msg.role === "user" && msg.attachments) {
      for (const a of msg.attachments) {
        const key = a.path ?? a.name;
        if (seen.has(key)) continue;
        seen.add(key);
        files.push({
          name: a.name,
          path: a.path ?? a.name,
          size: a.size,
          ext: a.name.split(".").pop()?.toLowerCase() ?? "",
          source: "attachment",
        });
      }
    }

    // Assistant artifacts
    if (msg.role === "assistant") {
      const { artifacts } = parseArtifacts(msg.content);
      for (const a of artifacts) {
        if (!a.path) continue;
        if (seen.has(a.path)) continue;
        seen.add(a.path);
        const name = a.path.split("/").pop() ?? a.path;
        files.push({
          name,
          path: a.path,
          size: 0,
          ext: name.split(".").pop()?.toLowerCase() ?? "",
          source: "artifact",
        });
      }
    }
  }

  return files;
}

function fmtSize(bytes: number): string {
  if (bytes === 0) return "";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function FilesPanel({ messages, onOpenFile }: FilesPanelProps) {
  const files = collectFiles(messages);
  const attached = files.filter((f) => f.source === "attachment");
  const created = files.filter((f) => f.source === "artifact");

  return (
    <aside className="files-panel">
      <div className="fp-scroll">
        {attached.length > 0 && (
          <>
            <div className="fp-section-title">Прикреплённые</div>
            {attached.map((f) => (
              <div
                key={f.path}
                className="fp-row"
                onClick={() => onOpenFile(f.path)}
                title={f.path}
              >
                <span className="fp-row-ic">{fileExtIcon(f.ext)}</span>
                <span className="fp-row-info">
                  <span className="fp-row-name">{f.name}</span>
                  {f.size > 0 && <span className="fp-row-meta">{fmtSize(f.size)}</span>}
                </span>
              </div>
            ))}
          </>
        )}

        {created.length > 0 && (
          <>
            <div className="fp-section-title">Созданные</div>
            {created.map((f) => (
              <div
                key={f.path}
                className="fp-row"
                onClick={() => onOpenFile(f.path)}
                title={f.path}
              >
                <span className="fp-row-ic">{fileExtIcon(f.ext)}</span>
                <span className="fp-row-info">
                  <span className="fp-row-name">{f.name}</span>
                  <span className="fp-row-meta">{f.path}</span>
                </span>
              </div>
            ))}
          </>
        )}

        {files.length === 0 && (
          <div className="fp-empty">Нет файлов в этом чате</div>
        )}
      </div>
    </aside>
  );
}
