# AgentChat

Desktop AI chat with an agentic loop. Tauri shell, Python backend, LiteLLM provider abstraction, skill packages with hot-reload.

## Stack

| Layer | Tech |
|---|---|
| Desktop shell | Tauri 2.x (Rust) |
| UI | React 18 + TypeScript + Vite |
| Backend | FastAPI + uvicorn (Python 3.11) |
| LLM routing | LiteLLM |
| Skills | agentskills.io + hot-reload via watchdog |

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

## Building the desktop app

```powershell
# 1. Build Python backend sidecar
.\scripts\build-backend.ps1

# 2. Build Tauri installer
cd src-tauri
cargo tauri build
```

Output: `src-tauri/target/release/bundle/msi/AgentChat_*.msi`

## Releases / Auto-update

Tagged pushes trigger GitHub Actions which:
1. Builds `backend.exe` via PyInstaller
2. Builds the Tauri `.msi` installer
3. Publishes a GitHub Release with `latest.json`

The installed app checks for updates on every launch and prompts the user to install.

```powershell
git tag v1.0.0
git push origin v1.0.0
```

## Skills

Skills extend the agent's capabilities. Install from GitHub:

```
https://github.com/owner/repo
```

Or drop a folder with `skill.json` into `.agents/skills/`.

## Remote / mobile access

In Settings → Paths, set a custom **Backend URL** pointing to a hosted instance of the backend. The desktop app continues to use the local sidecar by default.

## Project structure

<details>
<summary>📂 Click to expand</summary>

```
AgentChat/
├── backend/
│   ├── main.py              # App factory, settings store, startup
│   ├── run.py               # Uvicorn entry point
│   ├── api/
│   │   ├── chat.py          # POST /api/chat — SSE streaming (core)
│   │   ├── chats.py         # CRUD /api/chats — session persistence
│   │   ├── settings.py      # GET/PUT /api/settings
│   │   ├── files.py         # File upload/download
│   │   ├── skills.py        # Skills install/list/delete
│   │   ├── wsl.py           # WSL detection & management
│   │   ├── health.py        # GET /api/system-status
│   │   └── schemas/         # Pydantic request/response models
│   ├── agent/
│   │   ├── loop.py          # AgentLoop — run_stream() is the main path
│   │   ├── config.py        # AgentConfig dataclass
│   │   ├── file_tag_interceptor.py  # <file>/<edit> streaming parser
│   │   └── sandbox.py       # SandboxPolicy — path access control
│   ├── tools/
│   │   ├── registry.py      # ToolRegistry — register/execute tools
│   │   ├── bash_tool.py     # Shell command execution
│   │   ├── read_file.py     # File reader
│   │   ├── write_file.py    # File writer (canonical path)
│   │   └── read_skill.py    # Reads SKILL.md for agent
│   ├── llm/
│   │   ├── client.py        # LLMClient — wraps LiteLLM
│   │   └── models_fetcher.py
│   ├── store/
│   │   └── chat_store.py    # SQLite chat storage
│   └── skills/
│       ├── reader.py        # Scans SKILL.md files (with timestamp cache)
│       └── installer.py     # GitHub/archive skill installer
│
├── ui/src/
│   ├── App.tsx              # Root — settings context, layout
│   ├── hooks/
│   │   ├── useChats.ts      # Multi-session chat manager (main hook)
│   │   └── useSSE.ts        # SSE connection helper
│   ├── contexts/
│   │   └── SettingsContext.tsx
│   ├── components/
│   │   ├── Chat/            # ChatView, ChatInput, MessageBubble, ModelSelector
│   │   ├── Settings/              # Settings panel
│   │   │   ├── SettingsPanel.tsx  # Shell (nav, tab routing, state)
│   │   │   ├── tabs/              # Per-tab components
│   │   │   │   ├── MainTab.tsx
│   │   │   │   ├── ProvidersTab.tsx
│   │   │   │   ├── ModelsTab.tsx
│   │   │   │   ├── PathsTab.tsx
│   │   │   │   └── AboutTab.tsx
│   │   ├── Sidebar.tsx
│   │   ├── AllChatsPage.tsx
│   │   ├── Skills/          # Skills manager UI
│   │   ├── Onboarding/      # First-run wizard
│   │   └── Artifacts/       # File preview panels
│   ├── types/               # ChatSession, ChatNode, ToolCall, LiveFile
│   └── utils/               # apiBase, tauri, formatTime, parseArtifacts
│
├── src-tauri/               # Tauri shell — Rust
├── skills/                  # Installed skills directory
└── tests/
```

</details>
