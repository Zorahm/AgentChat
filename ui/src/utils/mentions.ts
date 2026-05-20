/** @-mention suggestion for TipTap.
 *
 * Two item kinds:
 *   - action  → file picker (no chip is inserted; calls onAttachFile)
 *   - skill   → typeahead of installed skills; inserts a mention chip
 *               with id/label `skill:NAME` so the agent's read_skill tool
 *               can pick it up from submitted text as `@skill:NAME`.
 */

import { API_BASE } from "./apiBase";

export interface MentionDeps {
  onAttachFile: () => void;
}

interface SkillEntry {
  name: string;
  description: string;
}

interface BaseItem {
  key: string;
  label: string;
  desc: string;
  icon: string;
}

interface ActionItem extends BaseItem {
  kind: "action";
  action: "attach-file";
}

interface SkillItem extends BaseItem {
  kind: "skill";
  skillName: string;
}

type Item = ActionItem | SkillItem;

const ACTION_FILE: ActionItem = {
  key: "action:file",
  kind: "action",
  action: "attach-file",
  label: "Файл",
  desc: "Прикрепить файл с диска",
  icon: "📄",
};

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

function buildItems(query: string, skills: SkillEntry[]): Item[] {
  const q = query.trim().toLowerCase();
  const items: Item[] = [];

  // Action item: shown when query is empty or matches its label/keywords.
  if (!q || "файл".includes(q) || "file".includes(q) || ACTION_FILE.label.toLowerCase().includes(q)) {
    items.push(ACTION_FILE);
  }

  for (const s of skills) {
    if (
      !q ||
      s.name.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q)
    ) {
      items.push({
        key: `skill:${s.name}`,
        kind: "skill",
        skillName: s.name,
        label: s.name,
        desc: s.description || "Скилл",
        icon: "🧩",
      });
    }
  }

  return items;
}

// ── Popup rendering ────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderHtml(items: Item[], selectedIndex: number): string {
  if (items.length === 0) {
    return '<div class="mp-empty">Ничего не найдено</div>';
  }
  let html = "";
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const active = i === selectedIndex ? " active" : "";
    // Action items get a short hint as a sub-line (the action is self-describing).
    // Skill items show only the name in the row — full description lives in the tooltip.
    const sub =
      item.kind === "action"
        ? `<span class="mp-item-sub">${escapeHtml(item.desc)}</span>`
        : "";
    html +=
      `<div class="mp-item${active}" data-idx="${i}">` +
      `<span class="mp-item-ic">${item.icon}</span>` +
      `<span class="mp-item-info">` +
      `<span class="mp-item-label">${escapeHtml(item.label)}</span>` +
      sub +
      `</span>` +
      `</div>`;
  }
  return html;
}

function positionTooltip(
  tooltip: HTMLElement,
  popup: HTMLElement,
  activeRow: HTMLElement | null,
) {
  if (!activeRow) {
    tooltip.style.display = "none";
    return;
  }
  tooltip.style.display = "block";
  const pad = 8;
  const rowRect = activeRow.getBoundingClientRect();
  const popupRect = popup.getBoundingClientRect();
  const tw = tooltip.offsetWidth || 280;
  const th = tooltip.offsetHeight || 80;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // Default: right of popup, vertically centered on the active row.
  let left = popupRect.right + 8;
  let top = rowRect.top + rowRect.height / 2 - th / 2;

  // If no room on the right, flip to the left of the popup.
  if (left + tw + pad > vw) {
    left = popupRect.left - tw - 8;
    if (left < pad) left = pad;
  }
  if (top + th + pad > vh) top = Math.max(pad, vh - th - pad);
  if (top < pad) top = pad;

  tooltip.style.left = `${Math.round(left)}px`;
  tooltip.style.top = `${Math.round(top)}px`;
}

function positionPopup(popup: HTMLElement, anchor: DOMRect | null) {
  const pad = 8;
  const pw = popup.offsetWidth || 280;
  const ph = popup.offsetHeight || 240;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  let left = anchor ? anchor.left : pad;
  let top = anchor ? anchor.bottom + 4 : pad;

  if (left + pw + pad > vw) left = Math.max(pad, vw - pw - pad);
  if (top + ph + pad > vh && anchor) {
    // flip above the caret if there's more room up there
    const above = anchor.top - ph - 4;
    top = above >= pad ? above : Math.max(pad, vh - ph - pad);
  }
  popup.style.left = `${Math.round(left)}px`;
  popup.style.top = `${Math.round(top)}px`;
}

// ── TipTap Suggestion config ───────────────────────────────────────────────

