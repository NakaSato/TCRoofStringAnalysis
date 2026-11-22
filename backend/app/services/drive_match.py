"""Match Google Drive file / folder names to Growatt plants (docs/plans/plant-asbuilt-links.md §4).

Pure functions, no DB. The site numbers in Drive names can't be trusted (a PDF named 186 sits in
folder 183, phases 3 and 4 have their own numbering), so names are matched on the site name and
the PWA branch (กปภ.สาขา…) after stripping numbers, "As-built", revisions, kWp, dates and the
region tags Growatt names carry. Scores are 0…1; the caller decides what is accepted.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from difflib import SequenceMatcher
from typing import Iterable, List, Optional, Sequence, Tuple

_REV = re.compile(r"(?:rev\.?\s*|\b[rv])(\d+)\b", re.I)  # "REV.3", "Rev 2", "R1", "V2"
# not drawings: calculation sheets, cable route plans, reports, IV test sheets, forms and photo sets
# share the as-built folders
_NOT_DRAWING = re.compile(
    r"รายการคำนว[ณน]|\bcal\b|route\s*line|รายงาน|iv\s*test|test\s*report|iec\s*62446|before[\s\-]*after|แบบฟอร์ม|ภาพถ่าย|รูปถ่าย",
    re.I,
)
_STRIP = [
    re.compile(r"\.pdf(?:pdf)?$", re.I),  # also "….pdfpdf"
    re.compile(r"^\s*p\d\s*[_\-\s]\s*\d+\s*", re.I),  # Growatt "P2 57 …", "P1_23 …"
    re.compile(r"แบบ\s*as[\s\-]*buil[dt]|as[\s\-]*buil[dt]|as\s*bult", re.I),  # before the number: "AS BUILT 10 …"
    re.compile(r"drawing", re.I),
    re.compile(r"^\s*\d+\s*[\.\-]?\s*"),  # Drive "175 …", "43.…", "17. …"
    re.compile(r"(?:rev\.?\s*|\b[rv])\d+\b", re.I),
    re.compile(r"\d+(?:\.\d+)?\s*kwp", re.I),
    re.compile(r"\b\d{1,2}[\.\-/]\d{1,2}[\.\-/]\d{2,4}\b"),  # 30.07.69, 14-09-26
    re.compile(r"(?<![\d.])\d{6}(?![\d.])"),  # 051126 (ddmmyy)
    re.compile(r"\((?:\d+|s|ขนานไฟ)\)", re.I),  # "(2)" copy suffix, "(S)", "(ขนานไฟ)"
    re.compile(r"\((?:w|ne|n|s|e|c|ce)\)\s*$", re.I),  # Growatt region tag "(NE)"
    re.compile(r"\s(?:w|ne|n|s|e|c)\s*$", re.I),  # "… สุโขทัย N"
]
_DIGITS = re.compile(r"\d+")
_BRANCH = re.compile(r"กปภ\.?\s*(?:สาขา)?\s*(เขต\s*\d+|[^\s()]+)")  # "กปภ.สาขาลำพูน", "กปภ.เขต 9"
# words every PWA site name shares: compared separately so the place name decides
_GENERIC = [
    "สถานีผลิตจ่ายน้ำ", "สถานีผลิต-จ่ายน้ำ", "สถานีผลิตน้ำ-จ่ายน้ำ", "สถานีผลิตน้ำประปา", "สถานีผลิตน้ำ",
    "สถานีจ่ายน้ำ", "สถานีเพิ่มแรงดัน", "สถานีโรงกรองน้ำ", "โรงกรองน้ำ", "โรงสูบน้ำแรงต่ำ", "โรงสูบน้ำแรงสูง",
    "โรงสูบน้ำ", "สำนักงานประปา", "สถานีสำนักงานประปา", "สถานี", "สำนักงาน", "แม่ข่าย", "ประปา", "สาขา",
]
_GENERIC.sort(key=len, reverse=True)


@dataclass(frozen=True)
class SiteName:
    raw: str
    core: str  # the site name, compact (no spaces / punctuation), without the branch
    place: str  # core without the generic words
    branch: Optional[str]  # PWA branch, compact


def _fold(s: str) -> str:
    s = unicodedata.normalize("NFC", s)
    s = s.replace("\u200b", "").replace("เเ", "แ")
    # "นํ้า" typed as nikhahit + tone + sara aa → "น้ำ" (tone + sara am)
    s = re.sub("\u0e4d([\u0e48-\u0e4b]?)\u0e32", "\\1\u0e33", s)
    s = s.replace("การประปาส่วนภูมิภาค", "กปภ.")
    return re.sub(r"\s+", " ", s).strip().lower()


def _compact(s: str) -> str:
    return re.sub(r"[\s\.\-_,()（）'\"]+", "", s)


def is_drawing(title: str) -> bool:
    """False for the calculation sheets, route plans, reports and forms kept next to the drawings."""
    return not _NOT_DRAWING.search(_fold(title))


def revision(title: str) -> Optional[int]:
    """`REV.3` → 3; the highest when a name carries several. None without one."""
    revs = [int(m) for m in _REV.findall(title)]
    return max(revs) if revs else None


def parse(title: str) -> SiteName:
    s = _fold(title)
    for rx in _STRIP:
        s = rx.sub(" ", s).strip()
    branch: Optional[str] = None
    m = _BRANCH.search(s)
    if m:
        branch = _compact(m.group(1)) or None
        s = _BRANCH.sub(" ", s).strip()  # every mention ("…สาขาลำพูน กปภ.สาขาลำพูน")
    core = _compact(s)
    place = core
    for g in _GENERIC:
        place = place.replace(g, "")
    # an office named only by its branch ("สำนักงานประปา กปภ.สาขากาญจนบุรี"): the branch is the place
    return SiteName(raw=title, core=core, place=place or branch or core, branch=branch)


def _ratio(a: str, b: str) -> float:
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    if len(a) >= 3 and len(b) >= 3 and (a in b or b in a):
        return 0.92
    return SequenceMatcher(None, a, b).ratio()


def score(a: SiteName, b: SiteName) -> float:
    """How alike two site names are, 0…1: the place name weighs most, a matching branch adds,
    a different branch takes off (both only when both names carry one)."""
    s = 0.35 * _ratio(a.core, b.core) + 0.65 * _ratio(a.place, b.place)
    if a.branch and b.branch:
        s += 0.08 if _ratio(a.branch, b.branch) >= 0.85 else -0.15
    da, db = _DIGITS.findall(a.place), _DIGITS.findall(b.place)
    if da and db and da != db:  # "ปลายคลอง 1" is not "ปลายคลอง 2"
        s -= 0.3
    return max(0.0, min(1.0, s))


@dataclass(frozen=True)
class Candidate:
    plant_id: int
    names: Tuple[SiteName, ...]  # every known name of the plant (Growatt, PWA report, registry)
    phase: Optional[int] = None


def candidates(plant_id: int, names: Iterable[Optional[str]], phase: Optional[int] = None) -> Candidate:
    seen = []
    for n in names:
        if n and n.strip() and n not in seen:
            seen.append(n)
    return Candidate(plant_id=plant_id, names=tuple(parse(n) for n in seen), phase=phase)


def best(title: str, plants: Sequence[Candidate], phases: Optional[Sequence[int]] = None) -> List[Tuple[int, float]]:
    """Plants ranked for one Drive name: [(plant_id, score)], best first. `phases` limits the
    plants to those phases when the file sits in a phase folder (a plant with no phase stays in)."""
    site = parse(title)
    out = []
    for c in plants:
        if phases and c.phase is not None and c.phase not in phases:
            continue
        sc = max((score(site, n) for n in c.names), default=0.0)
        out.append((c.plant_id, round(sc, 3)))
    out.sort(key=lambda x: -x[1])
    return out


AUTO_ACCEPT = 0.9
AUTO_MARGIN = 0.1
AUTO_MARGIN_EXACT = 0.05


def verdict(ranked: Sequence[Tuple[int, float]]) -> str:
    """`auto` when the best is ≥ AUTO_ACCEPT and the runner-up ≥ AUTO_MARGIN below (AUTO_MARGIN_EXACT
    for an exact name), `review` when
    the best is at least 0.6, else `none`."""
    if not ranked:
        return "none"
    top = ranked[0][1]
    second = ranked[1][1] if len(ranked) > 1 else 0.0
    # an exact name (≥ 0.99) needs a smaller lead: the runner-up is then only a near namesake
    margin = AUTO_MARGIN_EXACT if top >= 0.99 else AUTO_MARGIN
    if top >= AUTO_ACCEPT and top - second >= margin - 1e-9:
        return "auto"
    return "review" if top >= 0.6 else "none"


def drive_url(drive_id: str, folder: bool = False) -> str:
    return f"https://drive.google.com/drive/folders/{drive_id}" if folder else f"https://drive.google.com/file/d/{drive_id}/view"
