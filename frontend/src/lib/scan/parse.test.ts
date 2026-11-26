import { describe, expect, test } from "bun:test";
import { GS, defaultField, hintFor, isIccid, isImei, isSimCategory, normalise, parseAppCode, parseGs1, pickByHint, serialField, splitFields } from "./parse";

describe("normalise", () => {
  test("prefix, case, controls", () => {
    expect(normalise("  S/N: bne4c1z00a\r\n")).toEqual({ value: "BNE4C1Z00A", partNumber: false });
    expect(normalise("SN BNE4C1Z00A").value).toBe("BNE4C1Z00A");
    expect(normalise("Serial No. 123").value).toBe("123");
    expect(normalise("P/N:ABC-1")).toEqual({ value: "ABC-1", partNumber: true });
    expect(normalise("O1I0").value).toBe("O1I0");
    expect(normalise("SN").value).toBe("SN");
  });
});

describe("parseAppCode", () => {
  test("URL, path and short forms", () => {
    expect(parseAppCode("https://tcroof.example/s/tool/MT-INS-02")).toEqual({ kind: "tool", code: "MT-INS-02" });
    expect(parseAppCode("/s/rt/RT-0103")).toEqual({ kind: "rt", code: "RT-0103" });
    expect(parseAppCode("s/dev/12/")).toEqual({ kind: "dev", code: "12" });
    expect(parseAppCode("TOOL:mt-ins-02")).toEqual({ kind: "tool", code: "mt-ins-02" });
    expect(parseAppCode("https://x.example/s/tool/MT%2001")).toEqual({ kind: "tool", code: "MT 01" });
    expect(parseAppCode("BNE4C1Z00A")).toBeNull();
    expect(parseAppCode("abc:123")).toBeNull();
    expect(parseAppCode("https://example.com/other")).toBeNull();
  });
});

describe("GS1", () => {
  test("element string with GS", () => {
    const g = parseGs1(`]d201095011015300031721123110ABC123${GS}21SN0042`);
    expect(g?.gtin).toBe("09501101530003");
    expect(g?.expiry).toBe("211231");
    expect(g?.batch).toBe("ABC123");
    expect(g?.serial).toBe("SN0042");
  });
  test("human-readable form", () => {
    const g = parseGs1("(01)09501101530003(21)XYZ 9");
    expect(g?.serial).toBe("XYZ 9");
  });
  test("not GS1", () => {
    expect(parseGs1("BNE4C1Z00A")).toBeNull();
    expect(parseGs1("12345")).toBeNull();
  });
});

describe("Luhn ids", () => {
  test("IMEI and ICCID", () => {
    expect(isImei("490154203237518")).toBe(true);
    expect(isImei("490154203237519")).toBe(false);
    expect(isIccid("8966012345678901231")).toBe(true);
    expect(isIccid("8966012345678901232")).toBe(false);
    expect(isIccid("1234567890123456789")).toBe(false);
  });
});

describe("splitFields", () => {
  test("keyed fields, serial picked", () => {
    const f = splitFields("SN:1102345678;IMEI:490154203237518;MAC:00:1E:42:AA:BB:CC");
    expect(f.map((x) => x.role)).toEqual(["serial", "imei", "mac"]);
    expect(serialField(f)?.value).toBe("1102345678");
  });
  test("a SIM field pre-selects the ICCID, never the serial", () => {
    const f = splitFields("S/N:1102345678;IMEI:490154203237518;ICCID:8966012345678901234");
    expect(isSimCategory("router:sim")).toBe(true);
    expect(isSimCategory("router")).toBe(false);
    expect(isSimCategory(undefined)).toBe(false);
    expect(defaultField(f, "router:sim")?.value).toBe("8966012345678901234");
    expect(defaultField(f, "router")?.value).toBe("1102345678");
    expect(defaultField(f)?.value).toBe("1102345678");
    // no ICCID on the label: nothing pre-selected for the SIM field
    expect(defaultField(splitFields("SN:1102345678;IMEI:490154203237518"), "router:sim")).toBeNull();
  });
  test("unkeyed list: roles from the values", () => {
    const f = splitFields("RUT241|1102345678|490154203237518");
    expect(f.map((x) => x.value)).toEqual(["RUT241", "1102345678", "490154203237518"]);
    expect(f[2].role).toBe("imei");
    expect(serialField(f)).toBeNull();
  });
  test("one value or an app code is not a multi-field label", () => {
    expect(splitFields("BNE4C1Z00A")).toEqual([]);
    expect(splitFields("https://x.example/s/tool/MT-1")).toEqual([]);
  });
  test("GS1 fields", () => {
    const f = splitFields(`]d2010950110153000321SN0042`);
    expect(serialField(f)?.value).toBe("SN0042");
  });
});

describe("field hints", () => {
  const keyed = splitFields("Model:RUT241;S/N:1102345678;IMEI:356938035643809");
  const bare = splitFields("RUT241|1102345678|356938035643809");

  test("by printed key, case and spaces ignored", () => {
    expect(pickByHint(keyed, { field_key: "s/n", field_index: 0, field_count: 9 })?.value).toBe("1102345678");
    expect(pickByHint(keyed, { field_key: "MAC", field_index: 0, field_count: 3 })).toBeNull();
  });

  test("by position only when the field count matches", () => {
    expect(pickByHint(bare, { field_key: null, field_index: 1, field_count: 3 })?.value).toBe("1102345678");
    expect(pickByHint(bare, { field_key: null, field_index: 1, field_count: 4 })).toBeNull();
    expect(pickByHint(bare, null)).toBeNull();
  });

  test("hintFor keeps a unique key, else the position", () => {
    expect(hintFor(keyed, 1)).toEqual({ field_key: "S/N", field_index: 1, field_count: 3 });
    expect(hintFor(bare, 1)).toEqual({ field_key: null, field_index: 1, field_count: 3 });
    const dup = splitFields("SN:A1;SN:B2;IMEI:356938035643809");
    expect(hintFor(dup, 1).field_key).toBeNull();
  });
});
