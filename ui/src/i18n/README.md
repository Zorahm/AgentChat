# UI i18n — translation guide

Infrastructure is wired (react-i18next). This folder is where the **strings and
keys** get filled in. `en` is canonical (source of truth); other languages
overlay on top, with `en` as the fallback for any missing key.

## How to migrate a component

Replace a hardcoded literal with a `t()` call, and add the key to **both**
`locales/en/translation.json` (English) and `locales/ru/translation.json`
(the existing Russian text, moved verbatim).

```tsx
import { useTranslation } from "react-i18next";

export function ChatInput() {
  const { t } = useTranslation();
  return <button>{t("chat.send")}</button>; // was: <button>Отправить</button>
}
```

```jsonc
// locales/en/translation.json        // locales/ru/translation.json
{ "chat": { "send": "Send" } }        { "chat": { "send": "Отправить" } }
```

## Conventions

- **Keys**: nested by feature area — `chat.*`, `settings.*`, `sidebar.*`,
  `onboarding.*`, `projects.*`, `skills.*`, `common.*` (shared/generic).
- **Interpolation**: `t("greeting", { name })` ⇄ `"greeting": "Hi {{name}}"`.
- **Plurals** (Russian needs `one/few/many/other`): use the count suffix form.
  i18next picks the right one via CLDR automatically.

  ```jsonc
  // en                                    // ru
  "files_one":   "{{count}} file",         "files_one":   "{{count}} файл",
  "files_other": "{{count}} files",        "files_few":   "{{count}} файла",
                                           "files_many":  "{{count}} файлов",
                                           "files_other": "{{count}} файла"
  ```
  Call with a `count`: `t("files", { count: n })`.

## Adding a language

1. Add it to `SUPPORTED_LANGUAGES` in `languages.ts` (native label).
2. Create `locales/<code>/translation.json`.
3. Import + register it under `resources` in `index.ts`.
   The Settings → Appearance picker updates automatically.

## Optional: typed keys / autocomplete

Once `en/translation.json` is populated, you can enable key autocomplete and
compile-time checks by augmenting react-i18next (create `i18next.d.ts`):

```ts
import en from "./locales/en/translation.json";
declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "translation";
    resources: { translation: typeof en };
  }
}
```

Until then `t()` accepts any string key (type-safe, returns `string`).
