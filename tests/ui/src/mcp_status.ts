/** The MCP state → StatusDot mapping.
 *
 * Two components read it — the settings card and the composer's connectors
 * flyout — and they must never tell the user different things about the same
 * server. That is the whole reason the mapping is a shared function rather than
 * a ternary copied into each component, and these cases are what keep it one.
 *
 * The `connecting` flag is the piece with real semantics: it is client-side
 * only (the backend has no such state), it wins over whatever the last poll
 * said, and it deliberately does NOT apply to a server that is already
 * connected — re-probing a live connector must not make its dot blink. */

import { mcpDot } from "../../../ui/src/utils/mcpStatus";
import { assert, report, section, test } from "./assert";

section("MCP status dot");

test("a connected server is green", () => {
  const dot = mcpDot("running");
  assert(dot.variant === "success", `expected success, got ${dot.variant}`);
  assert(dot.isPulsing === false, "a settled state must not pulse");
});

test("a failed server is red, not grey", () => {
  // "error" and "stopped" both mean "no tools right now", but only one of them
  // is the user's problem to fix — they must not look the same.
  assert(mcpDot("error").variant === "error", "expected the error variant");
  assert(mcpDot("stopped").variant === "neutral", "expected the neutral variant");
});

test("an unprobed server is neutral rather than alarming", () => {
  const dot = mcpDot("stopped");
  assert(dot.variant === "neutral", `expected neutral, got ${dot.variant}`);
  assert(dot.labelKey.endsWith("stopped"), `unexpected label key ${dot.labelKey}`);
});

test("a probe in flight overrides the stale state", () => {
  const dot = mcpDot("error", true);
  assert(dot.variant === "accent", `expected accent, got ${dot.variant}`);
  assert(dot.isPulsing === true, "a probe in flight should pulse");
  assert(dot.labelKey.endsWith("connecting"), `unexpected label key ${dot.labelKey}`);
});

test("every state maps to its own label key", () => {
  const keys = [
    mcpDot("running").labelKey,
    mcpDot("stopped").labelKey,
    mcpDot("error").labelKey,
    mcpDot("stopped", true).labelKey,
  ];
  // A duplicate here means one state is silently described as another.
  assert(new Set(keys).size === keys.length, `label keys collide: ${keys.join(", ")}`);
  assert(
    keys.every((k) => k.startsWith("settings.mcp.state.")),
    "labels must live under one i18n namespace",
  );
});

report("mcp_status");