// The TipTap suggestion types are awkward to import from `@tiptap/suggestion`
// here without dragging in the whole package; use `any` at the seam.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildMentionSuggestion(deps: MentionDeps): any {
  return {
    char: "@",
    allowSpaces: false,

    items: async ({ query }: { query: string }) => {
      const skills = await getSkills();
      return buildItems(query, skills);
    },

    // The Mention extension's command callback inserts the chip via its own
    // `command(item)` from props. We override insertion semantics: action
    // items invoke the callback instead of inserting; skill items insert a
    // chip whose label is "skill:NAME" so submitted text contains "@skill:NAME".
    command: ({
      editor,
      range,
      props,
    }: {
      editor: { chain: () => any }; // eslint-disable-line @typescript-eslint/no-explicit-any
      range: { from: number; to: number };
      props: Item;
    }) => {
      if (props.kind === "action" && props.action === "attach-file") {
        // Drop the typed @query so the input is clean before we open the picker.
        editor
          .chain()
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .focus()
          .deleteRange(range)
          .run();
        deps.onAttachFile();
        return;
      }
      if (props.kind === "skill") {
        editor
          .chain()
          .focus()
          .insertContentAt(range, [
            {
              type: "mention",
              attrs: { id: `skill:${props.skillName}`, label: `skill:${props.skillName}` },
            },
            { type: "text", text: " " },
          ])
          .run();
      }
    },

    render: () => {
      let popup: HTMLDivElement | null = null;
      let tooltip: HTMLDivElement | null = null;
      let currentItems: Item[] = [];
      let selectedIndex = 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let currentProps: any = null;

      const commit = (idx: number) => {
        const item = currentItems[idx];
        if (!item || !currentProps) return;
        currentProps.command(item);
      };

      const refreshTooltip = () => {
        if (!popup || !tooltip) return;
        const item = currentItems[selectedIndex];
        if (!item || !item.desc) {
          tooltip.style.display = "none";
          return;
        }
        tooltip.textContent = item.desc;
        const activeRow = popup.querySelector<HTMLElement>(".mp-item.active");
        positionTooltip(tooltip, popup, activeRow);
      };

      const updateActive = () => {
        if (!popup) return;
        popup.querySelectorAll<HTMLElement>(".mp-item").forEach((el, i) => {
          el.classList.toggle("active", i === selectedIndex);
        });
        refreshTooltip();
      };

      const rebuild = (items: Item[]) => {
        currentItems = items;
        if (selectedIndex >= items.length) selectedIndex = 0;
        if (!popup) return;
        popup.innerHTML = renderHtml(items, selectedIndex);
        wireMouseHandlers();
        refreshTooltip();
      };

      const wireMouseHandlers = () => {
        if (!popup) return;
        popup.querySelectorAll<HTMLElement>(".mp-item").forEach((el) => {
          el.addEventListener("mouseenter", () => {
            const idx = Number(el.dataset.idx ?? "-1");
            if (idx >= 0 && idx !== selectedIndex) {
              selectedIndex = idx;
              updateActive();
            }
          });
          el.addEventListener("mousedown", (e) => {
            // mousedown (not click) so we beat the editor's blur handling.
            e.preventDefault();
            const idx = Number(el.dataset.idx ?? "-1");
            if (idx >= 0) commit(idx);
          });
        });
      };

      return {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        onStart(props: any) {
          currentProps = props;
          popup = document.createElement("div");
          popup.className = "mp-pop";
          popup.style.position = "fixed";
          document.body.appendChild(popup);

          tooltip = document.createElement("div");
          tooltip.className = "mp-tooltip";
          tooltip.style.position = "fixed";
          tooltip.style.display = "none";
          document.body.appendChild(tooltip);

          rebuild(props.items ?? []);
          positionPopup(popup, props.clientRect?.() ?? null);
          refreshTooltip();
        },

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        onUpdate(props: any) {
          currentProps = props;
          rebuild(props.items ?? []);
          if (popup) {
            positionPopup(popup, props.clientRect?.() ?? null);
            refreshTooltip();
          }
        },

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        onKeyDown(props: any) {
          const e = props.event as KeyboardEvent;
          if (e.key === "ArrowDown") {
            selectedIndex = Math.min(selectedIndex + 1, currentItems.length - 1);
            updateActive();
            return true;
          }
          if (e.key === "ArrowUp") {
            selectedIndex = Math.max(selectedIndex - 1, 0);
            updateActive();
            return true;
          }
          if (e.key === "Enter" || e.key === "Tab") {
            if (currentItems.length === 0) return true;
            commit(selectedIndex);
            return true;
          }
          if (e.key === "Escape") {
            return true;
          }
          return false;
        },

        onExit() {
          popup?.remove();
          tooltip?.remove();
          popup = null;
          tooltip = null;
          currentItems = [];
          currentProps = null;
          selectedIndex = 0;
        },
      };
    },
  };
}

/** Extract plain text from TipTap editor JSON, mentions become @label. */
export function extractText(json: Record<string, unknown>): string {
  if (json.type === "text") return String(json.text ?? "");
  if (json.type === "mention") {
    const attrs = json.attrs as Record<string, string> | undefined;
    return `@${attrs?.label ?? "mention"}`;
  }
  const children = json.content as Array<Record<string, unknown>> | undefined;
  if (!children) return "";
  const inner = children.map(extractText).join("");
  if (json.type === "paragraph") return inner + "\n";
  return inner;
}
