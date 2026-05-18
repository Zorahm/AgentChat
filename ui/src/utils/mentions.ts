/** @mention suggestion for TipTap — wireframe v2 design. */

interface MentionItem {
  id: string;
  label: string;
  desc: string;
}

const ITEMS: MentionItem[] = [
  { id: "file", label: "File", desc: "Прикрепить файл" },
  { id: "folder", label: "Folder", desc: "Прикрепить папку" },
  { id: "skill", label: "Skill", desc: "Активировать скилл" },
  { id: "url", label: "URL", desc: "Прикрепить веб-страницу" },
];

const ICONS: Record<string, string> = {
  file: "📄", folder: "📁", skill: "🧩", url: "🔗",
};

/* ── TipTap Suggestion config ────────────────── */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildMentionSuggestion(): any {
  let popup: HTMLDivElement | null = null;
  let items: MentionItem[] = [];
  let selectedIndex = 0;

  function renderList(query: string) {
    items = ITEMS.filter(
      (m) => !query || m.label.toLowerCase().includes(query.toLowerCase()),
    );
    selectedIndex = 0;
    if (!popup) return;

    let html = '<div class="mp-head">Упоминания</div>';
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      const active = i === 0 ? " active" : "";
      html +=
        `<div class="mp-item${active}" data-idx="${i}">` +
        `<span class="mp-item-ic">${ICONS[item.id] ?? "•"}</span>` +
        `<span class="mp-item-info">` +
        `<span class="mp-item-label">@${item.label}</span>` +
        `<span class="mp-item-desc">${item.desc}</span>` +
        `</span>` +
        `</div>`;
    }
    popup.innerHTML = html;
  }

  function updateActive() {
    if (!popup) return;
    popup.querySelectorAll(".mp-item").forEach((el, i) => {
      el.classList.toggle("active", i === selectedIndex);
    });
  }

  return {
    items: ({ query }: { query: string }) =>
      ITEMS.filter(
        (m) => !query || m.label.toLowerCase().includes(query.toLowerCase()),
      ),

    render: () => ({
      onStart(props: Record<string, unknown>) {
        popup = document.createElement("div");
        popup.className = "mp-pop";
        document.body.appendChild(popup);
        const cr = props.clientRect as (() => DOMRect) | null | undefined;
        const rect = cr?.();
        if (rect) {
          popup.style.position = "fixed";
          popup.style.left = rect.left + "px";
          popup.style.top = rect.bottom + 4 + "px";
        }
        renderList(props.query as string);
      },

      onUpdate(props: Record<string, unknown>) {
        renderList(props.query as string);
        const cr = props.clientRect as (() => DOMRect) | null | undefined;
        const rect = cr?.();
        if (popup && rect) {
          popup.style.left = rect.left + "px";
          popup.style.top = rect.bottom + 4 + "px";
        }
      },

      onKeyDown(props: Record<string, unknown>) {
        const e = props.event as KeyboardEvent;
        if (e.key === "ArrowDown") {
          selectedIndex = Math.min(selectedIndex + 1, items.length - 1);
          updateActive();
          return true;
        }
        if (e.key === "ArrowUp") {
          selectedIndex = Math.max(selectedIndex - 1, 0);
          updateActive();
          return true;
        }
        if (e.key === "Enter") {
          const item = items[selectedIndex];
          if (item && typeof props.command === "function") {
            (props.command as (i: MentionItem) => void)(item);
          }
          return true;
        }
        return e.key === "Escape";
      },

      onExit() {
        popup?.remove();
        popup = null;
      },
    }),
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
  if (json.type === "paragraph") return inner + " ";
  return inner;
}
