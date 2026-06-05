# AgentChat

A local-first desktop AI chat with a real agentic loop. Bring your own provider keys, give the agent a sandboxed shell and filesystem, extend it with skills and MCP servers, and organize work into projects — all in a small native app that updates itself.

## Why a Python backend behind a Rust shell

The agent loop lives in **Python** because the LLM ecosystem is Python-native: LiteLLM (provider routing), the official provider SDKs, `tiktoken` (tokenization), the Agent Skills tooling, `watchdog` hot-reload — all first-class in Python and either absent or immature elsewhere. Rewriting the loop in Rust would mean reimplementing or FFI-binding that entire stack for zero user-visible benefit.

**Tauri** earns its place on the other axis — distribution. It wraps the app in the OS-native webview (no bundled Chromium like Electron), producing a small installer with a genuine auto-updater and OS-level filesystem permissions.

So the split follows each language's strength:

- **Rust (`src-tauri/`)** — window, app lifecycle, spawning and reaping the Python sidecar, auto-update, path/permission boundaries.
- **Python (`backend/`)** — the agent loop, tools, provider routing, persistence. Shipped as a single PyInstaller `agentchat-backend.exe` sidecar. Fair warning: it weighs in at ~120–150 MB. PyInstaller bundles the entire Python interpreter plus every dependency (LiteLLM, httpx, PIL, pypdf, and a hundred more) into a single file. That's the price of not asking the user to install Python.
- **React (`ui/`)** — the chat interface, talking to the backend over HTTP + SSE.

The shipped binary is native and self-updating; the brain stays in the language its libraries are written in.

## Stack

| Layer | Tech |
|---|---|
| Desktop shell | Tauri 2.x (Rust) |
| UI | React 18 + TypeScript + Vite |
| Backend | FastAPI + uvicorn (Python 3.11) |
| LLM routing | LiteLLM |
| Tools / MCP | built-in tool registry + Model Context Protocol servers |
| Skills | Agent Skills (agentskills.io) + `watchdog` hot-reload |
| i18n | react-i18next |

## Features

- **Multi-provider** — OpenAI, Anthropic, Google Gemini, DeepSeek, OpenRouter, or any OpenAI-compatible endpoint, switchable per chat.
- **Agentic loop** — the model can run shell commands, read/write files, and call skills, streamed live over SSE with inline file/edit rendering.
- **Sandboxed by default** — the agent sees only the current chat's folder; bash runs through WSL (with PowerShell fallback on Windows). An opt-in unrestricted mode lifts the cage.
- **Projects** — per-project system prompt and file set, so related chats share context.
- **Skills** — install from GitHub or an archive; hot-reloaded from `~/.agents/skills/`.
- **MCP** — connect Model Context Protocol servers (stdio or HTTP) to expose external tools.
- **Multi-language UI** — interface localization via react-i18next.
- **Local-first** — keys, chats, and settings stay on your machine; the only outbound traffic is the provider API calls you configure.
- **Self-updating** — the installed app checks for releases on launch and updates in place.

## Providers supported

OpenAI · Anthropic · Google Gemini · DeepSeek · OpenRouter · any OpenAI-compatible endpoint

## Running in development

**Prerequisites:** Python 3.11+, Node 20+, Rust stable

```powershell
# Backend
cd backend
pip install -r requirements.txt
uvicorn main:app --host 127.0.0.1 --port 8787 --reload

# UI (separate terminal)
cd ui
npm install
npm run dev

# Or both at once
.\run.bat   # choose option 3
```

UI: http://localhost:5173 · Backend: http://127.0.0.1:8787

In development the UI talks to the local `uvicorn` directly; in the packaged app the Rust shell starts the bundled sidecar and the UI auto-detects it.

## Building the desktop app

```powershell
# 1. Build the Python backend sidecar (PyInstaller → agentchat-backend.exe)
.\scripts\build-backend.ps1

# 2. Build the Tauri installers
cd src-tauri
cargo tauri build
```

Outputs (`bundle = "all"`):

