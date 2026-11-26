/**
 * What a scanned code holds (docs/plans/barcode-scanning.md §6). Pure module, `bun test`.
 *
 * - `normalise`: control characters out (GS kept), trimmed, label prefix (`S/N:`, `SN`, `P/N`)
 *   removed, upper case. O ↔ 0 and I ↔ 1 are never swapped.
 * - `parseAppCode`: TC Roof labels (`https://host/s/<kind>/<code>`, `/s/<kind>/<code>`, `kind:code`).
 * - `parseGs1`: GS1 element strings (`]d2…`, `(01)…(21)…`, or AIs separated by GS).
 * - `splitFields`: multi-field labels (`SN:…;IMEI:…`, `|`, `,`, new lines) into fields, the serial
 *   pre-selected when a field is labelled so.
 * - `isImei` / `isIccid`: Luhn-checked identifiers, offered as IMEI / SIM, never as the device SN.
 * - `pickByHint` / `hintFor`: the field remembered per category + model (`/scan/field-hints`).
 *
 * The backend (`services/scan.py`) normalises the same way; keep the two in step.
 */

export const GS = "\x1d";

export const APP_KINDS = ["rt", "sp", "loc", "tool", "dev", "df"] as const;
export type AppKind = (typeof APP_KINDS)[number];

/** Control characters out, except GS (GS1 field separator); spaces trimmed. */
export const clean = (raw: string): string =>
  [...raw]
    .filter((ch) => ch === GS || (ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) !== 127))
    .join("")
    .trim();

const PREFIX = /^(?:SERIAL\s*NO\.?|SERIAL\s*NUMBER|S\/N|SN|P\/N)\s*[:#.-]?\s*/i;

export interface Normalised {
  /** for comparison: upper case, prefix removed */
  value: string;
  /** the label said P/N: a part number, not a serial */
  partNumber: boolean;
}

export const normalise = (raw: string): Normalised => {
  let s = clean(raw);
  let partNumber = false;
  const m = PREFIX.exec(s);
  if (m && m[0].length < s.length) {
    partNumber = m[0].toUpperCase().startsWith("P/N");
    s = s.slice(m[0].length).trim();
  }
  return { value: s.toUpperCase(), partNumber };
};

export interface AppCode {
  kind: AppKind;
  code: string;
}

const APP_PATH = /^\/?s\/([a-z]+)\/(.+)$/i;
const APP_SHORT = /^([a-z]+):(\S.*)$/i;

const decode = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

export const parseAppCode = (raw: string): AppCode | null => {
  const s = clean(raw);
  if (!s) return null;
  let path = s;
  if (/^https?:\/\//i.test(s)) {
    try {
      path = new URL(s).pathname;
    } catch {
      return null;
    }
  }
  const m = APP_PATH.exec(path) ?? APP_SHORT.exec(s);
  if (!m) return null;
  const kind = m[1].toLowerCase();
  const code = decode(m[2]).trim().replace(/^\/+|\/+$/g, "");
  if (!code || !(APP_KINDS as readonly string[]).includes(kind)) return null;
  return { kind: kind as AppKind, code };
};

// ---------------------------------------------------------------- GS1

/** Fixed-length AIs (value length); every other AI is variable length, ended by GS or the end. */
const GS1_FIXED: Record<string, number> = {
  "00": 18,
  "01": 14,
  "02": 14,
  "11": 6,
  "12": 6,
  "13": 6,
  "15": 6,
  "16": 6,
  "17": 6,
  "20": 2,
};
/** variable-length AIs this app reads, with their maximum length */
const GS1_VARIABLE: Record<string, number> = { "10": 20, "21": 20, "240": 30, "241": 30, "250": 30, "30": 8, "37": 8 };

export interface Gs1Field {
  ai: string;
  value: string;
}

export interface Gs1 {
  fields: Gs1Field[];
  gtin: string | null;
  serial: string | null;
  batch: string | null;
  /** YYMMDD as printed (AI 17) */
  expiry: string | null;
}

const SYMBOLOGY = /^\][A-Za-z]\d/;

const gs1Result = (fields: Gs1Field[]): Gs1 => {
  const get = (ai: string) => fields.find((f) => f.ai === ai)?.value ?? null;
  return { fields, gtin: get("01"), serial: get("21"), batch: get("10"), expiry: get("17") };
};

/** GS1 element string, or null when the text is not one. A variable field without GS reads to the end. */
export const parseGs1 = (raw: string): Gs1 | null => {
  let s = raw.replace(/[\r\n]+$/, "");
  const hadSymbology = SYMBOLOGY.test(s);
  if (hadSymbology) s = s.slice(3);
  // human-readable form: (01)09501101530003(21)ABC
  if (s.startsWith("(")) {
    const fields: Gs1Field[] = [];
    const re = /\((\d{2,4})\)([^(]*)/g;
    let m: RegExpExecArray | null;
    let consumed = 0;
    while ((m = re.exec(s))) {
      fields.push({ ai: m[1], value: m[2].replace(new RegExp(GS, "g"), "").trim() });
      consumed += m[0].length;
    }
    return fields.length && consumed === s.length ? gs1Result(fields) : null;
  }
  if (!hadSymbology && !s.includes(GS)) return null;
  if (!/^\d{2}/.test(s)) return null;
  const fields: Gs1Field[] = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === GS) {
      i += 1;
      continue;
    }
    const two = s.slice(i, i + 2);
    const three = s.slice(i, i + 3);
    let ai: string;
    if (two in GS1_FIXED) ai = two;
    else if (three in GS1_VARIABLE) ai = three;
    else if (two in GS1_VARIABLE) ai = two;
    else return fields.length ? gs1Result(fields) : null;
    i += ai.length;
    if (ai in GS1_FIXED) {
      const n = GS1_FIXED[ai];
      const v = s.slice(i, i + n);
      if (v.length < n || !/^\d+$/.test(v)) return null;
      fields.push({ ai, value: v });
      i += n;
    } else {
      const end = s.indexOf(GS, i);
      const stop = end === -1 ? s.length : end;
      const v = s.slice(i, Math.min(stop, i + GS1_VARIABLE[ai]));
      if (!v) return null;
      fields.push({ ai, value: v });
      i += v.length;
    }
  }
  return fields.length ? gs1Result(fields) : null;
};

