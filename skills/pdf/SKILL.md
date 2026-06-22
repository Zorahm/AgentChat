---
name: pdf
description: "Use for anything involving PDF files: extracting text or tables, merging/splitting/rotating pages, adding watermarks, creating PDFs from scratch or from text/HTML, filling simple form fields, encrypting/decrypting, extracting images, and OCR on scanned PDFs. Trigger when the user mentions a .pdf file or wants a PDF deliverable."
version: "1.0.0"
author: AgentChat
---

# PDF files

Read, manipulate, and create PDFs with open-source Python libraries
(**pypdf**, **pdfplumber**, **reportlab**) and **poppler** CLI tools. Original
guide for AgentChat.

## Running in AgentChat

- **Save in the chat folder.** Write the final PDF to the current chat's working
  directory with a relative path (e.g. `output.pdf`).
- **Show it.** When ready, call the **`present_files`** tool with its path so the
  user gets a viewable/downloadable card. Present the final PDF only — not
  intermediate page images.
- **Dependencies:** Python with **`pypdf`**, **`pdfplumber`**, **`reportlab`**
  (`pip install pypdf pdfplumber reportlab`); **poppler** for `pdftotext`/
  `pdftoppm`; for OCR also **`pdf2image`** + **`pytesseract`** and the Tesseract
  engine. If a tool is missing, ask the user to install it from **Settings →
  Terminal** — don't install it yourself.

## Extracting text

Fast CLI dump (poppler):

```bash
pdftotext -layout input.pdf output.txt
pdftotext -f 1 -l 5 input.pdf first5.txt      # pages 1–5
```

Python, with layout/tables (pdfplumber):

```python
import pdfplumber
with pdfplumber.open("input.pdf") as pdf:
    for i, page in enumerate(pdf.pages, start=1):
        print(f"--- page {i} ---")
        print(page.extract_text() or "")
        for table in page.extract_tables():
            for row in table:
                print(row)
```

## Merge / split / rotate (pypdf)

```python
from pypdf import PdfReader, PdfWriter

# Merge
writer = PdfWriter()
for path in ("a.pdf", "b.pdf"):
    for page in PdfReader(path).pages:
        writer.add_page(page)
with open("merged.pdf", "wb") as f:
    writer.write(f)

# Split into one file per page
reader = PdfReader("input.pdf")
for i, page in enumerate(reader.pages, start=1):
    w = PdfWriter()
    w.add_page(page)
    with open(f"page-{i}.pdf", "wb") as f:
        w.write(f)

# Rotate page 1 by 90°
reader = PdfReader("input.pdf"); w = PdfWriter()
for i, page in enumerate(reader.pages):
    if i == 0:
        page.rotate(90)
    w.add_page(page)
with open("rotated.pdf", "wb") as f:
    w.write(f)
```

## Creating a PDF (reportlab)

Simple flowing document with Platypus:

```python
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle
from reportlab.lib import colors

styles = getSampleStyleSheet()
story = [
    Paragraph("Quarterly Report", styles["Title"]),
    Spacer(1, 12),
    Paragraph("Revenue grew <b>15%</b> year over year.", styles["BodyText"]),
    Spacer(1, 12),
]
data = [["Item", "Qty", "Price"], ["Widget", "120", "$9.99"]]
t = Table(data)
t.setStyle(TableStyle([
    ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1F4E78")),
    ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
    ("GRID", (0, 0), (-1, -1), 0.5, colors.grey),
]))
story.append(t)

SimpleDocTemplate("output.pdf", pagesize=letter).build(story)
```

> **Never** use Unicode sub/superscript glyphs (₀¹², etc.) in reportlab — the
> built-in fonts lack them and render as black boxes. Use `<sub>`/`<super>` tags
> in a `Paragraph` instead.

Another option: render to HTML/Markdown and convert with `pandoc input.md -o
output.pdf` (needs a LaTeX engine or `--pdf-engine=weasyprint`), or export from
LibreOffice (`soffice --headless --convert-to pdf input.docx`).

## Watermark / stamp (pypdf)

```python
from pypdf import PdfReader, PdfWriter
base = PdfReader("input.pdf")
stamp = PdfReader("watermark.pdf").pages[0]   # a 1-page PDF with the mark
w = PdfWriter()
for page in base.pages:
    page.merge_page(stamp)
    w.add_page(page)
with open("stamped.pdf", "wb") as f:
    w.write(f)
```

## Encrypt / decrypt (pypdf)

```python
from pypdf import PdfReader, PdfWriter
w = PdfWriter(clone_from="input.pdf")
w.encrypt("user-password")
with open("encrypted.pdf", "wb") as f:
    w.write(f)

r = PdfReader("encrypted.pdf")
if r.is_encrypted:
    r.decrypt("user-password")
```

## Filling form fields — use the bundled script

For PDFs that already have AcroForm fields, use **`scripts/fill_form.py`**. It
sets the `/NeedAppearances` flag so the values actually render in viewers (the
classic invisible-fill bug) and fills across all pages:

```bash
python scripts/fill_form.py form.pdf --list                 # inspect field names/types first
python scripts/fill_form.py form.pdf filled.pdf -f full_name "Jane Doe" -f agree "/Yes"
python scripts/fill_form.py form.pdf filled.pdf --data values.json
```

(Paths are relative to this skill's directory — see the read_skill header for the
`cd` command. Always `--list` first: field names are rarely what you'd guess, and
checkbox on-states vary.)

If the PDF has **no** form fields, overlay text instead: draw the values onto a
transparent reportlab page positioned by coordinates, then `merge_page` it onto
the original (same pattern as the watermark above).

## PDF → images & OCR

```bash
pdftoppm -png -r 200 input.pdf page          # page-1.png, page-2.png, …
```

```python
# OCR a scanned PDF (needs pdf2image + pytesseract + Tesseract engine)
from pdf2image import convert_from_path
import pytesseract
text = "\n".join(pytesseract.image_to_string(img)
                 for img in convert_from_path("scan.pdf", dpi=300))
open("ocr.txt", "w", encoding="utf-8").write(text)
```

## Tips

- For text-based PDFs use pdfplumber/pypdf; only fall back to OCR for scans
  (images of text).
- When creating PDFs, set the page size explicitly (`letter` vs `A4`).
- Inspect form field names before filling — they're rarely what you'd guess.
- After saving, `present_files("output.pdf")`.
