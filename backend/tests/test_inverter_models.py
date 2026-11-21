from app.services.inverter_models import model_spec


def test_max_125ktl3_x_lv_datasheet():
    spec = model_spec("MAX 125KTL3-X LV")
    assert spec is not None
    assert spec["rated_power_w"] == 125000.0
    assert spec["max_apparent_power_va"] == 137500.0
    assert spec["mppt_count"] == 10 and spec["strings_per_mppt"] == 2
    assert spec["max_input_current_per_mppt_a"] == 32.0
    assert spec["max_short_circuit_current_per_mppt_a"] == 40.0
    assert (spec["mppt_voltage_min_v"], spec["mppt_voltage_max_v"]) == (180.0, 1000.0)
    assert spec["max_output_current_a"] == 198.5
    assert spec["euro_efficiency_pct"] == 98.5


def test_model_name_spelling_and_unknown():
    assert model_spec("MAX125KTL3-XLV")["model"] == "MAX 125KTL3-X LV"
    assert model_spec(" max 125ktl3-x lv ") is not None
    assert model_spec("MAX 110KTL3-X LV") is None
    assert model_spec(None) is None and model_spec("") is None
