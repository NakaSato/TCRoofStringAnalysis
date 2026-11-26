/**
 * Keyboard-wedge (HID) barcode scanners (docs/plans/barcode-scanning.md §4).
 *
 * A scanner "types" a whole code in a burst (2–15 ms between keys) and presses Enter; a person
 * types much slower (> 80 ms). `BurstDetector` (pure, `bun test`) tells the two apart from
 * keydown events and rebuilds the text from the physical keys (`keymap.ts`), so a Thai input
 * source does not turn `RT-0103` into Thai letters. `useHidScanner` mounts it on `window`.
 *
 * Settings per device (localStorage `tcroof.scan`, guarded): max gap between keys, minimum
 * length, end-on-idle time, optional prefix, sound.
 */
import type React from "react";
import { useEffect, useRef } from "react";
import { charFromCode, charFromKey } from "./keymap";
import { GS } from "./parse";

export interface ScanSettings {
  /** longest gap between keys of one burst, ms */
  maxGapMs: number;
  /** shortest code taken as a scan */
  minLength: number;
  /** a burst with no Enter / Tab ends after this many ms without a key */
  idleEndMs: number;
  /** characters the scanner sends first (programmed on the scanner); "" = none */
  prefix: string;
  /** beep on a read */
  sound: boolean;
}

export const DEFAULT_SCAN_SETTINGS: ScanSettings = { maxGapMs: 35, minLength: 4, idleEndMs: 80, prefix: "", sound: true };

const SETTINGS_KEY = "tcroof.scan";
const SETTINGS_EVENT = "tcroof:scan-settings";

const clampInt = (v: unknown, lo: number, hi: number, dflt: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : dflt;

export const readScanSettings = (): ScanSettings => {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") as Partial<ScanSettings>;
    const d = DEFAULT_SCAN_SETTINGS;
    return {
      maxGapMs: clampInt(raw.maxGapMs, 10, 150, d.maxGapMs),
      minLength: clampInt(raw.minLength, 2, 40, d.minLength),
      idleEndMs: clampInt(raw.idleEndMs, 40, 500, d.idleEndMs),
      prefix: typeof raw.prefix === "string" ? raw.prefix.slice(0, 4) : d.prefix,
      sound: typeof raw.sound === "boolean" ? raw.sound : d.sound,
    };
  } catch {
    return DEFAULT_SCAN_SETTINGS;
  }
};

export const saveScanSettings = (s: ScanSettings): void => {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    // private window / blocked storage: the setting lasts this page only
  }
  window.dispatchEvent(new Event(SETTINGS_EVENT));
};

/** What the detector needs from a KeyboardEvent (so tests can feed plain objects). */
export interface KeyLike {
  key: string;
  code: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  capsLock?: boolean;
  /** ms, e.g. `event.timeStamp` */
  time: number;
}

export interface Burst {
  /** the code as the US layout would type it, prefix removed */
  value: string;
  /** what `event.key` gave (shows a Thai layout in the scanner test) */
  keys: string;
  /** ms between keys */
  gaps: number[];
  /** how the burst ended */
  end: "enter" | "tab" | "idle";
  /** started with the configured prefix */
  prefixed: boolean;
}

export type Step =
  | { kind: "ignore" } // not a key of a burst (modifier, F-key, …)
  | { kind: "char"; fast: boolean } // a character was added; `fast` = it follows the previous within the gap
  | { kind: "scan"; burst: Burst } // a burst ended: a scan
  | { kind: "reset" }; // Enter / Tab after slow typing: not a scan

export class BurstDetector {
  private chars: string[] = [];
  private keys: string[] = [];
  private times: number[] = [];
  private slow = false;

  constructor(private settings: ScanSettings = DEFAULT_SCAN_SETTINGS) {}

  configure(s: ScanSettings) {
    this.settings = s;
  }

  get length() {
    return this.chars.length;
  }

  /** The burst so far is still fast (every gap within the limit). */
  get isFast() {
    return !this.slow;
  }

  get lastTime(): number | null {
    return this.times.length ? this.times[this.times.length - 1] : null;
  }

  /** Text typed so far starts with the configured prefix. */
  get startsWithPrefix() {
    const p = this.settings.prefix;
    return p !== "" && this.chars.join("").startsWith(p);
  }

  clear() {
    this.chars = [];
    this.keys = [];
    this.times = [];
    this.slow = false;
  }

  private emit(end: Burst["end"]): Step {
    const text = this.chars.join("");
    const gaps = this.times.slice(1).map((t, i) => Math.round(t - this.times[i]));
    const p = this.settings.prefix;
    const prefixed = p !== "" && text.startsWith(p);
    const value = prefixed ? text.slice(p.length) : text;
    const ok = !this.slow && value.length >= this.settings.minLength;
    const burst: Burst = { value, keys: this.keys.join(""), gaps, end, prefixed };
    this.clear();
    return ok ? { kind: "scan", burst } : { kind: "reset" };
  }

  feed(e: KeyLike): Step {
    // a slow key starts a new burst
    const last = this.lastTime;
    if (last != null && e.time - last > this.settings.maxGapMs && this.chars.length) {
      if (e.key === "Enter" || e.key === "Tab" || e.code === "Enter" || e.code === "NumpadEnter" || e.code === "Tab") {
        this.slow = true;
        return this.emit(e.key === "Tab" ? "tab" : "enter");
      }
      this.clear();
    }
    if (e.code === "Enter" || e.code === "NumpadEnter" || e.key === "Enter") {
      return this.chars.length ? this.emit("enter") : { kind: "ignore" };
    }
    if (e.code === "Tab" || e.key === "Tab") {
      return this.chars.length ? this.emit("tab") : { kind: "ignore" };
    }
    let ch: string | null = null;
    if (e.ctrlKey && (e.code === "BracketRight" || e.key === "]")) ch = GS; // GS sent as Ctrl+]
    else if (e.ctrlKey || e.metaKey || e.altKey) return { kind: "ignore" };
    else ch = e.code ? charFromCode(e.code, e.shiftKey, e.capsLock ?? false) : charFromKey(e.key);
    if (ch == null) return { kind: "ignore" };
    const fast = last != null && this.chars.length > 0 && e.time - last <= this.settings.maxGapMs;
    this.chars.push(ch);
    this.keys.push(e.key.length === 1 ? e.key : ch);
    this.times.push(e.time);
    return { kind: "char", fast };
  }

