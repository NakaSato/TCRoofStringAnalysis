"""Cleaned copies of the PWA daily report workbooks (billing/Phase 1.xlsx, Phase 2.xlsx).

    PYTHONPATH=backend uv run python backend/scripts/clean_pwa_report_workbooks.py \
        --phase 1 "billing/Phase 1.xlsx" --phase 2 "billing/Phase 2.xlsx" --out billing/clean

Each copy has one visible sheet per report day, named DD.MM.YYYY, in date order. Dropped: sheets with no
date (`Sheet`, `Sheet18`) and, for a day with two sheets, the copy that does not match the meter
readings stored in `pwa_meter_days` (the phase 1 workbook has 4–31 May twice). The day of each sheet
comes from `pwa_meter_report.parse_workbook`, the same reading the import uses.

Only `xl/workbook.xml`, its rels, `[Content_Types].xml` and the sheets' `tabSelected` flag are edited;
every cell, format and drawing is copied byte for byte, and the originals are never written. A
`<name>_log.csv` beside each copy lists every original sheet: its new name, or why it was dropped.
"""

from __future__ import annotations

import argparse
import csv
import posixpath
import re
import sqlite3
import zipfile
from collections import defaultdict
from datetime import date
from pathlib import Path
from typing import Dict, List, Optional, Set, Tuple

from app.services.pwa_meter_report import parse_workbook

NS_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"


def stored_meter(db: Path, phase: int) -> Dict[date, Set[float]]:
    con = sqlite3.connect(db)
    out: Dict[date, Set[float]] = defaultdict(set)
    for day, kwh in con.execute(
        "select d.day, d.meter_kwh from pwa_meter_days d join pwa_meter_sites s using (site_id) where s.phase = ? and d.meter_kwh is not null",
        (phase,),
    ):
        out[date.fromisoformat(str(day)[:10])].add(round(float(kwh), 2))
    return out


def plan(path: Path, phase: int, db: Path) -> Tuple[List[Tuple[str, Optional[str], str]], Dict[str, str]]:
    """[(original sheet, new name or None, reason)] in original order, and {original: new} of the kept."""
    sheets = parse_workbook(path.read_bytes(), path.name, date.today())
    stored = stored_meter(db, phase)
    by_day: Dict[date, list] = defaultdict(list)
    for s in sheets:
        if s.day:
            by_day[s.day].append(s)

    def matches(s) -> int:
        vals = set()
        for r in s.rows:
            for v in (r.meter_kwh, r.table[0] if r.table else None):
                if v is not None:
                    vals.add(round(v, 2))
        return len(vals & stored.get(s.day, set()))

    keep: Dict[str, str] = {}
    log: List[Tuple[str, Optional[str], str]] = []
    winner: Dict[date, str] = {}
    for day, group in by_day.items():
        if len(group) == 1:
            winner[day] = group[0].sheet
        else:
            scores = sorted(((matches(s), s.sheet) for s in group), reverse=True)
            if scores[0][0] == scores[1][0]:
                raise SystemExit(f"{path.name}: {day} has sheets {[n for _, n in scores]} and none matches the database better")
            winner[day] = scores[0][1]
    for s in sheets:
        if s.day is None:
            log.append((s.sheet, None, "dropped: no date (no title, the name is not a day)"))
        elif winner[s.day] != s.sheet:
            log.append((s.sheet, None, f"dropped: second copy of {s.day:%d.%m.%Y}; sheet {winner[s.day]!r} matches the stored meter readings"))
        else:
            new = f"{s.day:%d.%m.%Y}"
            keep[s.sheet] = new
            how = "date from the title" if s.day_source == "title" else "date from the sheet name in sequence"
            if len(by_day[s.day]) > 1:
                how += f"; kept over {[o.sheet for o in by_day[s.day] if o.sheet != s.sheet]} (matches the stored meter readings)"
            log.append((s.sheet, new, how))
    return log, keep


def _attr(tag: str, name: str) -> Optional[str]:
    m = re.search(rf'\s{name}="([^"]*)"', tag)
    return m.group(1) if m else None


def _xml_name(s: str) -> str:
    return s.replace("&", "&amp;").replace('"', "&quot;").replace("<", "&lt;").replace(">", "&gt;")


def _unxml(s: str) -> str:
    return s.replace("&quot;", '"').replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&")


