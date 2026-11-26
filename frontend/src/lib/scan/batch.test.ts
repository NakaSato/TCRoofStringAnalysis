import { describe, expect, test } from "bun:test";
import type { StockUnit } from "../../api/types/stock";
import { buildBatch, countRows, evaluateRow, findDuplicate, markServerErrors, parseRows, storageKey, type BatchRow } from "./batch";

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

const row = (over: Partial<BatchRow> = {}): BatchRow => ({
  id: "r",
  raw: "SN1",
  input_method: "hid",
  serial: "SN1",
  kind: "serial",
  units: [],
  unit_id: null,
  part: null,
  server_error: null,
  ...over,
});

const PART = { id: 5, code: "P-RUT", name: "Router" };

describe("receive", () => {
  test("new serial needs the part", () => {
    expect(evaluateRow("receive", row(), 10)).toMatchObject({ status: "error", msg: "Pick the part first", send: false });
    expect(evaluateRow("receive", row({ part: PART }), 10)).toMatchObject({ status: "ok", msg: "New", send: true });
  });
  test("a serial in the register is refused with where", () => {
    const e = evaluateRow("receive", row({ part: PART, units: [unit({ state: "installed", location_code: null, plant_name: "Plant X" })] }), 10);
    expect(e).toMatchObject({ status: "error", state: "installed", where: "Plant X", send: false });
  });
  test("not a serial", () => {
    expect(evaluateRow("receive", row({ kind: "unknown" }), 10).msg).toBe("Not a serial");
    expect(evaluateRow("receive", row({ kind: "unit", units: [unit()] }), 10).status).toBe("error");
  });
});

describe("transfer", () => {
  test("in stock elsewhere = ok, already here = warn, not sent", () => {
    expect(evaluateRow("transfer", row({ units: [unit()] }), 20)).toMatchObject({ status: "ok", send: true, where: "STORE-A" });
    expect(evaluateRow("transfer", row({ units: [unit()] }), 10)).toMatchObject({ status: "warn", msg: "Already here", send: false });
  });
  test("installed / failed / none", () => {
    expect(evaluateRow("transfer", row({ units: [unit({ state: "installed" })] }), 20).status).toBe("error");
    expect(evaluateRow("transfer", row({ units: [unit({ state: "failed" })] }), 20).status).toBe("error");
    expect(evaluateRow("transfer", row(), 20)).toMatchObject({ status: "error", msg: "Not in the register" });
  });
  test("several units: pick one", () => {
    const units = [unit({ id: 1 }), unit({ id: 2, part_id: 6 })];
    expect(evaluateRow("transfer", row({ units }), 20)).toMatchObject({ status: "warn", pick: true, send: false });
    expect(evaluateRow("transfer", row({ units, unit_id: 2 }), 20)).toMatchObject({ status: "ok", pick: true, send: true });
  });
});

describe("return", () => {
  test("installed = ok, in stock = error", () => {
    expect(evaluateRow("return", row({ units: [unit({ state: "installed", plant_name: "P1", location_code: null })] }), 10)).toMatchObject({ status: "ok", where: "P1" });
    expect(evaluateRow("return", row({ units: [unit()] }), 10).status).toBe("error");
  });
});

describe("batch", () => {
  test("only sendable rows, with their list index", () => {
    const rows = [row({ id: "a", serial: "A", part: PART }), row({ id: "b", serial: "B" }), row({ id: "c", serial: "C", part: PART, raw: "S/N:C", input_method: "camera" })];
    const b = buildBatch("receive", rows, 10);
    expect(b.index).toEqual([0, 2]);
    expect(b.rows[1]).toEqual({ kind: "receive", part_id: 5, serial: "C", to_location_id: 10, input_method: "camera", raw_scan: "S/N:C" });
  });
  test("transfer rows carry the unit", () => {
    const b = buildBatch("transfer", [row({ units: [unit({ id: 7 })] })], 20);
    expect(b.rows).toEqual([{ kind: "transfer", unit_id: 7, to_location_id: 20, input_method: "hid", raw_scan: "SN1" }]);
  });
  test("409 errors go back to the list rows", () => {
    const rows = [row({ id: "a" }), row({ id: "b" }), row({ id: "c" })];
    const out = markServerErrors(rows, ["a", "c"], [{ row: 1, error: "taken" }, { row: null, error: "x" }, { row: 9, error: "y" }]);
    expect(out.map((r) => r.server_error)).toEqual([null, null, "taken"]);
    expect(evaluateRow("receive", out[2], 10)).toMatchObject({ status: "error", msg: "taken" });
  });
  test("duplicates ignore rows in error", () => {
    const rows = [row({ serial: "sn1" })];
    expect(findDuplicate("receive", rows, "SN1", 10)).toBe(-1); // in error: no part
    expect(findDuplicate("receive", [row({ serial: "sn1", part: PART })], " SN1 ", 10)).toBe(0);
  });
  test("counts", () => {
    expect(countRows("transfer", [row({ units: [unit()] }), row({ units: [unit()] }), row()], 10)).toEqual({ total: 3, ok: 0, warn: 2, error: 1 });
  });
});

describe("storage", () => {
  test("key and parsing", () => {
    expect(storageKey("transfer", 4)).toBe("tcroof.batch.transfer.4");
    expect(storageKey("receive", null)).toBe("tcroof.batch.receive.none");
    expect(parseRows(null)).toEqual([]);
    expect(parseRows("{bad")).toEqual([]);
    expect(parseRows('{"a":1}')).toEqual([]);
    const r = parseRows(JSON.stringify([{ id: "x", raw: "A", serial: "A", kind: "serial", units: [] }, { id: 1 }]));
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ unit_id: null, part: null, server_error: null, input_method: "manual" });
  });
});
