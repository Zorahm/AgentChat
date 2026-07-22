/** @-mention items for the Astryx ChatComposer `@` trigger.
 *
 * Two item kinds:
 *   - action  → file picker (no token inserted; the composer calls the picker)
 *   - skill   → inserts a token whose serialized value is `@skill:NAME`, so the
 *               agent's read_skill tool can pick it up from the submitted text.
 */

import i18n from "i18next";
import { API_BASE } from "./apiBase";
import type { SearchableItem } from "@astryxdesign/core/Typeahead";

/** Sentinel id for the "attach file" action item (inserts no token). */
export const ATTACH_FILE_ID = "__attach_file__";

/** Auxiliary payload carried on each mention item. */
export interface MentionAux {
  kind: "action" | "skill";
  desc: string;
  type: "file" | "skill";
}

interface SkillEntry {
  name: string;
  description: string;
}

/** Capitalize the first character (rest untouched). */
export function capitalizeFirst(s: string): string {
  return s.length ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** Longest a mention item's description may be before eliding. SKILL.md
 *  descriptions are written for the model, not this menu — some run well
 *  past a full line. Astryx's trigger-menu row has no `min-width: 0`, so an
 *  unwrapped long description forces its own intrinsic width onto the whole
 *  popover (it renders full-width, pinned to the viewport's top-left instead
 *  of anchored to the caret). Capping the string here is the workaround. */
const MENTION_DESC_MAX = 90;

/** Trim a description to MENTION_DESC_MAX chars, breaking on the last space. */
function truncateDesc(s: string): string {
  if (s.length <= MENTION_DESC_MAX) return s;
  const cut = s.slice(0, MENTION_DESC_MAX);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/** Split a mention label like "skill:foo" into its type and a human display
 *  text ("Foo"). Labels without a "type:" prefix are treated as files. */
export function mentionDisplay(label: string): { type: string; text: string } {
  const parts = String(label).split(":");
  const hasType = parts.length > 1;
  const type = hasType ? parts[0]! : "file";
  const raw = hasType ? parts.slice(1).join(":") : label;
  return { type, text: capitalizeFirst(raw) };
}

// ── Skills cache ───────────────────────────────────────────────────────────

let skillsCache: SkillEntry[] = [];
let skillsFetchedAt = 0;
const SKILLS_TTL_MS = 30_000;

async function getSkills(): Promise<SkillEntry[]> {
  const fresh = Date.now() - skillsFetchedAt < SKILLS_TTL_MS;
  if (fresh && skillsCache.length > 0) return skillsCache;
  try {
    const r = await fetch(`${API_BASE}/skills`);
    if (r.ok) {
      const data = (await r.json()) as SkillEntry[];
      skillsCache = Array.isArray(data) ? data : [];
      skillsFetchedAt = Date.now();
    }
  } catch {
    /* offline — keep stale cache */
  }
  return skillsCache;
}

/** Build the mention menu items: an "attach file" action first, then every
 *  installed skill. Consumed by the composer's `@` trigger via a static
 *  Typeahead source (which filters by `label` as the user types). */
export async function getMentionItems(): Promise<SearchableItem<MentionAux>[]> {
  const skills = await getSkills();
  const items: SearchableItem<MentionAux>[] = [
    {
      id: ATTACH_FILE_ID,
      label: i18n.t("chat.mention.file"),
      auxiliaryData: { kind: "action", type: "file", desc: i18n.t("chat.mention.fileDesc") },
    },
  ];
  for (const s of skills) {
    items.push({
      id: s.name,
      label: capitalizeFirst(s.name),
      auxiliaryData: {
        kind: "skill",
        type: "skill",
        desc: truncateDesc(s.description || i18n.t("chat.mention.skillDesc")),
      },
    });
  }
  return items;
}

/** Render a submitted message's text as display HTML, turning `@type:name`
 *  tokens into styled mention chips (mirrors the old composer getHTML output so
 *  message bubbles look identical). */
export function textToDisplayHtml(text: string): string {
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const mention = /@([A-Za-z][\w-]*):([^\s@]+)/g;
  return text
    .split("\n")
    .map((line) => {
      let out = "";
      let last = 0;
      let m: RegExpExecArray | null;
      mention.lastIndex = 0;
      while ((m = mention.exec(line))) {
        out += esc(line.slice(last, m.index));
        const type = m[1]!;
        const name = m[2]!;
        out += `<span class="mention-chip mention-chip--${esc(type)}">@${esc(capitalizeFirst(name))}</span>`;
        last = m.index + m[0].length;
      }
      out += esc(line.slice(last));
      return `<p>${out || "<br>"}</p>`;
    })
    .join("");
}
