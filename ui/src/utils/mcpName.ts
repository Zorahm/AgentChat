/** Parse MCP tool names of the form `mcp__<server>__<tool>`. */

const MCP_PREFIX = "mcp__";

export interface McpToolName {
  server: string;
  tool: string;
}

/** Split `mcp__context7__resolve-library-id` into `{ server: "context7",
 * tool: "resolve-library-id" }`. Returns null for non-MCP tool names. The tool
 * segment may itself contain `__`, so we split on the FIRST separator only —
 * mirroring the backend's `split_tool_name`. */
export function parseMcpToolName(name: string): McpToolName | null {
  if (!name.startsWith(MCP_PREFIX)) return null;
  const rest = name.slice(MCP_PREFIX.length);
  const idx = rest.indexOf("__");
  if (idx === -1) return null;
  return { server: rest.slice(0, idx), tool: rest.slice(idx + 2) };
}

export function isMcpToolName(name: string): boolean {
  return name.startsWith(MCP_PREFIX);
}
