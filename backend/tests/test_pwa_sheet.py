from datetime import date, datetime

from app.services import pwa_sheet as ps

DAY = date(2026, 11, 12)
HDR1 = ["No", "Plant", "SN", "", "", "weather Status", "09:00", "", "", "", "13:00", "", "", "", "17:00", "", "", ""]
HDR2 = ["", "", "", "", "", "", *(["Status", "ค่าแสง", "สภาพอากาศ", "DATA LOG"] * 3)]

DATA = {
    "plants": {"1": {"name": "Plant A", "latitude": 13.7, "longitude": 100.5}, "2": {"name": "Plant B"}},
    "loggers": {"SN1": "1", "SN2": "2"},
    "days": {
        "1": {
            "hourly_kw": [None] * 9 + [50.0] + [None] * 3 + [80.0] + [None] * 3 + [5.0],
            "checks": {
                "09": {"inverters": 2, "offline": [], "fault": [], "alarms": []},
                "13": {"inverters": 2, "offline": ["INV2"], "fault": [], "alarms": ["INV1 Relay fault"]},
            },
            "weather": {"has_sensor": True, "slots": {"09": {"irradiance_wm2": 600.4}, "13": {"irradiance_wm2": None}}},
            "google_weather": {"slots": {"13": {"condition": "RAIN", "raining": True}}},
        },
    },
}


def grid():
    return [list(HDR1), list(HDR2), [1, "Plant A", "SN1"], [2, "Plant B", "SN2"], [3, "Gone", "SNX"], [4, "", ""]]


def test_layout_new():
    lay = ps.layout(grid())
    assert lay.weather == 6
    assert [(b.hour, b.status, b.irr, b.wx, b.log, b.note) for b in lay.blocks] == [
        (9, 7, 8, 9, 10, 0), (13, 11, 12, 13, 14, 0), (17, 15, 16, 17, 18, 0)]
    assert (lay.first, lay.last) == (6, 18)


def test_fill_rows_all_checks():
    rows = grid()
    stats = ps.fill_rows(DAY, ps.layout(rows), rows, DATA)
    a, b, gone, empty = rows[2], rows[3], rows[4], rows[5]
    assert a[6:10] == ["Normal", 600, "ท้องฟ้าปลอดโปร่ง", "—"]
    assert a[10:14] == ["Abnormal", "—", "ฝนตก", "INV2 Offline, INV1 Relay fault"]
    assert a[14] == "Normal" and a[15] == "—"
    assert a[5] == "Abnormal"  # sensor missed 13:00 and 17:00
    assert b[5] == "Abnormal" and b[6] == "—" and b[9] == "offline"  # no published doc: nothing invented
    assert gone[5] == "Abnormal"
    assert empty == [4, "", ""]
    assert (stats.rows, stats.unmatched, stats.normal, stats.abnormal) == (2, 1, 2, 1)


def test_fill_rows_only_given_hours_keeps_others():
    rows = grid()
    rows[2] += [""] * 3 + [""] * 4 + ["x"] * 8
    ps.fill_rows(DAY, ps.layout(rows), rows, DATA, hours=[9])
    assert rows[2][6] == "Normal"
    assert rows[2][10:18] == ["x"] * 8
    assert rows[2][5] == "Normal"


def test_published_hours_from_the_slot_time():
    assert ps.published_hours(datetime(2026, 11, 12, 8, 49)) == []
    assert ps.published_hours(datetime(2026, 11, 12, 8, 50)) == [9]
    assert ps.published_hours(datetime(2026, 11, 12, 12, 50)) == [9, 13]
    assert ps.published_hours(datetime(2026, 11, 12, 19, 30)) == [9, 13, 17]


