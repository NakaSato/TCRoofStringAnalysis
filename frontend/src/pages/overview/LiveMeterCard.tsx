/**
 * Plant Overview: the energy meter at the grid point, live (`meter_last_data`, memory only, never stored),
 * drawn as a power-flow diagram: PV (inverter AC) on top, the site load (derived) bottom left and the grid
 * (measured by the meter) bottom right, joined by lanes with rounded corners: PV → load and PV → grid drop
 * from PV and turn to each side, grid → load runs straight along the bottom.
 *
 * Animations use Motion (`motion/react`): lanes draw in, comets travel along each flowing lane (faster and
 * wider with more kW), active nodes glow, and a node's ring is a donut of where its power goes / comes from.
 * `MotionConfig reducedMotion="user"` + `useReducedMotion` drop the moving parts under reduced motion.
 */
import React from "react";
import { AnimatePresence, MotionConfig, motion, useReducedMotion } from "motion/react";
import type { Transition } from "motion/react";
import { House, Sun, UtilityPole } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { useLiveMeter } from "./useLiveMeter";
import { Led, fmt } from "../../components/ui";
import { SERIES } from "../../components/chartTheme";
import { cn } from "@/lib/utils";
import { AnimatedNumber } from "@/components/ui/animated-number";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useI18n } from "../../i18n";

const todayBkk = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Bangkok" });
/** "2026-11-15 22:28:45" → "22:28" today, else "2026-11-15 22:28" */
const when = (ts: string | null | undefined) => (!ts ? "—" : ts.slice(0, 10) === todayBkk() ? ts.slice(11, 16) : ts.slice(0, 16));
/** below this a flow is drawn as idle (meter / inverter noise) */
const IDLE_KW = 0.05;
const IDLE = "rgba(255,255,255,0.09)";
/**
 * Power-flow colours (from the reference design, not the chart roles): PV gold, the site load blue, the
 * grid grey. A lane takes the colour of the power on it: PV → load and PV → grid gold, grid → load grey.
 */
const FLOW = { pv: "#f5b70a", load: "#5b8cf0", grid: "#a3a7b0" } as const;
/** rings and bars settle on each poll with a soft spring */
const SPRING: Transition = { type: "spring", stiffness: 120, damping: 20, mass: 0.9 };

/* ---- geometry (SVG viewBox units; the box keeps this aspect ratio, nodes are HTML on top) ---- */
const VB = { w: 200, h: 172 };
/** node radius */
const R = 20;
const NODE = { pv: { x: 100, y: 42 }, load: { x: 32, y: 124 }, grid: { x: 168, y: 124 } } as const;
const PATH = {
  // two lanes drop from PV's bottom and turn (radius 6) to the load and to the grid
  pvLoad: "M95 61 V112 Q95 118 89 118 H51",
  pvGrid: "M105 61 V112 Q105 118 111 118 H149",
  // grid → load along the bottom
  gridLoad: "M149 128 H51",
} as const;
const pct = (v: number, of: number) => `${(v / of) * 100}%`;

/** label + extra line, shown on hover / focus */
const Tip: React.FC<{ label: string; hint?: string; children: React.ReactElement }> = ({ label, hint, children }) => (
  <Tooltip>
    <TooltipTrigger asChild>{children}</TooltipTrigger>
    <TooltipContent>
      <span className="flex max-w-64 flex-col">
        <span className="font-medium">{label}</span>
        {hint && <span className="text-muted-foreground">{hint}</span>}
      </span>
    </TooltipContent>
  </Tooltip>
);

/**
 * One lane: a thin track that always shows the route; while power flows, the line takes its colour
 * and small dots march along it from the source to the destination at a steady pace.
 * Reduced motion = the coloured line and the dots, standing still.
 */
const DOT_GAP = 0.2; // dot spacing, as a fraction of the lane
const FlowPath: React.FC<{ d: string; color: string; power: number | null }> = ({ d, color, power }) => {
  const reduce = useReducedMotion();
  const on = power != null && power > IDLE_KW;
  return (
    <g>
      <path d={d} fill="none" stroke={IDLE} strokeWidth={1.5} strokeLinecap="round" />
      <AnimatePresence>
        {on && (
          <motion.g key="flow" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.4 }}>
            <path d={d} fill="none" stroke={color} strokeOpacity={0.45} strokeWidth={1.5} strokeLinecap="round" />
            {/* a repeating dash of (almost) no length with round caps = a row of dots; shifting it by one gap loops seamlessly */}
            <motion.path
              d={d}
              fill="none"
              stroke={color}
              strokeWidth={3}
              strokeLinecap="round"
              initial={{ pathLength: 0.002, pathSpacing: DOT_GAP - 0.002, pathOffset: 0 }}
              animate={reduce ? undefined : { pathOffset: DOT_GAP }}
              transition={{ duration: 0.8, ease: "linear", repeat: Infinity }}
            />
          </motion.g>
        )}
      </AnimatePresence>
    </g>
  );
};

