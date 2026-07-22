# Astryx migration guide (for component-restyle subagents)

You are migrating **AgentChat**'s React UI onto **Astryx**, Meta's open-source design
system (`@astryxdesign/core`, React 19 + StyleX, consumed here via its **pre-built CSS**).
Your job: **swap each component's presentation to Astryx primitives — do NOT change its
logic, data flow, hooks, props, or behavior.** Presentation only.

The foundation is already installed and wired (Ф0/Ф1). Deps, theme, CSS layers, the
`<Theme>` provider and a token bridge are done. You only restyle the components you are
assigned.

---

## 0. The single most important tool: the Astryx CLI

Astryx ships a CLI that documents every component. **Use it to look up exact props,
variants, and usage for ANY component before you use it** — do not guess props.

```bash
# from the ui/ directory:
node node_modules/@astryxdesign/cli/bin/astryx.mjs component <Name>     # props + usage + best practices
node node_modules/@astryxdesign/cli/bin/astryx.mjs component            # list all components
node node_modules/@astryxdesign/cli/bin/astryx.mjs docs icons           # valid semantic icon names
node node_modules/@astryxdesign/cli/bin/astryx.mjs template <slug> --skeleton   # layout examples
```

There are **123 components**. Run `component <Name>` whenever you need one. Names below.

---

## 1. Golden rules

1. **Presentation only.** Keep every hook, handler, effect, ref, state, prop interface,
   data flow, markdown/KaTeX rendering, SSE, upload logic, and i18n key EXACTLY as-is.
   Replace only DOM chrome: `<button>`→`Button`, custom card `<div>`→`Card`, custom
   toggle→`Switch`, custom badge→`Badge`, custom collapsible→`Collapsible`, etc.
2. **Import from subpaths**, never the root barrel:
   `import { Button } from "@astryxdesign/core/Button";` ✅
   `import { Button } from "@astryxdesign/core";` ❌ (pulls the whole library).
3. **Keep existing className hooks** where you're unsure — most Astryx components accept
   `className`, so you can keep a legacy class for layout while gaining Astryx styling.
   Prefer removing bespoke visual CSS once the Astryx component covers it.
4. **TypeScript strict**: zero `any` (use `unknown` + guards), explicit prop interfaces,
   named exports only (no `export default`), functional components only.
5. **i18n**: any user-visible string MUST go through `react-i18next` (`const { t } =
   useTranslation()`), with keys added to BOTH `ui/src/i18n/locales/en/` and `ru/`.
   Never hardcode a visible literal. Reuse existing keys — don't invent duplicates.
6. **Icons**: the app uses `@phosphor-icons/react` (e.g. `import { Gear } from
   "@phosphor-icons/react"`). Astryx `icon`/`startIcon` props accept a phosphor component
   or element — keep using phosphor icons. Astryx also has its own `Icon`/`IconButton`.
7. **Verify before finishing**: run `npm run typecheck` from `ui/` (it must be clean for
   your files). Do NOT run `npm run build`/`vite build` (other agents run concurrently).
   `tsc` may report errors in files outside your scope (another agent mid-edit) — only fix
   errors in YOUR assigned files.

---

## 2. How Astryx is already set up here (do NOT touch these)

- `ui/package.json` — React 19, `@astryxdesign/core`, `@astryxdesign/theme-chocolate`,
  `@stylexjs/stylex` already installed.
- `ui/src/styles/astryx-setup.css` — imports reset/astryx/theme CSS in `@layer` order +
  fonts. **Do not edit.**
- `ui/src/styles/global.css` — the **token bridge**: legacy CSS vars are mapped to Astryx
  chocolate tokens. **Do not edit.**
- `ui/src/App.tsx`, `main.tsx`, `Sidebar.tsx`, `Chat/ChatInput.tsx`, `Chat/ModelSelector.tsx`
  — already migrated. **Do not edit** (unless your task explicitly names one).

### The token bridge (why the app already looks "chocolate")
`global.css` maps legacy vars to Astryx semantic tokens, e.g.
`--ink → var(--color-text-primary)`, `--bg → var(--color-background-body)`,
`--accent → var(--color-accent)`, `--surface → var(--color-background-surface)`,
`--line → var(--color-border-*)`, `--hover → var(--color-background-muted)`, radii, fonts.
So existing CSS already renders in the chocolate palette. You may use either the legacy
vars (`var(--ink)`) or Astryx tokens directly (`var(--color-text-primary)`). Prefer Astryx
tokens (`--color-*`) in any NEW CSS you write.

Key Astryx semantic tokens (all `light-dark()`, theme-aware):
`--color-text-primary`, `--color-text-secondary`, `--color-accent`, `--color-on-accent`,
`--color-background-body|surface|card|muted|popover`, `--color-border-*`,
`--color-success-muted`, `--color-error-muted`, `--color-warning-muted`,
radius scale, `--font-size-*`, `--spacing-*`.

---

## 3. Component map (bespoke pattern → Astryx component)

