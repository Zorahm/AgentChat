/** Clean assistant text for display and detect the crisis-support marker.
 *
 * File cards no longer come from text tags — the model calls the `present_files`
 * tool and the UI builds cards from those calls (see presentedFiles.ts). The
 * only inline marker left is `<support />` (the crisis-resources card). */

interface ParseResult {
  cleanText: string;
  /** The model emitted <support /> — show the mental-health resources card. */
  support: boolean;
}

// <support /> — the model's signal to surface the mental-health resources card.
const SUPPORT_RE = /<support\s*\/>/gi;

export function parseArtifacts(text: string): ParseResult {
  SUPPORT_RE.lastIndex = 0;
  const support = SUPPORT_RE.test(text);

  const cleanText = text
    .replace(SUPPORT_RE, "")          // strip the support marker (renders a card)
    .replace(/\n{3,}/g, "\n\n")       // collapse excess blank lines
    .trim();

  return { cleanText, support };
}
