"""Growatt OpenAPI client tests (no network)."""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from solar_core.growatt import GrowattAPIError, GrowattClient


def _resp(body):
    r = MagicMock()
    r.json.return_value = body
    r.raise_for_status.return_value = None
    return r


def test_missing_token_raises():
    with pytest.raises(GrowattAPIError):
        GrowattClient(token="")


def test_list_inverters_dedupes_max_and_skips_sensors():
    client = GrowattClient(token="t")
    client.session.get = MagicMock(
        return_value=_resp(
            {
                "error_code": 0,
                "data": {
                    "count": 3,
                    "devices": [
                        {"device_sn": "env", "type": 3, "datalogger_sn": "L1"},
                        {"device_sn": "INV1", "type": 1, "status": 1, "lost": False, "datalogger_sn": "L1"},
                        {"device_sn": "INV1", "type": 4, "status": 1, "lost": False, "datalogger_sn": "L1"},
                    ],
                },
            }
        )
    )
    invs = client.list_inverters(123)
    assert [i["device_sn"] for i in invs] == ["INV1"]
    assert invs[0]["device_types"] == ["inverter", "max"]
    assert invs[0]["status_label"] == "Normal"

    client.list_inverters(123)  # served from cache
    assert client.session.get.call_count == 1


def test_error_code_raises():
    client = GrowattClient(token="t")
    client.session.get = MagicMock(return_value=_resp({"error_code": 10012, "error_msg": "rate limited"}))
    with pytest.raises(GrowattAPIError, match="10012"):
        client.list_plants()


def test_parse_max_records_strings_mppt_and_night_filter():
    from solar_core.growatt import parse_max_records

    day = {"time": "2026-11-11 12:00:00", "ppv": 9000, "pac": 8800, "status": 1,
           "vString1": 730, "currentString1": 7.0, "vString2": 730, "currentString2": 0,
           "vString3": 700, "currentString3": 5.5, "vpv1": 730, "ipv1": 7.0, "ppv1": 5110}
    night = {"time": "2026-11-11 23:00:00", "ppv": 0, "pac": 0, "status": 0,
             "vString1": 60, "currentString1": 0, "vString2": 60, "vString3": 60}
    inv, strings = parse_max_records("SN1", [day, night])

    assert len(inv) == 2
    assert inv[0]["mppt_json"] == [{"mppt": 1, "v": 730.0, "i": 7.0, "p": 5110.0}]
    # night record produces no string rows; zero-current string 2 is kept (could be a dead string)
    assert [(s["string_no"], s["mppt_no"], s["power_w"]) for s in strings] == [(1, 1, 5110.0), (2, 1, 0.0), (3, 2, 3850.0)]
