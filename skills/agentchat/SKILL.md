---
name: agentchat
description: "Read this whenever the user asks about AgentChat itself — the app they are using right now. Triggers: questions about what AgentChat is or can do, its features (chats, projects, skills, MCP, web search, research, widgets, file tools, attachments, remote/phone access, themes, languages), how to do something in the app, where a setting lives, why the agent can or can't access a file, which providers/models are supported, how the sandbox/shell works, or troubleshooting the app. Use this to answer 'how do I…', 'can AgentChat…', 'where is…', 'why did it…' questions about the application. Do NOT use it for general coding tasks unrelated to the app."
version: "1.0.0"
author: AgentChat
---

# AgentChat — application guide

AgentChat is a **local-first desktop AI chat with a real agentic loop**. The user
brings their own provider API keys; the agent can run shell commands, read/write
files in a sandbox, call skills, use MCP tools, search the web, and produce files
— all streamed live. This skill is the source of truth for answering questions
**about the app itself**.

> When the user asks the exact version, point them to **Settings → About** (don't
> guess a number). Everything below is stable across versions.

## What it is

- **Native desktop app**: a Rust/Tauri shell around a webview, with a bundled
  Python backend (the agent loop) and a React UI. Runs offline except for the
  provider API calls the user configures.
- **Local-first**: API keys, chats, projects, and settings stay on the user's
  machine. The only outbound traffic is the LLM provider calls.
- **Self-updating**: the installed app checks for new releases on launch.

## Providers & models

- Multi-provider, switchable **per chat**: OpenAI, Anthropic, Google Gemini,
  DeepSeek, OpenRouter, or **any OpenAI-compatible endpoint** (e.g. LM Studio,
  local servers).
- Keys are entered in **Settings → Providers**; the default model is chosen in
  **Settings → Models**. The model dropdown at the top of a chat overrides it for
  that chat.
- Vision: images are sent to the model optimistically; if a provider rejects
  them, the agent retries the turn as text.

## The agentic loop & tools

The model doesn't just chat — it acts, with each step streamed live. Built-in
tools:

- **bash_tool** — run shell commands.
- **read_file / write_file / edit_file** — file I/O (write/edit stream a live
  preview in the chat).
- **present_files** — surface finished files as viewable/downloadable cards.
- **read_photo** — extract image content.
- **read_skill** — load a skill's full instructions on demand.
- **web_search / web_fetch** — when web search is enabled.
- **show_widget** — render an inline themed HTML/SVG/Canvas visualization.
- MCP tools — anything exposed by connected MCP servers.

## Sandbox & shell

- **Sandboxed by default**: the agent sees only the **current chat's folder**.
  Attempts to read/write outside it are blocked. Settings and app-internal dirs
  are always off-limits.
- An opt-in **unrestricted mode** (Settings → Sandbox) lifts the cage.
- **Shell**: bash runs through **WSL** on Windows, with a **PowerShell** fallback;
  on Linux/macOS a native **posix** shell. Configured in **Settings → Terminal**,
  which also detects and installs office-document tooling (pandoc, LibreOffice,
  Node, Python libs, poppler) used by some skills.
- If the agent says it "can't access" a path, it's almost always the sandbox —
  the file is outside the chat folder, or unrestricted mode is off.

## Chats, projects, attachments

- **Chats** live in the sidebar; each has its own folder. Messages support
  variants/branches (retry/edit a message to fork), copy, and edit.
- **Projects** group related chats with a shared **system prompt** and **file
  set**, so context carries across chats in the project.
- **Attachments**: drag-and-drop or upload files into a message; they land in the
  chat folder where the agent can read them.
- **All chats / Files gallery** pages browse everything across sessions.

## Skills

- Skills are `SKILL.md`-based capability packs the model reads on demand via
  `read_skill` (only their short descriptions sit in the system prompt, to save
  tokens).
- Managed in **Settings → Skills**: a curated catalog (Word/Excel/PowerPoint/PDF
  document skills + frontend-design), plus install from a **GitHub repo** or a
  local **.skill/.zip** archive.
- Installed skills live in `~/.agents/skills/` and hot-reload.
- The four office skills are bundled and adapted for AgentChat (they write output
  to the chat folder and surface it with `present_files`).

## Web search & research

- **Web search** (toggle in the composer) has three backends: the provider's
  native search, **Tavily** (API key), or a self-hosted **SearXNG** instance.
- **Research** is a sticky mode with its own model: it spins up an internal agent
  loop that gathers sources and writes a `report.md`, shown with live progress and
  a sources panel.

## Widgets

The `show_widget` tool renders interactive HTML/SVG/Canvas inline (Claude-artifact
style), themed to match the app. The HTML lives in the tool call and persists with
the chat; it runs sandboxed (scripts only).

## Remote / phone access

The phone acts as a thin client to the PC backend: enable remote access (Settings
→ Paths), scan the QR, and open the PWA. Access is guarded by a Bearer token;
Tailscale is recommended for reaching the PC from anywhere.

## Appearance & language

- **Themes**: light/dark (Settings → Appearance), with the system-following dark
  mode.
- **Language**: the UI is localized via react-i18next (Settings → Appearance).

## Troubleshooting tips

- **"Can't access that file"** → sandbox: the path is outside the chat folder, or
  enable unrestricted mode (Settings → Sandbox).
- **Office skill fails** → a tool is missing; install deps in **Settings →
  Terminal**.
- **Provider error / "LLM Provider NOT provided"** → check the key in Settings →
  Providers; OpenAI-compatible endpoints are configured as a custom provider.
- **No WSL internet (VPN)** → Settings → Terminal has a WSL network fix.
- **Settings stuck loading after an update** → a stale backend may be running;
  fully quit and relaunch the app.

When the user asks "how do I…" or "where is…", give the concrete location
(usually a Settings tab) and the steps — don't hand-wave.
