/** Key/value editor for a provider's extra HTTP headers. */

import { useTranslation } from "react-i18next";
import { Plus, X } from "@phosphor-icons/react";
import { Button } from "@astryxdesign/core/Button";
import { IconButton } from "@astryxdesign/core/IconButton";
import type { HeaderRow } from "./helpers";

interface HeadersEditorProps {
  rows: HeaderRow[];
  onChange: (rows: HeaderRow[]) => void;
  /** Header names the provider needs — shown read-only so they can't be renamed. */
  lockedKeys?: Set<string>;
  /** Extra control placed beside "Add header" (the Save button, in practice). */
  trailing?: React.ReactNode;
}

export function HeadersEditor({ rows, onChange, lockedKeys, trailing }: HeadersEditorProps) {
  const { t } = useTranslation();
  const update = (i: number, field: "key" | "value", val: string) => {
    onChange(rows.map((r, j) => (j === i ? { ...r, [field]: val } : r)));
  };
  const remove = (i: number) => onChange(rows.filter((_, j) => j !== i));
  const add = () => onChange([...rows, { key: "", value: "" }]);

  return (
    <div className="mcp-kv">
      {rows.map((r, i) => {
        const locked = lockedKeys?.has(r.key) ?? false;
        return (
          <div key={i} className="mcp-kv-row">
            {locked ? (
              <span className="mcp-kv-key-locked"><code>{r.key}</code></span>
            ) : (
              <input
                className="mcp-kv-key"
                placeholder={t("settings.providers.headerName")}
                value={r.key}
                onChange={(e) => update(i, "key", e.target.value)}
              />
            )}
            <span className="mcp-kv-eq">=</span>
            <input
              className="mcp-kv-val"
              placeholder={t("settings.providers.headerValue")}
              value={r.value}
              onChange={(e) => update(i, "value", e.target.value)}
            />
            {!locked && (
              <IconButton
                label={t("settings.providers.removeHeader")}
                icon={<X size={13} weight="bold" />}
                onClick={() => remove(i)}
                variant="ghost"
                size="sm"
              />
            )}
          </div>
        );
      })}
      <div className="st2-pv-inline-btn">
        <Button
          label={t("settings.providers.addHeader")}
          icon={<Plus size={13} weight="bold" />}
          onClick={add}
          variant="secondary"
          size="sm"
        />
        {trailing}
      </div>
    </div>
  );
}