- `src-tauri/target/release/bundle/nsis/AgentChat_*-setup.exe` — NSIS installer (used by the auto-updater)
- `src-tauri/target/release/bundle/msi/AgentChat_*.msi` — MSI installer

The NSIS installer closes a running backend before copying files, so updates never fail on a locked sidecar.

## Releases / Auto-update

Tagged pushes trigger GitHub Actions which:

1. Builds `agentchat-backend.exe` via PyInstaller
2. Builds the Tauri NSIS `-setup.exe` + `.msi` installers
3. Publishes a GitHub Release with `latest.json`

The installed app checks for updates on every launch and prompts the user to install.

```powershell
git tag v1.1.0
git push origin v1.1.0
```

## Skills

Skills extend the agent's capabilities and live in the shared, cross-agent directory `~/.agents/skills/`. Install from a GitHub repo via Settings → Skills:

```
https://github.com/owner/repo
```

…or drop a folder containing `SKILL.md` into `~/.agents/skills/`. New and changed skills are picked up without a restart.

## Internationalization

UI strings are localized with **react-i18next**. English is the canonical source language; other languages overlay on top with English as the fallback. The active language is detected from the OS locale on first run and can be changed in Settings → Appearance.

To add a language, see `ui/src/i18n/README.md`: register it in `ui/src/i18n/languages.ts`, drop a `locales/<code>/translation.json`, and wire it into `ui/src/i18n/index.ts`.

## Inspiration & acknowledgements

