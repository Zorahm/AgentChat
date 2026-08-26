"""Did a tool actually succeed, or did it just decline to raise?

Every tool here catches its own failures and returns them as text — that is
deliberate (``agent.loop`` must keep going, and the model needs to read what
went wrong). The cost is that "no exception" stops meaning "worked": a failed
``write_file`` reached the UI with ``success=True`` and drew a green check next
to a file that was never written.

So the loop asks this module instead. It reads the tool's own output, which is
the only signal the tools actually produce, and the rules differ per tool
because their outputs differ in kind: ``bash_tool`` relays whatever a command
printed, ``read_file`` relays file contents, and everything else returns text
this app wrote.

Only the ``success`` flag on the ``tool_end`` event changes. The model receives
the identical text either way, and the turn continues exactly as before.
"""

from __future__ import annotations

import re

# "Error: file not found — …", "Error writing file: …" — both shapes are in use
# across the tools, so match the word plus its separator rather than one prefix.
_ERROR_START = re.compile(r"^Error[: ]")

# bash relays a command's own stdout/stderr, where a line beginning with "Error"
# is ordinary output, not a tool failure. Its real signals are the two markers
# ``tools.bash_tool`` adds itself; ``[exit code: N]`` is only ever appended for a
# non-zero exit.
_BASH_MARKERS = ("[bash_tool error]", "[exit code:")

# Tools whose output is arbitrary content the user chose (file text, an image
# note). Their own errors are always one short line, so anything longer or
# multi-line is content that merely happens to start with "Error".
_CONTENT_TOOLS = frozenset({"read_file", "read_photo"})
_CONTENT_ERROR_MAX = 300


def looks_failed(name: str, output: str) -> bool:
    """True when *output* is a tool reporting its own failure.

    Conservative by construction: when in doubt it returns False, because a
    green check on a broken call is a smaller lie than a red cross on a call
    that worked.
    """
    if not output:
        return False

    if name == "bash_tool":
        return any(marker in output for marker in _BASH_MARKERS)

    if not _ERROR_START.match(output):
        return False

    if name in _CONTENT_TOOLS:
        # One short line — the shape of these tools' own error returns.
        return "\n" not in output.strip() and len(output) <= _CONTENT_ERROR_MAX

    return True
