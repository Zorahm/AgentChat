/** Tool call display types. */

export type ToolCallStatus = "running" | "success" | "error" | "cancelled";

export type ProcessStep =
  | { type: "thought"; content: string }
  | { type: "tool"; call: ToolCall }
  | { type: "text"; content: string }
  | { type: "break" }
  | { type: "iterations_exhausted"; count: number };

export interface ResearchSource {
  url: string;
  domain: string;
}

/** One sub-question the lead researcher published via `plan_research`. */
export interface ResearchPlanStep {
  id: string;
  title: string;
}

/** One thing an agent did. Mirrors the backend's `agent_step` event. */
export type ResearchAgentStep =
  | { kind: "search"; query: string }
  | { kind: "read"; url: string };

export type ResearchAgentStatus = "running" | "ok" | "failed" | "timeout" | "cancelled";

/** The lead or one subagent, with its own slice of the timeline. */
export interface ResearchAgent {
  /** "lead" for the lead researcher, "a1"/"a2"/… for subagents. */
  id: string;
  title: string;
  status: ResearchAgentStatus;
  steps: ResearchAgentStep[];
  sources: ResearchSource[];
  summary?: string;
}

/** A free-form line the lead wrote about what it was doing. */
export interface ResearchNote {
  text: string;
}

/** Live state of a `research` tool call — drives the card + the side panel.
 *  Rebuilt from `tool_progress` events; see ui/src/utils/research.ts. */
export interface ResearchData {
  title?: string;
  status: "running" | "complete" | "cancelled";
  plan: ResearchPlanStep[];
  agents: ResearchAgent[];
  notes: ResearchNote[];
  reportPath?: string;
  startedAt: number;
  durationMs?: number;
}

/** One finished image, as reported by an `image` tool_progress event. */
export interface GeneratedImageRef {
  path: string;
  width: number;
  height: number;
  seed?: number;
}

/** Live state of an `image_generate` tool call — drives the image card.
 *  Rebuilt from `tool_progress` events; see ui/src/utils/imageGen.ts.
 *  The paths live here rather than in `input` because they only exist after
 *  the tool has run — unlike show_widget's HTML, they cannot ride the call's
 *  arguments. */
export interface ImageGenData {
  status: "running" | "complete" | "failed" | "cancelled";
  /** Backend that rendered it: "a1111" | "comfy" | "api". */
  backend: string;
  prompt: string;
  /** How many images were requested — sizes the placeholder grid. */
  count: number;
  /** 0..100 while a backend reports it; undefined = indeterminate. */
  percent?: number;
  /** Short backend status, e.g. "12/25" or "queued (1 ahead)". */
  statusText?: string;
  images: GeneratedImageRef[];
  error?: string;
  startedAt: number;
  durationMs?: number;
}

/** The five verdicts a check can return. They are NOT interchangeable, and the
 *  badge must render each one differently: `inconclusive` drawn like `verified`
 *  is how the badge stops meaning anything, and `error` drawn like `refuted`
 *  tells the user a correct answer is wrong. Mirrors backend/schemas/math.py. */
export type VerifyStatus = "verified" | "refuted" | "partial" | "inconclusive" | "error";

/** Where the verdict came from: the deterministic tool, or the Re-check agent. */
export type VerifierKind = "deterministic" | "subagent";

export interface VerifySymbolic {
  ok: boolean;
  detail: string;
}

export interface VerifyNumeric {
  ok: boolean;
  maxAbsErr: number;
  maxRelErr: number;
  samples: number;
  detail: string;
}

/** One completed check. A message can hold several — one per claim, and up to
 *  two per claim when a refuted answer was rewritten. Both are kept: showing
 *  only the successful retry is exactly what turns the badge into theatre. */
export interface VerifyAttempt {
  status: VerifyStatus;
  kind: string;
  /** The problem the claim was checked AGAINST. Shown to the user verbatim,
   *  because a claim proven against a quietly reworded problem is still green —
   *  and a human spots that mismatch in a second. */
  problem: string;
  claim: Record<string, unknown>;
  symbolic?: VerifySymbolic;
  numeric?: VerifyNumeric;
  counterexample?: Record<string, unknown>;
  detail: string;
  method: string;
  verifier: VerifierKind;
  attempt: number;
  seed: number;
  durationMs: number;
}

/** Live state of a `math_verify` tool call — drives the verification badge.
 *  Rebuilt from `tool_progress` events; see ui/src/utils/verification.ts. */
export interface VerificationData {
  status: "running" | "complete" | "failed" | "cancelled";
  kind: string;
  problem: string;
  attempts: VerifyAttempt[];
  /** The backend's per-turn id, so a Re-check files under the same turn. */
  messageId?: string;
  error?: string;
  startedAt: number;
  durationMs?: number;
}

/** Live state of a `math_plot` tool call — drives the plot card.
 *  The SVG is rendered by the backend, so like image_generate's paths it only
 *  exists after the call and cannot ride the tool call's arguments. */
export interface MathPlotData {
  status: "running" | "complete" | "failed" | "cancelled";
  plotKind: string;
  exprs: string[];
  title: string;
  svg?: string;
  warnings: string[];
  error?: string;
  startedAt: number;
  durationMs?: number;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  output?: string;
  status: ToolCallStatus;
  durationMs?: number;
  filePath?: string;
  /** Present only on `research` tool calls — the timeline of the research run. */
  research?: ResearchData;
  /** Present only on `image_generate` tool calls — progress + finished images. */
  image?: ImageGenData;
  /** Present only on `math_verify` tool calls — the verdict behind the badge. */
  verify?: VerificationData;
  /** Present only on `math_plot` tool calls — the rendered plot. */
  plot?: MathPlotData;
  /** Present only on `ask_user` tool calls — the questions shown to the user. */
  userQuestion?: UserQuestionData;
}

/** Data for an ask_user tool call — questions + the user's selections. */
export interface UserQuestionData {
  chatId: string;
  questions: UserQuestion[];
  /** Default selection type for questions that don't set their own. */
  selectionType: "single" | "multiple";
  answers?: string[][];
}

export interface UserQuestion {
  question: string;
  options: string[];
  /** Per-question override of the card's default selection type. */
  selectionType?: "single" | "multiple";
}

export const TOOL_ICONS: Record<string, string> = {
  bash_tool: ">_",
  web_search: "🔍",
  web_fetch: "🌐",
  read_file: "📄",
  list_dir: "📂",
  read_photo: "🖼",
  write_file: "📄",
  edit_file: "📄",
  present_files: "📎",
  read_skill: "📚",
  ask_user: "❓",
  image_generate: "🎨",
  math_eval: "🧮",
  math_verify: "✓",
  math_plot: "📈",
};
