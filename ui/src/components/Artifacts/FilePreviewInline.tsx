/** Inline file preview — appears under write_file tool call. */

import type { LiveFile } from "../../types/artifact";

interface FilePreviewInlineProps {
  file: LiveFile;
}

export function FilePreviewInline({ file }: FilePreviewInlineProps) {
  const lines = file.content.split("\n");

  return (
    <div className="file-preview-inline">
      <div className="fp-inline-head">
        <span>📄 {file.path.split("/").pop() ?? file.path}</span>
        {!file.done && <span className="pv-writing">writing</span>}
      </div>
      <div className="fp-inline-code">
        {lines.slice(-12).map((line, i) => (
          <div key={i} className="fp-inline-ln">
            <span className="fp-inline-no">{Math.max(1, lines.length - 12 + i + 1)}</span>
            <span>{line || "\u00A0"}</span>
          </div>
        ))}
        {!file.done && <span className="pv-caret" />}
      </div>
    </div>
  );
}
