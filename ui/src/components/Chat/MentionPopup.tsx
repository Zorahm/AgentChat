/** React component rendered inside the @-mention suggestion popup.
 *  Uses @phosphor-icons/react icons directly. */

import { forwardRef, useCallback, useEffect, useImperativeHandle, useState } from "react";
import { useTranslation } from "react-i18next";
import { FileText, Folder, SquaresFour, Globe } from "@phosphor-icons/react";

export interface MentionItemData {
  key: string;
  label: string;
  desc: string;
  type: "file" | "folder" | "skill" | "url";
  kbd?: string;
  kind: string;
}

const ICON_MAP: Record<string, React.ReactNode> = {
  file: <FileText size={14} weight="bold" />,
  folder: <Folder size={14} weight="bold" />,
  skill: <SquaresFour size={14} weight="bold" />,
  url: <Globe size={14} weight="bold" />,
};

export const MentionPopup = forwardRef<any, any>((props, ref) => {
  const { t } = useTranslation();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const items = props.items as MentionItemData[];

  const selectItem = useCallback(
    (index: number) => {
      const item = items[index];
      if (item) props.command(item);
    },
    [items, props.command],
  );

  const onKeyDown = useCallback(
    ({ event }: { event: KeyboardEvent }) => {
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSelectedIndex((i) => Math.max(0, i - 1));
        return true;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSelectedIndex((i) => Math.min(items.length - 1, i + 1));
        return true;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        selectItem(selectedIndex);
        return true;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        return true;
      }
      return false;
    },
    [items, selectItem, selectedIndex],
  );

  useImperativeHandle(ref, () => ({ onKeyDown }));

  useEffect(() => {
    setSelectedIndex(0);
  }, [items]);

  if (items.length === 0) {
    return <div className="mp-pop"><div className="mp-empty">{t("chat.mention.nothingFound")}</div></div>;
  }

  return (
    <div className="mp-pop">
      <div className="mp-head">{t("chat.mention.heading")}</div>
      {items.map((item, i) => (
        <div
          key={item.key}
          className={`mp-item${i === selectedIndex ? " active" : ""}`}
          onClick={() => selectItem(i)}
          onMouseEnter={() => setSelectedIndex(i)}
        >
          <span className="mp-item-ic">{ICON_MAP[item.type] ?? ICON_MAP.file}</span>
          <span className="mp-item-info">
            <span className="mp-item-label">{item.label}</span>
            {item.desc && <span className="mp-item-sub">{item.desc}</span>}
          </span>
        </div>
      ))}
    </div>
  );
});
