/** Shared bits of the Providers tab: logos, header rows, error copy. */

export interface ProviderStatus {
  id: string;
  status: string;
  count: number;
  error: string | null;
}

export interface HeaderRow {
  key: string;
  value: string;
}

export type TFn = (key: string, opts?: Record<string, unknown>) => string;

/** Brand swatch class per provider id — see `.lg-*` in settings-providers.css. */
export const LOGO: Record<string, string> = {
  openai: "lg-openai", anthropic: "lg-anthropic", gemini: "lg-google",
  deepseek: "lg-deepseek", groq: "lg-groq", mistral: "lg-mistral",
  cohere: "lg-cohere", together: "lg-together", openrouter: "lg-openrouter",
  lmstudio: "lg-lmstudio", litellm_proxy: "lg-proxy",
  opencode: "lg-opencode", yandex: "lg-yandex",
};

export const RU_PROVIDERS = new Set(["yandex"]);

export function headersToRows(h: Record<string, string> | null | undefined): HeaderRow[] {
  return h ? Object.entries(h).map(([key, value]) => ({ key, value })) : [];
}

export function rowsToHeaders(rows: HeaderRow[]): Record<string, string> | null {
  const valid = rows.filter((r) => r.key.trim());
  return valid.length > 0 ? Object.fromEntries(valid.map((r) => [r.key.trim(), r.value])) : null;
}

/** Turn a raw fetch failure into something a user can act on. */
export function friendlyFetchError(
  raw: string | null | undefined,
  providerId: string,
  t: TFn,
): string {
  if (!raw) return t("settings.providers.errUnknown");
  if (raw === "api_key not set") return t("settings.providers.errNoKey");
  if (raw === "api_base not configured") return t("settings.providers.errNoBase");
  if (/connect|timeout|network/i.test(raw)) return t("settings.providers.errConnect");

  const m = raw.match(/^HTTP (\d{3})$/);
  if (m) {
    const code = Number(m[1]);
    if (code === 401) return t("settings.providers.errHttp401");
    if (code === 403) {
      return t(
        providerId === "yandex"
          ? "settings.providers.errHttp403Yandex"
          : "settings.providers.errHttp403"
      );
    }
    if (code === 404) return t("settings.providers.errHttp404");
    if (code === 429) return t("settings.providers.errHttp429");
    if (code >= 500) return t("settings.providers.errHttp5xx", { code });
  }

  return raw;
}

/** Slug used as the provider id — derived from the display name. */
export function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
}
