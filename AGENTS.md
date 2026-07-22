# AGENTS.md — Coding Standards & Project Map

## General

- One module = one responsibility

## TypeScript (UI)

- Strict mode enabled (`strict: true` in tsconfig.json)
- `noUncheckedIndexedAccess: true`
- Zero `any` — use `unknown` with type guards instead
- All component props must have explicit interfaces (no inline `{}`)
- Functional components and hooks only (no class components)
- Named exports only (no `export default`)

## Python (Backend)

- Type hints on all function signatures and class attributes
- Pydantic models for all data structures crossing module boundaries
- `async`/`await` for all I/O operations
- Black formatting: 100 char line length, double quotes
- Ruff for linting (replaces isort, flake8, pyupgrade)
- `from __future__ import annotations` at top of each file

---

## Project Structure

```
AgentChat/
├── backend/                    # Python — FastAPI + agent loop
│   ├── main.py                 # App factory — composition root; remote-access guard middleware
│   ├── run.py                  # Uvicorn entry point
│   ├── paths.py                # Path resolution (data dir, chat dirs)
│   ├── shell.py                # Shell abstraction (WSL/PowerShell/posix)
│   ├── extraction.py           # Content/text extraction utilities
│   ├── _buildstamp.py          # Version stamped in by build-backend.ps1/.sh
│   ├── api/                    # FastAPI route handlers
│   │   ├── chat.py             # POST /api/chat — SSE streaming (core)
│   │   ├── chats.py            # CRUD /api/chats — session persistence
│   │   ├── settings.py         # GET/PUT /api/settings
│   │   ├── files.py            # File upload/download/serve/preview (Office→PDF)
│   │   ├── skills.py           # Skills install/list/delete
│   │   ├── wsl.py              # WSL detection & management
│   │   ├── health.py           # GET /api/system-status
│   │   ├── models_routes.py    # GET /api/models
│   │   ├── mcp.py              # MCP server management routes
│   │   ├── projects.py         # Projects CRUD
│   │   ├── agents.py           # Agent-persona CRUD (name, gradient avatar, system-prompt override)
│   │   ├── remote.py           # Remote access (token, toggle, QR)
│   │   ├── searxng.py          # SearXNG proxy
│   │   ├── win_deps.py         # Windows dependency detection
│   │   ├── config_routes.py    # GET /api/config/* — runtime capability probes for the UI
│   │   ├── usage.py            # GET /api/usage/* — token/cost dashboard queries
│   │   ├── router.py           # Route assembly
│   │   └── schemas/            # Pydantic request/response models
│   │       ├── chat.py         # ChatRequest, ChatMessage, AttachmentInfo
│   │       ├── mcp.py          # MCP schemas
│   │       ├── settings.py     # Settings schemas
│   │       ├── skills.py       # Skills schemas
│   │       └── agents.py       # Agent-persona schemas
│   ├── agent/                  # Agent core logic
│   │   ├── loop.py             # AgentLoop — run_stream() is the main path
│   │   ├── config.py           # AgentConfig dataclass
│   │   ├── system_prompt.py    # System prompt builder
│   │   ├── types.py            # Agent event/message types
│   │   ├── sandbox.py          # SandboxPolicy — path access control
│   │   ├── write_file_stream.py # write_file streaming chunk emitter
│   │   ├── wsl_exec.py         # WSL/posix/PowerShell command execution hub
│   │   ├── reasoning_split.py  # Splits model output into thinking/text
│   │   ├── research_prompt.py  # System prompt for the research sub-agent
│   │   └── research_runner.py  # Drives a nested AgentLoop for the research tool
│   ├── tools/                  # Tool implementations (agent-callable)
│   │   ├── base.py             # BaseTool ABC
│   │   ├── registry.py         # ToolRegistry — register/execute tools
│   │   ├── factory.py          # build_tool_registry() — per-request assembly
│   │   ├── bash_tool.py        # BashTool — shell command execution
│   │   ├── read_file.py        # ReadFileTool
│   │   ├── write_file.py       # WriteFileTool — canonical file write path
│   │   ├── edit_file.py        # EditFileTool — in-place file edits
│   │   ├── present_files.py    # PresentFilesTool — surfaces files as cards
│   │   ├── read_skill.py       # ReadSkillTool — reads SKILL.md
│   │   ├── read_photo.py       # ReadPhotoTool — image content extraction
│   │   ├── ask_user.py         # AskUserTool — pauses the turn for user input
│   │   ├── research_tool.py    # ResearchTool — wraps research_runner
│   │   ├── show_widget.py      # ShowWidgetTool — inline HTML/SVG visualizations
│   │   ├── web_search_tool.py  # WebSearchTool
│   │   └── web_fetch_tool.py   # WebFetchTool
│   ├── llm/                    # LLM client layer
│   │   ├── client.py           # LLMClient — wraps LiteLLM
│   │   ├── model_tag.py        # Re-tags custom/OpenAI-compatible model ids
│   │   ├── models_fetcher.py   # Fetches available models from providers
│   │   ├── usage_logging.py    # litellm.callbacks hook — writes one usage_log row per LLM call
│   │   └── token_breakdown.py  # Local estimate of where prompt tokens went (system/tools/history/...)
│   ├── mcp_integration/        # Model Context Protocol
│   │   ├── client.py           # MCP client (stdio/HTTP)
│   │   ├── config.py           # MCP server config
│   │   ├── manager.py          # MCPManager — server lifecycle
│   │   ├── registry_view.py    # Exposes MCP tools to agent
│   │   └── tool_proxy.py       # Proxies MCP tool calls
│   ├── store/                  # Persistence
│   │   ├── chat_store.py       # SQLite chat storage (upsert, get, touch)
│   │   ├── project_store.py    # SQLite project storage
│   │   ├── settings_store.py   # Settings read/write
│   │   └── usage_store.py      # SQLite usage/cost log (usage_log + model_pricing tables)
│   ├── web_search/             # Web search module
│   │   ├── config.py           # Provider config (native/Tavily/SearXNG)
│   │   └── service.py          # WebSearchService — routes to active provider
│   └── skills/                 # Skills system
│       ├── reader.py           # AgentSkillsReader — scans SKILL.md files
│       ├── installer.py        # GitHub/archive skill installer
│       └── catalog.py          # Curated Anthropic skill catalog (docx/xlsx/pptx/pdf/...)
│
├── ui/                         # React + TypeScript frontend, on Meta's Astryx design system
│   └── src/
│       ├── main.tsx            # React entry point; also routes ?debug-* query params to the harnesses below
│       ├── App.tsx             # Root component, settings context, layout (Astryx AppShell/Theme)
│       ├── Debug{Composer,Update,Usage}Harness.tsx # Dev-only presentation harnesses (?debug-composer/-update/-usage) — render one component tree in isolation against fabricated props for visual verification without a live backend
│       ├── hooks/
│       │   ├── useChats/           # Multi-session chat manager (THE main hook)
│       │   │   ├── index.ts        # useChats() — composes the pieces below
│       │   │   ├── api.ts          # backend chat CRUD + localStorage→backend migration
│       │   │   ├── tree.ts         # pure chat-tree helpers (branches, variants)
│       │   │   ├── persistence.ts  # localStorage load/save + legacy-tree migration + pinned-chat ids
│       │   │   └── easterEgg.ts    # Ghost Chat easter-egg lore injection
│       │   ├── useSSE.ts           # SSE connection helper (sseConnect)
│       │   ├── useAvatar.ts        # Avatar URL management
│       │   ├── useProjects.ts      # Projects data hook
│       │   ├── useAgents.ts        # Agent-persona CRUD hook (mirrors useProjects)
│       │   ├── useShortcuts.ts     # Keyboard shortcut registration
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
│       │   │   ├── CodeBlockView.tsx    # Syntax-highlighted code blocks
│       │   │   ├── MCPChip.tsx          # MCP indicator chip + composer "Connectors" row
│       │   │   ├── WebSearchControl.tsx # Web search toggle
│       │   │   ├── WebSearchMenuSection.tsx # Composer "+" menu — web search toggle/mode
│       │   │   ├── ResearchMenuSection.tsx  # Composer "+" menu — research toggle
│       │   │   ├── ResearchCard.tsx     # Research tool-call summary card
│       │   │   ├── ResearchPanel.tsx    # Research report side panel
│       │   │   ├── SourcesBox.tsx       # Web-search/research source list
│       │   │   └── SupportCard.tsx
│       │   ├── Mobile/
│       │   │   └── MobileConnect.tsx    # Backend connect/reconnect screen (APK + PWA)
│       │   ├── BottomSheet.tsx      # Generic mobile bottom-sheet primitive (drag handle)
│       │   ├── AgentAvatar.tsx      # Gradient agent avatar — wraps Astryx Avatar, snaps to its pixel size scale
│       │   ├── Settings/
│       │   │   ├── SettingsPanel.tsx    # Shell — nav, tab routing, state
│       │   │   ├── RestartBackendButton.tsx
│       │   │   └── tabs/
│       │   │       ├── ProfileTab.tsx
│       │   │       ├── AppearanceTab.tsx
│       │   │       ├── TerminalTab.tsx
│       │   │       ├── SandboxTab.tsx
│       │   │       ├── ProvidersTab.tsx
│       │   │       ├── ModelsTab.tsx
│       │   │       ├── PathsTab.tsx
│       │   │       ├── MCPTab.tsx
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
│       │   ├── GhostChat.tsx        # Empty/placeholder chat state
│       │   ├── GlobalDropZone.tsx   # App-wide file drop handler
│       │   └── ErrorBoundary.tsx
│       ├── types/
│       │   ├── chat.ts         # ChatSession, ChatNode, UserNode, AssistantNode, MessageUsage
│       │   ├── tool-call.ts    # ToolCall, ProcessStep
│       │   ├── artifact.ts     # LiveFile
│       │   ├── project.ts      # Project
│       │   └── agent.ts        # Agent persona
│       ├── i18n/
│       │   ├── index.ts
│       │   ├── languages.ts
│       │   └── locales/en/ ru/
│       ├── styles/              # astryx-setup.css (theme import) + global.css (legacy-name → --color-* token bridge) + per-screen CSS
│       └── utils/
│           ├── apiBase.ts          # API_BASE/token, installApiAuth(), withToken(), disconnect events
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
│           ├── research.ts         # Research report/event helpers
│           ├── widgetTheme.ts      # Resolves app design tokens into a show_widget iframe's <style> block
│           ├── zoom.ts             # UI zoom level handling
│           ├── greetings.ts        # Welcome-screen greeting copy
│           ├── frontmatter.ts      # Markdown frontmatter parsing
│           ├── getLang.ts          # Syntax-highlighter language detection
│           ├── basename.ts         # Path basename helper
│           ├── parseCodeBlocks.ts  # Code block extraction
│           ├── latexPlugins.tsx    # KaTeX inlinePlugins for Astryx's <Markdown/> (no built-in math support)
│           └── updater.ts          # Tauri auto-updater
│
├── src-tauri/                  # Tauri shell — Rust
│   ├── src/
│   │   ├── main.rs             # Desktop entry point — calls lib::run()
│   │   ├── lib.rs              # Shared run() — plugin registration, shared by desktop+mobile
│   │   └── desktop_backend.rs  # Sidecar spawn/supervise/restart (desktop only)
│   └── capabilities/
│       ├── default.json            # Core permissions, all platforms
│       ├── desktop-downloads.json  # fs:allow-download-write — desktop only
│       └── mobile.json             # Barcode-scanner permissions — android/iOS only
├── skills/                     # Bundled skills shipped in the repo (office four + agentchat)
├── tests/                      # All tests
│   └── backend/                # pytest — agent loop, tools, sandbox, streaming, research, ...
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
auto-updater manifest) plus a portable ZIP.

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
