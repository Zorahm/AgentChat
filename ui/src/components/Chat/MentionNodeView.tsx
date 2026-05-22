/** React component rendered as the inline mention chip in TipTap.
 *  Uses @phosphor-icons/react icons directly. */

import { type NodeViewProps } from "@tiptap/react";
import { NodeViewWrapper } from "@tiptap/react";
import { FileText, Folder, SquaresFour, Globe } from "@phosphor-icons/react";

const ICON_MAP: Record<string, React.ReactNode> = {
  file: <FileText size={12} weight="bold" />,
  folder: <Folder size={12} weight="bold" />,
  skill: <SquaresFour size={12} weight="bold" />,
  url: <Globe size={12} weight="bold" />,
};

export function MentionNodeView({ node }: NodeViewProps) {
  const label = node.attrs.label as string;
  const parts = String(label).split(":");
  const type = parts.length > 1 ? parts[0]! : "file";
  const displayLabel = parts.length > 1 ? parts.slice(1).join(":") : label;
  const icon = ICON_MAP[type] ?? ICON_MAP.file;

  return (
    <NodeViewWrapper as="span" className={`mention-chip mention-chip--${type}`} data-label={label}>
      <span className="mention-chip-ic">{icon}</span>
      @{displayLabel}
    </NodeViewWrapper>
  );
}
