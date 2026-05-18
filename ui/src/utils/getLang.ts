/** Map file extension to syntax-highlighting language identifier. */

const LANG_MAP: Record<string, string> = {
  md: "markdown",
  py: "python",
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  rs: "rust",
  go: "go",
  sh: "bash",
  bash: "bash",
  txt: "plaintext",
  css: "css",
  html: "html",
};

export function getLang(path: string): string {
  const ext = path.split(".").pop() ?? "";
  return LANG_MAP[ext] ?? "plaintext";
}
