import { describe, expect, test } from "bun:test";
import type { CountPreview, CountRow, StockLocation, StockUnit } from "../../api/types/stock";
import {
  blockingCount,
  buildCountScans,
  confirmGate,
  countRowKey,
  countStorageKey,
  findCountDuplicate,
  groupRows,
  isFirstCount,
  isStockChanged,
  parseCountRows,
  previewByRow,
  rowErrors,
  scansKey,
  type CountListRow,
} from "./count";
import { markServerErrors } from "./batch";

const unit = (over: Partial<StockUnit> = {}): StockUnit => ({
  id: 1,
  part_id: 5,
  part_code: "P-RUT",
  part_name: "Router",
  serial: "SN1",
  state: "in_stock",
  location_id: 10,
  location_code: "STORE-A",
  plant_id: null,
  plant_name: null,
  received_day: null,
  note: null,
  ...over,
});

const row = (over: Partial<CountListRow> = {}): CountListRow => ({
  id: "r",
  raw: "SN1",
  input_method: "hid",
  serial: "SN1",
  kind: "serial",
  units: [],
  part_id: null,
  server_error: null,
  ...over,
});

const LOC = { id: 10, code: "STORE-A" } as StockLocation;
const counts = (over: Partial<CountPreview["counts"]> = {}): CountPreview["counts"] => ({
  scanned: 0,
  matched: 0,
  moved_here: 0,
  found_again: 0,
  new: 0,
  missing: 0,
  needs_part: 0,
  ambiguous: 0,
  blocked: 0,
  duplicate: 0,
  not_a_unit: 0,
  ...over,
});
const crow = (index: number, result: CountRow["result"]): CountRow => ({ index, raw: "", input_method: "hid", serial: null, result, unit: null, part_id: null, message: null });
const preview = (over: Partial<CountPreview> = {}): CountPreview => ({ location: LOC, expected: [], rows: [], missing: [], counts: counts(), expected_ids: [], ...over });

describe("scans", () => {
  test("oldest first, with the list id of each index", () => {
    const rows = [row({ id: "b", raw: "B" }), row({ id: "a", raw: "A" })];
    const { scans, ids } = buildCountScans(rows, null);
    expect(scans.map((s) => s.raw)).toEqual(["A", "B"]);
    expect(ids).toEqual(["a", "b"]);
  });
  test("a new serial takes the row's part, else the part for new serials", () => {
    expect(buildCountScans([row()], 7).scans[0]).toEqual({ raw: "SN1", input_method: "hid", part_id: 7 });
    expect(buildCountScans([row({ part_id: 3 })], 7).scans[0].part_id).toBe(3);
    expect(buildCountScans([row()], null).scans[0].part_id).toBeUndefined();
  });
  test("a known serial sends no part; an sp label sends its unit", () => {
    expect(buildCountScans([row({ units: [unit()] })], 7).scans[0]).toEqual({ raw: "SN1", input_method: "hid" });
    expect(buildCountScans([row({ kind: "unit", units: [unit({ id: 9 })] })], null).scans[0].unit_id).toBe(9);
  });
  test("several parts: the pick sends unit and part", () => {
    const units = [unit({ id: 1, part_id: 5 }), unit({ id: 2, part_id: 6 })];
    expect(buildCountScans([row({ units })], 7).scans[0]).toEqual({ raw: "SN1", input_method: "hid" });
    expect(buildCountScans([row({ units, part_id: 6 })], 7).scans[0]).toMatchObject({ unit_id: 2, part_id: 6 });
  });
  test("key follows location and scans", () => {
    const s = buildCountScans([row()], null).scans;
    expect(scansKey(1, s)).toBe(scansKey(1, buildCountScans([row()], null).scans));
    expect(scansKey(1, s)).not.toBe(scansKey(2, s));
    expect(scansKey(1, s)).not.toBe(scansKey(1, buildCountScans([row()], 4).scans));
  });
});

describe("preview mapping", () => {
  test("rows by index, out of range ignored", () => {
    const m = previewByRow(preview({ rows: [crow(0, "matched"), crow(1, "new"), crow(5, "new")] }), ["a", "b"]);
    expect(m.get("a")?.result).toBe("matched");
    expect(m.get("b")?.result).toBe("new");
    expect(m.size).toBe(2);
    expect(previewByRow(null, ["a"]).size).toBe(0);
  });
  test("groups: pending first, problems before matched", () => {
    const rows = [row({ id: "a" }), row({ id: "b" }), row({ id: "c" }), row({ id: "d" })];
    const m = new Map<string, CountRow>([
      ["a", crow(0, "matched")],
      ["b", crow(1, "needs_part")],
      ["d", crow(3, "matched")],
    ]);
    expect(groupRows(rows, m).map((g) => [g.key, g.rows.map((r) => r.id)])).toEqual([
      ["pending", ["c"]],
      ["needs_part", ["b"]],
      ["matched", ["a", "d"]],
    ]);
  });
});

