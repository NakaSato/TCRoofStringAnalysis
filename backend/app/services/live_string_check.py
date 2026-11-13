"""String status from the newest live record (realtime, memory only, never stored).

Compares each string with the other strings of the same inverter **at the same moment**, so
irradiance, temperature and time of day cancel out. Nothing from stored history is used; the
String Layout (module counts, a configuration, not a measurement) is used only to make voltage
comparable between strings of different length.

- **Current** (A): modules in a string are in series, so every string of an inverter should carry
  about the same current whatever its length. Compared with the median of the inverter's strings.
- **Voltage** (V): Growatt's `vString` is the MPPT voltage, which scales with the number of
  modules. Compared per module, and only when every string of the inverter has a module count;
  otherwise a shorter string would look like a fault, so voltage is not judged.
- **Wired inputs only:** a MAX inverter has up to 24 string inputs and unused ones read 0 A
  forever. Only inputs in the String Layout or that carried current recently (`wired`) are
  judged; without that knowledge a 0 A input gets no verdict instead of "Critical".
- **Persistence:** a string is flagged only when every one of the newest records Growatt returned
  (`previous` = the older ones, same API call, ≈ 5 min apart) agrees; the mildest verdict wins.
  A moving cloud shadow covers part of an array for one record and makes those strings look
  40-50 % low; a real fault is still there 10 minutes later.
- Too little light (median current below `MIN_MEDIAN_A`): no verdict (`status = None`). Below
  `WARN_MIN_MEDIAN_A` only open strings are flagged: in morning / evening light, strings facing
  different ways differ by 15-20 % without any fault.
"""

from __future__ import annotations

import statistics
from typing import Any, Dict, List, Optional, Sequence, Set, Tuple

Layout = Dict[Tuple[str, int], Tuple[int, Optional[float]]]

MIN_MEDIAN_A = 1.0  # below this the inverter is in low light: deviations are noise
WARN_MIN_MEDIAN_A = 3.0  # current mismatches are judged only in strong light (orientation effects)
OPEN_A = 0.3  # a string at or below this while its peers carry current is open / fused / unplugged
WARN_CURRENT_PCT = -15.0  # current this far below the inverter median = Warning
CRIT_CURRENT_PCT = -40.0
WARN_VOLTAGE_PCT = -8.0  # per-module voltage this far below the median = Warning (bypass diode ≈ -1/3 module group)
MIN_PEERS = 3  # need at least this many strings to call a median "normal"


def _pct(v: float, ref: float) -> float:
    return (v - ref) / ref * 100.0


_RANK = {"Healthy": 0, "Warning": 1, "Critical": 2}


def check_inverter(
    sn: str,
    strings: Sequence[Dict[str, Any]],
    layout: Optional[Layout] = None,
    wired: Optional[Set[int]] = None,
    previous: Optional[Sequence[Sequence[Dict[str, Any]]]] = None,
) -> Dict[str, Any]:
    """Per-string live status for one inverter: the newest record (`strings`) judged, and a
    Warning / Critical kept only if each older record in `previous` (newest first) agrees.
    The result's deviations and reason are the newest record's; `records_judged` says how many
    records the verdict rests on.
    """
    out = _judge(sn, strings, layout, wired)
    older = [_judge(sn, p, layout, wired)["strings"] for p in (previous or []) if p]
    out["records_judged"] = 1 + len(older)
    for no, v in out["strings"].items():
        if v["status"] not in ("Warning", "Critical"):
            continue
        # mildest verdict across the records; a record with no verdict cannot confirm a fault
        mild = min((_RANK.get((o.get(no) or {}).get("status") or "Healthy", 0) for o in older), default=_RANK[v["status"]])
        if mild < _RANK[v["status"]]:
            cut = "Warning" if mild == 1 else "Healthy"
            v["reason"] = f"{v['reason']} (in the newest record only: not yet confirmed)"
            v["status"] = cut
    return out


