---
name: docx
description: "Use when the user wants to create, read, edit, or convert Word documents (.docx). Triggers: 'Word doc', '.docx', a report/memo/letter/template deliverable, extracting or reorganizing content from a Word file, adding headings/tables/images/page numbers/table of contents, find-and-replace in a Word file, or converting Markdown/text to .docx (or .doc to .docx). Do NOT use for PDFs, spreadsheets, or presentations."
version: "1.0.0"
author: AgentChat
---

# Word documents (.docx)

Create, read, and edit `.docx` files with the open-source **python-docx**
library, plus `pandoc`/LibreOffice for conversions. Original guide for AgentChat.

## Running in AgentChat

- **Save in the chat folder.** Write the final document to the current chat's
  working directory with a relative path (e.g. `report.docx`).
- **Show it.** When the file is ready, call the **`present_files`** tool with its
  path so the user gets a download card. Present the final document only.
- **Dependencies:** Python with **`python-docx`** (`pip install python-docx`).
  Optional: **pandoc** (rich read / Markdown→docx), **LibreOffice** (`.doc`→
  `.docx` and PDF export). If a tool is missing, ask the user to install it from
  **Settings → Terminal** — don't install it yourself.

## Reading / extracting content

Quick text dump with pandoc (keeps structure as Markdown):

```bash
pandoc input.docx -o extracted.md
```

Or in Python (also gives you tables and paragraph styles):

```python
from docx import Document

doc = Document("input.docx")
for p in doc.paragraphs:
    print(p.style.name, "|", p.text)
for table in doc.tables:
    for row in table.rows:
        print([cell.text for cell in row.cells])
```

Legacy `.doc` must be converted first (needs LibreOffice):

```bash
soffice --headless --convert-to docx input.doc --outdir .
```

## Creating a document

```python
from docx import Document
from docx.shared import Pt, Inches, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH

doc = Document()

# Default font for the whole document
style = doc.styles["Normal"]
style.font.name = "Calibri"
style.font.size = Pt(11)

doc.add_heading("Quarterly Report", level=0)        # title
doc.add_heading("Summary", level=1)
p = doc.add_paragraph("Revenue grew ")
p.add_run("15%").bold = True
p.add_run(" year over year.")

# Bulleted / numbered lists use built-in styles (never type "•" yourself)
doc.add_paragraph("First point", style="List Bullet")
doc.add_paragraph("Step one", style="List Number")

doc.save("report.docx")
```

### Tables

```python
table = doc.add_table(rows=1, cols=3)
table.style = "Light Grid Accent 1"          # a built-in style → clean borders
hdr = table.rows[0].cells
hdr[0].text, hdr[1].text, hdr[2].text = "Item", "Qty", "Price"
for item, qty, price in rows_data:
    cells = table.add_row().cells
    cells[0].text, cells[1].text, cells[2].text = item, str(qty), f"${price}"
```

### Images

```python
from docx.shared import Inches
doc.add_picture("chart.png", width=Inches(6))   # width keeps aspect ratio
```

### Page setup, headers/footers, page breaks

```python
from docx.shared import Inches
from docx.enum.section import WD_ORIENT

section = doc.sections[0]
section.page_width, section.page_height = Inches(8.5), Inches(11)   # US Letter
section.left_margin = section.right_margin = Inches(1)

section.header.paragraphs[0].text = "Company Name"
section.footer.paragraphs[0].text = "Confidential"

doc.add_page_break()
```

For automatic page numbers in the footer, python-docx needs a raw field — add a
`PAGE` field run; for most reports a static footer is enough.

## Editing an existing document

### Find-and-replace — use the bundled script

A visible word in Word is often split across several runs, so naive
`run.text.replace(...)` silently misses matches that cross run boundaries. Use
**`scripts/replace.py`**, which is run-aware and preserves formatting (it walks
the body, tables, headers, and footers):

```bash
python scripts/replace.py input.docx output.docx --replace "{{year}}" "2026"
python scripts/replace.py input.docx output.docx -r "{{name}}" "Acme" -r "{{date}}" "Jun 2026"
python scripts/replace.py input.docx output.docx --map tokens.json   # {"{{a}}": "b"}
```

(Paths are relative to this skill's directory — see the read_skill header for the
`cd` command.)

### Other edits in Python

```python
from docx import Document
doc = Document("input.docx")
doc.paragraphs[0].text = "New title"
doc.add_paragraph("Appended note.")
doc.save("output.docx")
```

## Converting Markdown → .docx

When the user gives Markdown/prose, pandoc is the fastest path:

```bash
pandoc notes.md -o notes.docx
# Use a reference doc to control styles/fonts:
pandoc notes.md --reference-doc=template.docx -o notes.docx
```

## Export to PDF (optional)

```bash
soffice --headless --convert-to pdf report.docx --outdir .
```

## Tips

- Prefer **built-in styles** (`Heading 1`, `List Bullet`, `Light Grid Accent 1`)
  over manual formatting — they render consistently and keep a real outline (so
  a Table of Contents works in Word).
- Set an explicit page size; Word/LibreOffice defaults differ by locale.
- For charts, render an image (e.g. with matplotlib) and `add_picture` it.
- After saving, `present_files("report.docx")`.
