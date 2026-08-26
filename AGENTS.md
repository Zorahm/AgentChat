# AGENTS.md — Coding Standards & Project Map

## General

- One module = one responsibility
- Prefer `dataclasses` over bare `dict`s for internal data structures (Pydantic stays the rule for API boundaries)
- Keep functions small enough to read on one screen; keep files ≤ ~300 lines — split when they grow past that
- Comments explain *why*, not *what*; a non-obvious invariant (e.g. a prompt-cache prefix ordering) must carry a comment

## TypeScript (UI)

- Strict mode enabled (`strict: true` in tsconfig.json)
- `noUncheckedIndexedAccess: true`
- Zero `any` — use `unknown` with type guards instead
- All component props must have explicit interfaces (no inline `{}`)
- Functional components and hooks only (no class components)
- Named exports only (no `export default`)

## Python (Backend)

- Type hints on all function signatures and class attributes; code must be clean under `mypy --strict` (no implicit `Any`, no untyped defs)
- Pydantic models for all data structures crossing module boundaries; `dataclasses` for internal-only structures
- `async`/`await` for all I/O operations
- Black formatting: 100 char line length, double quotes
- Ruff for linting (replaces isort, flake8, pyupgrade)
- `from __future__ import annotations` at top of each file
- **Import layering:** shared Pydantic contracts live in `backend/schemas/`, a leaf that
  imports nothing from the app. Lower layers (`store/`, `llm/`, `mcp_integration/`,
  `research/`) import *down* into it and must never reach up into `api/`. Keep package
  `__init__.py` files import-free unless the package is a genuine façade — an eager
  re-export turns the package into a cycle hub, and the resulting `ImportError` only
  appears when a module is imported first in a process (see `tests/backend/test_import_graph.py`)

<!-- ASTRYX:START -->
Astryx v0.1.8 · 153 components
CLI: run every command as `npx @astryxdesign/cli <cmd>` (shown below as `astryx ...`).

SETUP (once, in your app entry e.g. main.tsx) — without these, components render unstyled:
  import "@astryxdesign/core/reset.css";
  import "@astryxdesign/core/astryx.css";

WORKFLOW — discover, don't guess. Before writing UI:
1. `astryx build "<idea>"` — START HERE: returns a kit (closest [page] + [block]s + [component]s). No args = full playbook.
2. `astryx template <name> [--skeleton]` — scaffold the [page]/[block]s it named, or study their layout. Templates are reference code.
3. `astryx component <Name>` — props + examples for every component you use.

