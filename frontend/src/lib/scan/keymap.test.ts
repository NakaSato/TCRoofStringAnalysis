import { describe, expect, test } from "bun:test";
import { KNOWN_CODES, charFromCode, charFromKey, hasThai, thaiToUs } from "./keymap";

describe("keymap", () => {
  test("every printable ASCII character has a key on the US table", () => {
    const typed = new Set<string>();
    for (const code of KNOWN_CODES) for (const shift of [false, true]) {
      const c = charFromCode(code, shift);
      if (c) typed.add(c);
    }
    for (let i = 32; i < 127; i++) expect(typed.has(String.fromCharCode(i))).toBe(true);
  });

  test("physical keys give the same text whatever the layout", () => {
    // RT-0103 as a scanner sends it
    const keys: Array<[string, boolean]> = [["KeyR", true], ["KeyT", true], ["Minus", false], ["Digit0", false], ["Digit1", false], ["Digit0", false], ["Digit3", false]];
    expect(keys.map(([c, s]) => charFromCode(c, s)).join("")).toBe("RT-0103");
    expect(charFromCode("Numpad7", false)).toBe("7");
    expect(charFromCode("ShiftLeft", false)).toBeNull();
  });

  test("CapsLock flips letters only", () => {
    expect(charFromCode("KeyA", false, true)).toBe("A");
    expect(charFromCode("KeyA", true, true)).toBe("a");
    expect(charFromCode("Digit1", false, true)).toBe("1");
  });

  test("Kedmanee characters map back to the US key", () => {
    // R, T on a Thai layout
    expect(charFromKey("พ")).toBe("r");
    expect(charFromKey("ฑ")).toBe("R");
    expect(charFromKey("ะ")).toBe("t");
    expect(charFromKey("ธ")).toBe("T");
    expect(charFromKey("จ")).toBe("0");
    expect(charFromKey("ๅ")).toBe("1");
    expect(charFromKey("๑")).toBe("@");
    expect(charFromKey("A")).toBe("A");
    expect(charFromKey("Shift")).toBeNull();
    expect(thaiToUs("ฑธ-จๅจ")).toBe("RT-010");
    expect(hasThai("RT-01")).toBe(false);
    expect(hasThai("ฑธ")).toBe(true);
  });
});