/** Ring segment of a donut (fraction of the circumference from `start`), springing to new values. */
const Segment: React.FC<{ color: string; start: number; frac: number }> = ({ color, start, frac }) => (
  <motion.circle
    cx={22}
    cy={22}
    r={20.5}
    fill="none"
    stroke={color}
    strokeWidth={2.5}
    strokeLinecap="butt"
    initial={{ pathLength: 0, pathOffset: start, pathSpacing: 1 }}
    animate={{ pathLength: Math.max(0, frac - 0.012), pathOffset: start, pathSpacing: 1 }}
    transition={SPRING}
  />
);

/**
 * One node of the flow, centred on its lane ends: a dark disc with the icon and kW inside, a ring in its
 * colour (a donut of where its power goes / comes from when `segments` are given), a glow while active,
 * and its name above (PV) or below (load, grid) with an optional caption.
 */
const FlowNode: React.FC<{
  at: { x: number; y: number };
  icon: LucideIcon;
  name: string;
  nameAt: "above" | "below";
  label: string;
  hint: string;
  value: number | null | undefined;
  color: string;
  active: boolean;
  segments?: Array<{ color: string; frac: number }>;
  caption?: string;
}> = ({ at, icon: Icon, name, nameAt, label, hint, value, color, active, segments, caption }) => {
  const reduce = useReducedMotion();
  const shown = value != null && Number.isFinite(value) ? value : null;
  const segs = active ? (segments?.filter((s) => s.frac > 0) ?? [{ color, frac: 1 }]) : [];
  let start = 0;
  return (
    <div
      className="absolute aspect-square -translate-x-1/2 -translate-y-1/2"
      style={{ left: pct(at.x, VB.w), top: pct(at.y, VB.h), width: pct(2 * R, VB.w) }}
    >
      {/* glow: a soft halo that breathes, plus a ripple, while power flows through this node */}
      <AnimatePresence>
        {active && (
          <motion.span
            key="halo"
            aria-hidden
            className="absolute -inset-[22%] rounded-full blur-md"
            style={{ backgroundColor: color }}
            initial={{ opacity: 0 }}
            animate={reduce ? { opacity: 0.16 } : { opacity: [0.1, 0.24, 0.1] }}
            exit={{ opacity: 0 }}
            transition={reduce ? { duration: 0.4 } : { duration: 3.2, repeat: Infinity, ease: "easeInOut" }}
          />
        )}
        {active && !reduce && (
          <motion.span
            key="ripple"
            aria-hidden
            className="absolute inset-0 rounded-full border"
            style={{ borderColor: color }}
            initial={{ scale: 1, opacity: 0 }}
            animate={{ scale: [1, 1.45], opacity: [0.45, 0] }}
            exit={{ opacity: 0 }}
            transition={{ duration: 2.6, repeat: Infinity, ease: "easeOut" }}
          />
        )}
      </AnimatePresence>

      <Tip label={label} hint={hint}>
        <motion.div
          tabIndex={0}
          aria-label={`${label}: ${shown == null ? "—" : `${fmt(shown, 2)} kW`}`}
          whileHover={{ scale: 1.05 }}
          transition={SPRING}
          className="relative size-full rounded-full bg-ink-900 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] outline-none focus-visible:ring-1 focus-visible:ring-white/30"
        >
          <svg viewBox="0 0 44 44" className="absolute inset-0 size-full -rotate-90" aria-hidden>
            <circle cx={22} cy={22} r={20.5} fill="none" stroke={IDLE} strokeWidth={2} />
            {segs.map((s, i) => {
              const seg = <Segment key={i} color={s.color} start={start} frac={s.frac} />;
              start += s.frac;
              return seg;
            })}
          </svg>
          <span className="absolute inset-0 flex flex-col items-center justify-center leading-none">
            <motion.span
              className="mb-0.5"
              initial={false}
              animate={{ color: active ? color : "#64748b" }}
              transition={{ duration: 0.5 }}
            >
              <Icon className="size-4" aria-hidden />
            </motion.span>
            <span className="num text-[13px] font-semibold text-slate-100">
              <AnimatedNumber value={shown} digits={shown != null && Math.abs(shown) >= 100 ? 0 : 1} />
            </span>
            <span className="num mt-0.5 text-[10px] text-muted-foreground">kW</span>
          </span>
        </motion.div>
      </Tip>

      {/* name above or below the disc, caption under the name */}
      <div
        className={cn(
          "pointer-events-none absolute left-1/2 flex -translate-x-1/2 flex-col items-center whitespace-nowrap",
          nameAt === "above" ? "bottom-full mb-1.5" : "top-full mt-1.5"
        )}
      >
        <span className="text-[11px] font-medium text-slate-300">{name}</span>
        <span className="h-3 text-[10px] leading-3">
          <AnimatePresence mode="wait" initial={false}>
            {caption && (
              <motion.span
                key={caption}
                className="block"
                style={{ color: active ? color : undefined }}
                initial={{ opacity: 0, y: 3 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -3 }}
                transition={{ duration: 0.2 }}
              >
                {caption}
              </motion.span>
            )}
          </AnimatePresence>
        </span>
      </div>
    </div>
  );
};

