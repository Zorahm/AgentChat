/** Copy text to the clipboard, with the fallback the app actually needs.
 *
 *  `navigator.clipboard` is unavailable outside a secure context — which is
 *  exactly where this app often runs: the Tauri webview, and the phone client
 *  talking to a plain-HTTP backend over the LAN. The hidden-textarea +
 *  `execCommand` path is deprecated but still the only thing that works there,
 *  so every copy button routes through here rather than reinventing it. */

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // fall through to the legacy path
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
}