def _judge(
    sn: str,
    strings: Sequence[Dict[str, Any]],
    layout: Optional[Layout] = None,
    wired: Optional[Set[int]] = None,
) -> Dict[str, Any]:
    """Per-string status from one record.

    `wired` = string inputs known to be connected (String Layout rows, or current seen recently).
    Inputs outside it are left out. `None` = not known: an input at 0 A gets no verdict.

    Returns `{"status": "ok"|"low_light"|"too_few_strings", "median_current_a", "voltage_basis",
    "strings": {string_no: {"status": "Healthy"|"Warning"|"Critical"|None, "current_dev_pct",
    "voltage_dev_pct", "reason"}}}`.
    """
    layout = layout or {}
    if wired is not None:
        strings = [s for s in strings if s["string_no"] in wired]
    rows = [s for s in strings if s.get("current_a") is not None and (wired is not None or float(s["current_a"]) > OPEN_A)]
    out: Dict[str, Any] = {"median_current_a": None, "voltage_basis": None, "strings": {}}
    if len(rows) < MIN_PEERS:
        out["status"] = "too_few_strings"
        out["strings"] = {s["string_no"]: _none("fewer than 3 strings reporting") for s in strings}
        return out
    # open strings (≈ 0 A) are faults, not peers: leave them out of the reference when enough remain
    carrying = [float(s["current_a"]) for s in rows if float(s["current_a"]) > OPEN_A]
    med_i = statistics.median(carrying if len(carrying) >= MIN_PEERS else [float(s["current_a"]) for s in rows])
    out["median_current_a"] = round(med_i, 2)
    if med_i < MIN_MEDIAN_A:
        out["status"] = "low_light"
        out["strings"] = {s["string_no"]: _none("too little light to compare") for s in strings}
        return out
    out["status"] = "ok"

    counts = {s["string_no"]: layout.get((sn, s["string_no"])) for s in rows}
    per_module = all(c is not None and c[0] > 0 for c in counts.values())
    med_v: Optional[float] = None
    if per_module:
        vols = [float(s["voltage_v"]) / counts[s["string_no"]][0] for s in rows if s.get("voltage_v")]  # type: ignore[index]
        med_v = statistics.median(vols) if len(vols) >= MIN_PEERS else None
        out["voltage_basis"] = "per_module" if med_v else None

    for s in strings:
        no = s["string_no"]
        if s.get("current_a") is None:
            out["strings"][no] = _none("no current reported")
            continue
        i = float(s["current_a"])
        if wired is None and i <= OPEN_A:
            out["strings"][no] = _none("0 A, and not known to be wired (enter it on String Layout)")
            continue
        strong = med_i >= WARN_MIN_MEDIAN_A
        i_dev = _pct(i, med_i)
        v_dev: Optional[float] = None
        if med_v and s.get("voltage_v"):
            v_dev = _pct(float(s["voltage_v"]) / counts[no][0], med_v)  # type: ignore[index]

        if i <= OPEN_A:
            status, reason = "Critical", f"No current now ({i:.2f} A) while peers carry {med_i:.1f} A: open string, fuse or connector"
        elif strong and i_dev <= CRIT_CURRENT_PCT:
            status, reason = "Critical", f"Current {i_dev:+.0f}% vs inverter median now"
        elif strong and i_dev <= WARN_CURRENT_PCT:
            status, reason = "Warning", f"Current {i_dev:+.0f}% vs inverter median now: soiling, shading or a weak module"
        elif strong and v_dev is not None and v_dev <= WARN_VOLTAGE_PCT:
            status, reason = "Warning", f"Voltage per module {v_dev:+.0f}% vs median now: possible bypass diode / module fault"
        else:
            status, reason = "Healthy", "Within peers now" if strong else "No open string (light too weak to judge mismatch)"
        out["strings"][no] = {
            "status": status,
            "current_dev_pct": round(i_dev, 1),
            "voltage_dev_pct": round(v_dev, 1) if v_dev is not None else None,
            "reason": reason,
        }
    return out


def _none(reason: str) -> Dict[str, Any]:
    return {"status": None, "current_dev_pct": None, "voltage_dev_pct": None, "reason": reason}


def check_plant(
    inverters: Sequence[Dict[str, Any]],
    layout: Optional[Layout] = None,
    wired: Optional[Dict[str, Set[int]]] = None,
) -> Dict[str, Any]:
    """Live string check for every inverter of a `/live/plants/{id}/latest` payload.

    Returns `{"inverters": {sn: check_inverter(...)}, "summary": {"healthy", "warning", "critical",
    "unknown", "checked_inverters", "at"}}`; `at` = newest record time judged.
    """
    per: Dict[str, Any] = {}
    counts = {"healthy": 0, "warning": 0, "critical": 0, "unknown": 0}
    times: List[str] = []
    for inv in inverters:
        sn = inv["device_sn"]
        prev = [p.get("strings") or [] for p in inv.get("previous_strings") or []]
        r = check_inverter(sn, inv.get("strings") or [], layout, (wired or {}).get(sn), prev)
        r["timestamp"] = inv.get("timestamp")
        r["stale"] = bool(inv.get("stale"))
        per[sn] = r
        if r["status"] == "ok" and inv.get("timestamp"):
            times.append(inv["timestamp"])
        for v in r["strings"].values():
            counts[{"Healthy": "healthy", "Warning": "warning", "Critical": "critical"}.get(v["status"], "unknown")] += 1
    checked = sum(1 for r in per.values() if r["status"] == "ok")
    return {"inverters": per, "summary": {**counts, "checked_inverters": checked, "at": max(times) if times else None}}