/** A labelled reading of the meter, as reported: name on top, value + unit under it. */
const Reading: React.FC<{ label: string; value: number | null | undefined; digits: number; unit?: string; hint?: string }> = ({
  label,
  value,
  digits,
  unit,
  hint,
}) => {
  const body = (
    <div
      tabIndex={hint ? 0 : undefined}
      className="flex min-w-0 flex-col gap-0.5 rounded-md bg-white/[0.025] px-2.5 py-2 outline-none focus-visible:ring-1 focus-visible:ring-white/20"
    >
      <span className="truncate text-[10px] text-muted-foreground">{label}</span>
      <span className="num truncate text-[13px] font-semibold text-slate-100">
        <AnimatedNumber value={value} digits={digits} />
        {value != null && unit && <span className="ml-0.5 text-[10px] font-normal text-muted-foreground">{unit}</span>}
      </span>
    </div>
  );
  return hint ? (
    <Tip label={label} hint={hint}>
      {body}
    </Tip>
  ) : (
    body
  );
};

/**
 * Grid import / export now (measured by the plant's energy meter) and the site load (PV AC + grid,
 * derived), from the page's `useLiveMeter` poll; hidden for plants without a meter.
 */
export const LiveMeterCard: React.FC<{ m: ReturnType<typeof useLiveMeter> }> = ({ m: { res, error, noMeter } }) => {
  const { t } = useI18n();
  if (noMeter) return null;

  const d = res?.data ?? null;
  const g = d?.grid ?? null;
  const load = d?.load ?? null;
  // a failed poll keeps the last answer on screen, but it is no longer live
  const stale = Boolean(res?.stale) || Boolean(d?.meters.some((m) => m.stale)) || error != null;
  const meters = d?.meters ?? [];
  const one = meters.length === 1 ? meters[0] : null;
  const errorCount = d ? Object.keys(d.errors).length : 0;

  const pv = load?.pv_kw ?? null;
  const loadKw = load?.load_kw ?? null;
  const imp = g?.grid_import_kw ?? null;
  const exp = g?.grid_export_kw ?? null;
  const importing = imp != null && imp > IDLE_KW;
  const exporting = exp != null && exp > IDLE_KW;
  const gridKw = g?.grid_power_kw == null ? null : Math.abs(g.grid_power_kw);
  const time = when(g?.timestamp);

  // the three flows (derived from PV AC and the meter): importing, load = PV + import; exporting, PV = load + export
  const pvToLoad = pv != null && loadKw != null && loadKw >= 0 ? Math.min(pv, loadKw) : null;
  const loadShare =
    importing && loadKw != null && loadKw > IDLE_KW && pvToLoad != null
      ? [
          { color: FLOW.pv, frac: Math.min(1, pvToLoad / loadKw) },
          { color: FLOW.grid, frac: Math.max(0, 1 - pvToLoad / loadKw) },
        ]
      : undefined;
  const pvShare =
    exporting && pv != null && pv > IDLE_KW && pvToLoad != null
      ? [
          { color: FLOW.load, frac: Math.min(1, pvToLoad / pv) },
          { color: FLOW.grid, frac: Math.max(0, 1 - pvToLoad / pv) },
        ]
      : undefined;

  const loadHint =
    loadKw == null
      ? (load?.reason ?? t("Load not available"))
      : loadShare && pvToLoad != null
        ? t("Load {load} kW: {pv} kW from PV, {grid} kW from the grid. Derived from inverter AC and the meter, not measured", {
            load: fmt(loadKw, 2),
            pv: fmt(pvToLoad, 2),
            grid: fmt(imp, 2),
          })
        : t("PV AC {pv} kW + grid {grid} kW: derived, not measured", { pv: fmt(pv, 2), grid: fmt(g?.grid_power_kw, 2) });
  const pvHint =
    pvShare && pvToLoad != null
      ? t("PV {pv} kW: {site} kW used on site, {grid} kW exported. Derived from inverter AC and the meter, not measured", {
          pv: fmt(pv, 2),
          site: fmt(pvToLoad, 2),
          grid: fmt(exp, 2),
        })
      : t("Inverter AC output now · {time}", { time: when(load?.timestamp) });

  return (
    <MotionConfig reducedMotion="user">
      <Card className="gap-3">
        <CardHeader>
          <CardTitle>{t("Energy meter")}</CardTitle>
          <CardAction>
            <AnimatePresence mode="wait" initial={false}>
              <motion.span
                key={g?.timestamp ? `${stale}-${time}` : res ? "none" : error ? "err" : "wait"}
                className="num inline-flex items-center gap-1.5 text-[11px] text-muted-foreground"
                initial={{ opacity: 0, y: -3 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 3 }}
                transition={{ duration: 0.2 }}
              >
                {g?.timestamp ? (
                  <>
                    <Led level={stale ? "warn" : "ok"} pulse={!stale} />
                    {stale ? t("Stale") : t("Live")} · {time}
                  </>
                ) : res ? (
                  t("No record")
                ) : error ? (
                  t("Unavailable")
                ) : null}
              </motion.span>
            </AnimatePresence>
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {!res && !error ? (
            <Skeleton className="mx-auto aspect-[200/172] w-4/5" aria-label={t("Loading the energy meter…")} />
          ) : !res ? (
            <p className="text-xs text-muted-foreground">{t("Live meter unavailable: {error}", { error })}</p>
          ) : (
            <motion.div
              className="flex flex-col gap-3"
              initial={{ opacity: 0 }}
              animate={{ opacity: stale ? 0.7 : 1 }}
              transition={{ duration: 0.4 }}
            >
              {/* power flow: PV on top, load bottom left, grid bottom right */}
              <div
                className="relative mx-auto w-4/5 rounded-lg bg-[radial-gradient(80%_60%_at_50%_0%,rgba(255,255,255,0.04),transparent_70%)]"
                style={{ aspectRatio: `${VB.w} / ${VB.h}` }}
              >
                <svg viewBox={`0 0 ${VB.w} ${VB.h}`} className="absolute inset-0 size-full" aria-hidden>
                  <FlowPath d={PATH.pvLoad} color={FLOW.pv} power={pvToLoad} />
                  <FlowPath d={PATH.pvGrid} color={FLOW.pv} power={exporting ? exp : null} />
                  <FlowPath d={PATH.gridLoad} color={FLOW.grid} power={importing ? imp : null} />
                </svg>
                <FlowNode
                  at={NODE.pv}
                  icon={Sun}
                  name="PV"
                  nameAt="above"
                  label={t("PV AC power")}
                  hint={pvHint}
                  value={pv}
                  color={FLOW.pv}
                  active={pv != null && pv > IDLE_KW}
                  segments={pvShare}
                />
                <FlowNode
                  at={NODE.load}
                  icon={House}
                  name={t("Load (derived)")}
                  nameAt="below"
                  label={t("Load (derived)")}
                  hint={loadHint}
                  value={loadKw}
                  color={FLOW.load}
                  active={loadKw != null && loadKw > IDLE_KW}
                  segments={loadShare}
                />
                <FlowNode
                  at={NODE.grid}
                  icon={UtilityPole}
                  name={t("Grid")}
                  nameAt="below"
                  label={importing ? t("Grid import") : exporting ? t("Grid export") : t("Grid")}
                  hint={
                    exporting
                      ? t("Sent to the grid now, measured by the energy meter · {time}", { time })
                      : t("Bought from the grid now, measured by the energy meter · {time}", { time })
                  }
                  value={gridKw}
                  color={FLOW.grid}
                  active={importing || exporting}
                  caption={importing ? t("import") : exporting ? t("export") : undefined}
                />
              </div>

              {/* one meter: its counter and quality figures, as reported */}
              {one && (
                <div className="flex flex-col gap-3 border-t border-white/[0.06] pt-3">
                  <div className="grid grid-cols-3 gap-1.5">
                    <Reading
                      label={t("Import counter")}
                      value={one.import_counter_kwh}
                      digits={0}
                      unit="kWh"
                      hint={t("Lifetime import register of the meter")}
                    />
                    <Reading label={t("Power factor")} value={one.power_factor} digits={2} />
                    <Reading label={t("Frequency")} value={one.frequency_hz} digits={2} unit="Hz" />
                  </div>
                </div>
              )}
              {(meters.length > 1 || errorCount > 0) && (
                <div className="flex items-center justify-between gap-2 text-[11px]">
                  {meters.length > 1 ? <span className="num text-muted-foreground">{t("Sum of {n} meters", { n: meters.length })}</span> : <span />}
                  {errorCount > 0 && (
                    <span className="text-amber-300" title={Object.entries(d?.errors ?? {}).map(([k, v]) => `${k}: ${v}`).join("\n")}>
                      {errorCount > 1 ? t("{n} meters not read", { n: errorCount }) : t("{n} meter not read", { n: 1 })}
                    </span>
                  )}
                </div>
              )}
            </motion.div>
          )}
        </CardContent>
      </Card>
    </MotionConfig>
  );
};
