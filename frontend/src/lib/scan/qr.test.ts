import { describe, expect, test } from "bun:test";
import qrcode from "qrcode-generator";
import { QUIET_ZONE, qrSvg } from "./qr";

/** dark modules back out of the path, to compare with the library's own matrix */
const darkSet = (d: string): Set<string> => {
  const out = new Set<string>();
  for (const m of d.matchAll(/M(\d+) (\d+)h(\d+)/g)) {
    const [x, y, w] = [Number(m[1]), Number(m[2]), Number(m[3])];
    for (let i = 0; i < w; i++) out.add(`${x + i},${y}`);
  }
  return out;
};

describe("qrSvg", () => {
  const url = "https://tcroof-string-analysis.web.app/s/tool/MT-INS-02";

  test("quiet zone and size", () => {
    const q = qrSvg(url);
    // a 55-byte URL at level Q needs version 5 (37 modules; version 4 holds 46 bytes)
    expect(q.size).toBe(37 + 2 * QUIET_ZONE);
    const dark = darkSet(q.d);
    for (let i = 0; i < q.size; i++) {
      for (const [x, y] of [[i, 0], [0, i], [i, q.size - 1], [q.size - 1, i]]) expect(dark.has(`${x},${y}`)).toBe(false);
    }
    // top-left finder pattern: its corner module is dark
    expect(dark.has(`${QUIET_ZONE},${QUIET_ZONE}`)).toBe(true);
  });

  test("the path is exactly the library's dark modules", () => {
    const q = qrSvg(url);
    const ref = qrcode(0, "Q");
    ref.addData(url, "Byte");
    ref.make();
    const want = new Set<string>();
    for (let r = 0; r < ref.getModuleCount(); r++)
      for (let c = 0; c < ref.getModuleCount(); c++) if (ref.isDark(r, c)) want.add(`${c + QUIET_ZONE},${r + QUIET_ZONE}`);
    expect(darkSet(q.d)).toEqual(want);
  });

  test("UTF-8: a Thai character takes three bytes, not one", () => {
    // 5 Thai characters = 15 bytes: too many for version 1 at level Q (11 bytes), unlike 5 Latin ones
    expect(qrSvg("ABCDE").size).toBe(21 + 2 * QUIET_ZONE);
    expect(qrSvg("ทดสอบ").size).toBe(25 + 2 * QUIET_ZONE);
  });
});