class FakeClient:
    def __init__(self, tabs):
        self.tabs = tabs  # title -> rows
        self.writes = {}
        self.cleared = []

    def sheets(self):
        return [{"sheetId": i, "title": t, "index": i} for i, t in enumerate(self.tabs)]

    def values(self, title):
        return [list(r) for r in self.tabs[title]]

    def duplicate(self, source_id, title, index):
        self.tabs[title] = [list(r) for r in list(self.tabs.values())[source_id]]

    def clear(self, rng):
        self.cleared.append(rng)
        title, cells = rng.split("!")
        a, b = cells.split(":")
        col = lambda ref: sum((ord(ch) - 64) * 26 ** k for k, ch in enumerate(reversed(ref.rstrip("0123456789"))))
        row = lambda ref: int(ref.lstrip("ABCDEFGHIJKLMNOPQRSTUVWXYZ"))
        for r in self.tabs[title.strip("'")][row(a) - 1 : row(b)]:
            for c in range(col(a) - 1, min(col(b), len(r))):
                r[c] = ""

    def write(self, rng, rows):
        self.writes[rng] = rows

    def write_cells(self, cells):
        for rng, v in cells:
            self.writes[rng] = v


def test_fill_day_creates_tab_and_writes_block(monkeypatch):
    tpl = grid()
    tpl[2] += [""] * 3 + ["old"] * 13
    client = FakeClient({"Summary": [["x"]], "11.11": tpl})
    monkeypatch.setattr(ps.pwa_report, "build", lambda _db, _day, _docs=None: DATA)
    out = ps.fill_day(None, DAY, [9], client=client)
    assert out["created"] is True and out["sheet"] == "12.11"
    assert client.cleared == ["'12.11'!F3:R6"]
    # cell by cell, only what changed
    assert [client.writes[f"'12.11'!{c}3"] for c in "GHIJ"] == ["Normal", 600, "ท้องฟ้าปลอดโปร่ง", "—"]
    assert client.writes["'12.11'!F3"] == "Normal"  # only check 09 asked: the sensor reported
    assert "'12.11'!K3" not in client.writes  # check 13 was not asked for
    assert out["cells_written"] == len(client.writes)


def test_col_letter():
    assert [ps.col_letter(n) for n in (1, 26, 27, 52)] == ["A", "Z", "AA", "AZ"]


def test_optional_columns_kw_inv_yield():
    hdr2 = ["", "", "", "", "", "", *(["Status", "ค่าแสง", "สภาพอากาศ", "DATA LOG", "kW", "INV online"] * 3), ""]
    hdr1 = ["No", "Plant", "SN", "", "", "weather Status"] + [""] * 18 + ["Yield (kWh)"]
    rows = [hdr1, hdr2, [1, "Plant A", "SN1"], [2, "Plant B", "SN2"]]
    lay = ps.layout(rows)
    assert [(b.kw, b.inv) for b in lay.blocks] == [(11, 12), (17, 18), (23, 24)]
    assert lay.yield_kwh == 25 and lay.last == 25
    data = {**DATA, "days": {"1": {**DATA["days"]["1"], "yield_kwh": 412.345}}}
    ps.fill_rows(DAY, lay, rows, data)
    a, b = rows[2], rows[3]
    assert a[10:12] == [50.0, "2/2"]
    assert a[16:18] == [80.0, "1/2"]
    assert a[22:24] == [5.0, "—"]  # no check data at 17:00
    assert a[24] == 412.3
    assert b[10:12] == ["—", "—"] and b[24] == "—"  # not published: nothing invented


def test_plant_cells_matches_fill_rows():
    cells = ps.plant_cells(DAY, DATA["days"]["1"], DATA["plants"]["1"], [9, 13])
    assert list(cells["checks"]) == ["09", "13"]
    assert dict(zip(ps.CELL_COLUMNS, cells["checks"]["09"])) == {
        "status": "Normal", "note": "INV ทำงานปกติ ค่าแสง 600", "irr": 600, "wx": "ท้องฟ้าปลอดโปร่ง",
        "log": "—", "kw": 50.0, "inv": "2/2",
    }
    assert cells["sources"] == {"09": "growatt", "13": "google"}
    assert cells["weather_status"] == "Abnormal" and cells["weather_detail"] == "loss (13:00)"
    assert ps.plant_cells(DAY, DATA["days"]["1"], DATA["plants"]["1"], [9])["weather_status"] == "Normal"
    no_doc = ps.plant_cells(DAY, {}, {}, [9])
    assert no_doc["weather_status"] == "Abnormal" and no_doc["weather_detail"] == "—"
    no_sensor = ps.plant_cells(DAY, {"weather": {"has_sensor": False}}, {}, [9])
    assert no_sensor["weather_status"] == "Abnormal" and no_sensor["weather_detail"] == "ไม่มีเซนเซอร์"


