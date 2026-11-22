/**
 * A live reading that eases from its previous value to the new one when a poll brings a change
 * (`useLivePoll`, every 120–300 s), with a short up / down tint. Formatting matches `fmt()`:
 * null or non-finite = "—", never 0. The first value, a value after "—" and a new mount (key it by
 * plant / device) are shown at once, so a number never counts from 0 or from another plant's figure.
 * Reduced motion = no tween, no tint. Screen readers get only the final value.
 */
import * as React from "react";
import { cn } from "@/lib/utils";

const format = (n: number, digits: number) => n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
const easeOut = (t: number) => 1 - (1 - t) ** 3;
const reducedMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

export function AnimatedNumber({
  value,
  digits = 1,
  duration = 700,
  flash = true,
  className,
}: {
  value: number | null | undefined;
  digits?: number;
  /** tween length in ms */
  duration?: number;
  /** tint green / red for a moment when the value goes up / down */
  flash?: boolean;
  className?: string;
}) {
  const target = value != null && Number.isFinite(value) ? value : null;
  const [shown, setShown] = React.useState<number | null>(target);
  const [trend, setTrend] = React.useState<{ dir: "up" | "down"; n: number } | null>(null);
  const shownRef = React.useRef<number | null>(target);

  React.useEffect(() => {
    const from = shownRef.current;
    // nothing to ease from (first value, after "—") or to ("—"): show it as is
    if (target == null || from == null || reducedMotion()) {
      shownRef.current = target;
      setShown(target);
      return;
    }
    // a change too small to show at this precision: no tween, no tint
    if (format(from, digits) === format(target, digits)) {
      shownRef.current = target;
      setShown(target);
      return;
    }
    if (flash) setTrend((p) => ({ dir: target > from ? "up" : "down", n: (p?.n ?? 0) + 1 }));
    let raf = 0;
    const t0 = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / duration);
      const v = t >= 1 ? target : from + (target - from) * easeOut(t);
      shownRef.current = v;
      setShown(v);
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    // a newer value mid-tween continues from where this one stopped
    return () => cancelAnimationFrame(raf);
  }, [target, digits, duration, flash]);

  const text = shown == null ? "—" : format(shown, digits);
  return (
    <span data-slot="animated-number" className={cn("num", className)}>
      <span
        // a new key restarts the tint animation on every change
        key={trend?.n ?? 0}
        aria-hidden
        className={cn(trend?.dir === "up" && "num-flash-up", trend?.dir === "down" && "num-flash-down")}
      >
        {text}
      </span>
      <span className="sr-only">{target == null ? "—" : format(target, digits)}</span>
    </span>
  );
}
