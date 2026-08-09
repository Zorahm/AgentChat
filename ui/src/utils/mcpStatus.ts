/** One mapping from an MCP server's runtime state to its StatusDot.
 *
 *  Shared by the settings card and the composer's connectors flyout so the two
 *  can't drift into telling the user different things about the same server. */

export type McpState = "stopped" | "running" | "error";

/** The subset of Astryx's StatusDot variants this mapping uses.
 *
 *  Spelled out rather than imported from the design system so the module stays
 *  free of Astryx's subpath exports and can run under the plain-tsc UI test
 *  harness. Nothing is lost: the components pass `variant` straight into
 *  `<StatusDot>`, so a name that Astryx stops accepting still fails to compile
 *  there. */
export type McpDotVariant = "success" | "error" | "accent" | "neutral";

export interface McpDotProps {
  variant: McpDotVariant;
  /** i18n key for the dot's accessible label / tooltip. */
  labelKey: string;
  isPulsing: boolean;
}

/** `connecting` is the client-side truth that a probe is in flight — the
 *  backend has no such state, since a server is either connected or it isn't. */
export function mcpDot(state: McpState, connecting = false): McpDotProps {
  if (connecting) {
    return { variant: "accent", labelKey: "settings.mcp.state.connecting", isPulsing: true };
  }
  if (state === "running") {
    return { variant: "success", labelKey: "settings.mcp.state.running", isPulsing: false };
  }
  if (state === "error") {
    return { variant: "error", labelKey: "settings.mcp.state.error", isPulsing: false };
  }
  return { variant: "neutral", labelKey: "settings.mcp.state.stopped", isPulsing: false };
}
