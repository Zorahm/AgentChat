#!/usr/bin/env python3
"""Inspect and fill AcroForm fields in a PDF, with values that actually render.

Why a script: the common failure when filling PDF forms is that the values are
written but stay invisible in most viewers — because the form's
``/NeedAppearances`` flag isn't set, so the viewer doesn't regenerate field
appearances. This sets it, and fills across all pages.

Usage:
    python fill_form.py form.pdf --list                 # print field names/types
    python fill_form.py form.pdf out.pdf --data data.json
    python fill_form.py form.pdf out.pdf -f name "Jane Doe" -f agree "/Yes"

Checkbox/radio values are the field's export value, usually "/Yes" (inspect with
--list to see the exact on-state).

Requires: pypdf  (pip install pypdf)
"""

from __future__ import annotations

import argparse
import json
import sys

from pypdf import PdfReader, PdfWriter
from pypdf.generic import BooleanObject, NameObject


def list_fields(path: str) -> int:
    reader = PdfReader(path)
    fields = reader.get_fields()
    if not fields:
        print("No AcroForm fields found. This PDF has no fillable form — overlay "
              "text instead (draw a reportlab page and merge_page it).")
        return 0
    for name, field in fields.items():
        ftype = field.get("/FT")
        states = field.get("/_States_")
        extra = f"  states={list(states)}" if states else ""
        print(f"{name}\t{ftype}{extra}")
    return 0


def _set_need_appearances(writer: PdfWriter) -> None:
    """Tell viewers to regenerate field appearances so values are visible."""
    root = writer._root_object
    if "/AcroForm" not in root:
        return
    root["/AcroForm"][NameObject("/NeedAppearances")] = BooleanObject(True)


def fill(path: str, out: str, data: dict[str, str]) -> int:
    reader = PdfReader(path)
    if not reader.get_fields():
        print("No fillable fields — nothing to fill. Overlay text instead.", file=sys.stderr)
        return 2

    writer = PdfWriter(clone_from=reader)
    _set_need_appearances(writer)
    for page in writer.pages:
        writer.update_page_form_field_values(page, data, auto_regenerate=False)

    with open(out, "wb") as fh:
        writer.write(fh)
    print(f"Filled {len(data)} field(s) → {out}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Inspect / fill PDF AcroForm fields")
    ap.add_argument("input")
    ap.add_argument("output", nargs="?", help="output path (omit with --list)")
    ap.add_argument("--list", action="store_true", help="list field names and types")
    ap.add_argument("-f", "--field", nargs=2, action="append", metavar=("NAME", "VALUE"),
                    default=[], help="a field value; repeatable")
    ap.add_argument("--data", help="JSON file of {\"field\": \"value\", ...}")
    args = ap.parse_args()

    if args.list:
        return list_fields(args.input)

    if not args.output:
        ap.error("output path is required when filling (or pass --list)")

    data: dict[str, str] = {name: value for name, value in args.field}
    if args.data:
        with open(args.data, encoding="utf-8") as fh:
            data.update({str(k): str(v) for k, v in json.load(fh).items()})
    if not data:
        ap.error("provide values with --field NAME VALUE or --data file.json")

    return fill(args.input, args.output, data)


if __name__ == "__main__":
    sys.exit(main())
