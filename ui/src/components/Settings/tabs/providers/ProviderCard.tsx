/** One provider: header row + the expanded connection/headers/models editor. */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { CaretDown, Eye, EyeSlash, Key, WarningCircle } from "@phosphor-icons/react";
import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Switch } from "@astryxdesign/core/Switch";
import type { ProviderConfig, ModelConfig } from "../../SettingsPanel";
import { HeadersEditor } from "./HeadersEditor";
import { YandexSetup } from "./YandexSetup";
import {
  LOGO,
  friendlyFetchError,
  headersToRows,
  rowsToHeaders,
  type HeaderRow,
  type ProviderStatus,
} from "./helpers";

interface ProviderCardProps {
  p: ProviderConfig;
  models: ModelConfig[];
  status?: ProviderStatus;
  defaultModel: string;
  open: boolean;
  onToggle: () => void;
  onUpdate: (patch: Record<string, unknown>) => Promise<boolean | undefined>;
  onSetDefault: (modelId: string) => void;
  onRefreshModels: () => void;
  onDelete?: () => Promise<boolean>;
}

export function ProviderCard({
  p, models, status, defaultModel, open, onToggle,
  onUpdate, onSetDefault, onRefreshModels, onDelete,
}: ProviderCardProps) {
  const { t } = useTranslation();
  const [base, setBase] = useState(p.api_base ?? "");
  const [baseSaving, setBaseSaving] = useState(false);
  const [key, setKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [keySaving, setKeySaving] = useState(false);
  const [headerRows, setHeaderRows] = useState<HeaderRow[]>([]);
  const [headersSaving, setHeadersSaving] = useState(false);

  // Opening the card is what seeds the editors — a collapse/expand cycle is
  // therefore also how the user discards an unsaved edit.
  useEffect(() => {
    if (!open) return;
    setBase(p.api_base ?? "");
    setKey("");
    setShowKey(false);
    const rows = headersToRows(p.extra_headers);
    if (p.id === "yandex" && !rows.some((r) => r.key === "x-folder-id")) {
      rows.unshift({ key: "x-folder-id", value: "" });
    }
    setHeaderRows(rows);
  }, [open]);

  const baseFieldId = `pv-${p.id}-base`;
  const keyFieldId = `pv-${p.id}-key`;
  const trimmedBase = base.trim();
  const baseDirty = trimmedBase !== (p.api_base ?? "");
  const canResetBase = !!p.default_api_base && trimmedBase !== p.default_api_base;
  const keyOptional = p.key_required === false;

  const saveBase = async () => {
    if (!trimmedBase || !baseDirty) return;
    setBaseSaving(true);
    const ok = await onUpdate({ api_base: trimmedBase });
    setBaseSaving(false);
    if (ok) onRefreshModels();
  };

  const resetBase = () => {
    if (p.default_api_base) setBase(p.default_api_base);
  };

  const saveKey = async () => {
    if (!key.trim()) return;
    setKeySaving(true);
    const ok = await onUpdate({ api_key: key.trim() });
    setKeySaving(false);
    if (ok) { setKey(""); onRefreshModels(); }
  };

  const clearKey = async () => {
    setKeySaving(true);
    const ok = await onUpdate({ api_key: "" });
    setKeySaving(false);
    if (ok) setKey("");
  };

  const saveHeaders = async () => {
    setHeadersSaving(true);
    await onUpdate({ extra_headers: rowsToHeaders(headerRows) ?? {} });
    setHeadersSaving(false);
    onRefreshModels();
  };

  return (
    <div className={`st2-provider${p.enabled ? "" : " is-off"}${open ? " is-open" : ""}`}>
      <div className="st2-pv-head" onClick={onToggle}>
        <div className={`st2-pv-logo ${LOGO[p.id] ?? "lg-other"}`}>
          {p.name[0]?.toUpperCase() ?? "?"}
        </div>
        <div className="st2-pv-name">{p.name}<small>{p.api_base ?? "—"}</small></div>
        <div className="st2-pv-meta">
          <ModelsBadge status={status} providerId={p.id} />
          <span className="st2-pv-key">
            <KeyBadge isSet={p.api_key_set} isOptional={keyOptional} />
          </span>
          <div onClick={(e) => e.stopPropagation()}>
            <Switch
              label={p.enabled ? t("settings.providers.enabled") : t("settings.providers.disabled")}
              value={p.enabled}
              onChange={(v) => onUpdate({ enabled: v })}
              isLabelHidden
            />
          </div>
          <span className="st2-pv-chev" aria-hidden><CaretDown size={14} weight="bold" /></span>
        </div>
      </div>

      {open && (
        <div className="st2-pv-body">
          {status?.status === "error" && (
            <div className="st2-pv-err">{friendlyFetchError(status.error, p.id, t)}</div>
          )}

          <div className="st2-pv-sec">{t("settings.providers.connection")}</div>

          {/* Not a <label> wrapper: the Save/eye buttons sit in the same row, and
              a label hijacks clicks on any control inside it. */}
          <div className="st2-pv-field">
            <label className="st2-pv-field-label" htmlFor={baseFieldId}>
              {t("settings.providers.apiBase")}
            </label>
            <div className="st2-pv-field-row">
              <input
                id={baseFieldId}
                className="st2-field st2-pv-input"
                spellCheck={false}
                placeholder={t("settings.providers.apiBasePlaceholder")}
                value={base}
                onChange={(e) => setBase(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") saveBase(); }}
              />
              <Button
                label={t("common.save")}
                onClick={saveBase}
                isDisabled={!trimmedBase || !baseDirty || baseSaving}
                isLoading={baseSaving}
                variant={baseDirty ? "primary" : "secondary"}
                size="sm"
              />
              {canResetBase && (
                <Button
                  label={t("settings.providers.resetDefault")}
                  onClick={resetBase}
                  variant="ghost"
                  size="sm"
                />
              )}
            </div>
            <span className="st2-pv-hint">{t("settings.providers.apiBaseHint")}</span>
          </div>

          <div className="st2-pv-field">
            <label className="st2-pv-field-label" htmlFor={keyFieldId}>
              {t("settings.providers.apiKey")}
              {keyOptional && (
                <span className="st2-pv-optional">{t("settings.providers.apiKeyOptional")}</span>
              )}
            </label>
            <div className="st2-pv-field-row">
              <span className="st2-pv-key-wrap">
                <input
                  id={keyFieldId}
                  type={showKey ? "text" : "password"}
                  className="st2-field st2-pv-input"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={p.api_key_set
                    ? t("settings.providers.keyNew")
                    : t("settings.providers.keyPlaceholder")}
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") saveKey(); }}
                />
                <IconButton
                  label={t(showKey ? "settings.providers.hideKey" : "settings.providers.showKey")}
                  icon={showKey ? <EyeSlash size={15} /> : <Eye size={15} />}
                  onClick={() => setShowKey((v) => !v)}
                  variant="ghost"
                  size="sm"
                />
              </span>
              <Button
                label={t("common.save")}
                onClick={saveKey}
                isDisabled={!key.trim() || keySaving}
                isLoading={keySaving}
                variant={key.trim() ? "primary" : "secondary"}
                size="sm"
              />
              {p.api_key_set && (
                <Button
                  label={t("settings.providers.clearKey")}
                  onClick={clearKey}
                  isDisabled={keySaving}
                  variant="ghost"
                  size="sm"
                />
              )}
            </div>
            <span className="st2-pv-hint">
              {keyOptional
                ? t("settings.providers.keyLocalHint")
                : t("settings.providers.keyHint")}
            </span>
          </div>

          {p.id === "yandex" && <YandexSetup />}

          <div className="st2-pv-sec">{t("settings.providers.customHeaders")}</div>
          <HeadersEditor
            rows={headerRows}
            onChange={setHeaderRows}
            lockedKeys={p.id === "yandex" ? new Set(["x-folder-id"]) : undefined}
            trailing={
              <Button
                label={headersSaving ? t("settings.providers.saving") : t("settings.providers.saveHeaders")}
                onClick={saveHeaders}
                isDisabled={headersSaving}
                isLoading={headersSaving}
                variant="secondary"
                size="sm"
              />
            }
          />

          <div className="st2-pv-sec">
            {t("settings.providers.modelsSection")}
            {models.length > 0 && <span className="st2-pv-sec-count">{models.length}</span>}
          </div>
          {models.length === 0 ? (
            <div className="st2-pv-empty">
              {p.api_key_set || keyOptional
                ? t("settings.providers.modelsEmpty")
                : t("settings.providers.modelsEmptyHint")}
            </div>
          ) : (
            <div className="st2-pv-models">
              {models.map((m) => (
                <ModelRow
                  key={m.id}
                  m={m}
                  isDefault={m.id === defaultModel}
                  onSetDefault={() => onSetDefault(m.id)}
                />
              ))}
            </div>
          )}

          {onDelete && (
            <div className="st2-pv-danger">
              <span className="st2-pv-hint">{t("settings.providers.deleteHint")}</span>
              <Button
                label={t("settings.providers.delete")}
                onClick={onDelete}
                variant="destructive"
                size="sm"
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ── Pieces ────────────────────────────────────────── */

/** Model count, or the fetch failure — the one thing worth an alarming colour. */
function ModelsBadge({ status, providerId }: { status?: ProviderStatus; providerId: string }) {
  const { t } = useTranslation();
  if (status?.status === "error") {
    return (
      <span className="st2-pv-badge-wrap" title={friendlyFetchError(status.error, providerId, t)}>
        <Badge
          variant="error"
          icon={<WarningCircle size={12} weight="bold" />}
          label={t("settings.providers.error")}
        />
      </span>
    );
  }
  if (status?.status === "ok") {
    return (
      <Badge variant="neutral" label={t("settings.providers.modelsCount", { count: status.count })} />
    );
  }
  return null;
}

/** Three states: key stored, key missing but needed, key not needed at all. */
function KeyBadge({ isSet, isOptional }: { isSet: boolean; isOptional: boolean }) {
  const { t } = useTranslation();
  if (isSet) {
    return (
      <Badge
        variant="teal"
        icon={<Key size={12} weight="bold" />}
        label={t("settings.providers.keySet")}
      />
    );
  }
  // Only the case the user has to act on gets a semantic (loud) variant.
  if (isOptional) {
    return <Badge variant="neutral" label={t("settings.providers.keyNotNeeded")} />;
  }
  return (
    <Badge
      variant="warning"
      icon={<WarningCircle size={12} weight="bold" />}
      label={t("settings.providers.noKey")}
    />
  );
}

function ModelRow({ m, isDefault, onSetDefault }: {
  m: ModelConfig;
  isDefault: boolean;
  onSetDefault: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className={`st2-pv-row${isDefault ? " is-default" : ""}`}
      role="button"
      tabIndex={0}
      title={isDefault ? t("settings.providers.defaultModel") : t("settings.providers.setDefault")}
      onClick={() => { if (!isDefault) onSetDefault(); }}
      onKeyDown={(e) => {
        if ((e.key === "Enter" || e.key === " ") && !isDefault) { e.preventDefault(); onSetDefault(); }
      }}
    >
      <span className="st2-pv-model">{m.name ?? m.id}</span>
      {m.thinking && <span className="st2-think-tag">{t("settings.providers.thinking")}</span>}
      {isDefault && <span className="st2-pv-default-tag">{t("settings.providers.defaultTag")}</span>}
      <span className={`st2-pv-radio${isDefault ? " on" : ""}`} aria-hidden />
    </div>
  );
}