RULES:
- No <div> — components do all layout/spacing. Full page → AppShell; sidebar nav → SideNav.
- Frame first: pick the shell (AppShell / Layout+LayoutPanel) and budget regions in px BEFORE writing content (`astryx docs layout`).
- Dense data = rows (Table, List/Item) edge-to-edge — never Card-wrapped list items. Card = dashboard widgets, galleries, settings groups only.
- Status → StatusDot/Token; Badge only for counts and enumerated states, never decoration.
- Custom styling: component props first; else style/className with tokens — var(--color-*|--spacing-*|--radius-*). No raw hex/px. (No StyleX/Tailwind compiler here — don't use xstyle/utility classes.)
- Tokens for every value (`astryx docs tokens`). Brand/accent via `astryx theme` — never override --color-* in :root.
- SELF-CHECK before you finish: re-read the file and replace any raw <div>/<span> layout, imported .css/@apply, or hardcoded value (#hex, 16px) with the component or a token (var(--color-*|--spacing-*|…)). If unsure a component/prop exists, run `astryx component <Name>` / `astryx search "<thing>"`; don't hand-roll CSS.

MORE CLI:
  search "<query>"   find any component / hook / doc / template / block
  component --list   153 components by category
  template --list    page + block recipes
  docs <topic>       color, elevation, icons, illustrations, internationalization, layout, migration, motion, principles, shape, spacing, styling, theme, tokens, typography
  swizzle <Name>     eject component source for deep customization
  upgrade --apply    run after any @astryxdesign/core bump
<!-- ASTRYX:END -->

---

## Project Structure

```
AgentChat/
├── backend/                    # Python — FastAPI + agent loop
│   ├── main.py                 # App factory — composition root; remote-access guard middleware
│   ├── run.py                  # Uvicorn entry point
│   ├── paths.py                # Path resolution (data dir, chat dirs); AGENTCHAT_DATA_DIR override
│   ├── shell.py                # Shell abstraction (WSL/PowerShell/posix)
│   ├── server_mode.py          # AGENTCHAT_SERVER_MODE — drops the loopback exemption, owns the token
│   ├── extraction.py           # Content/text extraction utilities
│   ├── retry.py                # Transient-vs-fatal classification + backoff — a LEAF, shared by the loop and the network tools
│   ├── archive_fetch.py        # GitHub zip download + Zip-Slip-safe extraction — a LEAF shared by both installers
│   ├── _buildstamp.py          # Version stamped in by build-backend.ps1/.sh
│   ├── api/                    # FastAPI route handlers
│   │   ├── chat.py             # POST /api/chat — SSE streaming (core)
│   │   ├── chats.py            # CRUD /api/chats — session persistence
│   │   ├── settings.py         # GET/PUT /api/settings
│   │   ├── files.py            # File upload/download/serve/preview (Office→PDF)
│   │   ├── skills.py           # Skills install/list/delete
│   │   ├── plugins.py          # Agent Plugins install/list/toggle/remove
│   │   ├── mcp_sources.py      # The full MCP server set: settings store + installed plugins
│   │   ├── wsl.py              # WSL detection & management
│   │   ├── health.py           # GET /api/system-status
│   │   ├── models_routes.py    # GET /api/models
│   │   ├── mcp.py              # MCP server management routes
│   │   ├── projects.py         # Projects CRUD
│   │   ├── agents.py           # Agent-persona CRUD + memory CRUD + rendered greeting + the whitelist roster
│   │   ├── math.py             # POST /math/recheck (the Re-check button) + verification history
│   │   ├── agent_runtime.py    # resolve_agent_runtime() — model/temperature/tool-policy/memory the agent contributes
│   │   ├── remote.py           # Remote access (token, toggle, QR)
│   │   ├── searxng.py          # SearXNG proxy
│   │   ├── win_deps.py         # Windows dependency detection
│   │   ├── config_routes.py    # GET /api/config/* — runtime capability probes for the UI
│   │   ├── usage.py            # /api/usage/* — token/cost dashboard + manual model pricing
│   │   ├── active_streams.py   # In-flight stream registry — DELETE /chats waits on it before rm -rf
│   │   ├── loopback.py         # is_loopback_request() — shared by the guard middleware and /remote-access
│   │   ├── router.py           # Route assembly — import this, NOT `api` (see api/__init__.py)
│   │   └── __init__.py         # Deliberately import-free; re-exporting the router made the cycle
│   ├── schemas/                # Pydantic request/response contracts — a LEAF package
│   │   ├── chat.py             # ChatRequest, ChatMessage, AttachmentInfo
│   │   ├── mcp.py              # MCP contracts: persisted MCPServerConfig + API views
│   │   ├── settings.py         # Settings schemas; ProviderPublic is the only shape sent over HTTP
│   │   ├── redaction.py        # MASK + redact_map/unredact_map for secret-bearing maps
│   │   ├── skills.py           # Skills schemas
│   │   ├── agents.py           # Agent-persona schemas (AgentFields base; tool policy, allowed_tools, RP fields)
│   │   ├── math.py             # VerifyOutcome + the five statuses — verified/refuted/partial/inconclusive/error
│   │   ├── memory.py           # Agent-memory contracts (MemoryFact/Create/Update)
│   │   └── plugins.py          # Agent Plugins: manifest, canonical $schema ids, the API's plugin views
│   ├── agent/                  # Agent core logic
│   │   ├── loop.py             # AgentLoop — run_stream() is the main path
│   │   ├── config.py           # AgentConfig dataclass
│   │   ├── system_prompt.py    # build_system_prompt() — thin wrapper over agent/prompt
│   │   ├── prompt/             # System-prompt module registry
│   │   │   ├── context.py      # PromptContext — frozen inputs to assembly
│   │   │   ├── modules.py      # PromptModule/PromptBuild + assemble() (cache invariant)
│   │   │   ├── registry.py     # build_registry() — ordered module list
│   │   │   ├── sections.py     # Static section constants (verbatim)
│   │   │   ├── shells.py       # Shell-dialect fragments (shared body + deltas)
│   │   │   └── model_family.py # Model-family detection + per-family quirks
│   │   ├── modes.py           # Chat modes (composer tab strip) as AgentConfigs — maths; shares a slot with agent_id
│   │   ├── untrusted.py        # Fences web_fetch/web_search/uploads/MCP output in <untrusted_content>
│   │   ├── types.py            # Agent event/message types
│   │   ├── sandbox.py          # SandboxPolicy — path access control
│   │   ├── partial_json.py     # ArgScanner — decodes a tool call's JSON args while they stream (single pass)
│   │   ├── tool_stream.py      # Live tool events: tool_start / tool_input_delta / tool_input / tool_chunk
│   │   ├── dir_listing.py      # DirEntry + local_list_dir — the shape every list backend returns
│   │   ├── exec_common.py      # Shared subprocess plumbing (run_blocking/run_capture/decode_loose)
│   │   ├── host_exec.py        # Platform dispatch — host_run/host_read_*/host_write_*/host_list_dir (single import point)
│   │   ├── posix_exec.py       # Native Linux/macOS execution (bash/zsh) + AppImage env scrub
│   │   ├── wsl_exec.py         # WSL-only execution — tunnels through wsl.exe
│   │   └── reasoning_split.py  # Splits model output into thinking/text
│   ├── research/               # Multi-agent research: lead + parallel subagents
│   │   ├── lead.py             # LeadResearcher — drives one run, brief → report
│   │   ├── worker.py           # SubagentRunner — one delegated task → Finding
│   │   ├── fanout.py           # Parallel round: timeouts, error + cancel isolation
│   │   ├── lead_tools.py       # plan_research / note / submit_report
│   │   ├── delegate_tool.py    # run_subagents — the lead spawns a round
│   │   ├── worker_tools.py     # submit_findings — a subagent's structured hand-off
│   │   ├── prompts.py          # Thin role contracts; the BRIEF carries the content
│   │   ├── budget.py           # ResearchBudget caps + BudgetTracker spend counters
│   │   ├── toolset.py          # Web-backend resolution + per-agent tool registries
│   │   ├── observer.py         # Loop events → progress steps + source list
│   │   ├── progress.py         # ProgressEmitter — the tool_progress vocabulary
│   │   ├── sources.py          # URL extraction/dedup + citation audit
│   │   ├── report.py           # research-<slug>.md path resolution + write
│   │   └── types.py            # ModelEndpoint, SubagentTask, Finding, ResearchOutcome
│   ├── mathkit/                # Maths engine — runs in a CHILD process, never in the server
│   │   ├── parsing.py          # Closed-namespace SymPy parsing + a LaTeX pre-pass (sympify is a code-exec hole)
│   │   ├── numeric.py          # Seeded sampling, RELATIVE tolerance, Wilson interval
│   │   ├── pysandbox.py        # Restricted Python for math_eval + Monte Carlo (a calculator, not an OS sandbox)
│   │   ├── verifiers/          # One strategy per kind — algebra/calculus/linalg/stochastic + registry
│   │   ├── worker.py           # The child's loop: one JSON job per line, in and out
│   │   ├── runner.py           # Parent side: a pool of warm workers, killed and replaced on timeout
│   │   ├── subagent.py         # Fallback verifier — gets problem + claim, never the solution
│   │   ├── progress.py         # tool_progress vocabulary for math_verify + math_plot
│   │   └── plot/               # sampler.py (breaks curves at poles) + svg.py + render.py
│   ├── images/                 # Image generation: local samplers + hosted APIs
│   │   ├── config.py           # ImageRequest/ImageGenConfig/GeneratedImage — a LEAF
│   │   ├── service.py          # ImageGenService — backend resolution (no silent fallback)
│   │   ├── progress.py         # ImageProgressEmitter — the tool_progress vocabulary
│   │   ├── probe.py            # Pixel size + mime straight from the header (no Pillow)
│   │   ├── backends/a1111.py   # AUTOMATIC1111 / Forge / SD.Next — /sdapi/v1/txt2img
│   │   ├── backends/comfy.py   # ComfyUI — queue a graph, poll /history, fetch /view
│   │   ├── backends/comfy_workflow.py # Graph surgery: find the sampler, patch its links
│   │   ├── backends/api.py     # Hosted models via litellm.aimage_generation/aimage_edit
│   │   └── workflows/          # Bundled ComfyUI graphs (txt2img/img2img, API format)
│   ├── tools/                  # Tool implementations (agent-callable)
│   │   ├── base.py             # BaseTool ABC
│   │   ├── registry.py         # ToolRegistry — register/execute tools; binds args BEFORE calling
│   │   ├── factory.py          # build_tool_registry() — per-request assembly
│   │   ├── arg_coerce.py       # "5" → 5 for model-supplied numbers, with a fallback
│   │   ├── output_budget.py    # clamp_output() — the cap on bash_tool + MCP output
│   │   ├── shell_exec.py       # run_in_shell() — 4 dialects + WSL fallbacks, shared by bash_tool/grep
│   │   ├── bash_tool.py        # BashTool — shell command execution (timeout arg, output budget)
│   │   ├── grep_tool.py        # GrepTool — content search in one process, grep/Select-String
│   │   ├── read_file.py        # ReadFileTool — bounded read, refuses binary/non-UTF-8
│   │   ├── read_ledger.py      # ReadLedger — an unread upload/ file is not overwritten blind
│   │   ├── url_guard.py        # web_fetch SSRF policy — link-local always, private in server mode
│   │   ├── list_dir.py         # ListDirTool — directory listing (depth/pattern), no shell
│   │   ├── binary_formats.py   # Office/binary formats write_file+edit_file refuse (generate via code)
│   │   ├── write_file.py       # WriteFileTool — canonical file write path
│   │   ├── edit_file.py        # EditFileTool — in-place file edits
│   │   ├── present_files.py    # PresentFilesTool — surfaces files as cards
│   │   ├── read_skill.py       # ReadSkillTool — reads SKILL.md
│   │   ├── read_photo.py       # ReadPhotoTool — image content extraction
│   │   ├── ask_user.py         # AskUserTool — pauses the turn for user input
│   │   ├── math_verify.py      # Independent check of a FINAL claim; enforces the one-rewrite cap
│   │   ├── math_eval.py        # Preconfigured calculator (sympy/numpy/mpmath preloaded, no imports)
│   │   ├── math_plot.py        # Plot kind + expressions → a themed, self-contained SVG
│   │   ├── research_tool.py    # ResearchTool — model-written brief → research/lead
│   │   ├── image_generate.py   # ImageGenerateTool — prompt → PNG in <chat>/images/
│   │   ├── show_widget.py      # ShowWidgetTool — inline HTML/SVG visualizations
│   │   ├── memory_tools.py     # remember/recall/forget — bound to one agent per request
│   │   ├── web_search_tool.py  # WebSearchTool
│   │   └── web_fetch_tool.py   # WebFetchTool
│   ├── llm/                    # LLM client layer
│   │   ├── client.py           # LLMClient — wraps LiteLLM
│   │   ├── model_tag.py        # Re-tags custom/OpenAI-compatible model ids
│   │   ├── api_base.py         # is_local_base/requires_api_key — local endpoints need no key
│   │   ├── models_fetcher.py   # Fetches available models from providers
│   │   ├── usage_logging.py    # litellm.callbacks hook — writes one usage_log row per LLM call
│   │   └── token_breakdown.py  # Local estimate of where prompt tokens went (system/tools/history/...)
│   ├── mcp_integration/        # Model Context Protocol (runtime only — models in schemas/mcp.py)
│   │   ├── client.py           # MCP client (stdio/HTTP)
│   │   ├── manager.py          # MCPManager — server lifecycle
│   │   ├── registry_view.py    # Exposes MCP tools to agent
│   │   └── tool_proxy.py       # Proxies MCP tool calls
│   ├── store/                  # Persistence
│   │   ├── chat_store.py       # SQLite chat storage (upsert, get, touch)
│   │   ├── project_store.py    # SQLite project storage
│   │   ├── settings_store.py   # Settings state + validation policy
│   │   ├── settings_io.py      # settings.json format: atomic I/O + secret split/merge
│   │   ├── secret_store.py     # Named secrets — OS keychain, 0600 file fallback
│   │   ├── usage_store.py      # SQLite usage/cost log (usage_log + model_pricing tables)
│   │   ├── verification_store.py # Cross-chat history of every math_verify outcome, keyed on message_id
│   │   ├── agent_presets.py    # Shipped presets, seeded ONCE per install — deletion sticks; now empty (Math became a mode) + retirement of untouched copies
│   │   └── memory_store.py     # SQLite agent memory + FTS5; core() is the ranked always-on window, search() the archive
│   ├── web_search/             # Web search module
│   │   ├── config.py           # Provider config (native/Tavily/SearXNG)
│   │   └── service.py          # WebSearchService — routes to active provider
│   ├── skills/                 # Skills system
│   │   ├── reader.py           # AgentSkillsReader — scans SKILL.md files; set_plugin_skills() merges the plugins' in
│   │   ├── installer.py        # GitHub/archive skill installer; marker carries version+fingerprint
│   │   ├── install_marker.py   # .agentchat-installed — "did we put this here?"; a LEAF shared with plugins/
│   │   ├── catalog.py          # Curated Anthropic skill catalog (docx/xlsx/pptx/pdf/...)
│   │   ├── fingerprint.py      # sha256 of a skill folder — a LEAF shared by installer + sync
│   │   └── bundled_sync.py     # Startup refresh of installed bundled skills when the app ships new ones
│   └── plugins/                # Agent Plugins 1.0.0 (agent-plugins.org) — see the contour below
│       ├── manifest.py         # §5 plugin.json: closed schema, two non-fatal violations, everything else rejects
│       ├── safety.py           # §4.1 containment — decided on the RESOLVED path, never the string
│       ├── skill_discovery.py  # §7.1 skills/ — immediate children only, never a deeper walk
│       ├── mcp_config.py       # §7.2/§9 mcp.json → MCPServerConfig: transports, URL rules, ${…} expansion
│       ├── variables.py        # PLUGIN_ROOT/PLUGIN_DATA single-pass expansion + derived server ids
│       ├── registry.py         # PluginRegistry — plugins are a VIRTUAL source; nothing is copied out
│       └── installer.py        # GitHub / local folder / zip → ~/.agents/plugins/<manifest name>
│
├── ui/                         # React + TypeScript frontend, on Meta's Astryx design system
│   └── src/
│       ├── main.tsx            # React entry point; also routes ?debug-* query params to the harnesses below
│       ├── App.tsx             # Root component, settings context, layout (Astryx AppShell/Theme)
│       ├── Debug{Composer,Update,Usage,Research,Image,ToolStream,Math}Harness.tsx # Dev-only presentation harnesses (?debug-composer/-update/-usage/-research/-images/-toolstream/-math) — render one component tree in isolation against fabricated props for visual verification without a live backend
│       ├── hooks/
│       │   ├── useChats/           # Multi-session chat manager (THE main hook)
│       │   │   ├── index.ts        # useChats() — composes the pieces below
│       │   │   ├── api.ts          # backend chat CRUD + localStorage→backend migration
│       │   │   ├── tree.ts         # pure chat-tree helpers (branches, variants)
│       │   │   └── persistence.ts  # localStorage load/save + legacy-tree migration + pinned-chat ids
│       │   ├── useSSE.ts           # SSE connection helper (sseConnect)
│       │   ├── useAvatar.ts        # Avatar URL management
│       │   ├── useProjects.ts      # Projects data hook
│       │   ├── useAgents.ts        # Agent-persona CRUD hook (mirrors useProjects)
│       │   ├── usePlugins.ts       # Agent Plugins CRUD; install calls resolve to the backend's message
│       │   ├── useShortcuts.ts     # Keyboard shortcut registration
│       │   ├── useMessageFocus.ts  # The Alt+↑/↓ ring around one message (pure half in utils/messageRing.ts)
│       │   ├── useAppUpdate.ts     # Auto-update check
│       │   ├── useFileDrop.ts      # File drop handling
│       │   ├── useIsMobile.ts      # matchMedia-backed mobile breakpoint hook
│       │   ├── useDarkMode.ts      # System dark-mode detection
│       │   ├── useViewportHeight.ts # Pins --app-height to visualViewport (mobile URL-bar-safe layout)
│       │   └── useWindowFileDrag.ts # Window-level drag detection
│       ├── contexts/
│       │   └── SettingsContext.tsx  # Shared settings state (model, theme, etc.)
│       ├── shortcuts/
│       │   └── registry.ts         # Shortcut definitions
│       ├── components/
│       │   ├── Chat/
│       │   │   ├── ChatView.tsx         # Chat column — messages + composer
│       │   │   ├── ChatInput.tsx        # Composer — Astryx ChatComposer/ChatComposerInput, no TipTap
│       │   │   ├── MessageBubble.tsx    # Single message renderer — Astryx ChatMessage/ChatToolCalls/ChatMessageMetadata
│       │   │   ├── ModelSelector.tsx    # Model dropdown
│       │   │   ├── MCPChip.tsx          # MCP indicator chip + composer "Connectors" row
│       │   │   ├── WebSearchMenuSection.tsx # Composer "+" menu — web search toggle/mode
│       │   │   ├── ResearchMenuSection.tsx  # Composer "+" menu — research toggle
│       │   │   ├── ImageGenCard.tsx     # image_generate card — progress + result tiles
│       │   │   ├── VerificationBadge.tsx # math_verify badge — 5 states told apart by icon, colour AND border
│       │   │   ├── MathPlotCard.tsx     # math_plot card — themed inline SVG + SVG/PNG export
│       │   │   ├── RetryNotice.tsx      # The turn is frozen between attempts — cause + countdown, not an error
│       │   │   ├── Research/            # ResearchCard, ResearchPanel (agent tree),
│       │   │   │                        # AgentNode, PlanList
│       │   │   ├── SourcesBox.tsx       # Web-search/research source list
│       │   │   └── SupportCard.tsx
│       │   ├── Mobile/
│       │   │   └── MobileConnect.tsx    # Backend connect/reconnect screen (APK + PWA)
│       │   ├── BottomSheet.tsx      # Generic mobile bottom-sheet primitive (drag handle)
│       │   ├── MathMarkdown.tsx     # THE markdown renderer to use — Astryx <Markdown/> + LaTeX that survives it
│       │   ├── AgentAvatar.tsx      # Gradient agent avatar — wraps Astryx Avatar, snaps to its pixel size scale
│       │   ├── Settings/
│       │   │   ├── SettingsPanel.tsx    # Shell — nav, tab routing, state
│       │   │   ├── RestartBackendButton.tsx
│       │   │   └── tabs/
│       │   │       ├── ProfileTab.tsx
│       │   │       ├── AppearanceTab.tsx
│       │   │       ├── TerminalTab.tsx
│       │   │       ├── SandboxTab.tsx
│       │   │       ├── ProvidersTab.tsx    # shell — provider list, add form, web search
│       │   │       ├── providers/          # ProviderCard, AddProviderForm, HeadersEditor,
│       │   │       │                       # WebSearchSettings, ImageGenSettings,
│       │   │       │                       # SearxngInstaller, YandexSetup
│       │   │       ├── ModelsTab.tsx
│       │   │       ├── PathsTab.tsx
│       │   │       ├── paths/            # ServerModeCard — point this client at a remote backend
│       │   │       ├── MCPTab.tsx        # A server carrying `plugin` is read-only here — the plugin owns it
│       │   │       ├── PluginsTab.tsx    # Agent Plugins — one card per package
│       │   │       ├── plugins/          # PluginCard, InstallPluginForm (GitHub / folder / zip)
│       │   │       ├── AgentsTab.tsx
│       │   │       ├── ShortcutsTab.tsx
│       │   │       └── AboutTab.tsx
│       │   ├── Projects/
│       │   │   ├── ProjectsView.tsx     # Projects list
│       │   │   └── ProjectDetail.tsx    # Project detail + chat list
│       │   ├── Artifacts/
│       │   │   ├── ArtifactCard.tsx     # present_files card — icon/kind + "Download and open"
│       │   │   ├── ArtifactsSidePanel.tsx
│       │   │   ├── ArtifactViews.tsx    # Render/Code views incl. Office→PDF preview iframe
│       │   │   ├── FilesPanel.tsx
│       │   │   └── WidgetView.tsx       # show_widget HTML/SVG renderer (sandboxed iframe)
│       │   ├── Skills/
│       │   │   └── SkillsManager.tsx    # Master-detail; mobile swaps list↔detail full-screen
│       │   ├── ToolCalls/
│       │   │   └── UserQuestionCard.tsx # ask_user tool — inline question UI
│       │   ├── Usage/
│       │   │   └── UsageDashboardPage.tsx # Token/cost dashboard — summary, by-model, breakdown, daily chart, top chats
│       │   ├── Onboarding/
│       │   │   ├── OnboardingWizard.tsx
│       │   │   ├── EnvironmentStep.tsx
│       │   │   └── DependencyCard.tsx
│       │   ├── Sidebar.tsx          # Left nav — Astryx SideNav; chat list, pin/unpin, update banner
│       │   ├── LibraryPage.tsx      # Chats | Files tab switcher over a shared search box
│       │   ├── AllChatsPage.tsx     # All chats grid with search/sort (rendered inside LibraryPage)
│       │   ├── FilesGalleryPage.tsx # Gallery of all uploaded files (rendered inside LibraryPage)
│       │   ├── GlobalDropZone.tsx   # App-wide file drop handler
│       │   └── ErrorBoundary.tsx
│       ├── types/
│       │   ├── chat.ts         # ChatSession, ChatNode, UserNode, AssistantNode, MessageUsage
│       │   ├── tool-call.ts    # ToolCall, ProcessStep
│       │   ├── artifact.ts     # LiveFile
│       │   ├── project.ts      # Project
│       │   ├── agent.ts        # Agent persona
│       │   └── plugin.ts       # Agent Plugin + its skills, servers and load issues
│       ├── i18n/
│       │   ├── index.ts
│       │   ├── languages.ts
│       │   └── locales/en/ ru/
│       ├── styles/              # astryx-setup.css (theme import) + global.css (legacy-name → --color-* token bridge) + per-screen CSS
│       └── utils/
│           ├── apiBase.ts          # API_BASE/token, installApiAuth(), withToken(), disconnect events
│           ├── serverMode.ts       # Server-mode toggle — the one writer of BOTH the localStorage override and the shell's flag file
│           ├── backendScope.ts     # scopedKey() — namespaces localStorage lists that hold backend-owned chat ids
│           ├── tauri.ts            # isTauri()/isAndroidTauri() detection
│           ├── downloadAndOpen.ts  # Blob-download fallback (browser/Android): fs write + OS "open with" on desktop
│           ├── saveFileAs.ts       # Desktop-only OS "Save As" dialog (Tauri save_file_as command)
│           ├── formatTime.ts       # Locale-aware time formatting
│           ├── parseArtifacts.ts   # Artifact extraction (support path)
│           ├── presentedFiles.ts   # Files surfaced via present_files tool
│           ├── collectAllFiles.ts  # Aggregate file cards from tool calls
│           ├── toolIcons.tsx       # Icon map for tool calls + file-ext icon/kind
│           ├── toolActivity.ts     # Reads the model-authored `activity` label off a tool call
│           ├── safeJson.ts         # Safe JSON parse/stringify
│           ├── notify.ts           # Desktop notifications
│           ├── openExternal.ts     # Open URLs in OS browser
│           ├── mentions.ts         # @mention parsing (Astryx ChatComposerInput trigger source)
│           ├── mcpName.ts          # MCP server display-name helpers
│           ├── mcpStatus.ts        # MCP state → StatusDot variant/label (settings + composer share it)
│           ├── research.ts         # Research report/event helpers
│           ├── imageGen.ts         # image_generate tool_progress → card state (mirrors images/progress.py)
│           ├── verification.ts     # math_verify tool_progress → badge state (mirrors mathkit/progress.py)
│           ├── mathPlot.ts         # math_plot tool_progress → plot card state
│           ├── widgetTheme.ts      # Resolves app design tokens into a show_widget iframe's <style> block
│           ├── zoom.ts             # UI zoom level handling
│           ├── chatModes.ts        # Composer mode ids + labels — mirrors backend/agent/modes.py
│           ├── greetings.ts        # Welcome-screen greeting (revealed by clicking the ghost); applyName() is the pure half
│           ├── frontmatter.ts      # Markdown frontmatter parsing
│           ├── getLang.ts          # Syntax-highlighter language detection
│           ├── basename.ts         # Path basename helper
│           ├── latexExtract.ts     # Lifts $…$/$$…$$/\[…\] OUT before Astryx parses — it eats backslashes as escapes
│           ├── latexPlugins.tsx    # KaTeX render of the sentinels latexExtract left behind
│           └── updater.ts          # Tauri auto-updater
│
├── src-tauri/                  # Tauri shell — Rust
│   ├── src/
│   │   ├── main.rs             # Desktop entry point — calls lib::run()
│   │   ├── lib.rs              # Shared run() — plugin registration, shared by desktop+mobile
│   │   ├── desktop_backend.rs  # Sidecar spawn/supervise/restart (desktop only)
│   │   └── server_mode.rs      # Reads server-mode.json before the webview exists — suppresses the sidecar
│   └── capabilities/
│       ├── default.json            # Core permissions, all platforms
│       ├── desktop-downloads.json  # fs:allow-download-write — desktop only
│       └── mobile.json             # Barcode-scanner permissions — android/iOS only
├── skills/                     # Bundled skills shipped in the repo (office four + agentchat + math)
├── scripts/                    # build-backend.ps1/.sh + install-server.sh (VDS deployment)
├── tests/                      # All tests
│   ├── backend/                # pytest — agent loop, tools, sandbox, streaming, research, ...
│   └── ui/                     # `node tests/ui/run.mjs` — tsc-compiled suites run by Node; stubs/ replaces modules needing ui/ runtime
└── docs/                       # Analysis reports
```

---

## Key Data Flows

### Message send (the core loop)
```
ChatInput.handleSend()
  → App.handleSend()
    → useChats.sendMessage()
      → sseConnect(POST /api/chat)
        → api/chat.py: chat() — builds AgentLoop via build_tool_registry()
          → AgentLoop.run_stream() — yields SSE events
            → tool calls → ToolRegistry.execute()
              → write_file / edit_file / present_files / bash / read_file / ...
          → finally: touch_chat(chat_id)
        → SSE events → useChats.makeEventHandler()
          → updates sessions tree (variants, tool calls, presented files)
```

### Chat persistence
```
Frontend debounce (1500ms) → PUT /api/chats/{id} → chat_store.update_chat()
  (saves full tree: messages + variants + branches)
Backend post-stream → chat_store.touch_chat(chat_id)
  (lightweight timestamp update — safety net)
```

### Settings flow
```
App.tsx holds settings state (model, theme, userName, ...)
  ↓ SettingsContext.Provider
SettingsPanel consumes context
  → updateSettings(partial) → PUT /api/settings → refreshSettings()
App.handleModelChange → updateSettings({ default_model }) → context syncs all
```

---

## Code Review Checklist

- [ ] No `any` in TypeScript files
- [ ] All Python functions have parameter and return type hints
- [ ] Pydantic models used for all API contracts
- [ ] Single responsibility per module
- [ ] No commented-out code
- [ ] No hardcoded secrets or keys

---

## Agent Plugins — a plugin is a virtual source

AgentChat is a conformant [Agent Plugins 1.0.0](https://agent-plugins.org/specification)
client: it loads a package (`plugin.json` + `skills/` + `mcp.json`), runs both
component types, and reports what it refused. Four things hold it up, and each
has a plausible-looking alternative that breaks something.

**Nothing is copied out of a plugin.** The registry loads packages in place and
*derives* `SkillEntry`s and `MCPServerConfig`s from them on every rebuild. The
obvious alternative — copy the skills into `~/.agents/skills/` and write the
servers into `settings.json` on install — makes uninstall a two-sided undo, lets
an update clobber a file the user edited, and turns a plugin's server into
something indistinguishable from one they configured. Here, uninstalling is
"delete the directory and rebuild". `api/mcp_sources.py` is the one place that
knows the full server set; a plugin's server is read-only over `/api/mcp` and
its write routes 400 by design.

**Failure isolation is the shape of the code, not a `try` at the top.** §11.3
draws three separate boundaries: a rejected manifest costs one plugin, a bad
`mcp.json` costs one plugin's MCP (never its skills), and a bad entry costs one
server. Every refusal becomes a `PluginIssue` rather than a log line, because
the spec's "MUST skip" without its "SHOULD report" makes a broken component
indistinguishable from one that was never there.

**Discovery inside a plugin stops at the immediate children of `skills/`.**
`AgentSkillsReader` walks a whole tree — correct for `~/.agents/skills/`, which
people nest by hand, and wrong here: a plugin shipping an example `SKILL.md`
under `references/` would otherwise install a skill it never declared. That is
why `plugins/skill_discovery.py` exists instead of pointing the reader at a
second root.

**`${PLUGIN_ROOT}` and `${PLUGIN_DATA}` are the only expansion, in three fields
only.** One non-recursive pass over `args`, `env` *values* and `cwd`; `command`
is exempt and stays the literal token it was written as; every other
placeholder-looking string stays literal, so a plugin cannot read the backend's
environment by writing `${OPENAI_API_KEY}`. An entry that sets either reserved
name in its own `env` is invalid, which is what lets the client set them last
without a collision check.

**The model is told a plugin is a plugin.** Merging a plugin's skills into the
shared index and stopping there produced a skill the model could use but could
not place: no way to say where it came from, no way to find the README beside
it, no idea the concept existed. So provenance rides on the skill line
(`skills/reader.py::_describe`), `PluginRegistry.render_prompt()` adds the
roster with each package's components and directory, and the `plugins` prompt
module explains the concept — gated on `has_plugins`, because an install with
none should not be taught what one is.

Three consequences worth knowing:

- Packages live in `~/.agents/plugins/`, **not** under `AGENTS_DIR`, because
  that tree is in `get_allowed_read_prefixes()` — a plugin's skill is useless if
  the model cannot read the `references/` beside it. `PLUGIN_DATA` is a
  *sibling* (`~/.agents/plugin-data/<name>/`), never nested, since an update
  replaces the package directory wholesale and that state has to survive it.
- Only the *disabled* set is persisted (`settings.json` → `plugins.disabled`),
  so a freshly installed plugin is live without a write, and disabling one that
  is not installed still sticks — a re-install cannot silently come back on.
  Toggling a plugin touches no directory the skills reader watches, which is why
  `PluginRegistry.apply_to_reader()` exists and why every mutation route calls it.
- The roster is appended by the loop (`AgentLoop.set_plugins`), *after* the
  skills manifest and — unlike it — ungated by `read_skill`: a plugin's MCP
  servers and package directory still mean something to an agent that cannot
  read skills. It shares the usage dashboard's `skills` token bucket on
  purpose; a few hundred bytes does not earn its own column.

`tests/backend/test_plugins_{manifest,discovery,mcp,registry,installer}.py`
mirror the spec's Appendix A conformance checklist; they are not tests to
"simplify" by relaxing a MUST.

---

## The verification contour (`math_verify`)

`math_verify` is in the **base** tool set, not just the maths preset: a
machine-checked answer is worth having wherever one is produced. Four invariants
hold it up, and each has a failure mode that looks like success.

**The verifier never sees the solution.** `VerifyJob` carries the problem and the
claim and has no field reasoning could arrive through. A checker handed the
working reliably agrees with it, error included — a green badge that means
nothing. Independence here is structural, not a promise in a prompt.

**Checks run backwards.** Roots go back into the equation; an antiderivative is
*differentiated*; a probability is checked against a Monte Carlo run the model
supplies. Re-deriving would repeat whatever method produced the answer, mistake
and all, and the two would agree.

**The five statuses are not interchangeable.** `verified` / `refuted` / `partial`
/ `inconclusive` / `error`. `error` means the *checker* failed and says nothing
about the answer — read as `refuted`, it makes the agent rewrite a correct
solution, the costliest outcome the design can produce. `inconclusive` drawn
like `verified` turns the badge into a light that is always on. The UI separates
all five on icon, colour **and** border style; `tests/backend/test_mathkit_verify.py`
and `tests/ui/src/verification.ts` pin the semantics.

**One automatic rewrite, never two** (`tools/math_verify.py`). A refuted claim
earns exactly one retry, counted per claim rather than per message, and both
attempts stay visible. Hiding the failed first pass is how the badge becomes
theatre.

Two consequences worth knowing:

- The engine runs in a **child process** (`mathkit/runner.py`), because `simplify`
  on a pathological expression cannot be interrupted and Windows has no
  `SIGALRM`. Workers are kept warm — sympy costs seconds to import, and the pool
  is what lets a base-set tool answer in milliseconds. A timeout kills and
  replaces the worker rather than waiting for it.
- The verdict is persisted **on the tool call**, which the chat tree already
  saves; `store/verification_store.py` is a separate cross-chat history, not the
  source the badge renders from. Chats are one JSON blob with no per-message
  rows, so there is nothing for a foreign key to point at.

---

## Freezing a turn instead of failing it (`retry.py`)

A provider that drops the socket used to end the turn: the `error` event went
out, the composer came back, and everything the model had already done — the
files it read, the commands it ran, the half-written answer — was rubbish. Now
the loop **freezes** instead. `self.messages` is untouched, so nothing re-runs;
only the one call to the provider is made again, up to `AgentConfig.max_retries`
times (10 by default, 3 for research agents, whose round has its own timeout).

Three rules hold it up.

**"Do not retry" is the default.** `retry.is_retryable` only says yes to
failures it can name as transient — 429, 5xx, the socket-shaped exceptions.
A rejected key, a 400 or an over-long prompt fails at once, because ten waits
of up to thirty seconds cannot make any of them true. An unrecognised
exception — a bug of ours — is fatal for the same reason.

**A retried attempt is un-said first.** `pass_start` marks the client's rewind
point, `pass_rewind` takes the abandoned attempt's tokens, thoughts and
half-streamed tool rows back out (`useChats/tree.ts`), `stream_retry` carries
the countdown and `stream_resume` clears it. Skipping the rewind is what makes
the model appear to stutter: half an answer, then the whole answer under it.
`tool_start` is emitted while arguments are still streaming
(`agent/tool_stream.py`), so a rewind that only trimmed text would leave a tool
row stuck at "running" forever.

**The wait is not silent.** `_sleep_with_heartbeat` breaks the backoff into
5-second steps and emits `ping`, because an idle SSE response is one a reverse
proxy may cut — and because a single long `await` would ignore Stop until it
expired.

`is_retryable` decides *whether* to try again; `looks_like_lost_connection`
decides *what to say*. They disagree exactly where it matters: litellm gives a
refused connection a status of 500, so classifying by the number alone tells a
user whose LM Studio is not running that their provider is having an outage.
`tests/backend/test_agent_retry.py` and `tests/ui/src/stream_rewind.ts` pin all
of the above.

---

## Server mode (backend on a VDS/VPS)

The backend runs on a server; the PC, laptop and phone are clients pointed at it
(Settings → Remote → Server mode). Because every tool call executes in the
backend process, the agent's shell, files and sandbox are then the **server's** —
which is the entire point, and also why the token is as sensitive as an SSH key.

```sh
curl -fsSL <raw>/scripts/install-server.sh | sudo bash -s -- --domain chat.example.com
```

The installer clones to `/opt/agentchat`, builds a venv and `ui/dist`, creates
the `agentchat` user with `/var/lib/agentchat` as its home (so per-chat working
folders land under the install's own state), writes `/etc/agentchat/agentchat.env`
0600, installs a systemd unit, and — given `--domain` — puts Caddy in front for
automatic TLS. `--update` re-pulls and restarts.

### The one invariant

**`AGENTCHAT_SERVER_MODE=1` turns OFF the loopback exemption in the `/api/*`
guard.** A desktop backend exempts loopback because that *is* the local app
talking to its own sidecar. Behind a reverse proxy every request arrives from
127.0.0.1, so keeping the exemption would serve the whole internet an
unauthenticated shell on the box. `tests/backend/test_server_mode.py` pins this;
it is not a test to "fix" by relaxing.

Consequences worth knowing:

- The token comes from `AGENTCHAT_REMOTE_TOKEN`, or a 0600 `server-token` file in
  the data dir if unset — never from settings.json, which has no keychain to
  protect it on a headless host.
- `/api/remote-access` (the pairing QR + token) **404s** in server mode: there is
  no caller the backend can still identify as local.
- `AGENTCHAT_HOST` defaults to `127.0.0.1` here, on the assumption of a proxy.
  The installer sets `0.0.0.0` explicitly when run without `--domain`.
- `AGENTCHAT_DATA_DIR` (which the installer always sets) also disables the OS
  keychain, so provider keys land in a 0600 file — correct for headless.

### Client side

`utils/serverMode.ts` is the only writer of both stores that have to agree: the
localStorage override (read synchronously by `apiBase` as the module graph
loads) and `server-mode.json` in the Tauri config dir (read by `lib.rs` *before*
the webview exists, to skip spawning the sidecar). Neither is derivable from the
other at the moment it is needed. If the remote host goes dark, the reconnect
overlay carries a "use the backend on this computer" escape — without it a
desktop in server mode has no reachable Settings to undo it from.

---

## Local builds (offline, no CI)

The UI is **bundled at build time** into both the desktop app and the APK — neither
fetches its design at runtime. So **any UI change requires rebuilding `ui/dist`
first** (`npm run build --prefix ui`), then rebuilding whichever app you want.
There is no `beforeBuildCommand`, so `tauri build` will NOT rebuild the UI for you.

### Desktop (Windows: exe + msi + nsis)

Run **all three** steps in order — skipping the backend step ships a *stale*
sidecar:

```powershell
npm run build --prefix ui            # 1. UI → ui/dist
.\scripts\build-backend.ps1          # 2. Python backend → src-tauri/binaries/agentchat-backend-*.exe (PyInstaller)
cd src-tauri ; cargo tauri build     # 3. desktop app (bundles ui/dist + whatever sidecar is in binaries/)
```

- **Don't forget step 2.** `cargo tauri build` only bundles the sidecar already
  sitting in `src-tauri/binaries/`; it does not rebuild the Python backend.
  Shipping an old sidecar causes silent runtime bugs (e.g. the UI reading a
  status response that predates a new field). `build-backend.ps1` also bundles
  `ui/dist` (for remote/phone serving) and stamps the version from
  `tauri.conf.json` into `_buildstamp.py`.
- Signing/updater secrets are only needed for auto-update artifacts — an offline
  test build doesn't need them.
- Linux is the same three steps with `scripts/build-backend.sh` — but the AppImage
  has real gotchas; see **Linux** below.

### Linux (deb + rpm + AppImage)

Same three steps, POSIX shell:

```sh
npm run build --prefix ui            # 1. UI → ui/dist
./scripts/build-backend.sh           # 2. sidecar → src-tauri/binaries/agentchat-backend-x86_64-unknown-linux-gnu
cd src-tauri && cargo tauri build    # 3. bundles: appimage/ + deb/ + rpm/
```

Build deps (Arch names): `webkit2gtk-4.1 gtk3 libayatana-appindicator librsvg
patchelf openssl base-devel rust nodejs npm`. Debian/Ubuntu use the `-dev`
equivalents (`libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `librsvg2-dev`, …).

- **The AppImage bundles the *build host's* WebKitGTK — and that's a trap.** A
  bundled WebKit older than the *runtime* host's Mesa hard-aborts on EGL init
  (`Could not create default EGL display: EGL_BAD_PARAMETER. Aborting…`), the
  webview process dies, and you get a **blank white window** with no error in the
  UI. So an AppImage built on Ubuntu (WebKit ~2.44) white-screens on Arch /
  CachyOS / Fedora (newer Mesa). The `.deb`/`.rpm` are immune — they link the
  *target's* system WebKit. No `WEBKIT_DISABLE_*` / software-GL env var fixes the
  abort; the only cure is a new-enough bundled WebKit.
- **So the release AppImage is built in an Arch container** (fresh WebKit) — the
  `appimage-arch` job in `release.yml`. Building an AppImage in a container needs
  two env vars: `NO_STRIP=true` (linuxdeploy's bundled `strip` is old binutils and
  chokes on modern libs' `.relr.dyn` / `DT_RELR` section → aborts the whole
  bundle) and `APPIMAGE_EXTRACT_AND_RUN=1` (linuxdeploy/appimagetool are
  themselves AppImages and there's no FUSE in the container).
- **`bundle.artifactName` must NOT be in `tauri.conf.json`.** tauri-cli ≥ 2.11
  rejects it (`Additional properties are not allowed ('artifactName' …)`); older
  CLIs silently ignored it. Bundle filenames come from `productName` + `version`
  regardless (`AgentChat_<version>_amd64.AppImage`, …).

### Android (APK)

The backend is **not** bundled — the APK is a thin client that connects to a
remote backend (URL + token / QR). So no backend step; just UI + the app:

```powershell
npm run build --prefix ui                                  # 1. UI → ui/dist (the APK's design)
cd src-tauri
cargo tauri android build --apk --debug --target aarch64   # 2. arm64 debug APK (auto-signed, sideloadable)
```

Output: `src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk`.

- **To change the phone's design you must rebuild `ui/dist` (step 1) then the
  APK (step 2).** The APK does not pull the UI from the PC; the PC app and the
  APK each carry their own copy. Rebuilding the PC app is not required for the
  phone, and vice versa.
- First-time toolchain (Windows): Android SDK + NDK r26b, `JAVA_HOME`/`ANDROID_HOME`/
  `NDK_HOME` set, the 4 Rust android targets, and **Windows Developer Mode ON**
  (Tauri symlinks the `.so` into `jniLibs`, which Windows blocks otherwise).
- cargo-tauri **ignores `NDK_HOME`** — it scans `ANDROID_HOME\ndk\` and picks the
  highest version. Delete any incomplete NDK version folder (no `source.properties`)
  or it shadows the good one and the build errors / hangs on an "install NDK?" prompt.
- Adding a **new mobile plugin**: put its crate in plain `[dependencies]`, NOT
  `[target.'cfg(mobile)'.dependencies]` — `tauri-build` only discovers plugin
  ACL/permissions from the regular dependency graph, so a target-gated dep makes
  its permissions unresolvable (`Permission <plugin>:allow-… not found`). Keep it
  desktop-safe by registering it only on mobile (`#[cfg(not(desktop))]` in
  lib.rs) and `platforms`-gating its capability. Then run `cargo tauri android
  init` once to regenerate `gen/android` plugin wiring + manifest permissions.

---

## Releases

A release is cut by **pushing a git tag `vX.Y.Z`**. The tag push triggers
`.github/workflows/release.yml`, which builds the UI, the PyInstaller backend
sidecar, and the Tauri app, then publishes a GitHub Release (installers +
auto-updater manifest) plus a portable ZIP — and, from separate jobs, the Arch
AppImage and the Android APK.

Every job builds into a **draft** release; the `publish` job flips it live only
once Windows, Linux, the Arch AppImage and the APK have all landed, so users
never see a half-built release.

**Before tagging, bump `"version"` to the new number (e.g. `1.3.0` → `1.3.2`)
in BOTH files.** They are not kept in sync automatically in the committed tree,
and each is read by something different:

| File | Field | Read by |
|------|-------|---------|
| `ui/package.json` | `"version"` | Settings → About screen, and the "from" version in the update prompt (`pkg.version`). Forgetting this ships an About screen showing the old version. |
| `src-tauri/tauri.conf.json` | `"version"` | The version baked into the app for the auto-updater, and the identity the desktop shell uses to spot a stale backend left on port 8787 (`ctx.package_info().version`). Also makes local `tauri build`s correct. |

Use the same `X.Y.Z` everywhere — the tag is that number prefixed with `v`.
`src-tauri/Cargo.toml`'s version is unused and stays as-is.

### Steps

1. Bump `"version"` in `ui/package.json` **and** `src-tauri/tauri.conf.json` to the new `X.Y.Z`.
2. Commit: `chore(release): vX.Y.Z`.
3. Tag and push:
   ```sh
   git tag vX.Y.Z
   git push origin master --tags
   ```
4. Watch the **Release** workflow on GitHub Actions; the Release and updater
   manifest appear when it finishes.

> CI re-bumps `src-tauri/tauri.conf.json` from the tag at build time, so the
> *published* app matches the tag even if you forget — but `ui/package.json` is
> **never** auto-bumped. Always bump both by hand; don't lean on the CI bump.

### Linux artifacts (two-stage)

`release.yml` builds Windows and Linux in a matrix. The `ubuntu-latest` leg
produces the `.deb` + `.rpm` (fine — they use the target's system WebKit) and,
via `tauri-action`, the `latest.json` updater manifest. A dependent
**`appimage-arch`** job then rebuilds *only* the AppImage in an `archlinux`
container (modern WebKit — see [Local builds → Linux](#linux-deb--rpm--appimage)
for why) and **overwrites** every `*.AppImage` release asset with it via
`gh release upload --clobber`. It reuses the exact sidecar the matrix leg built
(handed over as the `linux-backend-sidecar` workflow artifact) and leaves the
`.deb`/`.rpm`/`.sig`/`latest.json` untouched.

- The `build-linux.yml` smoke-test workflow (manual `workflow_dispatch`) mirrors
  this, uploading the Arch AppImage as the `agentchat-linux-appimage-arch`
  artifact — run it to validate a Linux change before tagging.
- Consequence of not touching `latest.json`: the AppImage's in-app auto-update
  signature stays the ubuntu leg's, so it won't match the Arch AppImage. The
  *download* works; wiring the updater to the Arch signature is a separate step.

### Android artifact (APK)

The **`android`** job builds the thin client and uploads
`agentchat-<version>-android-aarch64.apk` into the draft release. It shares
nothing with the desktop matrix but `ui/dist` — no Python sidecar is built,
because the APK connects to a *remote* backend.

- **It builds the DEBUG apk deliberately.** The generated Gradle project turns
  `usesCleartextTraffic` on only for the debug buildType, and pairing hands the
  phone a plain `http://<lan-ip>:8787` URL (`api/remote.py`) — a release APK
  would refuse that connection and simply never reach the backend. Debug is also
  auto-signed with Gradle's debug keystore, so it sideloads as is. Shipping a
  release APK instead means adding a keystore to repo secrets *and* a cleartext
  opt-in for the release buildType.
- `src-tauri/gen/` is gitignored, so the job runs `tauri android init` to
  scaffold the Gradle project every time — that step is also what wires the
  barcode-scanner plugin's ACL and manifest permissions in.
- The NDK is **pinned to the r26 line and every other NDK on the runner is
  deleted**, because cargo-tauri ignores `NDK_HOME` and takes the highest
  version under `$ANDROID_HOME/ndk` (same gotcha as the local Windows build).
- The job is `continue-on-error: true` — the Android toolchain is the most drift
  prone leg, and a broken APK build must not strand a finished desktop release
  as a permanent draft. **So check the release actually has an `.apk` asset.**
  Remove the flag once the job has proven itself over a few releases.
- `build-android.yml` (manual `workflow_dispatch`) is the smoke test: same
  steps, uploads the APK as the `agentchat-android-apk` workflow artifact
  instead of touching a release.
