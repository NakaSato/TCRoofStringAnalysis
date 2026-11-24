"""Convert the O&M asset & network register (OM-Asset & Network.xlsx) into an IP Switcher profile
import file: one static profile per plant on that plant's LAN.

    uv run --with openpyxl python ipswitcher/tools/om_network_to_profiles.py \
        "data/OM-Asset & Network.xlsx" -o data/ipswitcher-profiles.json

Import the output in the extension: Settings (⚙) → Import.

First "Growatt Ecosystem · 192.168.10.x" (laptop 192.168.10.250/24) and "Huawei SmartLogger ·
192.168.0.10" (laptop 192.168.0.250/24, ping + web UI 192.168.0.10), both without gateway; then per plant (sheet "อุปกรณ์ - Router 4G" plus the ShineMaster / PQM / Revenue meter sheets):
- subnet   = the router's (Teltonika) /24. The sheet's "Network" column is often empty or names another
             plant's subnet, so it is not used.
- laptop   = <subnet>.<--host> (default .250, a number no device uses in any plant; checked per plant)
- gateway  = the router IP; test ping = the router
- note     = the plant's device IPs (router, ShineMaster, PQM, meters), so the technician sees them.
A plant is skipped (and reported) when its router IP is missing or invalid, or when the laptop address
is already a device's IP there. Profile IDs are stable per plant code, so importing a newer file
updates the profiles instead of adding duplicates.
"""
from __future__ import annotations

import argparse
import ipaddress
import json
import re
import sys
import uuid
import warnings
from collections import defaultdict

import openpyxl

NAMESPACE = uuid.UUID("6f1c2b8e-3f0a-4c55-9a51-7d1e0c2b9a10")  # IP Switcher plant profiles
IPV4 = re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")
NAME_MAX, NOTE_MAX = 64, 500


def sheet_rows(wb, name: str) -> list[dict]:
    """Rows of a sheet as dicts keyed by the header row (the first row whose first cell is 'รหัส')."""
    hdr, out = None, []
    for r in wb[name].iter_rows(values_only=True):
        if hdr is None:
            if r and r[0] is not None and str(r[0]).strip() == "รหัส":
                hdr = [str(c).strip() if c is not None else None for c in r]
            continue
        if r and r[0]:
            out.append({h: v for h, v in zip(hdr, r) if h})
    if hdr is None:
        raise SystemExit(f"sheet {name!r}: no header row starting with 'รหัส'")
    return out


def ips_in(cell) -> list[ipaddress.IPv4Address]:
    out = []
    for s in IPV4.findall(str(cell or "")):
        try:
            out.append(ipaddress.IPv4Address(s))
        except ValueError:
            pass
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("xlsx")
    ap.add_argument("-o", "--out", default="data/ipswitcher-profiles.json")
    ap.add_argument("--host", type=int, default=250, help="last number of the laptop's address (default 250)")
    a = ap.parse_args()
    if not 1 <= a.host <= 253:
        raise SystemExit("--host must be 1–253")

    warnings.filterwarnings("ignore", module="openpyxl")
    wb = openpyxl.load_workbook(a.xlsx, read_only=True, data_only=True)
    routers = sheet_rows(wb, "อุปกรณ์ - Router 4G")
    devices: dict[str, list[tuple[str, ipaddress.IPv4Address]]] = defaultdict(list)
    for sheet, label in (("อุปกรณ์ - ShineMaster", "ShineMaster"), ("อุปกรณ์ - PQM", "PQM"), ("อุปกรณ์ - Revenue meter", "Meter")):
        for r in sheet_rows(wb, sheet):
            for ip in ips_in(r.get("IP")):
                devices[str(r["รหัส"]).strip()].append((label, ip))

    # Growatt Ecosystem first: same fixed ID as the extension's first-run profile (lib/store.js).
    profiles, skipped, warns = [{
        "id": str(uuid.uuid5(NAMESPACE, "growatt-ecosystem")),
        "name": "Growatt Ecosystem · 192.168.10.x",
        "mode": "static", "ip": "192.168.10.250", "prefix": 24, "gateway": "", "dns": [],
        "testHost": "", "openUrl": "", "preferredAdapter": "",
        "note": "Laptop on the Growatt devices' local network 192.168.10.0/24 (direct link, no gateway).",
    }, {
        "id": str(uuid.uuid5(NAMESPACE, "huawei-smartlogger")),
        "name": "Huawei SmartLogger · 192.168.0.10",
        "mode": "static", "ip": "192.168.0.250", "prefix": 24, "gateway": "", "dns": [],
        "testHost": "192.168.0.10", "openUrl": "https://192.168.0.10/", "preferredAdapter": "",
        "note": "SmartLogger 192.168.0.10",
    }], [], []
    for r in routers:
        code = str(r["รหัส"]).strip()
        station = " ".join(str(r.get("สถานี") or "").split())
        rips = ips_in(r.get("IP (Teltonika)"))
        if len(rips) != 1:
            skipped.append(f"{code}: router IP missing or not one address ({r.get('IP (Teltonika)')!r})")
            continue
        router = rips[0]
        net = ipaddress.IPv4Network(f"{router}/24", strict=False)
        laptop = net.network_address + a.host
        devs = [("Router", router)] + devices.get(code, [])
        if any(ip == laptop for _, ip in devs):
            skipped.append(f"{code}: {laptop} is already a device IP there")
            continue
        for label, ip in devs:
            if ip not in net:
                warns.append(f"{code}: {label} {ip} is outside the router's subnet {net}")

        by_label: dict[str, list[str]] = defaultdict(list)
        for label, ip in devs:
            if str(ip) not in by_label[label]:
                by_label[label].append(str(ip))
        note = " · ".join(f"{label} {', '.join(v)}" for label, v in by_label.items())
        name = f"{code} · {station}" if station else code
        profiles.append({
            "id": str(uuid.uuid5(NAMESPACE, code)),
            "name": name if len(name) <= NAME_MAX else name[: NAME_MAX - 1] + "…",
            "mode": "static",
            "ip": str(laptop),
            "prefix": 24,
            "gateway": str(router),
            "dns": [],
            "testHost": str(router),
            "openUrl": "",
            "preferredAdapter": "",
            "note": note[:NOTE_MAX],
        })

    with open(a.out, "w", encoding="utf-8") as f:
        json.dump({"version": 1, "profiles": profiles}, f, ensure_ascii=False, indent=1)
        f.write("\n")
    print(f"{len(profiles) - 2} plant profiles + Growatt Ecosystem + Huawei SmartLogger → {a.out} (laptop .{a.host}, /24, gateway = router)")
    for s in skipped:
        print("skipped", s)
    for w in warns:
        print("warning", w)
    return 0


if __name__ == "__main__":
    sys.exit(main())
