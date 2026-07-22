# AgentChat

A local-first AI chat with a real agentic loop. Bring your own provider keys, give the agent a sandboxed shell and filesystem, extend it with skills and MCP servers, and organize work into projects — all in a small native app that updates itself. Ships as a desktop app (Windows, Linux) and as a thin Android client that connects to a desktop instance over the network.

## Why a Python backend behind a Rust shell

The agent loop lives in **Python** because the LLM ecosystem is Python-native: LiteLLM (provider routing), the official provider SDKs, `tiktoken` (tokenization), the Agent Skills tooling, `watchdog` hot-reload — all first-class in Python and either absent or immature elsewhere. Rewriting the loop in Rust would mean reimplementing or FFI-binding that entire stack for zero user-visible benefit.

**Tauri** earns its place on the other axis — distribution. It wraps the app in the OS-native webview (no bundled Chromium like Electron), producing a small installer with a genuine auto-updater and OS-level filesystem permissions.

So the split follows each language's strength:

- **Rust (`src-tauri/`)** — window, app lifecycle, spawning and reaping the Python sidecar, auto-update, path/permission boundaries.
- **Python (`backend/`)** — the agent loop, tools, provider routing, persistence. Shipped as a single PyInstaller sidecar (`agentchat-backend.exe` on Windows, `agentchat-backend` on Linux). Fair warning: it weighs in at ~120–150 MB. PyInstaller bundles the entire Python interpreter plus every dependency (LiteLLM, httpx, PIL, pypdf, and a hundred more) into a single file. That's the price of not asking the user to install Python. The Android client skips this entirely — it has no local backend, just the UI.
- **React (`ui/`)** — the chat interface, talking to the backend over HTTP + SSE.

The shipped binary is native and self-updating; the brain stays in the language its libraries are written in.

## Stack

| Layer | Tech |
|---|---|
| Desktop shell | Tauri 2.x (Rust) — Windows + Linux |
| Mobile shell | Tauri 2.x Android — thin client, no bundled backend |
| UI | React 18 + TypeScript + Vite |
| Backend | FastAPI + uvicorn (Python 3.11) |
| LLM routing | LiteLLM |
| Tools / MCP | built-in tool registry + Model Context Protocol servers |
| Skills | Agent Skills (agentskills.io) + `watchdog` hot-reload |
| i18n | react-i18next |

## Features

