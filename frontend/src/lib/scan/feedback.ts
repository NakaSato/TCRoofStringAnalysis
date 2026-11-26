/**
 * Scan feedback (docs/plans/barcode-scanning.md §8): a beep (Web Audio, unlocked by the first tap:
 * iOS needs a gesture), a vibration where supported (not on iOS) and a visual flash the caller
 * always shows, so nothing depends on sound. Sound follows the per-device setting.
 */
import { readScanSettings } from "./hidScanner";

export type Feedback = "ok" | "warn" | "error";

let ctx: AudioContext | null = null;

const audio = (): AudioContext | null => {
  if (ctx) return ctx;
  const C = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!C) return null;
  try {
    ctx = new C();
  } catch {
    ctx = null;
  }
  return ctx;
};

/** Call from a click / tap handler so later beeps can play on iOS. */
export const unlockAudio = () => {
  const a = audio();
  if (a?.state === "suspended") void a.resume().catch(() => undefined);
};

const tone = (a: AudioContext, freq: number, start: number, dur: number) => {
  const osc = a.createOscillator();
  const gain = a.createGain();
  osc.type = "square";
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.0001, a.currentTime + start);
  gain.gain.exponentialRampToValueAtTime(0.08, a.currentTime + start + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + start + dur);
  osc.connect(gain).connect(a.destination);
  osc.start(a.currentTime + start);
  osc.stop(a.currentTime + start + dur + 0.02);
};

export const signal = (kind: Feedback) => {
  try {
    navigator.vibrate?.(kind === "ok" ? 50 : kind === "warn" ? [50, 50, 50] : 200);
  } catch {
    // not supported
  }
  if (!readScanSettings().sound) return;
  const a = audio();
  if (!a || a.state !== "running") return;
  if (kind === "ok") tone(a, 1800, 0, 0.08);
  else if (kind === "warn") {
    tone(a, 600, 0, 0.08);
    tone(a, 600, 0.13, 0.08);
  } else tone(a, 300, 0, 0.35);
};
