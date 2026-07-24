"""Model-family detection and per-family prompt quirks.

Everything reaches the model through LiteLLM, but one prompt does not behave
identically on Claude, GPT, Gemini, and locally-hosted open-weight models. This
module maps a LiteLLM model id to a coarse family and returns a short block of
family-specific corrections appended at the end of the static prompt. An
unrecognised id yields an empty family and no block, so the prompt never breaks.
"""

from __future__ import annotations

# Ordered most-specific-signal first. Local runtimes (ollama/lmstudio) and
# open-weight model names win over the OpenAI check, because LM Studio and other
# OpenAI-compatible locals are re-tagged "openai/<model>" upstream — the local
# model name is the only remaining tell.
_LOCAL_MARKERS = (
    "ollama",
    "lmstudio",
    "lm-studio",
    "lm_studio",
    "localhost",
    "llama",
    "qwen",
    "mistral",
    "mixtral",
    "gemma",
    "deepseek",
    "vicuna",
    "koboldcpp",
    "text-generation",
    "/local",
    "local-",
)
_CLAUDE_MARKERS = ("claude", "anthropic")
_GOOGLE_MARKERS = ("gemini", "palm", "bison", "google/")
_OPENAI_MARKERS = ("gpt", "openai", "o1-", "o3-", "o4-", "chatgpt", "davinci")


def detect_family(model: str) -> str:
    """Classify *model* into a coarse family from its id.

    Returns one of ``"claude" | "openai" | "google" | "local"`` or ``""`` when
    nothing matches (an unknown family produces no quirk block).
    """
    m = model.lower()
    if not m:
        return ""
    if any(marker in m for marker in _LOCAL_MARKERS):
        return "local"
    if any(marker in m for marker in _CLAUDE_MARKERS):
        return "claude"
    if any(marker in m for marker in _GOOGLE_MARKERS):
        return "google"
    if any(marker in m for marker in _OPENAI_MARKERS):
        return "openai"
    return ""


# Smaller local models hallucinate tool output and file contents more readily,
# so they get an extra grounding rule. Other families need no correction yet.
_LOCAL_QUIRK = """## Model-specific note

You are running as a local, open-weight model. Be especially strict about grounding: never state the output of a command you did not run, and never describe the contents of a file you did not read. If you have not actually executed or read something this turn, say so plainly instead of filling the gap with a plausible-looking guess."""

_QUIRKS = {"local": _LOCAL_QUIRK}


def family_quirks(family: str) -> str:
    """Return the prompt block for *family*, or ``""`` if it needs none."""
    return _QUIRKS.get(family, "")