- **Multi-provider** — OpenAI, Anthropic, Google Gemini, DeepSeek, OpenRouter, or any OpenAI-compatible endpoint, switchable per chat.
- **Agentic loop** — the model can run shell commands, read/write files, and call skills, streamed live over SSE with inline file/edit rendering.
- **Sandboxed by default** — the agent sees only the current chat's folder. Shell execution adapts to the host: WSL on Windows (PowerShell fallback if WSL isn't installed), native bash on Linux/macOS. An opt-in unrestricted mode lifts the cage.
- **Android client** — a thin Tauri Android app (no bundled backend) pairs with a desktop instance via QR code or a manual URL + token, then talks to it over the network like a remote control.
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
.\run.bat   # Windows — choose option 3
./run.sh    # Linux / macOS — choose option 3
```

UI: http://localhost:5173 · Backend: http://127.0.0.1:8787

In development the UI talks to the local `uvicorn` directly; in the packaged app the Rust shell starts the bundled sidecar and the UI auto-detects it.

## Building the desktop app

The UI is bundled into the app at build time — there's no `beforeBuildCommand`, so build it first or `cargo tauri build` ships a stale design.

**Windows** (exe + msi + nsis):

```powershell
npm run build --prefix ui            # 1. UI → ui/dist
.\scripts\build-backend.ps1          # 2. Python backend sidecar (PyInstaller → agentchat-backend.exe)
cd src-tauri ; cargo tauri build     # 3. desktop installers
```

Outputs (`bundle = "all"`):

- `src-tauri/target/release/bundle/nsis/AgentChat_*-setup.exe` — NSIS installer (used by the auto-updater)
- `src-tauri/target/release/bundle/msi/AgentChat_*.msi` — MSI installer

The NSIS installer closes a running backend before copying files, so updates never fail on a locked sidecar.

**Linux** — same shape, with the shell script instead:

```sh
npm run build --prefix ui
./scripts/build-backend.sh
cd src-tauri && cargo tauri build
```

This produces three bundles under `src-tauri/target/release/bundle/`: `.deb`,
`.rpm`, and `.AppImage`. Build deps: the WebKitGTK 4.1 stack, GTK 3, librsvg,
patchelf, and (on Arch) `libayatana-appindicator`.

> **AppImage & the white-screen trap.** An AppImage bundles the WebKit of the
> machine that *built* it. If that WebKit is older than the Mesa/GPU stack on the
> machine that *runs* it, the webview aborts on startup and the window is blank
> (white) — no error shown. So an AppImage built on an older distro can
> white-screen on a bleeding-edge one (Arch, CachyOS, Fedora). The official
> release AppImage is therefore built on Arch (see below), and the `.deb`/`.rpm`
> don't have this problem — they use your system's own WebKit. If you roll your
> own AppImage, build it on a distro at least as new as your target.

## Building the Android client

The APK is a thin client with **no bundled backend** — it pairs with a desktop instance over the network (QR code or manual URL + token), so there's no backend step:

```powershell
npm run build --prefix ui                                  # 1. UI → ui/dist (the APK's design)
cd src-tauri
cargo tauri android build --apk --debug --target aarch64   # 2. arm64 debug APK (auto-signed, sideloadable)
```

Output: `src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk`.

Requires the Android SDK + NDK, the Rust Android targets, and (on Windows) Developer Mode enabled for symlink support. The desktop app and the APK each carry their own copy of the UI — rebuilding one doesn't affect the other.

## Releases / Auto-update

Tagged pushes trigger GitHub Actions, which builds every platform in parallel:

- **Windows** — `agentchat-backend.exe` (PyInstaller) + the Tauri NSIS
  `-setup.exe` and `.msi` installers, plus a portable ZIP.
- **Linux** — the sidecar + `.deb`, `.rpm`, and `.AppImage`. The AppImage is
  rebuilt in an Arch container so it ships a modern WebKit (see the white-screen
  note above); the `.deb`/`.rpm` come from the standard Ubuntu runner.
- Publishes a GitHub Release with a `latest.json` updater manifest.

The installed desktop app checks for updates on every launch and prompts the user to install. The Android APK isn't part of this pipeline — it's built and sideloaded locally (see above); there's no auto-update for it.

**Which Linux artifact?** `.deb` for Debian/Ubuntu/Mint, `.rpm` for
Fedora/openSUSE, `.AppImage` for everything else (Arch/CachyOS and other rolling
distros) — `chmod +x` it and run. The AppImage needs FUSE (`fuse2`), or run it
with `--appimage-extract-and-run`.

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
- **UI components** — [https://astryx.atmeta.com/](https://astryx.atmeta.com/)

---

## Disk space

| What | Size |
|---|---|
| Installed app (`%LOCALAPPDATA%\AgentChat`) | ~98 MB |
| WSL 2 + Linux distro (optional) | ~2–4 GB |

WSL is not required — the agent falls back to PowerShell on Windows. Install it only if you want a proper Linux shell environment.

## Data & privacy

Everything is stored locally — there is no AgentChat account or cloud sync.

| What | Windows | Linux |
|---|---|---|
| Settings + provider keys | `%APPDATA%/AgentChat/.agents/settings.json` | `~/AgentChat/.agents/settings.json` |
| Chats | `%APPDATA%/AgentChat/.agents/agentchat.db` (SQLite) | `~/AgentChat/.agents/agentchat.db` |
| Projects | `%APPDATA%/AgentChat/.agents/projects.db` (SQLite) | `~/AgentChat/.agents/projects.db` |
| Skills | `~/.agents/skills/` | `~/.agents/skills/` |

In development these live under `<repo>/.agents/` instead.

## Remote / mobile access

The desktop app is the host: turn on remote access in **Settings → Paths** to expose its backend on the network with a bearer token, and pair a client to it two ways:

- **Android APK** — scan the QR code (encodes the URL + token) or enter them manually on the connect screen; reconnecting later (token rotated, network changed) reopens the same screen.
- **Browser / PWA** — open the desktop's address from any phone/laptop browser; the UI is served straight from the backend, same token-based pairing.

Either way it's a thin client: chats, settings, and the agent loop all run on the desktop instance.

## Project structure

<details>
<summary>📂 Click to expand</summary>

```
AgentChat/
├── backend/
│   ├── main.py              # App factory — composition root + remote-access guard
│   ├── run.py               # Uvicorn entry point
│   ├── paths.py             # Path resolution (data dir, chat dirs)
│   ├── shell.py             # Shell abstraction (WSL/PowerShell/posix)
│   ├── extraction.py        # Content/text extraction utilities
│   ├── api/
│   │   ├── chat.py          # POST /api/chat — SSE streaming (core)
│   │   ├── chats.py         # CRUD /api/chats — session persistence
│   │   ├── settings.py      # GET/PUT /api/settings
│   │   ├── files.py         # File upload/download/serve/preview (Office→PDF)
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
│   │   ├── sandbox.py       # SandboxPolicy — path access control
│   │   ├── wsl_exec.py      # WSL/posix/PowerShell execution hub
│   │   └── research_runner.py / research_prompt.py / reasoning_split.py
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
│   │   ├── ask_user.py      # Pauses the turn for user input
│   │   ├── research_tool.py # Nested-agent web research
│   │   ├── show_widget.py   # Inline HTML/SVG visualizations
│   │   ├── web_search_tool.py
│   │   └── web_fetch_tool.py
│   ├── mcp_integration/     # Model Context Protocol
│   │   ├── client.py        # MCP client (stdio/HTTP)
│   │   ├── manager.py       # Server lifecycle
│   │   ├── registry_view.py # Exposes MCP tools to agent
│   │   └── tool_proxy.py    # Proxies MCP tool calls
│   ├── llm/
│   │   ├── client.py        # LLMClient — wraps LiteLLM
│   │   ├── model_tag.py     # Re-tags custom/OpenAI-compatible model ids
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
│       ├── installer.py     # GitHub/archive skill installer
│       └── catalog.py       # Curated Anthropic skill catalog
│
├── ui/src/
│   ├── App.tsx              # Root — settings context, layout
│   ├── hooks/               # useChats, useSSE, useProjects, useIsMobile, ...
│   ├── contexts/
│   │   └── SettingsContext.tsx
│   ├── shortcuts/
│   │   └── registry.ts      # Keyboard shortcut definitions
│   ├── components/
│   │   ├── Chat/            # ChatView, ChatInput, MessageBubble, web-search/research menus, ...
│   │   ├── Mobile/          # MobileConnect — backend connect/reconnect (APK + PWA)
│   │   ├── BottomSheet.tsx  # Generic mobile bottom-sheet primitive
│   │   ├── Settings/        # SettingsPanel + tabs (Profile/Appearance/Terminal/Sandbox/Providers/...)
│   │   ├── Projects/        # ProjectsView, ProjectDetail
│   │   ├── Artifacts/       # ArtifactCard, ArtifactViews, FilesPanel, WidgetView, ...
│   │   ├── Skills/          # SkillsManager (master-detail, mobile-swappable)
│   │   ├── ToolCalls/       # ToolCallBlock, UserQuestionCard
│   │   ├── Onboarding/      # OnboardingWizard
│   │   ├── Markdown/        # Markdown renderer
│   │   ├── Sidebar.tsx
│   │   ├── AllChatsPage.tsx
│   │   ├── FilesGalleryPage.tsx
│   │   └── GlobalDropZone.tsx
│   ├── types/               # chat.ts, tool-call.ts, artifact.ts, project.ts
│   ├── i18n/                # react-i18next setup, en/ru catalogs
│   └── utils/               # apiBase (+withToken/disconnect events), tauri, downloadAndOpen, ...
│
├── src-tauri/               # Tauri shell — Rust
│   ├── src/                 # main.rs (desktop entry) + lib.rs (shared run()) + desktop_backend.rs
│   └── capabilities/        # default.json, desktop-downloads.json (desktop-only fs write), mobile.json
└── tests/backend/           # pytest — agent loop, tools, streaming, sandbox, research
```

</details>