// ---------------------------------------------------------------- Luhn ids

const luhnOk = (digits: string): boolean => {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
};

/** 15-digit IMEI with a valid check digit (routers, phones). */
export const isImei = (s: string): boolean => /^\d{15}$/.test(s) && luhnOk(s);

/** SIM ICCID: 19–20 digits starting 89, valid check digit. */
export const isIccid = (s: string): boolean => /^89\d{17,18}$/.test(s) && luhnOk(s);

// ---------------------------------------------------------------- multi-field labels

export type FieldRole = "serial" | "imei" | "iccid" | "mac" | "part" | "model" | "other";

export interface LabelField {
  /** the label printed before the value (`SN`, `IMEI`, …), null when none */
  key: string | null;
  value: string;
  role: FieldRole;
}

const ROLE_OF_KEY: Array<[RegExp, FieldRole]> = [
  [/^(s\/?n|serial(\s*(no|number))?\.?|sn\s*code)$/i, "serial"],
  [/^imei\d?$/i, "imei"],
  [/^(iccid|sim)$/i, "iccid"],
  [/^(mac|wifi\s*mac|lan\s*mac)$/i, "mac"],
  [/^(p\/?n|part(\s*(no|number))?\.?)$/i, "part"],
  [/^(model|type|m\/n)$/i, "model"],
];

const MAC = /^([0-9A-F]{2}[:-]){5}[0-9A-F]{2}$|^[0-9A-F]{12}$/i;

const roleOf = (key: string | null, value: string): FieldRole => {
  if (key) for (const [re, role] of ROLE_OF_KEY) if (re.test(key.trim())) return role;
  if (isImei(value)) return "imei";
  if (isIccid(value)) return "iccid";
  if (MAC.test(value) && /[A-F:-]/i.test(value)) return "mac";
  return "other";
};

/** Split a multi-field label. One field = not a multi-field label (the caller uses the value as is). */
export const splitFields = (raw: string): LabelField[] => {
  const s = clean(raw);
  if (!s || parseAppCode(s)) return [];
  const gs1 = parseGs1(raw);
  if (gs1) {
    return gs1.fields.map((f) => ({ key: `(${f.ai})`, value: f.value, role: f.ai === "21" ? "serial" : f.ai === "01" ? "part" : "other" }));
  }
  const parts = s
    .split(/[;|\n\r\t]+|,(?=\s*[A-Za-z][\w /.]{0,15}\s*[:=])|\s{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  // "a,b,c" with no keys at all: split on commas too
  const pieces = parts.length === 1 && s.includes(",") ? s.split(",").map((p) => p.trim()).filter(Boolean) : parts;
  const out: LabelField[] = pieces.map((p) => {
    const kv = /^([A-Za-z][\w /.]{0,15}?)\s*[:=]\s*(.+)$/.exec(p);
    const key = kv ? kv[1].trim() : null;
    const value = (kv ? kv[2] : p).trim();
    return { key, value, role: roleOf(key, value) };
  });
  return out.length > 1 ? out : [];
};

/** The field a person most likely wants as the device SN: a labelled serial, else none. */
export const serialField = (fields: LabelField[]): LabelField | null => fields.find((f) => f.role === "serial") ?? null;

/** what a remembered field hint holds (`scan_field_hints`) */
export interface FieldHintLike {
  field_key: string | null;
  field_index: number;
  field_count: number;
}

const keyEq = (a: string, b: string) => a.replace(/\s+/g, "").toUpperCase() === b.replace(/\s+/g, "").toUpperCase();

/** The field a remembered hint points at: the same printed key, else (a label without keys) the
 *  same position in a label with the same number of fields; null when the label does not fit. */
export const pickByHint = (fields: LabelField[], hint: FieldHintLike | null | undefined): LabelField | null => {
  if (!hint || fields.length < 2) return null;
  if (hint.field_key) return fields.find((f) => f.key != null && keyEq(f.key, hint.field_key!)) ?? null;
  return fields.length === hint.field_count ? fields[hint.field_index] ?? null : null;
};

/** The hint to remember for a pick: the printed key when it is unique on the label, else the position. */
export const hintFor = (fields: LabelField[], index: number): FieldHintLike => {
  const key = fields[index]?.key ?? null;
  const unique = key != null && fields.filter((f) => f.key != null && keyEq(f.key, key)).length === 1;
  return { field_key: unique ? key : null, field_index: index, field_count: fields.length };
};