def test_match_plant():
    names = {"1": "TC Roof สาขา 1", "2": "TC Roof สาขา 12"}
    assert ps.match_plant("SN1", "", {"SN1": "9"}, names) == "9"
    assert ps.match_plant("NEW", "สาขา 12", {}, names) == "2"
    assert ps.match_plant("NEW", "สาขา 1", {}, names) is None  # ambiguous: both names contain it
    assert ps.match_plant("NEW", "", {}, names) is None


# --------------------------------------------------------------------------- check slots (08:50)

SLOT_DOC = {
    "hourly_kw": [None] * 9 + [99.0],  # mean of 09:xx: not what a check slot shows
    "yield_kwh": 120.0,
    "weather": {"has_sensor": True},
    "checks": {
        "09": {"at": "08:50", "inverters": 2, "offline": [], "fault": [], "alarms": [], "kw": 41.26,
               "reading_at": "08:45", "irradiance_wm2": 512.4, "module_temp_c": 35.0, "sensor_at": "08:45", "google": None},
    },
}
SLOT_DATA = {"plants": {"1": {"name": "Plant A", "latitude": 13.7, "longitude": 100.5}, "2": {"name": "Plant B"}},
             "loggers": {"SN1": "1", "SN2": "2"}, "checks_ready": ["09"], "days": {"1": SLOT_DOC}}


def test_slot_values_come_from_the_snapshot_not_the_hour_mean():
    c = ps.plant_cells(DAY, SLOT_DOC, SLOT_DATA["plants"]["1"], [9], ready=["09"])
    v = dict(zip(ps.CELL_COLUMNS, c["checks"]["09"]))
    assert v["kw"] == 41.3 and v["status"] == "Normal"  # the 08:45 reading, not hourly_kw[9]
    assert v["irr"] == 512 and v["inv"] == "2/2"
    # sky class judged against clear sky at 08:50, not 09:00
    assert v["wx"] == ps.sky_th(512.4, ps.clear_sky(13.7, 100.5, DAY, 8, 50))
    assert c["weather_status"] == "Normal"


def test_check_not_ready_is_dash_for_every_plant():
    """Readiness gate: a check is fully built or "—" everywhere, so the Apps Script skips it."""
    for pid, doc in (("1", SLOT_DOC), ("2", {})):
        c = ps.plant_cells(DAY, doc, SLOT_DATA["plants"][pid], [9, 13], ready=["09"])
        assert c["checks"]["13"] == ["—"] * len(ps.CELL_COLUMNS)
    # a not-ready check does not count against weather Status
    assert ps.plant_cells(DAY, SLOT_DOC, {}, [9, 13], ready=["09"])["weather_status"] == "Normal"
    # nothing ready yet: no check so far, so not Normal
    assert ps.plant_cells(DAY, SLOT_DOC, {}, [9], ready=[])["weather_status"] == "Abnormal"


def test_fill_rows_skips_unpublished_checks_and_never_overwrites():
    rows = grid()
    rows[2] += ["", "", "old"] + [""] * 4 + ["kept"] * 4  # F weather, G..J check 09 empty, K..N check 13 filled
    rows[3] += ["", "", ""] + ["manual"] + [""] * 3  # Plant B: Status 09 typed by hand
    stats = ps.fill_rows(DAY, ps.layout(rows), rows, SLOT_DATA)
    a, b = rows[2], rows[3]
    assert a[6:10] == ["Normal", 512, ps.sky_th(512.4, ps.clear_sky(13.7, 100.5, DAY, 8, 50)), "—"]
    assert a[10:14] == ["kept"] * 4  # check 13 not published: untouched
    assert a[5] == "Normal"  # weather Status is kept up to date
    assert b[6] == "manual"  # a filled check cell is never overwritten
    assert b[9] == "offline"  # its empty cells are still filled
    assert stats.hours == [9] and stats.skipped_hours == [13, 17]
    assert stats.kept == 1

    again = [list(r) for r in rows]
    later = {**SLOT_DATA, "days": {"1": {**SLOT_DOC, "checks": {"09": {**SLOT_DOC["checks"]["09"], "kw": 0.0}}}}}
    ps.fill_rows(DAY, ps.layout(again), again, later)
    assert again[2][6:10] == rows[2][6:10]  # first published values stay


