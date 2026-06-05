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
│   ├── main.py                 # App factory — composition root
│   ├── run.py                  # Uvicorn entry point
│   ├── paths.py                # Path resolution (data dir, chat dirs)
│   ├── shell.py                # Shell abstraction (WSL/PowerShell/posix)
│   ├── extraction.py           # Content/text extraction utilities
│   ├── api/                    # FastAPI route handlers
│   │   ├── chat.py             # POST /api/chat — SSE streaming (core)
│   │   ├── chats.py            # CRUD /api/chats — session persistence
│   │   ├── config_routes.py    # GET/PUT /api/settings
│   │   ├── files.py            # File upload/download
│   │   ├── skills.py           # Skills install/list/delete
│   │   ├── wsl.py              # WSL detection & management
│   │   ├── health.py           # GET /api/system-status
│   │   ├── models_routes.py    # GET /api/models
│   │   ├── mcp.py              # MCP server management routes
│   │   ├── projects.py         # Projects CRUD
│   │   ├── remote.py           # Remote access (token, toggle, QR)
│   │   ├── searxng.py          # SearXNG proxy
│   │   ├── win_deps.py         # Windows dependency detection
│   │   ├── router.py           # Route assembly
│   │   └── schemas/            # Pydantic request/response models
│   │       ├── chat.py         # ChatRequest, ChatMessage, AttachmentInfo
│   │       ├── mcp.py          # MCP schemas
│   │       ├── settings.py     # Settings schemas
│   │       └── skills.py       # Skills schemas
│   ├── agent/                  # Agent core logic
│   │   ├── loop.py             # AgentLoop — run_stream() is the main path
│   │   ├── config.py           # AgentConfig dataclass
│   │   ├── system_prompt.py    # System prompt builder
│   │   ├── types.py            # Agent event/message types
│   │   ├── sandbox.py          # SandboxPolicy — path access control
│   │   ├── write_file_stream.py # write_file streaming chunk emitter
│   │   └── wsl_exec.py         # WSL command execution helpers
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
│   │   ├── web_search_tool.py  # WebSearchTool
│   │   └── web_fetch_tool.py   # WebFetchTool
│   ├── llm/                    # LLM client layer
│   │   ├── client.py           # LLMClient — wraps LiteLLM
│   │   └── models_fetcher.py   # Fetches available models from providers
│   ├── mcp_integration/        # Model Context Protocol
│   │   ├── client.py           # MCP client (stdio/HTTP)
│   │   ├── config.py           # MCP server config
│   │   ├── manager.py          # MCPManager — server lifecycle
│   │   ├── registry_view.py    # Exposes MCP tools to agent
│   │   └── tool_proxy.py       # Proxies MCP tool calls
│   ├── store/                  # Persistence
│   │   ├── chat_store.py       # SQLite chat storage (upsert, get, touch)
│   │   ├── project_store.py    # SQLite project storage
│   │   └── settings_store.py   # Settings read/write
│   ├── web_search/             # Web search module
│   │   ├── config.py           # Provider config (native/Tavily/SearXNG)
│   │   └── service.py          # WebSearchService — routes to active provider
│   └── skills/                 # Skills system
│       ├── reader.py           # AgentSkillsReader — scans SKILL.md files
│       └── installer.py        # GitHub/archive skill installer
│
├── ui/                         # React + TypeScript frontend
│   └── src/
│       ├── main.tsx            # React entry point
│       ├── App.tsx             # Root component, settings context, layout
│       ├── hooks/
│       │   ├── useChats.ts         # Multi-session chat manager (THE main hook)
│       │   ├── useSSE.ts           # SSE connection helper (sseConnect)
│       │   ├── useAvatar.ts        # Avatar URL management
│       │   ├── useProjects.ts      # Projects data hook
│       │   ├── useShortcuts.ts     # Keyboard shortcut registration
│       │   ├── useAppUpdate.ts     # Auto-update check
│       │   ├── useFileDrop.ts      # File drop handling
│       │   ├── useLongPress.ts     # Long-press gesture
│       │   └── useWindowFileDrag.ts # Window-level drag detection
│       ├── contexts/
│       │   └── SettingsContext.tsx  # Shared settings state (model, theme, etc.)
│       ├── shortcuts/
│       │   └── registry.ts         # Shortcut definitions
│       ├── components/
│       │   ├── Chat/
│       │   │   ├── ChatView.tsx         # Chat column — messages + composer
│       │   │   ├── ChatInput.tsx        # Message composer with file upload
│       │   │   ├── MessageBubble.tsx    # Single message renderer
│       │   │   ├── ModelSelector.tsx    # Model dropdown
│       │   │   ├── CodeBlockView.tsx    # Syntax-highlighted code blocks
│       │   │   ├── MCPChip.tsx          # MCP server indicator chip
│       │   │   ├── MentionNodeView.tsx  # @mention node
│       │   │   ├── MentionPopup.tsx     # @mention autocomplete
│       │   │   ├── WebSearchControl.tsx # Web search toggle
│       │   │   ├── WebSearchMenuSection.tsx
│       │   │   └── SupportCard.tsx
│       │   ├── Settings/
│       │   │   ├── SettingsPanel.tsx    # Shell — nav, tab routing, state
│       │   │   ├── RestartBackendButton.tsx
│       │   │   └── tabs/
│       │   │       ├── MainTab.tsx
│       │   │       ├── ProvidersTab.tsx
│       │   │       ├── ModelsTab.tsx
│       │   │       ├── PathsTab.tsx
│       │   │       ├── MCPTab.tsx
│       │   │       ├── ShortcutsTab.tsx
│       │   │       └── AboutTab.tsx
│       │   ├── Projects/
│       │   │   ├── ProjectsView.tsx     # Projects list
│       │   │   └── ProjectDetail.tsx    # Project detail + chat list
│       │   ├── Artifacts/
│       │   │   ├── ArtifactCard.tsx
│       │   │   ├── ArtifactsSidePanel.tsx
│       │   │   ├── ArtifactViews.tsx
│       │   │   ├── FilePreviewPanel.tsx
│       │   │   └── FilesPanel.tsx
│       │   ├── Skills/
│       │   │   └── SkillsManager.tsx
│       │   ├── ToolCalls/
│       │   │   └── ToolCallBlock.tsx
│       │   ├── Onboarding/
│       │   │   └── OnboardingWizard.tsx
│       │   ├── Markdown/
│       │   │   └── Markdown.tsx
│       │   ├── Sidebar.tsx          # Left nav — chat list + navigation
│       │   ├── AllChatsPage.tsx     # All chats grid with search/sort
│       │   ├── FilesGalleryPage.tsx # Gallery of all uploaded files
│       │   ├── GhostChat.tsx        # Empty/placeholder chat state
│       │   ├── GlobalDropZone.tsx   # App-wide file drop handler
│       │   └── ErrorBoundary.tsx
│       ├── types/
│       │   ├── chat.ts         # ChatSession, ChatNode, UserNode, AssistantNode
│       │   ├── tool-call.ts    # ToolCall, ProcessStep
│       │   ├── artifact.ts     # LiveFile
│       │   └── project.ts      # Project
│       ├── i18n/
│       │   ├── index.ts
│       │   ├── languages.ts
│       │   └── locales/en/ ru/
│       └── utils/
│           ├── apiBase.ts          # API_BASE detection (Tauri vs dev proxy)
│           ├── tauri.ts            # isTauri() detection
│           ├── formatTime.ts       # Locale-aware time formatting
│           ├── parseArtifacts.ts   # Artifact extraction (support path)
│           ├── presentedFiles.ts   # Files surfaced via present_files tool
│           ├── collectAllFiles.ts  # Aggregate file cards from tool calls
│           ├── toolIcons.tsx       # Icon map for tool calls
│           ├── safeJson.ts         # Safe JSON parse/stringify
│           ├── notify.ts           # Desktop notifications
│           ├── openExternal.ts     # Open URLs in OS browser
│           ├── mentions.ts         # @mention parsing
│           ├── parseCodeBlocks.ts  # Code block extraction
│           ├── parseMath.ts        # Math expression parsing
│           ├── renderMath.ts       # Math rendering
│           └── updater.ts          # Tauri auto-updater
│
├── src-tauri/                  # Tauri shell — Rust
│   └── src/main.rs             # Window, sidecar spawn, auto-update
├── skills/                     # Installed skills directory
├── tests/                      # All tests
│   └── backend/
│       ├── test_agent_loop.py
│       ├── test_chat_history.py
│       ├── test_chat_purge.py
│       ├── test_remote_access.py
│       ├── test_sandbox_policy.py
│       ├── test_tool_call_streaming.py
│       └── test_tools.py
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
