/**
 * Keyboard-wedge scanners send key positions, not characters (docs/plans/barcode-scanning.md §4.3).
 * With the OS input source on Thai (Kedmanee), `RT-0103` arrives as Thai letters in `event.key`.
 * So a scan is rebuilt from `KeyboardEvent.code` (the physical key) + Shift through a fixed US
 * table, whatever layout is active. `event.key` is used only when `code` is empty (some Bluetooth
 * stacks), through the Kedmanee → US reverse table.
 *
 * Pure module (no DOM), unit-tested with `bun test`.
 */

/** physical key → [US, US + Shift, Kedmanee, Kedmanee + Shift] */
const ROWS: Record<string, readonly [string, string, string, string]> = {
  Backquote: ["`", "~", "_", "%"],
  Digit1: ["1", "!", "ๅ", "+"],
  Digit2: ["2", "@", "/", "๑"],
  Digit3: ["3", "#", "-", "๒"],
  Digit4: ["4", "$", "ภ", "๓"],
  Digit5: ["5", "%", "ถ", "๔"],
  Digit6: ["6", "^", "ุ", "ู"],
  Digit7: ["7", "&", "ึ", "฿"],
  Digit8: ["8", "*", "ค", "๕"],
  Digit9: ["9", "(", "ต", "๖"],
  Digit0: ["0", ")", "จ", "๗"],
  Minus: ["-", "_", "ข", "๘"],
  Equal: ["=", "+", "ช", "๙"],
  KeyQ: ["q", "Q", "ๆ", "๐"],
  KeyW: ["w", "W", "ไ", '"'],
  KeyE: ["e", "E", "ำ", "ฎ"],
  KeyR: ["r", "R", "พ", "ฑ"],
  KeyT: ["t", "T", "ะ", "ธ"],
  KeyY: ["y", "Y", "ั", "ํ"],
  KeyU: ["u", "U", "ี", "๊"],
  KeyI: ["i", "I", "ร", "ณ"],
  KeyO: ["o", "O", "น", "ฯ"],
  KeyP: ["p", "P", "ย", "ญ"],
  BracketLeft: ["[", "{", "บ", "ฐ"],
  BracketRight: ["]", "}", "ล", ","],
  Backslash: ["\\", "|", "ฃ", "ฅ"],
  KeyA: ["a", "A", "ฟ", "ฤ"],
  KeyS: ["s", "S", "ห", "ฆ"],
  KeyD: ["d", "D", "ก", "ฏ"],
  KeyF: ["f", "F", "ด", "โ"],
  KeyG: ["g", "G", "เ", "ฌ"],
  KeyH: ["h", "H", "้", "็"],
  KeyJ: ["j", "J", "่", "๋"],
  KeyK: ["k", "K", "า", "ษ"],
  KeyL: ["l", "L", "ส", "ศ"],
  Semicolon: [";", ":", "ว", "ซ"],
  Quote: ["'", '"', "ง", "."],
  KeyZ: ["z", "Z", "ผ", "("],
  KeyX: ["x", "X", "ป", ")"],
  KeyC: ["c", "C", "แ", "ฉ"],
  KeyV: ["v", "V", "อ", "ฮ"],
  KeyB: ["b", "B", "ิ", "ฺ"],
  KeyN: ["n", "N", "ื", "์"],
  KeyM: ["m", "M", "ท", "?"],
  Comma: [",", "<", "ม", "ฒ"],
  Period: [".", ">", "ใ", "ฬ"],
  Slash: ["/", "?", "ฝ", "ฦ"],
  Space: [" ", " ", " ", " "],
};

/** numeric keypad: the same character with any layout and without NumLock tricks */
const NUMPAD: Record<string, string> = {
  Numpad0: "0",
  Numpad1: "1",
  Numpad2: "2",
  Numpad3: "3",
  Numpad4: "4",
  Numpad5: "5",
  Numpad6: "6",
  Numpad7: "7",
  Numpad8: "8",
  Numpad9: "9",
  NumpadDecimal: ".",
  NumpadAdd: "+",
  NumpadSubtract: "-",
  NumpadMultiply: "*",
  NumpadDivide: "/",
};

/** Thai character → the US character at the same key position (non-ASCII Kedmanee output only:
 * ASCII it produces, like `/` on Digit2, cannot be told from the same US character). */
const THAI_TO_US: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  for (const [us, usShift, th, thShift] of Object.values(ROWS)) {
    if (th.charCodeAt(0) > 127) m[th] = us;
    if (thShift.charCodeAt(0) > 127) m[thShift] = usShift;
  }
  return m;
})();

/** The US character of a physical key, or null for a key that types nothing (Shift, F-keys, …).
 * CapsLock flips letters only. */
export const charFromCode = (code: string, shift: boolean, capsLock = false): string | null => {
  const pad = NUMPAD[code];
  if (pad) return pad;
  const row = ROWS[code];
  if (!row) return null;
  const letter = code.startsWith("Key");
  const upper = letter && capsLock ? !shift : shift;
  return upper ? row[1] : row[0];
};

/** Fallback when `code` is empty: `event.key` with Thai characters turned back into US ones. */
export const charFromKey = (key: string): string | null => {
  if ([...key].length !== 1) return null;
  return THAI_TO_US[key] ?? key;
};

/** Does the text hold Thai characters (the input source was Thai while scanning)? */
export const hasThai = (s: string): boolean => /[฀-๿]/.test(s);

/** Whole-string fallback: Thai characters of a pasted / typed value turned into US ones. */
export const thaiToUs = (s: string): string => [...s].map((c) => THAI_TO_US[c] ?? c).join("");

/** For tests: every physical key the table knows. */
export const KNOWN_CODES = [...Object.keys(ROWS), ...Object.keys(NUMPAD)];