  /** Call from a timer: a fast burst with no key for `idleEndMs` ends as a scan (scanners with no suffix). */
  idle(now: number): Step | null {
    const last = this.lastTime;
    if (last == null || now - last < this.settings.idleEndMs) return null;
    if (this.chars.length < 2) {
      this.clear();
      return null;
    }
    return this.emit("idle");
  }
}

export const keyLike = (e: KeyboardEvent): KeyLike => ({
  key: e.key,
  code: e.code,
  shiftKey: e.shiftKey,
  ctrlKey: e.ctrlKey,
  altKey: e.altKey,
  metaKey: e.metaKey,
  capsLock: e.getModifierState?.("CapsLock") ?? false,
  time: e.timeStamp || performance.now(),
});

/** Focus in a text field, select or contenteditable: typing belongs to it. */
export const isEditable = (el: EventTarget | null): boolean => {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  if (el instanceof HTMLInputElement) {
    return !["button", "checkbox", "radio", "submit", "reset", "range", "color", "file", "image"].includes(el.type);
  }
  return false;
};

/** Inside a ScanField (it takes its own bursts). */
const inScanField = (el: EventTarget | null) => el instanceof HTMLElement && el.closest("[data-scan-field]") != null;

/**
 * Global keyboard-scanner listener: a burst typed while no text field has focus (or one that
 * starts with the configured prefix, anywhere but a ScanField) is a scan. Its Enter is consumed,
 * so it does not click a focused button. `enabled` false = not listening (e.g. while a dialog takes scans).
 */
export const useHidScanner = (onScan: (b: Burst) => void, enabled = true): void => {
  const cb = useRef(onScan);
  cb.current = onScan;
  useEffect(() => {
    if (!enabled) return;
    const det = new BurstDetector(readScanSettings());
    const onSettings = () => det.configure(readScanSettings());
    let timer: number | undefined;
    let editable = false;

    const onKey = (ev: KeyboardEvent) => {
      if (ev.isComposing || ev.repeat) return;
      if (inScanField(ev.target)) {
        det.clear();
        return;
      }
      if (det.length === 0) editable = isEditable(ev.target);
      const step = det.feed(keyLike(ev));
      window.clearTimeout(timer);
      if (step.kind === "scan") {
        // in a text field only a prefixed burst is a scan; the code was typed there as text
        if (editable && !step.burst.prefixed) return;
        ev.preventDefault();
        ev.stopPropagation();
        cb.current(step.burst);
        return;
      }
      if (step.kind === "char") {
        // a prefixed burst in a text field: keep the code out of the field
        if (editable && det.startsWithPrefix) ev.preventDefault();
        timer = window.setTimeout(() => {
          const s = det.idle(performance.now());
          if (s?.kind === "scan" && (!editable || s.burst.prefixed)) cb.current(s.burst);
        }, readScanSettings().idleEndMs + 10);
      }
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener(SETTINGS_EVENT, onSettings);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener(SETTINGS_EVENT, onSettings);
    };
  }, [enabled]);
};

// ---------------------------------------------------------------- scan targets

/** While a scan dialog is open it takes keyboard-scanner bursts the global listener catches,
 * instead of the global "open the record" action (top of the stack wins). */
const targets: Array<(b: Burst) => void> = [];

export const pushScanTarget = (fn: (b: Burst) => void): (() => void) => {
  targets.push(fn);
  return () => {
    const i = targets.lastIndexOf(fn);
    if (i >= 0) targets.splice(i, 1);
  };
};

export const scanTarget = (): ((b: Burst) => void) | null => targets[targets.length - 1] ?? null;

// ---------------------------------------------------------------- one input

/**
 * Keyboard-scanner bursts typed into one input (ScanField, the dialog's Type box): the burst is
 * typed as usual, then replaced by the US-layout value and submitted on its Enter / idle end.
 * Returns the input's `onKeyDown`. Mark the input's wrapper `data-scan-field` so the global
 * listener leaves it alone.
 */
export const useFieldScanner = (onBurst: (b: Burst) => void) => {
  const det = useRef<BurstDetector | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const cb = useRef(onBurst);
  cb.current = onBurst;
  useEffect(() => {
    const onSettings = () => det.current?.configure(readScanSettings());
    window.addEventListener(SETTINGS_EVENT, onSettings);
    return () => {
      window.removeEventListener(SETTINGS_EVENT, onSettings);
      window.clearTimeout(timer.current);
    };
  }, []);
  return (ev: React.KeyboardEvent<HTMLElement>) => {
    const e = ev.nativeEvent;
    if (e.isComposing || e.repeat) return;
    det.current ??= new BurstDetector(readScanSettings());
    const step = det.current.feed(keyLike(e));
    window.clearTimeout(timer.current);
    if (step.kind === "scan") {
      ev.preventDefault();
      cb.current(step.burst);
    } else if (step.kind === "char") {
      timer.current = window.setTimeout(() => {
        const s = det.current?.idle(performance.now());
        if (s?.kind === "scan") cb.current(s.burst);
      }, readScanSettings().idleEndMs + 10);
    }
  };
};
