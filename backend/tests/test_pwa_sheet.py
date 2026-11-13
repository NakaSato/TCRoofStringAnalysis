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
    assert a[6:10] == ["normal", 600, "แดดดี", "online"]
    assert a[10:14] == ["abnormal", "—", "ฝนตก (Google)", "INV2 Offline, INV1 Relay fault"]
    assert a[14] == "normal" and a[15] == "—"
    assert a[5] == "loss (13:00, 17:00)"
    assert b[5] == "—" and b[6] == "—" and b[9] == "offline"  # no published doc: nothing invented
    assert gone[5] == "ไม่พบในระบบ"
    assert empty == [4, "", ""]
    assert (stats.rows, stats.unmatched, stats.normal, stats.abnormal) == (2, 1, 2, 1)


def test_fill_rows_only_given_hours_keeps_others():
    rows = grid()
    rows[2] += [""] * 3 + ["x"] * 12
    ps.fill_rows(DAY, ps.layout(rows), rows, DATA, hours=[9])
    assert rows[2][6] == "normal"
    assert rows[2][10:18] == ["x"] * 8
    assert rows[2][5] == "normal"


def test_published_hours():
    assert ps.published_hours(datetime(2026, 11, 12, 9, 29)) == []
    assert ps.published_hours(datetime(2026, 11, 12, 9, 30)) == [9]
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

    def write(self, rng, rows):
        self.writes[rng] = rows


def test_fill_day_creates_tab_and_writes_block(monkeypatch):
    tpl = grid()
    tpl[2] += [""] * 3 + ["old"] * 13
    client = FakeClient({"Summary": [["x"]], "11.11": tpl})
    monkeypatch.setattr(ps.pwa_report, "build", lambda _db, _day, _docs=None: DATA)
    out = ps.fill_day(None, DAY, [9], client=client)
    assert out["created"] is True and out["sheet"] == "12.11"
    assert client.cleared == ["'12.11'!F3:R6"]
    (rng, block), = client.writes.items()
    assert rng == "'12.11'!F3:R6"
    assert block[0][1:5] == ["normal", 600, "แดดดี", "online"]


def test_col_letter():
    assert [ps.col_letter(n) for n in (1, 26, 27, 52)] == ["A", "Z", "AA", "AZ"]
