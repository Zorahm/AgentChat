/** Files panel — all attachments + artifacts for the current chat. */

import { X } from "@phosphor-icons/react";
import type { ChatMessage } from "../../types/chat";
import type { Artifact } from "../../types/artifact";
import { parseArtifacts } from "../../utils/parseArtifacts";
import { fileExtIcon } from "../../utils/toolIcons";
import { basename } from "../../utils/basename";

interface FilesPanelProps {
  messages: ChatMessage[];
  onOpenFile: (path: string) => void;
  onClose: () => void;
}

interface FileEntry {
  name: string;
  path: string;
  ext: string;
  source: "attachment" | "artifact";
}

function collectFiles(messages: ChatMessage[]): FileEntry[] {
  const seen = new Set<string>();
  const files: FileEntry[] = [];

  for (const msg of messages) {
    if (msg.role === "user" && msg.attachments) {
      for (const a of msg.attachments) {
        const key = a.path ?? a.name;
        if (seen.has(key)) continue;
        seen.add(key);
        files.push({
          name: a.name,
          path: a.path ?? a.name,
          ext: a.name.split(".").pop()?.toLowerCase() ?? "",
          source: "attachment",
        });
      }
    }

    if (msg.role === "assistant") {
      const { artifacts } = parseArtifacts(msg.content);
      for (const a of artifacts) {
        if (!a.path) continue;
        if (seen.has(a.path)) continue;
        seen.add(a.path);
        const name = basename(a.path);
        files.push({
          name,
          path: a.path,
          ext: name.split(".").pop()?.toLowerCase() ?? "",
          source: "artifact",
        });
      }
    }
  }

  return files;
}

export function FilesPanel({ messages, onOpenFile, onClose }: FilesPanelProps) {
  const files = collectFiles(messages);
  const attached = files.filter((f) => f.source === "attachment");
  const created = files.filter((f) => f.source === "artifact");

  return (
    <aside className="files-panel">
      <div className="fp-head">
        <span className="fp-head-title">Файлы чата</span>
        <button className="fp-head-close" onClick={onClose} title="Закрыть">
          <X size={15} weight="bold" />
        </button>
      </div>
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
                <span className="fp-row-name">{f.name}</span>
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
                <span className="fp-row-name">{f.name}</span>
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
