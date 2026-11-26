import { describe, expect, test } from "bun:test";
import type { ScanLabel } from "../../api/types/scan";
import { LAYOUTS, cellAt, isLocalOrigin, labelsCsv, perSheet, toSheets } from "./labelSheet";

const lab = (n: number): ScanLabel => ({ kind: "tool", key: String(n), code: `tool:MT-${n}`, path: `/s/tool/MT-${n}`, title: `MT-${n}`, lines: [] });

describe("layouts fit A4", () => {
  for (const l of Object.values(LAYOUTS)) {
    test(l.id, () => {
      const right = l.left + l.cols * l.w + (l.cols - 1) * l.colGap;
      const bottom = l.top + l.rows * l.h + (l.rows - 1) * l.rowGap;
      expect(right).toBeLessThanOrEqual(210);
      expect(bottom).toBeLessThanOrEqual(297);
      // centred within a millimetre
      expect(Math.abs(l.left - (210 - right))).toBeLessThan(1);
      expect(l.qr).toBeGreaterThanOrEqual(15);
      expect(l.qr).toBeLessThan(l.h);
    });
  }
});

describe("toSheets", () => {
  const l = LAYOUTS.tag8; // 8 a sheet

  test("fills sheets in order, pads the last", () => {
    const s = toSheets([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(lab), l);
    expect(s.length).toBe(2);
    expect(s[0].map((c) => c?.title)).toEqual(["MT-1", "MT-2", "MT-3", "MT-4", "MT-5", "MT-6", "MT-7", "MT-8"]);
    expect(s[1].filter(Boolean).length).toBe(2);
    expect(s[1].length).toBe(perSheet(l));
  });

  test("start at label N leaves the used ones empty", () => {
    const s = toSheets([1, 2, 3].map(lab), l, 7);
    expect(s[0].slice(0, 6).every((c) => c === null)).toBe(true);
    expect(s[0][6]?.title).toBe("MT-1");
    expect(s[1][0]?.title).toBe("MT-3");
    // out of range: clamped
    expect(toSheets([lab(1)], l, 0)[0][0]?.title).toBe("MT-1");
    expect(toSheets([lab(1)], l, 99)[0][7]?.title).toBe("MT-1");
    expect(toSheets([], l, 3)).toEqual([]);
  });

  test("cell positions", () => {
    expect(cellAt(LAYOUTS.poly24, 0)).toEqual({ x: 7.25, y: 12.9 });
    const c = cellAt(LAYOUTS.poly24, 4); // row 2, col 2
    expect(c.x).toBeCloseTo(7.25 + 66, 6);
    expect(c.y).toBeCloseTo(12.9 + 33.9, 6);
  });
});

test("csv", () => {
  const csv = labelsCsv([{ ...lab(1), title: 'Tag, "one"', lines: ["Fluke 1587", "S/N 42"] }], "https://app.example/");
  expect(csv.split("\r\n")).toEqual(["code,qr_url,title,text", 'tool:MT-1,https://app.example/s/tool/MT-1,"Tag, ""one""",Fluke 1587 | S/N 42']);
});

test("local origins", () => {
  for (const o of ["http://localhost:5173", "https://192.168.1.20:5173", "http://10.0.0.5", "http://172.20.1.1", "http://127.0.0.1:8000", "http://mac.local"])
    expect(isLocalOrigin(o)).toBe(true);
  for (const o of ["https://tcroof-string-analysis.web.app", "https://172.32.0.1", "https://example.com"]) expect(isLocalOrigin(o)).toBe(false);
});