| Bespoke pattern in AgentChat | Astryx component (import subpath) |
|---|---|
| `<button className="...">` action | `Button` (`/Button`) — `variant: primary\|secondary\|ghost\|destructive`, `size`, `label` (required, a11y), `children` (visible override), `icon`, `endContent`, `onClick`, `isLoading`, `isDisabled`, `tooltip`, `isIconOnly`, `width` |
| Icon-only button | `IconButton` (`/IconButton`) |
| Custom toggle / switch | `Switch` (`/Switch`) — `label` (req), `value` (bool, req), `onChange(checked)`, `description`, `labelPosition:'start'`, `labelSpacing:'spread'`, `isLabelHidden` |
| Card / panel container | `Card` (`/Card`); clickable → `ClickableCard`; selectable → `SelectableCard` |
| Status/label chip, mention chip, tag | `Badge` (`/Badge`) — `variant` colors (e.g. `green`, `blue`, `red`), `label`/children, `icon` |
| Collapsible section / accordion | `Collapsible` (`/Collapsible`) |
| Colored status dot | `StatusDot` (`/StatusDot`) |
| Spinner / loading | `Spinner` (`/Spinner`); progress → `ProgressBar` |
| Modal dialog | `Dialog` (`/Dialog`); destructive confirm → `AlertDialog` |
| Dropdown / context menu | `DropdownMenu` (`/DropdownMenu`), `MoreMenu`, `ContextMenu` |
| Tooltip | `Tooltip` (`/Tooltip`); rich → `HoverCard` |
| Tabs | `TabList` (`/TabList`) |
| Text / headings | `Text` (`/Text`) — `type`, `color`; `Heading` (`/Text`) — `level` |
| Form field wrapper | `Field`, `FormLayout`, `TextInput`, `TextArea`, `NumberInput`, `Selector`, `MultiSelector`, `Typeahead`, `Slider`, `CheckboxInput`, `RadioList`, `FileInput` |
| Layout | `Stack`/`HStack`/`VStack` (`/Stack` or `/Layout`), `Grid`, `Center`, `Divider`, `Section` |
| Empty placeholder | `EmptyState` (`/EmptyState`) |
| Data table | `Table` (`/Table`) |
| Avatar | `Avatar`, `AvatarGroup` |
| Toast/notification | `Toast`, `Banner` |
| Thumbnail / image preview | `Thumbnail`, `Lightbox`, `AspectRatio` |

When a pattern isn't listed, run `astryx component` to browse, or reuse the closest match.

---

## 4. Worked examples

**Button** (replaces `<button className="btn">Save</button>`):
```tsx
import { Button } from "@astryxdesign/core/Button";
<Button variant="primary" label={t("common.save")} icon={<FloppyDisk />} onClick={onSave} />
// visible content override + a11y label:
<Button variant="ghost" size="sm" label={model} onClick={open}>{name}<CaretDown /></Button>
```

**Switch** (replaces a custom `role="switch"` toggle with label + hint):
```tsx
import { Switch } from "@astryxdesign/core/Switch";
<Switch label={t("x.title")} description={t("x.hint")} value={on}
        onChange={() => toggle()} labelPosition="start" labelSpacing="spread" />
```

**Card**:
```tsx
import { Card } from "@astryxdesign/core/Card";
<Card>{/* keep inner content */}</Card>
```

**Badge** (replaces a `<span className="chip chip--skill">@Foo</span>`):
```tsx
import { Badge } from "@astryxdesign/core/Badge";
<Badge variant="green" label="Foo" />
```

**Collapsible** (replaces a bespoke expand/collapse block):
```tsx
import { Collapsible } from "@astryxdesign/core/Collapsible";
// look up exact props via: astryx component Collapsible
```

**Dialog** (replaces a custom modal overlay). Keep the open/close STATE and handlers you
already have; swap only the overlay/markup. `astryx component Dialog` for props.

**Canonical reference in this repo**: `ui/src/components/Chat/ChatInput.tsx` (composer,
already migrated to `ChatComposer`/`ChatComposerInput`) and
`ui/src/components/Sidebar.tsx` (migrated to `SideNav`/`SideNavItem`) and
`ui/src/components/Chat/ModelSelector.tsx` (migrated pill→`Button`, toggle→`Switch`).
Read these for the house style.

---

## 5. Process for each assigned component

1. Read the component file.
2. Identify the bespoke visual elements (buttons, cards, chips, toggles, dialogs, menus).
3. For each, look up the Astryx replacement's props via the CLI, then swap — keeping ALL
   logic/props/handlers/i18n intact.
4. Remove now-dead bespoke CSS from the component's OWN css file if fully replaced (leave
   layout classes you still rely on). Do NOT edit shared/global CSS.
5. Keep it building: `npm run typecheck` (from `ui/`) clean for your files.

Report back: which files changed, which Astryx components you introduced, and anything you
could not cleanly map (leave those as-is and note them).
