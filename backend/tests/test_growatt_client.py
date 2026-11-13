"""Growatt OpenAPI client: error text."""

from solar_core.growatt import growatt_error_text


# --- Growatt error text: Growatt's own message, never a made-up "unknown error" ---


def test_growatt_error_text_uses_growatts_message():
    assert growatt_error_text({"error_code": 10012, "error_msg": "error_frequently_access"}) == "error_frequently_access"
    assert growatt_error_text({"error_code": 10012, "error_msg": "", "msg": "too fast"}) == "too fast"
    text = growatt_error_text({"error_code": 10001, "error_msg": "", "data": {"x": 1}})
    assert "unknown" not in text and "'data': {'x': 1}" in text
    assert growatt_error_text({"error_code": 10001}) == "no message and no other fields"
