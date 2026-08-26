# AgentChat

A local-first AI chat with a real agentic loop. Bring your own provider keys, give the agent a sandboxed shell and filesystem, extend it with skills and MCP servers, and organize work into projects — all in a small native app that updates itself.

Beyond the loop it can machine-check its own maths, run a multi-agent web research round, generate images locally or through a hosted API, draw interactive widgets inline, and remember facts across chats. Ships as a desktop app (Windows, Linux), as a thin Android client that pairs with a desktop instance, and — if you'd rather the agent lived on a box of its own — as a headless **server mode** every client can point at.

## Why a Python backend behind a Rust shell

The agent loop lives in **Python** because the LLM ecosystem is Python-native: LiteLLM (provider routing), the official provider SDKs, `tiktoken` (tokenization), the Agent Skills tooling, SymPy (the verification engine), `watchdog` hot-reload — all first-class in Python and either absent or immature elsewhere. Rewriting the loop in Rust would mean reimplementing or FFI-binding that entire stack for zero user-visible benefit.

**Tauri** earns its place on the other axis — distribution. It wraps the app in the OS-native webview (no bundled Chromium like Electron), producing a small installer with a genuine auto-updater and OS-level filesystem permissions.

So the split follows each language's strength:

- **Rust (`src-tauri/`)** — window, app lifecycle, spawning and reaping the Python sidecar, auto-update, path/permission boundaries.
- **Python (`backend/`)** — the agent loop, tools, provider routing, persistence. Shipped as a single PyInstaller sidecar (`agentchat-backend.exe` on Windows, `agentchat-backend` on Linux). Fair warning: it weighs in at ~120–150 MB. PyInstaller bundles the entire Python interpreter plus every dependency (LiteLLM, httpx, SymPy, PIL, pypdf, and a hundred more) into a single file. That's the price of not asking the user to install Python. The Android client skips this entirely — it has no local backend, just the UI.
- **React (`ui/`)** — the chat interface, talking to the backend over HTTP + SSE.

The shipped binary is native and self-updating; the brain stays in the language its libraries are written in.

## Stack

| Layer | Tech |
|---|---|
| Desktop shell | Tauri 2.x (Rust) — Windows + Linux |
| Mobile shell | Tauri 2.x Android — thin client, no bundled backend |
| UI | React 18 + TypeScript + Vite, built on Meta's **Astryx** design system |
| Backend | FastAPI + uvicorn (Python 3.11) |
| LLM routing | LiteLLM |
| Tools / MCP | built-in tool registry + Model Context Protocol servers |
| Skills | Agent Skills (agentskills.io) + `watchdog` hot-reload |
| Maths engine | SymPy + mpmath + NumPy, in an isolated child process |
| Image generation | AUTOMATIC1111 / Forge · ComfyUI · hosted APIs |
| Web search | provider-native · Tavily · self-hosted SearXNG |
| Storage | SQLite — chats, projects, usage, agent memory, verifications |
| i18n | react-i18next (en · ru) |

## Features

### The agent

- **Multi-provider** — OpenAI, Anthropic, Google Gemini, DeepSeek, OpenRouter, or any OpenAI-compatible endpoint (LM Studio, Ollama, a local vLLM), switchable per chat. Local endpoints need no API key.
- **Agentic loop** — the model runs shell commands, reads and writes files, searches the web, calls skills and MCP tools, streamed live over SSE. Tool calls render as they arrive, arguments included, before the tool has finished.
- **Sandboxed by default** — the agent sees only the current chat's folder. Shell execution adapts to the host: WSL on Windows (PowerShell fallback if WSL isn't installed), native bash/zsh on Linux and macOS. An opt-in unrestricted mode lifts the cage.
- **Untrusted content is fenced** — anything the agent didn't author (web pages, fetched files, uploads, MCP output) arrives wrapped in an `<untrusted_content>` marker, so a page telling the model what to do reads as data rather than instruction.
- **Turns freeze instead of failing** — a 429, a 5xx or a dropped socket no longer throws the turn away. The abandoned attempt is rewound out of the transcript, a countdown is shown, and only the one call to the provider is retried; a rejected key or a 400 still fails immediately, because waiting cannot make it true.
- **Vision** — attach images to a message; the loop sends them and falls back to text automatically if the provider refuses.

