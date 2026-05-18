# AgentChat

Desktop AI chat with an agentic loop. Tauri shell, Python backend, LiteLLM provider abstraction, skill packages with hot-reload.

## Stack

| Layer | Tech |
|---|---|
| Desktop shell | Tauri 1.x (Rust) |
| UI | React 18 + TypeScript + Vite |
| Backend | FastAPI + uvicorn (Python 3.11) |
| LLM routing | LiteLLM |
| Skills | JSON manifests + hot-reload via watchdog |

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

```
AgentChat/
├── backend/          # FastAPI app, agent loop, tools, LiteLLM client
│   ├── agent/        # Streaming agent loop, file interceptor
│   ├── api/          # HTTP routes (chat, settings, skills, models)
│   ├── llm/          # LiteLLM wrapper + model fetcher
│   ├── tools/        # bash_tool, read_file, write_file, read_skill
│   └── skills/       # Skill installer + reader
├── ui/               # React + TypeScript frontend
├── src-tauri/        # Tauri shell (Rust)
├── scripts/          # Build scripts
├── skills/           # Bundled skills
└── tests/            # Backend tests
```
