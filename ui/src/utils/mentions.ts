/** @-mention suggestion for TipTap.
 *
 * Two item kinds:
 *   - action  → file picker (no chip is inserted; calls onAttachFile)
 *   - skill   → typeahead of installed skills; inserts a mention chip
 *               with id/label `skill:NAME` so the agent's read_skill tool
 *               can pick it up from submitted text as `@skill:NAME`.
 */

import { API_BASE } from "./apiBase";
import { ReactRenderer } from "@tiptap/react";
import { MentionPopup, type MentionItemData } from "../components/Chat/MentionPopup";

export interface MentionDeps {
  onAttachFile: () => void;
}

interface SkillEntry {
  name: string;
  description: string;
}

interface ActionItem extends MentionItemData {
  kind: "action";
  action: "attach-file";
}

interface SkillItem extends MentionItemData {
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
  type: "file",
  kbd: "",
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
        type: "skill",
      });
    }
  }

  return items;
}

// ── Popup rendering via ReactRenderer ──────────────────────────────────────

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
    const above = anchor.top - ph - 4;
    top = above >= pad ? above : Math.max(pad, vh - ph - pad);
  }
  popup.style.left = `${Math.round(left)}px`;
  popup.style.top = `${Math.round(top)}px`;
}

// ── TipTap Suggestion config ───────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildMentionSuggestion(deps: MentionDeps): any {
  return {
    char: "@",
    allowSpaces: false,

    items: async ({ query }: { query: string }) => {
      const skills = await getSkills();
      return buildItems(query, skills);
    },

    command: ({
      editor,
      range,
      props,
    }: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      editor: { chain: () => any };
      range: { from: number; to: number };
      props: Item;
    }) => {
      if (props.kind === "action" && props.action === "attach-file") {
        editor
          .chain()
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let renderer: ReactRenderer<any> | null = null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let currentProps: any = null;

      return {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        onStart(props: any) {
          currentProps = props;

          renderer = new ReactRenderer(MentionPopup, {
            props,
            editor: props.editor,
          });

          const popup = renderer.element as HTMLElement;
          popup.style.position = "fixed";
          popup.style.zIndex = "200";
          document.body.appendChild(popup);

          positionPopup(popup, props.clientRect?.() ?? null);
        },

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        onUpdate(props: any) {
          currentProps = props;
          renderer?.updateProps(props);

          if (renderer) {
            positionPopup(
              renderer.element as HTMLElement,
              props.clientRect?.() ?? null,
            );
          }
        },

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        onKeyDown(props: any) {
          if (renderer?.ref) {
            return renderer.ref.onKeyDown(props);
          }
          return false;
        },

        onExit() {
          renderer?.destroy();
          renderer = null;
          currentProps = null;
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
