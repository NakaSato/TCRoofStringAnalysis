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
    assert model_spec("MID 30KTL3-X") is None
    assert model_spec(None) is None and model_spec("") is None


def test_max_50_80ktl3_lv_datasheets():
    s80 = model_spec("MAX 80KTL3 LV")
    s60 = model_spec("MAX 60KTL3 LV")
    assert s80 and s60
    assert (s80["rated_power_w"], s80["max_apparent_power_va"], s80["max_output_current_a"]) == (80000.0, 88800.0, 128.8)
    assert (s60["rated_power_w"], s60["max_apparent_power_va"], s60["max_output_current_a"]) == (60000.0, 66600.0, 96.6)
    assert (s80["mppt_count"], s60["mppt_count"]) == (7, 6)
    for s in (s80, s60):
        assert s["strings_per_mppt"] == 2
        assert s["max_input_current_per_mppt_a"] == 26.0 and s["max_short_circuit_current_per_mppt_a"] == 32.0
        assert (s["mppt_voltage_min_v"], s["mppt_voltage_max_v"], s["start_voltage_v"]) == (200.0, 1000.0, 250.0)
    assert (s80["max_pv_power_w"], s60["max_pv_power_w"]) == (120000.0, 90000.0)
    # a copy: changing one answer never changes the catalog or another model
    s80["certifications"].append("x")
    assert "x" not in model_spec("MAX 60KTL3 LV")["certifications"]


def test_mid_40ktl3_x_datasheet():
    s = model_spec("MID 40KTL3-X")
    assert s is not None and s["datasheet_status"] == "preliminary"
    assert (s["rated_power_w"], s["max_apparent_power_va"], s["max_output_current_a"]) == (40000.0, 44000.0, 66.6)
    assert (s["mppt_count"], s["strings_per_mppt"]) == (4, 2)
    assert (s["max_input_current_per_mppt_a"], s["max_short_circuit_current_per_mppt_a"]) == (26.0, 32.0)
    assert s["max_pv_power_w"] == 60000.0
    assert model_spec("MID40KTL3-X")["model"] == "MID 40KTL3-X"
