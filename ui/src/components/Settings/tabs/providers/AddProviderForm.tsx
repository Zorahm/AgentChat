/** "Add provider" — any OpenAI-compatible endpoint, key optional. */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, X } from "@phosphor-icons/react";
import { Button } from "@astryxdesign/core/Button";
import { IconButton } from "@astryxdesign/core/IconButton";
import { HeadersEditor } from "./HeadersEditor";
import { rowsToHeaders, toSlug, type HeaderRow } from "./helpers";

export interface NewProvider {
  id: string;
  name: string;
  api_base: string;
  api_key?: string;
  extra_headers?: Record<string, string>;
}

interface AddProviderFormProps {
  existingIds: Set<string>;
  onAdd: (body: NewProvider) => Promise<boolean>;
}

export function AddProviderForm({ existingIds, onAdd }: AddProviderFormProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [base, setBase] = useState("");
  const [key, setKey] = useState("");
  const [headerRows, setHeaderRows] = useState<HeaderRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const slug = toSlug(name);
  const slugConflict = !!slug && existingIds.has(slug);

  const reset = () => { setName(""); setBase(""); setKey(""); setHeaderRows([]); setErr(null); };
  const close = () => { reset(); setOpen(false); };

  const submit = async () => {
    setErr(null);
    if (!name.trim() || !base.trim()) { setErr(t("settings.providers.validationRequired")); return; }
    if (!slug) { setErr(t("settings.providers.validationFormat")); return; }
    if (slugConflict) { setErr(t("settings.providers.validationExists", { id: slug })); return; }
    setSaving(true);
    const headers = rowsToHeaders(headerRows);
    const ok = await onAdd({
      id: slug,
      name: name.trim(),
      api_base: base.trim(),
      api_key: key.trim() || undefined,
      ...(headers ? { extra_headers: headers } : {}),
    });
    setSaving(false);
    if (ok) close();
    else setErr(t("settings.providers.saveError"));
  };

  if (!open) {
    return (
      <div className="st2-pv-inline-btn">
        <Button
          label={t("settings.providers.addButton")}
          icon={<Plus size={14} weight="bold" />}
          onClick={() => setOpen(true)}
          variant="secondary"
        />
      </div>
    );
  }

  return (
    <div className="st2-add-form">
      <div className="st2-add-form-head">
        <span>{t("settings.providers.formTitle")}</span>
        <IconButton
          label={t("common.close")}
          icon={<X size={15} />}
          onClick={close}
          variant="ghost"
          size="sm"
        />
      </div>

      <div className="st2-add-fields">
        <label className="st2-add-label">
          {t("settings.providers.name")}
          <span className="st2-add-name-wrap">
            <input
              className="st2-field"
              placeholder={t("settings.providers.namePlaceholder")}
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
            {slug && (
              <span className={`st2-add-slug${slugConflict ? " conflict" : ""}`}>
                id: <code>{slug}</code>
              </span>
            )}
          </span>
        </label>

        <label className="st2-add-label">
          {t("settings.providers.apiBase")}
          <input
            className="st2-field"
            spellCheck={false}
            placeholder={t("settings.providers.apiBasePlaceholder")}
            value={base}
            onChange={(e) => setBase(e.target.value)}
          />
          <span className="st2-pv-hint">{t("settings.providers.apiBaseHint")}</span>
        </label>

        <label className="st2-add-label">
          {t("settings.providers.apiKey")}
          <span className="st2-pv-optional">{t("settings.providers.apiKeyOptional")}</span>
          <input
            type="password"
            className="st2-field"
            autoComplete="off"
            placeholder="sk-…"
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
          <span className="st2-pv-hint">{t("settings.providers.keyLocalHint")}</span>
        </label>

        <div className="st2-add-label">
          {t("settings.providers.customHeaders")}
          <span className="st2-pv-optional">{t("settings.providers.apiKeyOptional")}</span>
          <HeadersEditor rows={headerRows} onChange={setHeaderRows} />
        </div>
      </div>

      {err && <div className="st2-add-err">{err}</div>}

      <div className="st2-add-actions">
        <Button
          label={saving ? t("settings.providers.saving") : t("settings.providers.add")}
          onClick={submit}
          isDisabled={saving || !slug || slugConflict}
          isLoading={saving}
          variant="primary"
          size="sm"
        />
        <Button
          label={t("settings.providers.cancel")}
          onClick={close}
          variant="ghost"
          size="sm"
        />
      </div>
    </div>
  );
}