AgentChat is inspired by [Claude](https://claude.ai) — Anthropic's AI assistant — and by the broader vision of agentic AI that [Anthropic](https://anthropic.com) is building toward. The idea of giving a language model a real shell, a real filesystem, and real tools rather than a sandboxed toy environment comes directly from watching Claude Desktop work.

Built on the shoulders of:

- **[LiteLLM](https://github.com/BerriAI/litellm)** — provider-agnostic LLM routing that makes multi-provider support trivial
- **[Tauri](https://tauri.app)** — lightweight native shell without the Electron overhead
- **[FastAPI](https://fastapi.tiangolo.com)** — async Python API layer
- **[Model Context Protocol](https://modelcontextprotocol.io)** — open standard by Anthropic for connecting AI models to external tools and data sources
- **[Agent Skills](https://agentskills.io)** — the shared skill ecosystem the agent hooks into

---

## Disk space

| What | Size |
|---|---|
| Installed app (`%LOCALAPPDATA%\AgentChat`) | ~98 MB |
| WSL 2 + Linux distro (optional) | ~2–4 GB |

WSL is not required — the agent falls back to PowerShell on Windows. Install it only if you want a proper Linux shell environment.

## Data & privacy

Everything is stored locally — there is no AgentChat account or cloud sync.

| What | Where (packaged app) |
|---|---|
| Settings + provider keys | `%APPDATA%/AgentChat/.agents/settings.json` |
| Chats | `%APPDATA%/AgentChat/.agents/agentchat.db` (SQLite) |
| Projects | `%APPDATA%/AgentChat/.agents/projects.db` (SQLite) |
| Skills | `~/.agents/skills/` |

In development these live under `<repo>/.agents/` instead.

## Remote / mobile access

In Settings → Paths, set a custom **Backend URL** pointing to a hosted instance of the backend. The desktop app continues to use the local sidecar by default.

## Project structure

<details>
<summary>📂 Click to expand</summary>

```
AgentChat/
├── backend/
│   ├── main.py              # App factory — composition root
│   ├── run.py               # Uvicorn entry point
│   ├── paths.py             # Path resolution (data dir, chat dirs)
│   ├── shell.py             # Shell abstraction (WSL/PowerShell/posix)
│   ├── extraction.py        # Content/text extraction utilities
│   ├── api/
│   │   ├── chat.py          # POST /api/chat — SSE streaming (core)
│   │   ├── chats.py         # CRUD /api/chats — session persistence
│   │   ├── config_routes.py # GET/PUT /api/settings
│   │   ├── files.py         # File upload/download
│   │   ├── skills.py        # Skills install/list/delete
│   │   ├── wsl.py           # WSL detection & management
│   │   ├── health.py        # GET /api/system-status
│   │   ├── models_routes.py # GET /api/models
│   │   ├── mcp.py           # MCP server management
│   │   ├── projects.py      # Projects CRUD
│   │   ├── remote.py        # Remote access (token, toggle, QR)
│   │   ├── searxng.py       # SearXNG proxy
│   │   ├── win_deps.py      # Windows dependency detection
│   │   ├── router.py        # Route assembly
│   │   └── schemas/         # Pydantic request/response models
│   ├── agent/
│   │   ├── loop.py          # AgentLoop — run_stream() is the main path
│   │   ├── config.py        # AgentConfig dataclass
│   │   ├── system_prompt.py # System prompt builder
│   │   ├── types.py         # Agent event/message types
│   │   └── sandbox.py       # SandboxPolicy — path access control
│   ├── tools/
│   │   ├── factory.py       # build_tool_registry() — per-request assembly
│   │   ├── registry.py      # ToolRegistry — register/execute tools
│   │   ├── bash_tool.py     # Shell command execution
│   │   ├── read_file.py     # File reader
│   │   ├── write_file.py    # File writer
│   │   ├── edit_file.py     # In-place file edits
│   │   ├── present_files.py # Surfaces files as UI cards
│   │   ├── read_skill.py    # Reads SKILL.md for agent
│   │   ├── read_photo.py    # Image content extraction
│   │   ├── web_search_tool.py
│   │   └── web_fetch_tool.py
│   ├── mcp_integration/     # Model Context Protocol
│   │   ├── client.py        # MCP client (stdio/HTTP)
│   │   ├── manager.py       # Server lifecycle
│   │   ├── registry_view.py # Exposes MCP tools to agent
│   │   └── tool_proxy.py    # Proxies MCP tool calls
│   ├── llm/
│   │   ├── client.py        # LLMClient — wraps LiteLLM
│   │   └── models_fetcher.py
│   ├── store/
│   │   ├── chat_store.py    # SQLite chat storage
│   │   ├── project_store.py # SQLite project storage
│   │   └── settings_store.py
│   ├── web_search/          # Web search (native/Tavily/SearXNG)
│   │   ├── config.py
│   │   └── service.py
│   └── skills/
│       ├── reader.py        # Scans SKILL.md files
│       └── installer.py     # GitHub/archive skill installer
│
├── ui/src/
│   ├── App.tsx              # Root — settings context, layout
│   ├── hooks/               # useChats, useSSE, useProjects, useShortcuts, ...
│   ├── contexts/
│   │   └── SettingsContext.tsx
│   ├── shortcuts/
│   │   └── registry.ts      # Keyboard shortcut definitions
│   ├── components/
│   │   ├── Chat/            # ChatView, ChatInput, MessageBubble, MentionPopup, ...
│   │   ├── Settings/        # SettingsPanel + tabs (Main/Providers/Models/Paths/MCP/...)
│   │   ├── Projects/        # ProjectsView, ProjectDetail
│   │   ├── Artifacts/       # ArtifactCard, FilesPanel, FilePreviewPanel, ...
│   │   ├── Skills/          # SkillsManager
│   │   ├── ToolCalls/       # ToolCallBlock
│   │   ├── Onboarding/      # OnboardingWizard
│   │   ├── Markdown/        # Markdown renderer
│   │   ├── Sidebar.tsx
│   │   ├── AllChatsPage.tsx
│   │   ├── FilesGalleryPage.tsx
│   │   └── GlobalDropZone.tsx
│   ├── types/               # chat.ts, tool-call.ts, artifact.ts, project.ts
│   ├── i18n/                # react-i18next setup, en/ru catalogs
│   └── utils/               # apiBase, tauri, parseArtifacts, presentedFiles, ...
│
├── src-tauri/               # Tauri shell — Rust (window, sidecar, auto-update)
└── tests/backend/           # pytest — agent loop, tools, streaming, sandbox
```

</details>
