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
│   ├── main.py                 # App factory, settings store, startup
│   ├── run.py                  # Uvicorn entry point
│   ├── api/                    # FastAPI route handlers
│   │   ├── chat.py             # POST /api/chat — SSE streaming endpoint (core)
│   │   ├── chats.py            # CRUD /api/chats — session persistence
│   │   ├── settings.py         # GET/PUT /api/settings
│   │   ├── files.py            # File upload/download
│   │   ├── skills.py           # Skills install/list/delete
│   │   ├── wsl.py              # WSL detection & management
│   │   ├── health.py           # GET /api/system-status
│   │   ├── models_routes.py    # GET /api/models
│   │   └── schemas/            # Pydantic request/response models
│   │       └── chat.py         # ChatRequest, ChatMessage, AttachmentInfo
│   ├── agent/                  # Agent core logic
│   │   ├── loop.py             # AgentLoop — run_stream() is the main path
│   │   ├── config.py           # AgentConfig dataclass
│   │   ├── file_tag_interceptor.py  # <file> and <edit> tag streaming parser
│   │   ├── sandbox.py          # SandboxPolicy — path access control
│   │   ├── write_file_stream.py # write_file streaming chunk emitter
│   │   └── wsl_exec.py         # WSL command execution helpers
│   ├── tools/                  # Tool implementations (agent-callable)
│   │   ├── base.py             # BaseTool ABC
│   │   ├── registry.py         # ToolRegistry — register/execute tools
│   │   ├── bash_tool.py        # BashTool — shell command execution
│   │   ├── read_file.py        # ReadFileTool
│   │   ├── write_file.py       # WriteFileTool — canonical file write path
│   │   └── read_skill.py       # ReadSkillTool — reads SKILL.md
│   ├── llm/                    # LLM client layer
│   │   ├── client.py           # LLMClient — wraps LiteLLM
│   │   └── models_fetcher.py   # Fetches available models from providers
│   ├── store/                  # Persistence
│   │   └── chat_store.py       # SQLite chat storage (upsert, get, touch)
│   └── skills/                 # Skills system
│       ├── reader.py           # AgentSkillsReader — scans SKILL.md files
│       └── installer.py        # GitHub/archive skill installer
│
├── ui/                         # React + TypeScript frontend
│   └── src/
│       ├── main.tsx            # React entry point
│       ├── App.tsx             # Root component, settings context, layout
│       ├── hooks/
│       │   ├── useChats.ts     # Multi-session chat manager (THE main hook)
│       │   ├── useSSE.ts       # SSE connection helper (sseConnect)
│       │   └── useAvatar.ts    # Avatar URL management
│       ├── contexts/
│       │   └── SettingsContext.tsx  # Shared settings state (model, theme, etc.)
│       ├── components/
│       │   ├── Chat/
│       │   │   ├── ChatView.tsx     # Chat column — messages + composer
│       │   │   ├── ChatInput.tsx    # Message composer with file upload
│       │   │   ├── MessageBubble.tsx # Single message renderer
│       │   │   ├── ModelSelector.tsx # Model dropdown
│       │   │   └── CodeBlockView.tsx # Syntax-highlighted code blocks
│       │   ├── Settings/              # Settings panel
│       │   │   ├── SettingsPanel.tsx  # Shell — nav, tab routing, state
│       │   │   └── tabs/              # Per-tab components
│       │   ├── Sidebar.tsx          # Left nav — chat list + navigation
│       │   ├── AllChatsPage.tsx     # All chats grid with search/sort
│       │   ├── Skills/              # Skills manager UI
│       │   ├── Onboarding/          # First-run wizard
│       │   ├── Artifacts/           # File preview panels
│       │   ├── GlobalDropZone.tsx   # App-wide file drop handler
│       │   └── Markdown/            # Markdown rendering
│       ├── types/
│       │   ├── chat.ts         # ChatSession, ChatNode, UserNode, AssistantNode
│       │   ├── tool-call.ts    # ToolCall, ProcessStep
│       │   └── artifact.ts     # LiveFile
│       └── utils/
│           ├── apiBase.ts      # API_BASE detection (Tauri vs dev proxy)
│           ├── tauri.ts        # isTauri() detection
│           ├── formatTime.ts   # Locale-aware time formatting
│           ├── parseArtifacts.ts # <file>/<edit> tag extraction from messages
│           └── updater.ts      # Tauri auto-updater
│
├── src-tauri/                  # Tauri shell — Rust
├── skills/                     # Installed skills directory
├── tests/                      # All tests
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
        → api/chat.py: chat() — builds AgentLoop, sets up tools
          → AgentLoop.run_stream() — yields SSE events
            → FileTagInterceptor — parses <file>/<edit> tags
            → tool calls → ToolRegistry.execute()
          → finally: touch_chat(chat_id)
        → SSE events → useChats.makeEventHandler()
          → updates sessions tree (variants, tool calls, live files)
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
