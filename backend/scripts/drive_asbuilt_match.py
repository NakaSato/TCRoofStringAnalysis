"""Match the company Drive's as-built PDFs and site photo folders to Growatt plants
(docs/plans/plant-asbuilt-links.md §4).

    # 1. match: Drive inventory (JSON) + the plants in the DB → CSV to review
    PYTHONPATH=backend uv run python backend/scripts/drive_asbuilt_match.py match \
        --inventory drive_inventory.json --out asbuilt_matches.csv

    # 2. review the CSV: set `status` to ok on `review` rows that are right (or fix drive_id / url);
    #    `auto` rows are taken as they are, anything else is skipped

    # 3a. apply to the local DB (dry run without --apply)
    PYTHONPATH=backend uv run python backend/scripts/drive_asbuilt_match.py apply asbuilt_matches.csv --apply
    # 3b. or send to a running API as an admin (dry run without --apply)
    PYTHONPATH=backend uv run python backend/scripts/drive_asbuilt_match.py apply asbuilt_matches.csv \
        --api https://<host>/api --token "$TOKEN" --apply

Inventory shape: {"asbuilt_pdfs": [{id, title, source_folder (P1|P2|P3|P34…), size, modified}],
"asbuilt_subfolder_pdfs": [{id, title, source_folder ("site:<site folder title>"), size, modified}],
"site_folders": [{id, title}], "picture_folders": [{id, title, site_folder_id}]}.

Names, not numbers, decide (Drive numbers disagree with each other). A site with several PDFs gets
the highest REV.n, then the newest modified time. Empty (0-byte) files and the calculation sheets,
route plans, reports and forms kept in the same folders are skipped. A link set by an
admin (`manual`) is never overwritten by `apply`.
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
import urllib.request
from collections import defaultdict
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

from sqlalchemy import select

from app.db.models import GrowattPlant, PwaMeterSite
from app.db.session import SessionLocal
from app.services import drive_match as dm

ROOT = Path(__file__).resolve().parents[2]
TOOLS = ROOT / "Monitoring Report" / "รายงาน" / "_Tools"
# phase folders on Drive → Growatt project phases (the phase 3 Growatt account holds the P3 and P4 sites)
SOURCE_PHASES = {"P1": [1], "P2": [2], "P3": [3]}
# "AS BUILT / รายการคำนวณ PHASE 3-4" (P34, P34-other) is not a source for the links (owner's decision,
# 2026-11-22): its PDFs are skipped even when they are listed in the inventory.
EXCLUDED_SOURCES = ("P34",)
AUTO_SURE = 0.9  # a file matched at least this well belongs to the plant whatever its name looks like
FIELDS = [
    "plant_id", "plant_name", "phase", "kind", "status", "score", "runner_up", "runner_up_plant",
    "drive_title", "drive_id", "url", "revision", "size_bytes", "source_folder", "note",
]


def _registry_names() -> Dict[int, List[str]]:
    """Growatt plant_id → names from the report tools' site register (plant_map.json → registry.csv)."""
    out: Dict[int, List[str]] = defaultdict(list)
    try:
        codes = {r["code"]: r["name"] for r in csv.DictReader(open(TOOLS / "registry.csv", encoding="utf-8"))}
        for pid, m in json.load(open(TOOLS / "plant_map.json", encoding="utf-8")).items():
            if m.get("code") in codes:
                out[int(pid)].append(codes[m["code"]])
            if m.get("mon_name"):
                out[int(pid)].append(m["mon_name"])
    except (OSError, ValueError, KeyError):
        pass  # the register is a help, not a requirement
    return out


def load_candidates() -> List[dm.Candidate]:
    extra = _registry_names()
    with SessionLocal() as db:
        pwa: Dict[int, List[str]] = defaultdict(list)
        for s in db.scalars(select(PwaMeterSite).where(PwaMeterSite.growatt_plant_id.is_not(None))):
            pwa[s.growatt_plant_id] += [s.name, s.growatt_name]
        return [
            dm.candidates(p.plant_id, [p.name, *pwa.get(p.plant_id, []), *extra.get(p.plant_id, [])], p.phase)
            for p in db.scalars(select(GrowattPlant))
        ]


def _rev_key(f: Dict[str, Any]) -> tuple:
    """Order of preference: a PDF in the site folder's own "As-Built Drawing" subfolder first, then the
    highest REV.n, then the newest modifiedTime."""
    return (bool(f.get("_in_site")), dm.revision(f["title"]) or 0, f.get("modified") or "")