def test_fill_day_does_not_overwrite_cells_written_by_the_apps_script(monkeypatch):
    tab = grid()
    tab[2] += ["", "", ""] + ["Abnormal", 1, "x", "y"]  # check 09 of Plant A already written by Code.gs
    client = FakeClient({"12.11": tab})
    monkeypatch.setattr(ps.pwa_report, "build", lambda _db, _day, _docs=None: SLOT_DATA)
    out = ps.fill_day(None, DAY, [9, 13], client=client)
    assert not any(k.endswith(("G3", "H3", "I3", "J3")) for k in client.writes)
    assert client.writes["'12.11'!G4"] == "—"  # Plant B, no doc: offline at the check
    assert out["skipped_hours"] == [13]


def test_weather_is_google_first_then_the_sensor():
    info = {"latitude": 13.7, "longitude": 100.5}
    slot = {"at": "08:50", "inverters": 1, "offline": [], "fault": [], "alarms": [], "kw": 10.0, "irradiance_wm2": 600.0}
    g = {"source": "current", "modelled": True, "condition": "MOSTLY_CLOUDY", "raining": False}
    cells = ps.plant_cells(DAY, {"checks": {"09": {**slot, "google": g}}}, info, [9])
    assert cells["checks"]["09"][3] == "มีเมฆมาก" and cells["sources"]["09"] == "google"
    rain = {**g, "condition": "CLOUDY", "raining": True}
    assert ps.plant_cells(DAY, {"checks": {"09": {**slot, "google": rain}}}, info, [9])["checks"]["09"][3] == "ฝนตก"
    no_google = ps.plant_cells(DAY, {"checks": {"09": {**slot, "google": None}}}, info, [9])
    assert no_google["sources"]["09"] == "growatt"


def test_fill_rows_firmware_only_when_empty():
    rows = [["No", "Plant", "SN", "kWp", "Firmware", *HDR1[5:]], list(HDR2),
            [1, "Plant A", "SN1", 10, ""], [2, "Plant B", "SN2", 10, "OLD1"], [3, "Gone", "SNX", 10, "—"]]
    lay = ps.layout(rows)
    assert lay.firmware == 5 and lay.first == 6  # outside the check block
    stats = ps.fill_rows(DAY, lay, rows, {**DATA, "firmware": {"SN1": "3.1.0.2", "SN2": "NEW"}})
    assert [r[4] for r in rows[2:]] == ["3.1.0.2", "OLD1", ""]  # never overwrites; unknown SN = blank
    assert stats.firmware == 1


def test_fill_rows_blanks_firmware_when_the_api_has_no_datalogger_version():
    hdr = [["No", "Plant", "SN", "kWp", "Firmware", *HDR1[5:]], list(HDR2)]
    rows = hdr + [[1, "Plant A", "SN1", 10, "TNAA17130301"], [2, "Plant B", "SN2", 10, "—"],
                  [3, "Plant C", "SN3", 10, "3.1.0.2"], [4, "Plant D", "SN4", 10, ""]]
    stale = {"SN1": {"inverter_firmware": ["TN1.0", "TNAA17130301"]}, "SN3": {"inverter_firmware": ["TN1.0"]}}
    stats = ps.fill_rows(DAY, ps.layout(rows), rows, {**DATA, "firmware": {}, "dataloggers": stale})
    # an inverter version an older report wrote, and "—": blanked; a version typed by hand: kept
    assert [r[4] for r in rows[2:]] == ["", "", "3.1.0.2", ""]
    assert stats.firmware == 0