describe("confirm", () => {
  const base = { keeper: true, locationId: 10, preview: preview({ rows: [crow(0, "matched")], counts: counts({ matched: 1 }) }), fresh: true, busy: false, serverErrors: 0 };
  test("ok", () => expect(confirmGate(base)).toEqual({ ok: true, reason: null }));
  test("only a keeper", () => expect(confirmGate({ ...base, keeper: false }).reason).toBe("An admin or store keeper confirms the count"));
  test("needs a location and a fresh preview", () => {
    expect(confirmGate({ ...base, locationId: null }).ok).toBe(false);
    expect(confirmGate({ ...base, fresh: false }).reason).toBe("Checking the list…");
    expect(confirmGate({ ...base, preview: null }).ok).toBe(false);
  });
  test("blocking rows stop it", () => {
    const p = preview({ rows: [crow(0, "ambiguous")], counts: counts({ ambiguous: 1, needs_part: 1, blocked: 1 }) });
    expect(blockingCount(p)).toBe(3);
    expect(confirmGate({ ...base, preview: p })).toMatchObject({ ok: false, vars: { n: 3 } });
  });
  test("duplicates and not-a-unit do not stop it", () => {
    const p = preview({ rows: [crow(0, "duplicate"), crow(1, "not_a_unit")], counts: counts({ duplicate: 1, not_a_unit: 1 }) });
    expect(confirmGate({ ...base, preview: p }).ok).toBe(true);
  });
  test("server errors and an empty count stop it", () => {
    expect(confirmGate({ ...base, serverErrors: 1 }).ok).toBe(false);
    expect(confirmGate({ ...base, preview: preview() }).ok).toBe(false);
  });
  test("an empty scan of a location with stock is a count (all missing)", () => {
    expect(confirmGate({ ...base, preview: preview({ expected: [unit()], missing: [unit()], counts: counts({ missing: 1 }) }) }).ok).toBe(true);
  });
  test("first count = nothing expected", () => {
    expect(isFirstCount(preview())).toBe(true);
    expect(isFirstCount(preview({ expected: [unit()] }))).toBe(false);
    expect(isFirstCount(null)).toBe(false);
  });
});

describe("errors", () => {
  test("stock_changed vs row errors", () => {
    const changed = { status: 409, detail: { code: "stock_changed", message: "x" } };
    const rowsErr = { status: 409, detail: { message: "x", errors: [{ row: 0, error: "needs part" }] } };
    expect(isStockChanged(changed)).toBe(true);
    expect(isStockChanged(rowsErr)).toBe(false);
    expect(rowErrors(changed)).toBeNull();
    expect(rowErrors(rowsErr)?.errors).toHaveLength(1);
    expect(rowErrors({ status: 403, detail: { errors: [] } })).toBeNull();
    expect(isStockChanged(new Error("x"))).toBe(false);
  });
  test("row errors go back to the list rows by scan index", () => {
    const rows = [row({ id: "b" }), row({ id: "a" })];
    const { ids } = buildCountScans(rows, null);
    const out = markServerErrors(rows, ids, [{ row: 0, error: "needs part" }]);
    expect(out.find((r) => r.id === "a")?.server_error).toBe("needs part");
    expect(out.find((r) => r.id === "b")?.server_error).toBeNull();
  });
  test("duplicates by serial key", () => {
    const scan = (serial: string) => ({ serial, units: [], part_id: null });
    expect(findCountDuplicate([row({ serial: "sn1" })], scan(" SN1 "))).toBe(0);
    expect(findCountDuplicate([row({ serial: "sn2" })], scan("SN1"))).toBe(-1);
  });
  test("two parts sharing a serial count as two units (#140)", () => {
    const a = unit({ id: 1, part_id: 5, serial: "R1" });
    const b = unit({ id: 2, part_id: 6, serial: "R1" });
    expect(countRowKey({ serial: "R1", units: [a], part_id: null })).toBe("unit:1");
    expect(countRowKey({ serial: "R1", units: [a, b], part_id: null })).toBe("serial:R1");
    expect(countRowKey({ serial: "R1", units: [a, b], part_id: 6 })).toBe("unit:2");
    expect(countRowKey({ serial: "R1", units: [a, b], part_id: 99 })).toBe("serial:R1");
    // two unit labels
    const rows = [row({ id: "x", kind: "unit", serial: "R1", units: [a] })];
    expect(findCountDuplicate(rows, { serial: "R1", units: [b], part_id: null })).toBe(-1);
    expect(findCountDuplicate(rows, { serial: "R1", units: [a], part_id: null })).toBe(0);
    // the serial scanned again after a part was picked on the first row: the other unit can be counted
    const picked = [row({ id: "p", serial: "R1", units: [a, b], part_id: 5 })];
    expect(findCountDuplicate(picked, { serial: "R1", units: [a, b], part_id: null })).toBe(-1);
    // ... but not while the first row has no part yet
    expect(findCountDuplicate([row({ serial: "R1", units: [a, b] })], { serial: "R1", units: [a, b], part_id: null })).toBe(0);
  });
});

describe("storage", () => {
  test("key and parsing", () => {
    expect(countStorageKey(4)).toBe("tcroof.batch.count.4");
    expect(countStorageKey(null)).toBe("tcroof.batch.count.none");
    expect(parseCountRows(null)).toEqual([]);
    expect(parseCountRows("{bad")).toEqual([]);
    const r = parseCountRows(JSON.stringify([{ id: "x", raw: "A", serial: "A", kind: "serial", units: [] }, { id: 1 }]));
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ part_id: null, server_error: null, input_method: "manual" });
  });
});