def match(inventory: Dict[str, Any], plants: Sequence[dm.Candidate]) -> List[Dict[str, Any]]:
    names = {c.plant_id: (c.names[0].raw if c.names else str(c.plant_id), c.phase) for c in plants}
    rows: List[Dict[str, Any]] = []

    # --- as-built PDFs: each file goes to its best plant. A PDF in a site folder's "As-Built Drawing"
    # subfolder takes the site folder's match (the folder names are the cleanest) and wins over the
    # phase folders; a PDF in a phase folder is matched on its own name and is used only when the
    # site's subfolder has none. Among the files of the same kind, the newest revision is kept.
    site_rank = {s["title"]: dm.best(s["title"], plants) for s in inventory.get("site_folders", [])}
    files_in = [(f, False) for f in inventory.get("asbuilt_pdfs", [])]
    files_in += [(f, True) for f in inventory.get("asbuilt_subfolder_pdfs", [])]
    by_plant: Dict[int, List[Dict[str, Any]]] = defaultdict(list)
    for f, in_site in files_in:
        size = int(f.get("size") or 0)
        src = str(f.get("source_folder") or "")
        if src.split("-")[0] in EXCLUDED_SOURCES:
            continue
        skip = "empty file (0 bytes)" if size == 0 else None if dm.is_drawing(f["title"]) else "not a drawing (calculation sheet / route plan)"
        if skip:
            rows.append({"kind": "asbuilt", "status": "skipped", "drive_title": f["title"], "drive_id": f["id"],
                         "size_bytes": size, "source_folder": src, "note": skip})
            continue
        if in_site:
            ranked = site_rank.get(src.removeprefix("site:")) or dm.best(f["title"], plants)
        else:
            ranked = dm.best(f["title"], plants, SOURCE_PHASES.get(src.split("-")[0]))
        if not ranked:
            continue
        by_plant[ranked[0][0]].append({**f, "_in_site": in_site, "_ranked": ranked, "_verdict": dm.verdict(ranked)})
    for pid, files in by_plant.items():
        files.sort(key=_rev_key, reverse=True)
        f = files[0]
        ranked = f["_ranked"]
        status = f["_verdict"]
        where = "site folder As-Built Drawing" if f["_in_site"] else "phase folder"
        note = f"{len(files)} files; kept the {where} one" if len(files) > 1 else ""
        if status != "auto" and any(x["_verdict"] == "auto" for x in files[1:]):
            # the newest file's own name is unclear, but another file of the plant matched for sure:
            # keep the newest only when its name agrees with that file
            sure = next(x for x in files[1:] if x["_verdict"] == "auto")
            if dm.score(dm.parse(f["title"]), dm.parse(sure["title"])) >= 0.75:
                status, ranked = "auto", sure["_ranked"]
        # another site's file among them: one matched only weakly whose name disagrees with the kept one
        site = dm.parse(f["title"])
        odd = [x["title"] for x in files[1:] if x["_ranked"][0][1] < AUTO_SURE and dm.score(site, dm.parse(x["title"])) < 0.75]
        if odd and status == "auto":
            status, note = "review", f"files of different sites matched this plant: {f['title']} / {' / '.join(odd[:3])}"
        rows.append({
            "plant_id": pid, "plant_name": names[pid][0], "phase": names[pid][1], "kind": "asbuilt", "status": status,
            "score": ranked[0][1], "runner_up": ranked[1][1] if len(ranked) > 1 else "",
            "runner_up_plant": ranked[1][0] if len(ranked) > 1 else "",
            "drive_title": f["title"], "drive_id": f["id"], "url": dm.drive_url(f["id"]),
            "revision": (f"REV.{dm.revision(f['title'])}" if dm.revision(f["title"]) is not None else ""),
            "size_bytes": f.get("size") or "", "source_folder": f.get("source_folder") or "", "note": note,
        })

    # --- site photo folders: the site folder's "Picture" subfolder, else the site folder
    pictures = {p["site_folder_id"]: p for p in inventory.get("picture_folders", []) if p.get("site_folder_id")}
    photo_rows: Dict[int, Dict[str, Any]] = {}
    for s in inventory.get("site_folders", []):
        ranked = site_rank[s["title"]]
        if not ranked:
            continue
        pid, sc = ranked[0]
        pic = pictures.get(s["id"])
        target = pic["id"] if pic else s["id"]
        row = {
            "plant_id": pid, "plant_name": names[pid][0], "phase": names[pid][1], "kind": "site_photos",
            "status": dm.verdict(ranked), "score": sc, "runner_up": ranked[1][1] if len(ranked) > 1 else "",
            "runner_up_plant": ranked[1][0] if len(ranked) > 1 else "",
            "drive_title": s["title"] + (" / " + pic["title"] if pic else ""), "drive_id": target,
            "url": dm.drive_url(target, folder=True), "revision": "", "size_bytes": "", "source_folder": "photos",
            "note": "" if pic else "no Picture subfolder: links the site folder",
        }
        prev = photo_rows.get(pid)
        if prev is None or sc > float(prev["score"]):
            if prev is not None:
                row["status"], row["note"] = "review", f"two site folders matched: {prev['drive_title']} / {s['title']}"
            photo_rows[pid] = row
    rows += photo_rows.values()

    # --- plants left without a link of a kind
    have = {(r.get("plant_id"), r["kind"]) for r in rows if r.get("plant_id") not in (None, "")}
    for pid, (name, phase) in names.items():
        for kind in ("asbuilt", "site_photos"):
            if (pid, kind) not in have:
                rows.append({"plant_id": pid, "plant_name": name, "phase": phase, "kind": kind, "status": "none", "note": "no Drive match"})
    order = {"review": 0, "none": 1, "skipped": 2, "auto": 3}
    rows.sort(key=lambda r: (order.get(r["status"], 9), r["kind"], str(r.get("phase") or ""), str(r.get("plant_name") or "")))
    return rows


