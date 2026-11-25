"""PDF reading for the Knowledge Base library: page count, the text layer per page, and OCR of
pages that have none (docs/plans/kb-documents.md §6).

pypdfium2 (PDFium, Apache-2.0 / BSD) reads the file; nothing is written back to it. OCR runs only
in the worker (`kb_ocr` job): each page is rendered grey at `KB_OCR_DPI` and piped to the
`tesseract` command line as a PGM image (no image library needed). Only the languages of
`KB_OCR_LANGS` that tesseract has installed are used; none installed = OCR off.
"""

from __future__ import annotations

import functools
import re
import shutil
import subprocess
import unicodedata
from dataclasses import dataclass
from typing import List, Optional

import numpy as np

from app.config import settings

# a page whose text layer has fewer visible characters than this is treated as a scan
MIN_TEXT_CHARS = 10
PAGE_TEXT_MAX = 60_000  # characters kept per page (a dense table page is ~10k)
_WS = re.compile(r"[ \t\f\v ​]+")
_NL = re.compile(r"\s*\n\s*")


class PdfUnreadable(ValueError):
    """Not a PDF PDFium can open (damaged, or password-protected): 422."""


@dataclass
class PageText:
    page_no: int  # 1-based
    text: str
    needs_ocr: bool


def clean_text(text: str) -> str:
    """Normalise extracted text: NFC (Thai vowels and tone marks in one order), CR → LF, runs of
    spaces collapsed, blank lines dropped, capped at PAGE_TEXT_MAX."""
    t = unicodedata.normalize("NFC", text or "").replace("\r\n", "\n").replace("\r", "\n")
    t = _WS.sub(" ", t)
    t = _NL.sub("\n", t).strip()
    return t[:PAGE_TEXT_MAX]


def search_form(text: str) -> str:
    """The page text as the search compares it: lower case, whitespace (also line breaks) single
    spaces, so a phrase broken over two lines still matches."""
    return re.sub(r"\s+", " ", text).lower()


def visible_chars(text: str) -> int:
    return sum(1 for c in text if not c.isspace())


def _open(data: bytes):
    import pypdfium2 as pdfium

    if not data.startswith(b"%PDF-"):
        raise PdfUnreadable("The file is not a PDF.")
    try:
        return pdfium.PdfDocument(data)
    except pdfium.PdfiumError as exc:
        msg = str(exc)
        if "password" in msg.lower():
            raise PdfUnreadable("The PDF is password-protected; upload a copy without a password.") from exc
        raise PdfUnreadable(f"The PDF could not be read ({msg}).") from exc


def read_pages(data: bytes) -> List[PageText]:
    """Every page's text layer (1-based page numbers)."""
    pdf = _open(data)
    try:
        out: List[PageText] = []
        for i in range(len(pdf)):
            page = pdf[i]
            try:
                tp = page.get_textpage()
                try:
                    text = clean_text(tp.get_text_bounded())
                finally:
                    tp.close()
            finally:
                page.close()
            out.append(PageText(page_no=i + 1, text=text, needs_ocr=visible_chars(text) < MIN_TEXT_CHARS))
        return out
    finally:
        pdf.close()


# --------------------------------------------------------------------------- OCR


@functools.lru_cache(maxsize=1)
def _installed_langs() -> frozenset[str]:
    exe = shutil.which("tesseract")
    if not exe:
        return frozenset()
    try:
        r = subprocess.run([exe, "--list-langs"], capture_output=True, text=True, timeout=20)
    except (OSError, subprocess.SubprocessError):
        return frozenset()
    lines = (r.stdout or "").splitlines()[1:]  # first line is a heading
    return frozenset(x.strip() for x in lines if x.strip())


def ocr_langs() -> Optional[str]:
    """The `-l` value to use ("tha+eng"), or None when OCR is unavailable here."""
    have = _installed_langs()
    want = [x for x in settings.kb_ocr_langs.replace(",", "+").split("+") if x.strip()]
    use = [x.strip() for x in want if x.strip() in have]
    return "+".join(use) if use else None


def _pgm(gray: np.ndarray) -> bytes:
    a = np.ascontiguousarray(gray.reshape(gray.shape[0], gray.shape[1]), dtype=np.uint8)
    h, w = a.shape
    return b"P5\n%d %d\n255\n" % (w, h) + a.tobytes()


def ocr_pages(data: bytes, page_nos: List[int], langs: str) -> dict[int, str]:
    """OCR text of the given pages (1-based). A page tesseract fails on is left out."""
    exe = shutil.which("tesseract")
    if not exe or not page_nos:
        return {}
    pdf = _open(data)
    out: dict[int, str] = {}
    scale = max(72, min(600, settings.kb_ocr_dpi)) / 72
    try:
        for n in page_nos:
            if not (1 <= n <= len(pdf)):
                continue
            page = pdf[n - 1]
            try:
                bitmap = page.render(scale=scale, grayscale=True)  # pyright: ignore[reportArgumentType]  # scale is a float (pypdfium2 docs); the stub infers int from the default 1
                img = _pgm(bitmap.to_numpy())
            finally:
                page.close()
            try:
                r = subprocess.run(
                    [exe, "stdin", "stdout", "-l", langs, "--psm", "3"],
                    input=img,
                    capture_output=True,
                    timeout=settings.kb_ocr_timeout_s,
                )
            except subprocess.TimeoutExpired:
                continue
            if r.returncode == 0:
                out[n] = clean_text(r.stdout.decode("utf-8", "replace"))
    finally:
        pdf.close()
    return out
