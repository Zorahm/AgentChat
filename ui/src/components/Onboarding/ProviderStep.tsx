/** Wizard step 2 — the full Providers editor, not a cut-down copy of it.
 *
 * It renders the very same {@link ProviderCard} the Settings tab does, so a key
 * entered here gets the same key/model badges, api_base field, custom headers
 * and per-model "make default" rows. The first run is exactly when a user needs
 * that surface: pointing the app at LM Studio or fixing a 401 is otherwise a
 * trip into Settings before the wizard is even finished.
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowClockwise } from "@phosphor-icons/react";
import { Button } from "@astryxdesign/core/Button";
import { AddProviderForm } from "../Settings/tabs/providers/AddProviderForm";
import { ProviderCard } from "../Settings/tabs/providers/ProviderCard";
import { RU_PROVIDERS } from "../Settings/tabs/providers/helpers";
import type { ProviderConfig } from "../Settings/SettingsPanel";
import { useProviderSetup } from "./useProviderSetup";

interface ProviderStepProps {
  /** Reported up so the wizard can gate "Next" on a model being chosen. */
  onDefaultModelChange: (modelId: string) => void;
}

export function ProviderStep({ onDefaultModelChange }: ProviderStepProps) {
  const { t } = useTranslation();
  const {
    settings, statuses, loading, error,
    refreshModels, updateProvider, addProvider, deleteProvider, setDefaultModel,
  } = useProviderSetup();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [autoExpanded, setAutoExpanded] = useState(false);

  const defaultModel = settings?.default_model ?? "";
  useEffect(() => { onDefaultModelChange(defaultModel); }, [defaultModel, onDefaultModelChange]);

  // Open one card as soon as the list arrives: the key field is the reason this
  // step exists, and a wall of collapsed rows hides it behind a click. The
  // provider already holding a key wins, else the first one offered.
  useEffect(() => {
    if (autoExpanded || !settings?.providers.length) return;
    const configured = settings.providers.find((p) => p.enabled || p.api_key_set);
    setExpanded(configured?.id ?? settings.providers[0]?.id ?? null);
    setAutoExpanded(true);
  }, [settings, autoExpanded]);

  const providers = settings?.providers ?? [];
  const statusMap = new Map(statuses.map((s) => [s.id, s]));
  const connected = providers.filter((p) => p.enabled).length;
  const defaultName =
    settings?.models.find((m) => m.id === defaultModel)?.name ?? defaultModel;

  const renderCard = (p: ProviderConfig) => (
    <ProviderCard
      key={p.id}
      p={p}
      models={settings?.models.filter((m) => m.id.startsWith(p.id + "/")) ?? []}
      status={statusMap.get(p.id)}
      defaultModel={defaultModel}
      open={expanded === p.id}
      onToggle={() => setExpanded(expanded === p.id ? null : p.id)}
      onUpdate={(patch) => updateProvider(p.id, patch)}
      onSetDefault={(modelId) => void setDefaultModel(modelId)}
      onRefreshModels={() => void refreshModels()}
      onDelete={p.custom ? () => deleteProvider(p.id) : undefined}
    />
  );

  return (
    <div className="ob-body">
      <div className="ob-step-head">
        <div className="ob-step-head-text">
          <h3>{t("onboarding.step2Title")}</h3>
          <p className="ob-sub">{t("onboarding.step2Description")}</p>
        </div>
        <Button
          label={t("onboarding.step2Refresh")}
          icon={<ArrowClockwise size={14} weight="bold" />}
          onClick={() => void refreshModels()}
          isDisabled={loading}
          isLoading={loading}
          variant="secondary"
          size="sm"
        />
      </div>

      {error && <div className="ob-error">{error}</div>}

      {/* Where the keys the user is about to type will actually live. */}
      {settings?.secret_backend && (
        <p className={`st2-pv-storage${settings.secret_backend === "keyring" ? " ok" : " warn"}`}>
          {settings.secret_backend === "keyring"
            ? t("settings.providers.keyStorageKeyring")
            : t("settings.providers.keyStorageFile")}
        </p>
      )}

      <div className="ob-pv-list">
        <div className="st2-pv-section-label">{t("settings.providers.globalSection")}</div>
        {providers.filter((p) => !RU_PROVIDERS.has(p.id)).map(renderCard)}

        {providers.some((p) => RU_PROVIDERS.has(p.id)) && (
          <>
            <div className="st2-pv-section-label">{t("settings.providers.ruSection")}</div>
            {providers.filter((p) => RU_PROVIDERS.has(p.id)).map(renderCard)}
          </>
        )}

        <AddProviderForm
          existingIds={new Set(providers.map((p) => p.id))}
          onAdd={addProvider}
        />
      </div>

      <div className={`ob-pv-summary${defaultModel ? " is-ready" : ""}`}>
        <span className="ob-pv-summary-count">
          {t("onboarding.step2Connected", { n: connected })}
        </span>
        <span className="ob-pv-summary-model">
          {defaultModel
            ? t("onboarding.step2SummaryReady", { model: defaultName })
            : t("onboarding.step2SummaryEmpty")}
        </span>
      </div>
    </div>
  );
}