def cmd_match(a: argparse.Namespace) -> None:
    inventory = json.load(open(a.inventory, encoding="utf-8"))
    rows = match(inventory, load_candidates())
    with open(a.out, "w", newline="", encoding="utf-8-sig") as fh:  # BOM: Thai opens right in Excel
        w = csv.DictWriter(fh, FIELDS, extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)
    counts: Dict[str, Dict[str, int]] = defaultdict(lambda: defaultdict(int))
    for r in rows:
        counts[r["kind"]][r["status"]] += 1
    for kind, c in counts.items():
        print(f"{kind}: " + ", ".join(f"{k} {v}" for k, v in sorted(c.items())))
    print(f"→ {a.out}")


def accepted(path: str) -> List[Dict[str, Any]]:
    out = []
    for r in csv.DictReader(open(path, encoding="utf-8-sig")):
        if r.get("status") not in ("auto", "ok") or not r.get("plant_id") or not r.get("url"):
            continue
        out.append({
            "plant_id": int(r["plant_id"]), "kind": r["kind"], "url": r["url"], "drive_id": r.get("drive_id") or None,
            "title": r.get("drive_title") or None, "revision": r.get("revision") or None,
            "match_score": float(r["score"]) if r.get("score") else None,
        })
    return out


def cmd_apply(a: argparse.Namespace) -> None:
    rows = accepted(a.csv)
    if a.api:
        req = urllib.request.Request(
            f"{a.api.rstrip('/')}/growatt/documents/import?apply={'true' if a.apply else 'false'}",
            data=json.dumps({"rows": rows}).encode(), method="POST",
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {a.token}"},
        )
        with urllib.request.urlopen(req, timeout=60) as resp:  # noqa: S310 (admin-given URL)
            out = json.load(resp)
    else:
        from app.db.session import ensure_schema, engine
        from app.services import plant_documents

        ensure_schema(engine)
        with SessionLocal() as db:
            out = plant_documents.import_rows(db, rows, a.apply, "drive_asbuilt_match")
    print(json.dumps(out, ensure_ascii=False, indent=2))
    if not a.apply:
        print("dry run: add --apply to write", file=sys.stderr)


def main(argv: Optional[Sequence[str]] = None) -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    m = sub.add_parser("match")
    m.add_argument("--inventory", required=True)
    m.add_argument("--out", default="asbuilt_matches.csv")
    m.set_defaults(fn=cmd_match)
    ap = sub.add_parser("apply")
    ap.add_argument("csv")
    ap.add_argument("--apply", action="store_true", help="write (default: dry run)")
    ap.add_argument("--api", help="API base URL, e.g. https://host/api (default: the local DB)")
    ap.add_argument("--token", help="admin bearer token for --api")
    ap.set_defaults(fn=cmd_apply)
    a = p.parse_args(argv)
    a.fn(a)


if __name__ == "__main__":
    main()
