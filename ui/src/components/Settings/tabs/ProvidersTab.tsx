/** Providers tab — provider list, add form, web-search and image backends. */

import { useTranslation } from "react-i18next";
import { Button } from "@astryxdesign/core/Button";
import type { ProviderConfig, SettingsData } from "../SettingsPanel";
import { AddProviderForm, type NewProvider } from "./providers/AddProviderForm";
import { ProviderCard } from "./providers/ProviderCard";
import { WebSearchSettings } from "./providers/WebSearchSettings";
import { ImageGenSettings } from "./providers/ImageGenSettings";
import { RU_PROVIDERS, type ProviderStatus } from "./providers/helpers";

interface ProvidersTabProps {
  settings: SettingsData;
  statuses: ProviderStatus[];
  loading: boolean;
  expanded: string | null;
  setExpanded: (v: string | null) => void;
  onUpdate: (id: string, p: Record<string, unknown>) => Promise<boolean | undefined>;
  onAdd: (body: NewProvider) => Promise<boolean>;
  onDelete: (id: string) => Promise<boolean>;
  onRefreshModels: () => void;
  onUpdateGlobal: (p: Record<string, unknown>) => void;
}

export function ProvidersTab({
  settings, statuses, loading, expanded, setExpanded,
  onUpdate, onAdd, onDelete, onRefreshModels, onUpdateGlobal,
}: ProvidersTabProps) {
  const { t } = useTranslation();
  const statusMap = new Map(statuses.map((s) => [s.id, s]));

  const globalProviders = settings.providers.filter((p) => !RU_PROVIDERS.has(p.id));
  const ruProviders = settings.providers.filter((p) => RU_PROVIDERS.has(p.id));

  const renderCard = (p: ProviderConfig) => (
    <ProviderCard
      key={p.id}
      p={p}
      models={settings.models.filter((m) => m.id.startsWith(p.id + "/"))}
      status={statusMap.get(p.id)}
      defaultModel={settings.default_model}
      open={expanded === p.id}
      onToggle={() => setExpanded(expanded === p.id ? null : p.id)}
      onUpdate={(x) => onUpdate(p.id, x)}
      onSetDefault={(modelId) => onUpdateGlobal({ default_model: modelId })}
      onRefreshModels={onRefreshModels}
      onDelete={p.custom ? () => onDelete(p.id) : undefined}
    />
  );

  return <>
    <div className="st2-row-between">
      <div>
        <h3 className="st2-h">{t("settings.providers.title")}</h3>
        <p className="st2-sub">{t("settings.providers.description")}</p>
      </div>
      <Button
        label={t("settings.providers.refresh")}
        onClick={onRefreshModels}
        isDisabled={loading}
        isLoading={loading}
        variant="secondary"
      />
    </div>

    {/* Where keys actually live. Worth stating: the fallback is plaintext, and
        a user who assumes encryption they didn't get is worse off than one who
        knows. */}
    {settings.secret_backend && (
      <p className={`st2-pv-storage${settings.secret_backend === "keyring" ? " ok" : " warn"}`}>
        {settings.secret_backend === "keyring"
          ? t("settings.providers.keyStorageKeyring")
          : t("settings.providers.keyStorageFile")}
      </p>
    )}

    <div className="st2-pv-section-label">{t("settings.providers.globalSection")}</div>
    {globalProviders.map(renderCard)}

    {ruProviders.length > 0 && <>
      <div className="st2-pv-section-label">{t("settings.providers.ruSection")}</div>
      {ruProviders.map(renderCard)}
    </>}

    <AddProviderForm
      existingIds={new Set(settings.providers.map((p) => p.id))}
      onAdd={onAdd}
    />

    <WebSearchSettings settings={settings} onUpdate={onUpdateGlobal} />

    <ImageGenSettings settings={settings} onUpdate={onUpdateGlobal} />
  </>;
}
