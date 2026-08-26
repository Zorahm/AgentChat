/** Agent Plugins (agent-plugins.org) as the backend exposes them.
 *
 * Mirrors backend/schemas/plugins.py. A plugin is listed even when it failed
 * to load — `valid: false` plus the `issues` that explain why — because a
 * package that silently disappears is indistinguishable from one that was
 * never installed.
 */

export type PluginIssueLevel = "error" | "warning";
export type PluginIssueScope = "manifest" | "skill" | "mcp" | "extension";

export interface PluginIssue {
  level: PluginIssueLevel;
  scope: PluginIssueScope;
  message: string;
  /** The field, skill directory or server key the issue is about. */
  target: string | null;
}

export interface PluginSkillInfo {
  name: string;
  description: string;
  path: string;
}

export interface PluginMCPServerInfo {
  /** The derived id the MCP manager knows this server by. */
  id: string;
  /** Its name inside the plugin's mcp.json. */
  key: string;
  transport: string;
  state: "stopped" | "running" | "error";
  last_error: string | null;
  tool_count: number;
}

export interface Plugin {
  name: string;
  path: string;
  valid: boolean;
  enabled: boolean;
  version: string | null;
  description: string | null;
  author: string | null;
  homepage: string | null;
  repository: string | null;
  license: string | null;
  keywords: string[];
  /** Where it came from, per the install marker. */
  source: string | null;
  /** False for a package placed by hand — we refuse to delete those. */
  installed_by_us: boolean;
  skills: PluginSkillInfo[];
  mcp_servers: PluginMCPServerInfo[];
  issues: PluginIssue[];
}

export interface PluginLocation {
  plugins_dir: string;
  data_dir: string;
}