def test_fill_rows_without_firmware_map_leaves_column():
    rows = [["No", "Plant", "SN", "kWp", "Firmware", *HDR1[5:]], list(HDR2), [1, "Plant A", "SN1", 10, ""]]
    ps.fill_rows(DAY, ps.layout(rows), rows, DATA)
    assert rows[2][4] == ""


def test_data_log_of_a_slot_frozen_before_issues():
    slot = {"at": "08:50", "kw": 40.0, "inverters": 2, "offline": [], "fault": [], "alarms": [],
            "errors": ["INV1 AFCI Fault", "INV2 Error 25 (×2)"], "irradiance_wm2": None, "google": None}
    log = lambda s: ps.plant_cells(DAY, {"checks": {"09": s}}, {}, [9])["checks"]["09"][4]
    assert log(slot) == "INV1 AFCI Fault, INV2 Error 25 (×2)"  # closed earlier that day, still listed
    assert log({**slot, "errors": []}) == "—"
    assert log({**slot, "offline": ["INV2"]}) == "INV2 Offline, INV1 AFCI Fault, INV2 Error 25 (×2)"
    assert log({**slot, "kw": None, "offline": ["INV1", "INV2"]}) == "offline: INV1 AFCI Fault, INV2 Error 25 (×2)"
    old = {k: v for k, v in slot.items() if k != "errors"}  # frozen before `errors`: alarms open at the check
    assert log({**old, "alarms": ["INV1 Relay fault"]}) == "INV1 Relay fault"


def _log(issues, **over):
    slot = {"at": "08:50", "kw": 40.0, "inverters": 12, "offline": [], "fault": [], "alarms": [], "errors": ["INV9 Closed earlier"],
            "issues": issues, "irradiance_wm2": None, "google": None, **over}
    return ps.plant_cells(DAY, {"checks": {"09": slot}}, {}, [9])["checks"]["09"][4]


def test_data_log_shows_the_fault_code_and_growatt_text():
    relay = {"code": "117", "message": "Relay check fail"}
    assert _log([{"inv": "INV1", "state": "Offline", "items": []}, {"inv": "INV3", "state": "Fault", "items": [relay]}]) == (
        "INV1 Offline, INV3 Fault: 117 Relay check fail")
    # several active faults on one inverter
    assert _log([{"inv": "INV3", "state": "Fault", "items": [relay, {"code": "203", "message": "PV Isolation Low"}]}]) == (
        "INV3 Fault: 117 Relay check fail / 203 PV Isolation Low")
    # a code without Growatt text: the code only; neither: as before
    assert _log([{"inv": "INV3", "state": "Fault", "items": [{"code": "25", "message": None}]}]) == "INV3 Fault: 25"
    assert _log([{"inv": "INV3", "state": "Fault", "items": []}]) == "INV3 Fault"
    # an alarm active at the check on an inverter that is not in fault
    assert _log([{"inv": "INV2", "state": "Alarm", "items": [{"code": "400", "message": "Fan function abnormal"}]}]) == (
        "INV2 Alarm: 400 Fan function abnormal")
    # no INV number in Growatt: the serial
    assert _log([{"inv": "FYLXG4V00E", "state": "Fault", "items": [relay]}]) == "FYLXG4V00E Fault: 117 Relay check fail"


def test_data_log_says_since_when_how_often_and_last_data():
    relay = {"code": "117", "message": "Relay check fail", "since": "06:19", "count": 5}
    once = {"code": "203", "message": "PV Isolation Low", "since": "08:20", "count": 1}
    assert _log([{"inv": "INV3", "state": "Fault", "items": [relay, once]}]) == (
        "INV3 Fault: 117 Relay check fail (06:19, ×5) / 203 PV Isolation Low (08:20)")
    assert _log([{"inv": "INV1", "state": "Offline", "items": [], "last": "07:40"},
                 {"inv": "INV2", "state": "Offline", "items": [], "last": None}]) == (
        "INV1 Offline (last data 07:40), INV2 Offline (no data today)")


