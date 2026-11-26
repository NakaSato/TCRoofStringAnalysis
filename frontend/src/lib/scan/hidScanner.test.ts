import { describe, expect, test } from "bun:test";
import { BurstDetector, DEFAULT_SCAN_SETTINGS, type KeyLike } from "./hidScanner";
import { GS } from "./parse";

const US: Record<string, [string, boolean]> = {};
for (const c of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") US[c] = [`Key${c}`, true];
for (const c of "abcdefghijklmnopqrstuvwxyz") US[c] = [`Key${c.toUpperCase()}`, false];
for (const c of "0123456789") US[c] = [`Digit${c}`, false];
US["-"] = ["Minus", false];

/** key events for `text` + Enter, `gap` ms apart; `key` may differ from the physical key (Thai layout) */
const burst = (text: string, gap: number, t0 = 1000, keyOf: (c: string) => string = (c) => c): KeyLike[] => {
  const evs: KeyLike[] = [...text].map((c, i) => ({ key: keyOf(c), code: US[c][0], shiftKey: US[c][1], ctrlKey: false, altKey: false, metaKey: false, time: t0 + i * gap }));
  evs.push({ key: "Enter", code: "Enter", shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, time: t0 + text.length * gap });
  return evs;
};

const run = (d: BurstDetector, evs: KeyLike[]) => evs.map((e) => d.feed(e)).at(-1)!;

describe("BurstDetector", () => {
  test("a fast burst + Enter is a scan", () => {
    const s = run(new BurstDetector(), burst("RT-0103", 8));
    expect(s.kind).toBe("scan");
    if (s.kind === "scan") {
      expect(s.burst.value).toBe("RT-0103");
      expect(s.burst.end).toBe("enter");
      expect(s.burst.gaps.every((g) => g === 8)).toBe(true);
    }
  });

  test("Thai layout: event.key is Thai, the value is still US", () => {
    const thai: Record<string, string> = { R: "ฑ", T: "ธ", "-": "ข", "0": "จ", "1": "ๅ", "3": "-" };
    const s = run(new BurstDetector(), burst("RT-0103", 8, 1000, (c) => thai[c] ?? c));
    expect(s.kind === "scan" && s.burst.value).toBe("RT-0103");
    expect(s.kind === "scan" && s.burst.keys).toContain("ฑ");
  });

  test("a person typing is not a scan", () => {
    expect(run(new BurstDetector(), burst("RT-0103", 120)).kind).toBe("reset");
  });

  test("too short is not a scan", () => {
    expect(run(new BurstDetector(), burst("AB", 5)).kind).toBe("reset");
  });

  test("slow keys before a fast burst are dropped", () => {
    const d = new BurstDetector();
    d.feed({ key: "x", code: "KeyX", shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, time: 0 });
    const s = run(d, burst("ABCD12", 6, 500));
    expect(s.kind === "scan" && s.burst.value).toBe("ABCD12");
  });

  test("prefix is removed and marked", () => {
    const d = new BurstDetector({ ...DEFAULT_SCAN_SETTINGS, prefix: "~" });
    const evs = burst("ABCD", 5, 1000);
    evs.unshift({ key: "~", code: "Backquote", shiftKey: true, ctrlKey: false, altKey: false, metaKey: false, time: 995 });
    const s = run(d, evs);
    expect(s.kind === "scan" && s.burst.value).toBe("ABCD");
    expect(s.kind === "scan" && s.burst.prefixed).toBe(true);
  });

  test("Ctrl+] is GS; modifiers alone are ignored", () => {
    const d = new BurstDetector();
    const evs = burst("0101", 5);
    const enter = evs.pop()!;
    evs.push({ key: "Shift", code: "ShiftLeft", shiftKey: true, ctrlKey: false, altKey: false, metaKey: false, time: 1020 });
    evs.push({ key: "]", code: "BracketRight", shiftKey: false, ctrlKey: true, altKey: false, metaKey: false, time: 1022 });
    evs.push({ key: "2", code: "Digit2", shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, time: 1025 });
    evs.push({ ...enter, time: 1028 });
    const s = run(d, evs);
    expect(s.kind === "scan" && s.burst.value).toBe(`0101${GS}2`);
  });

  test("no suffix: the burst ends on idle", () => {
    const d = new BurstDetector();
    const evs = burst("ABCDEF", 5);
    evs.pop();
    evs.forEach((e) => d.feed(e));
    expect(d.idle(1030)).toBeNull();
    const s = d.idle(1200);
    expect(s?.kind === "scan" && s.burst.end).toBe("idle");
  });
});
