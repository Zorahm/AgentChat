# AGENTS.md — Coding Standards

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

## Project Structure

```
AgentChat/
├── backend/          # Python — FastAPI, agent loop, tools, skills
│   ├── agent/        # Agent loop and configuration
│   ├── tools/        # Tool implementations
│   ├── llm/          # LiteLLM client wrapper
│   ├── api/          # FastAPI routes (Phase 3)
│   └── skills/       # Skills manager, watcher, manifest (Phase 2)
├── ui/               # React + TypeScript frontend (Phase 4)
├── src-tauri/        # Tauri shell — Rust (Phase 5)
├── skills/           # Installed skills directory
└── tests/            # All tests
```

## Code Review Checklist

- [ ] No `any` in TypeScript files
- [ ] All Python functions have parameter and return type hints
- [ ] Pydantic models used for all API contracts and shared structures
- [ ] Files stay under 300 lines (refactor if exceeding)
- [ ] Single responsibility per module (one clear purpose)
- [ ] No commented-out code
- [ ] No hardcoded secrets or keys