def test_data_log_names_a_plant_that_reports_but_produces_nothing():
    assert _log([], kw=0.0) == "INV ไม่ผลิตไฟ"  # Status is abnormal: the cell says why
    assert _log([{"inv": "INV2", "state": "Fault", "items": []}], kw=0.0) == "INV ไม่ผลิตไฟ, INV2 Fault"
    # an older doc without a check slot: hourly kW only
    assert ps.plant_cells(DAY, {"hourly_kw": [0.0] * 24}, {}, [9])["checks"]["09"][4] == "INV ไม่ผลิตไฟ"


def test_data_log_nothing_wrong_is_dash_and_no_data_is_offline():
    assert _log([]) == "—"  # the day's closed errors are no longer listed
    assert _log([{"inv": "INV1", "state": "Offline", "items": []}], kw=None, inverters=1, offline=["INV1"]) == "offline"


def test_data_log_is_cut_at_a_whole_entry_under_300_characters():
    issues = [{"inv": f"INV{n}", "state": "Fault", "items": [{"code": "203", "message": "PV Isolation Low"}]} for n in range(1, 13)]
    text = _log(issues)
    full = ", ".join(f"INV{n} Fault: 203 PV Isolation Low" for n in range(1, 13))
    assert len(full) > 300 and len(text) <= 300
    kept = text.split(", ")
    assert kept[-1] == f"…(+{12 - (len(kept) - 1)})"
    assert kept[:-1] == full.split(", ")[: len(kept) - 1]  # whole entries, in INV order
    # one more entry would not fit
    assert len(", ".join(full.split(", ")[: len(kept)]) + ", …(+0)") > 300
    assert _log(issues[:5]) == ", ".join(f"INV{n} Fault: 203 PV Isolation Low" for n in range(1, 6))  # short: untouched


def test_weather_has_only_three_values():
    sky = lambda cond, raining=False: ps.google_sky({"condition": cond, "raining": raining})
    assert [sky(c) for c in ("CLEAR", "MOSTLY_CLEAR")] == ["ท้องฟ้าปลอดโปร่ง"] * 2
    assert [sky(c) for c in ("PARTLY_CLOUDY", "MOSTLY_CLOUDY", "CLOUDY", "CHANCE_OF_SHOWERS")] == ["มีเมฆมาก"] * 4
    assert [sky(c, True) for c in ("LIGHT_RAIN", "THUNDERSTORM", "CLOUDY")] == ["ฝนตก"] * 3
    assert sky("WINDY") is None and ps.google_sky(None) is None  # says nothing about the sky
    # a condition that names no sky: Google's cloud cover decides
    windy = lambda cover: ps.google_sky({"condition": "WINDY", "raining": False, "cloud_cover_pct": cover})
    assert [windy(c) for c in (10, 30, 31, 90)] == ["ท้องฟ้าปลอดโปร่ง", "ท้องฟ้าปลอดโปร่ง", "มีเมฆมาก", "มีเมฆมาก"]
    # the sensor: clear or cloudy only, never rain
    assert [ps.sky_th(i, 800.0) for i in (700.0, 400.0, 50.0)] == ["ท้องฟ้าปลอดโปร่ง", "มีเมฆมาก", "มีเมฆมาก"]
    assert ps.sky_th(50.0, 60.0) is None  # sun too low
    # WINDY with a sensor: the sensor's class, unlabelled
    info = {"latitude": 13.7, "longitude": 100.5}
    slot = {"at": "12:50", "inverters": 1, "offline": [], "fault": [], "alarms": [], "kw": 10.0, "irradiance_wm2": 900.0,
            "google": {"condition": "WINDY", "raining": False}}
    cells = ps.plant_cells(DAY, {"checks": {"13": slot}}, info, [13])
    assert cells["checks"]["13"][3] == "ท้องฟ้าปลอดโปร่ง" and cells["sources"]["13"] == "growatt"
