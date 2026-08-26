"""Formats that cannot be produced by writing text, and what to do instead.

``write_file``/``edit_file`` hand the model a string. A ``.docx`` is a ZIP
container, a ``.pdf`` is a binary document — writing either as text yields a file
that opens as garbage, and the failure surfaces to the *user* (a broken download
card), not to the model. So the tools refuse the write and name the library that
does produce a real file.

There is no legitimate case on the other side of this rule: every extension here
is binary or a container. Text formats that merely *look* office-ish (``.csv``,
``.md``, ``.rtf``, ``.html``, ``.txt``) are deliberately absent — those are
written as text and always were.
"""

from __future__ import annotations

import posixpath

# extension → the Python route that actually produces the format.
_GENERATORS: dict[str, str] = {
    ".docx": "python-docx (`from docx import Document`)",
    ".doc": "python-docx to write .docx, then `soffice --headless --convert-to doc`",
    ".xlsx": "openpyxl (`from openpyxl import Workbook`) or pandas `.to_excel()`",
    ".xlsm": "openpyxl (`from openpyxl import Workbook`)",
    ".xls": "openpyxl to write .xlsx, then `soffice --headless --convert-to xls`",
    ".pptx": "python-pptx (`from pptx import Presentation`)",
    ".ppt": "python-pptx to write .pptx, then `soffice --headless --convert-to ppt`",
    ".pdf": "reportlab, or write .docx/.md first and `soffice --headless --convert-to pdf`",
    ".odt": "`soffice --headless --convert-to odt` from a generated .docx",
    ".ods": "`soffice --headless --convert-to ods` from a generated .xlsx",
    ".odp": "`soffice --headless --convert-to odp` from a generated .pptx",
    ".epub": "pandoc from Markdown, or ebooklib",
}

#: The extensions the file-writing tools refuse. Exposed for tests and prompts.
BINARY_DOC_EXTENSIONS: frozenset[str] = frozenset(_GENERATORS)


def binary_format_refusal(path: str, *, verb: str = "write") -> str | None:
    """The error to return when *path* names a format text cannot express.

    ``None`` when the path is fine to write as text — the overwhelmingly common
    case, so the check costs one ``splitext`` and a dict lookup.
    """
    ext = posixpath.splitext(path.replace("\\", "/"))[1].lower()
    generator = _GENERATORS.get(ext)
    if generator is None:
        return None
    return (
        f"Error: refusing to {verb} {ext} as text — it is a binary/container format, "
        f"and a text {verb} produces a corrupt file the user cannot open.\n"
        f"Generate it with code instead: {generator}.\n"
        f"The generator script itself is ordinary text — write_file a .py and run it "
        f"with bash_tool (or pipe a heredoc), then surface the result with "
        f"present_files. Read the matching skill for a full recipe."
    )