def rewrite(src: Path, dst: Path, keep: Dict[str, str]) -> None:
    zin = zipfile.ZipFile(src)
    wb = zin.read("xl/workbook.xml").decode("utf-8")
    rels = zin.read("xl/_rels/workbook.xml.rels").decode("utf-8")
    ctypes = zin.read("[Content_Types].xml").decode("utf-8")

    rel_target = {_attr(t, "Id"): _attr(t, "Target") for t in re.findall(r"<Relationship\b[^>]*>", rels)}
    m = re.search(r"<sheets>(.*?)</sheets>", wb, re.S)
    assert m, "no <sheets> in workbook.xml"
    tags = re.findall(r"<sheet\b[^>]*/>", m.group(1))
    by_new: Dict[str, str] = {}
    drop_rids: List[str] = []
    for t in tags:
        name = _unxml(_attr(t, "name") or "")
        rid = _attr(t, f"r:id") or ""
        if name in keep:
            t2 = re.sub(r'\sstate="[^"]*"', "", t)  # every kept day visible
            t2 = re.sub(r'\sname="[^"]*"', f' name="{_xml_name(keep[name])}"', t2)
            by_new[keep[name]] = t2
        else:
            drop_rids.append(rid)
    order = sorted(by_new, key=lambda n: date(int(n[6:]), int(n[3:5]), int(n[:2])))
    wb = wb[: m.start(1)] + "".join(by_new[n] for n in order) + wb[m.end(1):]
    # open on the newest day when the workbook keeps a view, else Excel opens the first sheet
    active = len(order) - 1 if "<workbookView" in wb else 0
    wb = re.sub(r'\sactiveTab="\d+"', "", wb)
    wb = re.sub(r"<workbookView\b", f'<workbookView activeTab="{active}"', wb, count=1)
    wb = re.sub(r'\sfirstSheet="\d+"', "", wb)

    # parts of the dropped sheets: the sheet, its rels and whatever only they point at (drawings)
    def part(base: str, target: str) -> str:
        return posixpath.normpath(posixpath.join(posixpath.dirname(base), target)) if not target.startswith("/") else target[1:]

    def rels_of(p: str) -> str:
        return posixpath.join(posixpath.dirname(p), "_rels", posixpath.basename(p) + ".rels")

    def deps(p: str) -> Set[str]:
        r = rels_of(p)
        if r not in zin.namelist():
            return set()
        out = {r}
        for t in re.findall(r"<Relationship\b[^>]*>", zin.read(r).decode("utf-8")):
            if _attr(t, "TargetMode") == "External":
                continue
            q = part(p, _attr(t, "Target") or "")
            if q in zin.namelist():
                out |= {q} | deps(q)
        return out

    kept_rids = {_attr(t, "r:id") for t in by_new.values()}
    kept_parts: Set[str] = set()
    for rid in kept_rids:
        p = part("xl/workbook.xml", rel_target[rid] or "")
        kept_parts |= {p} | deps(p)
    drop: Set[str] = set()
    for rid in drop_rids:
        p = part("xl/workbook.xml", rel_target[rid] or "")
        drop |= ({p} | deps(p)) - kept_parts
    for rid in drop_rids:
        rels = re.sub(rf'<Relationship\b[^>]*\sId="{re.escape(rid)}"[^>]*/>', "", rels)
    for p in drop:
        ctypes = re.sub(rf'<Override\b[^>]*PartName="/{re.escape(p)}"[^>]*/>', "", ctypes)

    active_part = part("xl/workbook.xml", rel_target[_attr(by_new[order[active]], "r:id")] or "")
    dst.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as zout:
        for info in zin.infolist():
            n = info.filename
            if n in drop:
                continue
            if n == "xl/workbook.xml":
                data = wb.encode("utf-8")
            elif n == "xl/_rels/workbook.xml.rels":
                data = rels.encode("utf-8")
            elif n == "[Content_Types].xml":
                data = ctypes.encode("utf-8")
            elif n.startswith("xl/worksheets/sheet") and n.endswith(".xml"):
                data = zin.read(n)
                # one selected tab (else Excel opens with the sheets grouped)
                s = re.sub(rb'\stabSelected="(1|true)"', b"", data, count=1)
                if n == active_part:
                    s = re.sub(rb"<sheetView\b", b'<sheetView tabSelected="1"', s, count=1)
                data = s
            else:
                data = zin.read(n)
            zout.writestr(info, data)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--phase", nargs=2, action="append", metavar=("PHASE", "FILE"), required=True)
    ap.add_argument("--out", type=Path, default=Path("billing/clean"))
    ap.add_argument("--db", type=Path, default=Path("data/solar_fullstack.db"), help="SQLite DB holding pwa_meter_days")
    a = ap.parse_args()
    for phase, file in a.phase:
        src = Path(file)
        log, keep = plan(src, int(phase), a.db)
        dst = a.out / f"{src.stem} (clean).xlsx"
        rewrite(src, dst, keep)
        with open(a.out / f"{src.stem} (clean)_log.csv", "w", newline="", encoding="utf-8-sig") as fh:
            w = csv.writer(fh)
            w.writerow(["original_sheet", "clean_sheet", "note"])
            w.writerows((o, n or "", why) for o, n, why in log)
        print(f"{src.name}: {len(log)} sheets → {len(keep)} kept, {len(log) - len(keep)} dropped → {dst}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