### Modes and specialists

- **Math mode** — a composer tab that turns the chat into a mathematician: a fixed layout, LaTeX throughout, a narrow tool roster, and every final answer machine-checked before it is shown. See [Math mode](#math-mode-and-the-verification-contour).
- **Agent personas** — named agents with their own avatar, colours, model, temperature, prompt template and tool roster. See [Agents, personas and memory](#agents-personas-and-memory).
- **Agent memory** — per-agent facts in SQLite with FTS5 search; the agent writes them with `remember`, searches with `recall`, drops them with `forget`, and the ranked core arrives in every prompt.
- **Projects** — per-project system prompt and file set, so related chats share context.

### What it can produce

- **Deep research** — a `research` tool that spawns a lead agent plus parallel subagents, with a live progress tree, source list, citation audit and a written report. See [Research](#research).
- **Web search** — three interchangeable backends: the provider's own server-side search, Tavily, or a self-hosted SearXNG (installable from Settings).
- **Image generation** — local samplers (AUTOMATIC1111 / Forge / SD.Next, ComfyUI) or a hosted model, with no silent fallback between them. See [Image generation](#image-generation).
- **Inline widgets** — `show_widget` renders themed HTML/SVG/Canvas visualizations inside the message, in a sandboxed iframe that inherits the app's design tokens.
- **Artifacts and files** — files the agent surfaces become cards with a side panel; Office documents are previewed in-app via LibreOffice → PDF, and everything lands in a searchable files gallery.
- **Plots** — `math_plot` produces themed, self-contained SVG (exportable as SVG or PNG) that breaks curves at poles instead of drawing a vertical line through infinity.

### Extending it

- **Skills** — install from a GitHub repo or an archive, or pick from a curated catalog; hot-reloaded from `~/.agents/skills/`. The office four (Word/Excel/PowerPoint/PDF), a `math` skill and an `agentchat` self-documentation skill ship bundled and install offline. A `SKILL.md` the model writes in a chat gets an **Install skill** button.
- **MCP** — connect Model Context Protocol servers (stdio or HTTP) to expose external tools; per-server status is visible from the composer.

### The app around it

- **Android client** — a thin Tauri Android app (no bundled backend) pairs with a desktop instance via QR code or a manual URL + token, then talks to it over the network like a remote control. The pairing token can be rotated from Settings.
- **Server mode** — run the backend on a VDS and point the desktop, laptop and phone at it. One-line installer, systemd unit, Caddy + automatic TLS. See [Server mode](#server-mode-backend-on-a-server).
- **Usage dashboard** — per-model token/cost breakdown, a local estimate of where the prompt tokens went, daily chart, and top chats by spend. Model pricing can be entered by hand for models LiteLLM doesn't know.
- **Multi-language UI** — interface localization via react-i18next (English and Russian shipped).
- **Local-first** — provider keys live in the OS keychain (not a plaintext config file), chats and settings stay on your machine, and the only outbound traffic is the provider API calls you configure.
- **Self-updating** — the installed app checks for releases on launch and updates in place.

## Agent toolbox

The built-in tools, all of which an agent or a mode can be restricted to a subset of:

| Tool | What it does |
|---|---|
| `bash_tool` | Shell command execution — WSL, PowerShell or native bash, with an output budget |
| `read_file` · `write_file` · `edit_file` | Bounded reads (binary and non-UTF-8 refused), the canonical write path, in-place edits |
| `list_dir` · `grep` | Directory listing and content search without a shell round-trip |
| `present_files` | Surfaces a file to the user as a card in the artifacts panel |
| `read_photo` | Pulls content out of an image |
| `read_skill` | Reads a `SKILL.md` on demand, so skills cost nothing until used |
| `ask_user` | Ends the turn with a question instead of guessing; the answer comes back as a normal message |
| `web_search` · `web_fetch` | Search and fetch, with an SSRF policy on fetch (link-local always blocked, private ranges in server mode) |
| `research` | Runs a lead + subagent research round from a model-written brief |
| `math_eval` · `math_verify` · `math_plot` | Preconfigured calculator, independent verifier, themed SVG plots |
| `image_generate` | Prompt → PNG in the chat's `images/` folder |
| `show_widget` | Inline themed HTML/SVG visualization |
| `remember` · `recall` · `forget` | Per-agent long-term memory |

MCP servers add their tools to the same registry, proxied and budget-capped like the built-ins.

## Math mode and the verification contour

`math_verify` is in the **base** tool set, not only in Math mode — a machine-checked answer is worth having wherever one is produced. Math mode simply makes it the default posture: a mathematician's system prompt, a `Дано / Найти / Решение / Ответ / Проверка` layout, LaTeX for every formula, temperature pinned low, and a tool roster deliberately without web search (handed it, a model under pressure looks the answer up instead of working the problem, and the whole contour is then checking someone else's result).

Four invariants hold the verification up, and each has a failure mode that looks like success:

- **The verifier never sees the solution.** It is handed the problem and the claim, and there is no field the reasoning could arrive through. A checker shown the working reliably agrees with it, error included — a green badge that means nothing.
- **Checks run backwards.** Roots go back into the equation; an antiderivative is *differentiated*; a probability is checked against a Monte Carlo run. Re-deriving would repeat whatever method produced the answer, mistake and all.
- **The five statuses are not interchangeable** — `verified`, `refuted`, `partial`, `inconclusive`, `error`. An `error` means the *checker* failed and says nothing about the answer. The badge separates all five on icon, colour **and** border, so `inconclusive` can never be read as a green light.
- **One automatic rewrite, never two.** A refuted claim earns exactly one retry, counted per claim, and both attempts stay visible — hiding the failed first pass is how a badge becomes theatre.

The engine runs in a **child process** with a warm worker pool: `simplify` on a pathological expression cannot be interrupted, and Windows has no `SIGALRM`, so a timeout kills and replaces the worker rather than waiting for it. Parsing uses a closed namespace with a LaTeX pre-pass — `sympify` on raw input is a code-execution hole.

Every verdict is persisted on the tool call, and a **Re-check** button re-runs it later; a separate cross-chat history records every outcome.

## Research

The `research` tool takes a **model-written brief** — not the user's raw message — and runs it as a small organisation:

- a **lead** agent plans the work, delegates a round of tasks, and writes the report;
- **subagents** run in parallel, each in its own loop with its own tools, handing back structured findings;
- a **budget** caps rounds, subagents and tool calls, and a fan-out layer isolates timeouts and failures so one dead branch doesn't take the round with it;
- progress streams live as an agent tree, with sources collected and deduplicated as they are cited, and a citation audit at the end;
- the report is written to `research-<slug>.md` in the chat folder and surfaced as a card.

Research agents get a shorter retry budget than the main loop, since a round already has its own timeout.

## Image generation

`image_generate` routes one request to exactly one backend:

| Backend | What it is |
|---|---|
| `a1111` | AUTOMATIC1111 / Forge / SD.Next over `/sdapi/v1/txt2img` |
| `comfy` | ComfyUI — queues a bundled graph, polls `/history`, fetches `/view` |
| `api` | A hosted model through LiteLLM (`openai/gpt-image-1` and friends), including image edits |

`auto` tries the local samplers first and the hosted API last. There is deliberately **no silent fallback**: if the local sampler you chose is down, quietly billing your OpenAI key instead is not a kindness — the error names the alternatives and lets the model retry. Progress (queue position, steps, preview) streams into a card, and the finished PNG lands in the chat's `images/` folder.

Configured in **Settings → Providers → Image generation**.

## Agents, personas and memory

An agent is more than a system prompt:

- **Prompt templates, not snapshots** — `{date}`, `{tools}`, `{shell}`, `{memory}`, `{user_persona}` and friends are substituted on every request, so a persona never goes stale. `append` keeps the built-in tool contract, sandbox and safety rules and adds the persona as the last word; `replace` hands the whole prompt over to the template, which can pull pieces back in with `{base}` and `{block:<module>}`.
- **Module toggles** — drop individual built-in prompt sections. Only toggleable ones can be dropped, so a stale entry can never strip the sandbox rules.
- **Tool policy + whitelist** — a coarse posture (`full`, `memory_only`, `none`) plus an exact roster on top of it, for the narrow specialist that must not be able to reach for a tool that would let it cheat.
- **Roleplay fields** — who the *user* is playing (`user_persona`, kept out of the prompt template so one character can be reused across stories) and an opening line written into the chat verbatim, with no model call.
- **Per-agent model and temperature** — or `null` to follow the global setting.
- **Memory** — facts in their own SQLite database (it outlives chats, so purging every chat must not touch it), with FTS5 over the archive and a ranked always-on core. The memory block is glued on **last**, after everything cacheable, so remembering a fact doesn't invalidate the prompt cache.

Everything above is edited in **Settings → Agents**, with a live prompt preview and a variable palette.

## Providers supported

OpenAI · Anthropic · Google Gemini · DeepSeek · OpenRouter · any OpenAI-compatible endpoint (LM Studio, Ollama, vLLM, …)

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

Tests:

```powershell
pytest tests/backend        # agent loop, tools, sandbox, streaming, maths, research, import graph
node tests/ui/run.mjs       # UI logic suites (tsc-compiled, run under Node)
```

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

Don't skip step 2: `cargo tauri build` only bundles the sidecar already sitting in `src-tauri/binaries/`, so an old one ships silently and the UI ends up reading a status response that predates a field it now needs.

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

The APK is a thin client with **no bundled backend** — it pairs with a desktop or server instance over the network (QR code or manual URL + token), so there's no backend step:

```powershell
npm run build --prefix ui                                  # 1. UI → ui/dist (the APK's design)
cd src-tauri
cargo tauri android build --apk --debug --target aarch64   # 2. arm64 debug APK (auto-signed, sideloadable)
```

Output: `src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk`.

Requires the Android SDK + NDK, the Rust Android targets, and (on Windows) Developer Mode enabled for symlink support. The desktop app and the APK each carry their own copy of the UI — rebuilding one doesn't affect the other.

The **debug** APK is deliberate: pairing hands the phone a plain `http://<lan-ip>:8787` URL, and cleartext traffic is only allowed for the debug buildType in the generated Gradle project. A release APK would refuse that connection.

## Releases / Auto-update

Tagged pushes trigger GitHub Actions, which builds every platform in parallel into a **draft** release and only publishes it once all of them have landed:

- **Windows** — `agentchat-backend.exe` (PyInstaller) + the Tauri NSIS
  `-setup.exe` and `.msi` installers, plus a portable ZIP.
- **Linux** — the sidecar + `.deb`, `.rpm`, and `.AppImage`. The AppImage is
  rebuilt in an Arch container so it ships a modern WebKit (see the white-screen
  note above); the `.deb`/`.rpm` come from the standard Ubuntu runner.
- **Android** — the thin-client APK, uploaded as
  `agentchat-<version>-android-aarch64.apk`. It shares nothing with the desktop
  legs but `ui/dist`.
- Publishes a GitHub Release with a `latest.json` updater manifest.

The installed desktop app checks for updates on every launch and prompts the user to install. The APK has no auto-updater — download the new one and sideload it.

Before tagging, bump `"version"` in **both** `ui/package.json` (the About screen) and `src-tauri/tauri.conf.json` (the updater identity). CI re-bumps the latter from the tag; `ui/package.json` is never auto-bumped.

`build-linux.yml` and `build-android.yml` are manual smoke-test workflows that run the same steps without touching a release.

**Which Linux artifact?** `.deb` for Debian/Ubuntu/Mint, `.rpm` for
Fedora/openSUSE, `.AppImage` for everything else (Arch/CachyOS and other rolling
distros) — `chmod +x` it and run. The AppImage needs FUSE (`fuse2`), or run it
with `--appimage-extract-and-run`.

```powershell
git tag v1.1.0
git push origin v1.1.0
```

## Skills

Skills extend the agent's capabilities and live in the shared, cross-agent directory `~/.agents/skills/`. Three ways to get one:

- **The catalog** — Settings → Skills offers a curated set: Word, Excel, PowerPoint and PDF document skills, a `math` skill (the layout and tool contract Math mode follows), an `agentchat` skill that documents this app to the agent, and Anthropic's `frontend-design`. The first six ship bundled and install offline; `frontend-design` comes from GitHub.
- **A URL** — paste a GitHub repo and it is fetched, pruned and installed:

  ```
  https://github.com/owner/repo
  ```

- **A folder or archive** — drop a directory containing `SKILL.md` into `~/.agents/skills/`. New and changed skills are picked up without a restart.

A `SKILL.md` the model writes during a chat gets an **Install skill** button in the artifacts panel, so a skill can be authored and installed without leaving the conversation. Bundled skills are refreshed on startup when the app ships a newer copy, and the agent reads a skill's body with `read_skill` only when it needs it — an installed skill costs a line in the prompt, not its full text.

## Internationalization

UI strings are localized with **react-i18next**. English is the canonical source language; other languages overlay on top with English as the fallback. The active language is detected from the OS locale on first run and can be changed in Settings → Appearance. A drift test keeps the catalogs in step.

To add a language, see `ui/src/i18n/README.md`: register it in `ui/src/i18n/languages.ts`, drop a `locales/<code>/translation.json`, and wire it into `ui/src/i18n/index.ts`.

## Server mode (backend on a server)

Instead of one desktop hosting the others, the backend can run on a VDS with every device — PC, laptop, phone — as a client:

```sh
curl -fsSL <raw>/scripts/install-server.sh | sudo bash -s -- --domain chat.example.com
```

The installer clones to `/opt/agentchat`, builds a venv and `ui/dist`, creates an `agentchat` user with `/var/lib/agentchat` as its home, writes a 0600 environment file, installs a systemd unit, and — given `--domain` — puts Caddy in front for automatic TLS. `--update` re-pulls and restarts.

Because every tool call executes in the backend process, the agent's shell, files and sandbox are then the **server's** — which is the entire point, and also why the pairing token is as sensitive as an SSH key.

The one invariant: `AGENTCHAT_SERVER_MODE=1` **turns off the loopback exemption** in the `/api/*` guard. A desktop backend exempts loopback because that *is* the local app talking to its own sidecar; behind a reverse proxy every request arrives from `127.0.0.1`, so keeping the exemption would serve the whole internet an unauthenticated shell. Consequently `/api/remote-access` (the pairing QR) 404s in server mode — there is no caller the backend can still identify as local — and the token comes from `AGENTCHAT_REMOTE_TOKEN` or a 0600 `server-token` file, never from `settings.json`.

Clients switch over in **Settings → Paths → Server mode**. If the remote host goes dark, the reconnect overlay offers a "use the backend on this computer" escape — without it a desktop in server mode would have no reachable Settings to undo it from.

## Remote / mobile access

Without a server, the desktop app is the host: turn on remote access in **Settings → Paths** to expose its backend on the network with a bearer token, and pair a client to it two ways:

- **Android APK** — scan the QR code (encodes the URL + token) or enter them manually on the connect screen; reconnecting later (token rotated, network changed) reopens the same screen.
- **Browser / PWA** — open the desktop's address from any phone/laptop browser; the UI is served straight from the backend, same token-based pairing.

The token can be rotated on demand from Settings, which immediately invalidates every previously paired client — useful if you suspect the URL/QR leaked. Either way it's a thin client: chats, settings, and the agent loop all run on the host instance.

## Data & privacy

Everything is stored locally — there is no AgentChat account or cloud sync.

| What | Windows | Linux |
|---|---|---|
| Settings (no keys) | `%APPDATA%/AgentChat/.agents/settings.json` | `~/AgentChat/.agents/settings.json` |
| Provider keys + remote-access token | OS keychain (Credential Manager), 0600 file fallback | OS keychain (Secret Service), 0600 file fallback |
| Chats | `%APPDATA%/AgentChat/.agents/agentchat.db` (SQLite) | `~/AgentChat/.agents/agentchat.db` |
| Projects | `%APPDATA%/AgentChat/.agents/projects.db` | `~/AgentChat/.agents/projects.db` |
| Token / cost log | `%APPDATA%/AgentChat/.agents/usage.db` | `~/AgentChat/.agents/usage.db` |
| Agent memory | `%APPDATA%/AgentChat/.agents/memory.db` | `~/AgentChat/.agents/memory.db` |
| Verification history | `%APPDATA%/AgentChat/.agents/verifications.db` | `~/AgentChat/.agents/verifications.db` |
| Per-chat working folder | `~/AgentChat/chats/chat-<id>-<ts>/` | `~/AgentChat/chats/chat-<id>-<ts>/` |
| Skills | `~/.agents/skills/` | `~/.agents/skills/` |

In development these live under `<repo>/.agents/` instead, and `AGENTCHAT_DATA_DIR` relocates the whole set (the test suite uses it, and the server installer sets it). Provider keys and other secrets are never written to `settings.json` — they're stored under a single `AgentChat` keychain service, one entry per secret name, and only a masked form is ever returned to the UI.

Memory and verification history live in their own databases on purpose: both outlive chats, so purging every chat must not touch them.

## Disk space

| What | Size |
|---|---|
| Installed app (`%LOCALAPPDATA%\AgentChat`) | ~98 MB |
| WSL 2 + Linux distro (optional) | ~2–4 GB |

WSL is not required — the agent falls back to PowerShell on Windows. Install it only if you want a proper Linux shell environment.

## Inspiration & acknowledgements

AgentChat is inspired by [Claude](https://claude.ai) — Anthropic's AI assistant — and by the broader vision of agentic AI that [Anthropic](https://anthropic.com) is building toward. The idea of giving a language model a real shell, a real filesystem, and real tools rather than a sandboxed toy environment comes directly from watching Claude Desktop work.

Built on the shoulders of:

- **[LiteLLM](https://github.com/BerriAI/litellm)** — provider-agnostic LLM routing that makes multi-provider support trivial
- **[Tauri](https://tauri.app)** — lightweight native shell without the Electron overhead
- **[FastAPI](https://fastapi.tiangolo.com)** — async Python API layer
- **[SymPy](https://www.sympy.org)** + **[mpmath](https://mpmath.org)** — the symbolic and arbitrary-precision engine behind the verification contour
- **[Model Context Protocol](https://modelcontextprotocol.io)** — open standard by Anthropic for connecting AI models to external tools and data sources
- **[Agent Skills](https://agentskills.io)** — the shared skill ecosystem the agent hooks into
- **[Astryx](https://astryx.atmeta.com/)** — Meta's design system; the interface is built end-to-end on its React components, theming, and chat-specific building blocks (composer, message list, tool-call groups)

## License

[MIT](LICENSE) © 2026 Zorahm.

Bundled and depended-on third-party components keep their own licenses — LiteLLM, Tauri, FastAPI, SymPy, React and Astryx among them, plus the skills installed from `anthropics/skills`, which carry Anthropic's license.

---

## Project structure

<details>
<summary>📂 Click to expand</summary>

```
AgentChat/
├── backend/
│   ├── main.py              # App factory — composition root + remote-access guard
│   ├── run.py               # Uvicorn entry point
│   ├── paths.py             # Path resolution (data dir, chat dirs, AGENTCHAT_DATA_DIR)
│   ├── shell.py             # Shell abstraction (WSL/PowerShell/posix)
│   ├── server_mode.py       # AGENTCHAT_SERVER_MODE — drops the loopback exemption
│   ├── retry.py             # Transient-vs-fatal classification + backoff
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
│   │   ├── agents.py        # Agent-persona CRUD + memory CRUD + rendered greeting
│   │   ├── agent_runtime.py # Model/temperature/tool-policy/memory an agent contributes
│   │   ├── math.py          # POST /math/recheck + verification history
│   │   ├── remote.py        # Remote access (token, rotation, toggle, QR)
│   │   ├── searxng.py       # SearXNG proxy
│   │   ├── win_deps.py      # Windows dependency detection
│   │   ├── config_routes.py # Runtime capability probes for the UI
│   │   ├── usage.py         # Token/cost dashboard + manual model pricing
│   │   ├── active_streams.py# In-flight stream registry
│   │   ├── loopback.py      # Shared loopback-request check
│   │   └── router.py        # Route assembly
│   ├── schemas/             # Pydantic contracts — a leaf package (chat, agents, mcp,
│   │                        # settings, skills, math, memory, redaction/secret masking)
│   ├── agent/
│   │   ├── loop.py          # AgentLoop — run_stream() is the main path
│   │   ├── config.py        # AgentConfig dataclass
│   │   ├── modes.py         # Chat modes (the composer tab strip) as AgentConfigs
│   │   ├── system_prompt.py # Thin wrapper over the agent/prompt module registry
│   │   ├── prompt/          # System-prompt module registry (ordered, cache-prefix-safe)
│   │   ├── types.py         # Agent event/message types
│   │   ├── sandbox.py       # SandboxPolicy — path access control
│   │   ├── untrusted.py     # Fences web/upload/MCP output in <untrusted_content>
│   │   ├── partial_json.py  # Decodes tool-call args while they stream
│   │   ├── tool_stream.py   # Live tool events (tool_start / input deltas / chunks)
│   │   ├── host_exec.py     # Platform dispatch (WSL / native posix / PowerShell)
│   │   └── reasoning_split.py
│   ├── mathkit/             # Maths engine — runs in a CHILD process
│   │   ├── parsing.py       # Closed-namespace SymPy parsing + LaTeX pre-pass
│   │   ├── numeric.py       # Seeded sampling, relative tolerance, Wilson interval
│   │   ├── pysandbox.py     # Restricted Python for math_eval + Monte Carlo
│   │   ├── verifiers/       # One strategy per kind — algebra/calculus/linalg/stochastic
│   │   ├── worker.py        # The child's loop: one JSON job per line
│   │   ├── runner.py        # Warm worker pool; killed and replaced on timeout
│   │   ├── subagent.py      # Fallback verifier — problem + claim, never the solution
│   │   └── plot/            # Pole-aware sampler + themed SVG renderer
│   ├── images/              # Image generation
│   │   ├── service.py       # Backend resolution (no silent fallback)
│   │   ├── config.py        # ImageRequest / ImageGenConfig / GeneratedImage
│   │   ├── backends/        # a1111.py, comfy.py (+ graph surgery), api.py (hosted)
│   │   └── workflows/       # Bundled ComfyUI graphs (txt2img / img2img)
│   ├── research/            # Multi-agent research — lead + parallel subagents
│   │   ├── lead.py          # Drives one run: brief → plan → delegate → report
│   │   ├── worker.py        # One delegated task in its own loop
│   │   ├── fanout.py        # Parallel round with timeout + failure isolation
│   │   ├── budget.py        # Caps + spend counters
│   │   ├── observer.py      # Loop events → progress steps + source list
│   │   └── sources.py       # URL extraction/dedup + citation audit
│   ├── tools/
│   │   ├── factory.py       # build_tool_registry() — per-request assembly
│   │   ├── registry.py      # ToolRegistry — register/execute tools
│   │   ├── bash_tool.py     # Shell command execution
│   │   ├── grep_tool.py     # Content search in one process
│   │   ├── read_file.py / write_file.py / edit_file.py / list_dir.py
│   │   ├── present_files.py # Surfaces files as UI cards
│   │   ├── read_skill.py    # Reads SKILL.md on demand
│   │   ├── read_photo.py    # Image content extraction
│   │   ├── ask_user.py      # Ends the turn with a question
│   │   ├── math_verify.py   # Independent check of a final claim (one-rewrite cap)
│   │   ├── math_eval.py     # Preconfigured calculator
│   │   ├── math_plot.py     # Plot kind + expressions → themed SVG
│   │   ├── research_tool.py # Nested-agent web research
│   │   ├── image_generate.py# Prompt → PNG in <chat>/images/
│   │   ├── show_widget.py   # Inline HTML/SVG visualizations
│   │   ├── memory_tools.py  # remember / recall / forget
│   │   ├── url_guard.py     # web_fetch SSRF policy
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
│   │   ├── api_base.py      # Local endpoints need no API key
│   │   ├── models_fetcher.py
│   │   └── usage_logging.py / token_breakdown.py
│   ├── store/
│   │   ├── chat_store.py    # SQLite chat storage
│   │   ├── project_store.py # SQLite project storage
│   │   ├── settings_store.py# Settings state + validation policy
│   │   ├── settings_io.py   # settings.json atomic I/O + secret split/merge
│   │   ├── secret_store.py  # Named secrets — OS keychain, 0600 file fallback
│   │   ├── usage_store.py   # SQLite usage/cost log
│   │   ├── memory_store.py  # Agent memory + FTS5 (core window + archive search)
│   │   └── verification_store.py # Cross-chat history of every math_verify outcome
│   ├── web_search/          # Web search (native/Tavily/SearXNG)
│   └── skills/
│       ├── reader.py        # Scans SKILL.md files
│       ├── installer.py     # GitHub/archive/local skill installer
│       ├── catalog.py       # Curated skill catalog (office four + math + agentchat + …)
│       └── bundled_sync.py  # Startup refresh of installed bundled skills
│
├── ui/src/
│   ├── App.tsx              # Root — settings context, layout
│   ├── Debug*Harness.tsx    # Dev-only presentation harnesses (?debug-composer, -math, …)
│   ├── hooks/               # useChats, useSSE, useProjects, useAgents, useIsMobile, ...
│   ├── contexts/SettingsContext.tsx
│   ├── shortcuts/registry.ts# Keyboard shortcut definitions
│   ├── components/
│   │   ├── Chat/            # ChatView, ChatInput (mode tabs), MessageBubble,
│   │   │                    # VerificationBadge, MathPlotCard, ImageGenCard,
│   │   │                    # RetryNotice, SourcesBox, Research/, MCPChip, ...
│   │   ├── Mobile/          # MobileConnect — backend connect/reconnect (APK + PWA)
│   │   ├── MathMarkdown.tsx # The markdown renderer — Astryx <Markdown/> + LaTeX
│   │   ├── AgentAvatar.tsx  # Gradient agent-persona avatar
│   │   ├── Settings/        # SettingsPanel + tabs (Profile/Appearance/Terminal/Sandbox/
│   │   │                    # Providers/Models/Paths/MCP/Agents/Shortcuts/About),
│   │   │                    # agents/ (persona editor, tool policy, memory list),
│   │   │                    # providers/ (web search, image gen, SearXNG installer)
│   │   ├── Projects/        # ProjectsView, ProjectDetail
│   │   ├── Artifacts/       # ArtifactCard, ArtifactViews, FilesPanel, WidgetView, ...
│   │   ├── Skills/          # SkillsManager (master-detail, mobile-swappable)
│   │   ├── ToolCalls/       # UserQuestionCard (ask_user)
│   │   ├── Usage/           # UsageDashboardPage — cost summary, breakdown, daily chart
│   │   ├── Onboarding/      # OnboardingWizard
│   │   ├── Sidebar.tsx / LibraryPage.tsx / AllChatsPage.tsx / FilesGalleryPage.tsx
│   │   └── GlobalDropZone.tsx
│   ├── types/               # chat.ts, tool-call.ts, artifact.ts, project.ts, agent.ts
│   ├── i18n/                # react-i18next setup, en/ru catalogs
│   └── utils/               # apiBase, serverMode, chatModes, verification, imageGen,
│                            # mathPlot, widgetTheme, latexExtract, downloadAndOpen, ...
│
├── skills/                  # Bundled skills shipped in the repo (office four + math + agentchat)
├── scripts/                 # build-backend.ps1/.sh + install-server.sh (VDS deployment)
├── src-tauri/               # Tauri shell — Rust
│   ├── src/                 # main.rs (desktop entry), lib.rs (shared run()),
│   │                        # desktop_backend.rs (sidecar), server_mode.rs
│   └── capabilities/        # default.json, desktop-downloads.json, mobile.json
└── tests/
    ├── backend/             # pytest — loop, tools, sandbox, streaming, maths, research
    └── ui/                  # node tests/ui/run.mjs — UI logic suites
```

</details>
