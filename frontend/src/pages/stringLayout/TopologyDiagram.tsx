import React from "react";
import type { GrowattStringLayout } from "../../api/client";
import { fmt } from "../../components/ui";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useI18n } from "../../i18n";

export type LayoutInverter = GrowattStringLayout["inverters"][number];
export type LayoutString = LayoutInverter["strings"][number];

/** `wp` blank = the fleet module's rating (global setting), so a fleet change applies everywhere. */
export type Draft = { modules: string; wp: string; azimuth: string; tilt: string };

export interface TopologySlot {
  s: LayoutString;
  k: string;
  /** the string's draft as typed */
  d: Draft;
  /** modules as entered (draft) */
  m: number | null;
  /** m × Wp */
  kwp: number | null;
  invalid: boolean;
  dirty: boolean;
  /** added on this page and not saved yet */
  added: boolean;
}

export interface TopologyInverter {
  inv: LayoutInverter;
  /** strings grouped by MPPT, in MPPT order */
  mppts: [number, TopologySlot[]][];
  mismatch: Set<number>;
  complete: boolean;
  kwp: number;
  dirty: number;
  /** inputs removed from the layout (saved marks, plus strings with current removed on the page): drawn as spares labelled "removed" */
  removedInputs: Set<number>;
}

export const strLabel = (no: number) => `STR-${String(no).padStart(2, "0")}`;

type OnChange = (k: string, field: keyof Draft, value: string) => void;
/** string editing beyond the fields: add a string at a DC input, remove one, which editor opens on mount */
export interface StringEdits {
  onAdd: (inputNo: number, mppt: number) => void;
  onRemove: (k: string) => void;
  /** the string just added: its editor opens on mount */
  openKey: string | null;
  onEditorClosed: () => void;
}

/**
 * DC inputs from the model's datasheet (backend `inverter_models`, e.g. MAX 125KTL3-X LV = 10 MPPT × 2),
 * so inputs that carry no string are drawn as spares. Input n sits on MPPT ⌈n / perMppt⌉. A model not
 * in the catalog shows the inputs the layout knows (seen in the last 7 days or with a count).
 */
export const inputSpecOf = (inv: LayoutInverter) => {
  const mppts = inv.datasheet?.mppt_count;
  const perMppt = inv.datasheet?.strings_per_mppt;
  return mppts && perMppt ? { mppts, perMppt } : null;
};

/** One DC input of the drawing: a string (`slot`) or a spare input (`slot` null). */
type Term = { mppt: number; no: number; slot: TopologySlot | null };

/** Vector illustration of the Growatt MAX family, drawn for every MAX inverter (not this unit, not to scale). */
const MAX_ART = "/images/inverters/growatt-max.svg";
const MAX_ART_RATIO = 770 / 1130;
/** One PV module (60 mono cells, portrait), drawn for each string's generator; width / height. */
const PV_ART = "/images/pv/pv-module.svg";
const PV_ART_RATIO = 380 / 632;
/** drawn width of the illustration (px) */
const ART_W = 300;
/** the illustration only where Growatt names the model as MAX */
const isMax = (inv: LayoutInverter) => /^MAX\b/i.test(inv.device_model ?? "");

/** Key to the drawing's symbols and states. */
export const SldLegend: React.FC<{ canEdit: boolean }> = ({ canEdit }) => {
  const { t } = useI18n();
  const box = (cls: string) => <span className={cn("h-2.5 w-2.5 rounded-[2px] border", cls)} />;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-400">
      <span className="flex items-center gap-1.5">{box("border-solar-300/80 bg-solar-400/15")} {t("Modules entered")}</span>
      <span className="flex items-center gap-1.5">{box("border-slate-400")} {t("not set")}</span>
      <span className="flex items-center gap-1.5">{box("border-dashed border-slate-500 opacity-70")} {t("no current (7 d)")}</span>
      <span className="flex items-center gap-1.5">{box("border-sky-300 bg-sky-400/15")} {t("Unsaved changes")}</span>
      <span className="flex items-center gap-1.5">{box("border-dashed border-amber-300")} {t("unequal")}</span>
      {canEdit && <span className="text-slate-500">{t("Click a string to enter its modules")}</span>}
      {canEdit && <span className="text-slate-500">{t("Click a spare input to add a string")}</span>}
    </div>
  );
};

/** Drawing geometry (px). */
const G = {
  margin: 24,
  acTop: 22,
  box: 64,
  strip: 140,
  boxEnd: 180,
  tick: 204,
  conn: 226,
  pv: 244,
  pvH: 40,
  label: 290,
  plate: 230,
};
const pitchFor = (n: number) => (n > 14 ? 36 : 44);

/**
 * One inverter as a DC single-line diagram on a drawing sheet, in IEC 60617 style: AC output at the
 * top, the inverter (square with diagonal, ~ and ⎓) with its MPPT inputs, one DC cable per string
 * (two conductors, connector) to its PV generator, and the string's annotation under it. Everything comes from the String Layout as edited (unsaved changes
 * included); nothing is drawn or labelled that was not entered or reported. Terminals are grouped
 * by MPPT; which DC switch a string is on is not recorded, so none is drawn.
 */
export const InverterSld: React.FC<{
  ti: TopologyInverter;
  no: number;
  canEdit: boolean;
  fleetWp: number | null;
  onChange: OnChange;
  edits: StringEdits;
}> = ({ ti: { inv, mppts, mismatch, complete, kwp, removedInputs }, no, canEdit, fleetWp, onChange, edits }) => {
  const { t, lang } = useI18n();
  const ac = inv.rated_power_w != null ? inv.rated_power_w / 1000 : null;
  const ratio = complete && ac ? kwp / ac : null;
  const name = inv.alias || t("Inverter No.{no}", { no: String(no).padStart(2, "0") });
  const model = inv.device_model ?? (inv.model || null);

  // terminals in MPPT order (strings plus, for a model with a known input count, its spare inputs)
  const spec = inputSpecOf(inv);
  const byMppt = new Map(mppts);
  const terms: Term[] = [];
  if (spec) {
    const used = new Set(mppts.flatMap(([, slots]) => slots.map((r) => r.s.string_no)));
    const mpptNos = [...new Set([...Array.from({ length: spec.mppts }, (_, i) => i + 1), ...byMppt.keys()])].sort((a, b) => a - b);
    for (const m of mpptNos) {
      const own: Term[] = (byMppt.get(m) ?? []).map((slot) => ({ mppt: m, no: slot.s.string_no, slot }));
      const spares: Term[] =
        m <= spec.mppts
          ? Array.from({ length: spec.perMppt }, (_, j) => (m - 1) * spec.perMppt + j + 1)
              .filter((no) => !used.has(no))
              .map((no) => ({ mppt: m, no, slot: null }))
          : [];
      terms.push(...[...own, ...spares].sort((a, b) => a.no - b.no));
    }
  } else for (const [m, slots] of mppts) terms.push(...slots.map((slot) => ({ mppt: m, no: slot.s.string_no, slot })));
  const n = terms.length;
  const pitch = pitchFor(n);
  const boxW = Math.max(n * pitch, 300);
  const x0 = G.margin;
  const x1 = x0 + boxW;
  const off = x0 + (boxW - n * pitch) / 2;
  const tx = (i: number) => off + pitch * (i + 0.5);
  // MPPT groups = contiguous terminal ranges; kWp only when every string of the MPPT has one
  const groups: { mppt: number; from: number; to: number; kwp: number | null }[] = [];
  terms.forEach((tm, i) => {
    const g = groups[groups.length - 1];
    if (g && g.mppt === tm.mppt) g.to = i;
    else {
      const slots = byMppt.get(tm.mppt) ?? [];
      const kwp = slots.length > 0 && slots.every((r) => r.kwp != null) ? slots.reduce((a, r) => a + (r.kwp ?? 0), 0) : null;
      groups.push({ mppt: tm.mppt, from: i, to: i, kwp });
    }
  });
  const gx = (i: number) => off + pitch * i;
  const acX = x0 + boxW / 2;
  // MAX models: the illustration stands in for the inverter symbol, so everything under it moves down
  const art = isMax(inv);
  // nameplate: beside the illustration (it has room there), else beside the inverter symbol
  const plateX = art ? acX + ART_W / 2 + 56 : x1 + 18;
  const W = Math.max(x1 + G.margin, plateX + G.plate);
  const artH = ART_W * MAX_ART_RATIO;
  const dy = art ? G.box + artH + 28 - G.strip : 0;
  // the illustration's body starts 20 of its 770 units below its top edge
  const acEnd = art ? G.box + artH * (20 / 770) : G.box;
  const Y = {
    strip: G.strip + dy,
    boxEnd: G.boxEnd + dy,
    tick: G.tick + dy,
    conn: G.conn + dy,
    pv: G.pv + dy,
    label: G.label + dy,
  };
  const pvW = G.pvH * PV_ART_RATIO;
  const wpOf = (d: Draft) => {
    const own = d.wp.trim() !== "" && Number.isFinite(Number(d.wp)) ? Number(d.wp) : null;
    return own != null ? { wp: own, fleet: false } : fleetWp != null ? { wp: fleetWp, fleet: true } : null;
  };

  const annotOf = (slot: TopologySlot) => {
    const w = wpOf(slot.d);
    return !slot.s.active && !slot.added
      ? t("no current (7 d)")
      : slot.invalid
      ? t("invalid")
      : slot.m == null
      ? t("not set")
      : `${slot.m} × ${w ? `${fmt(w.wp, 0)} Wp${w.fleet ? "*" : ""}` : "— Wp"} · ${slot.kwp != null ? `${fmt(slot.kwp, 2)} kWp` : "— kWp"}`;
  };
  // a spare input's label: "removed" where the string was removed from the layout
  const spareLabel = (inputNo: number) => (removedInputs.has(inputNo) ? t("removed") : canEdit ? t("+ add string") : t("spare"));
  // ~5.6 px per 9 px character; at least room for "STR-00"
  const H = Y.label + Math.max(48, ...terms.map(({ no, slot }) => (slot ? annotOf(slot) : spareLabel(no)).length * 5.6)) + 18;

  const line = "stroke-slate-300";
  const thin = "stroke-slate-400";
  const text = "fill-slate-300";
  const dim = "fill-slate-500";

  return (
    <div className="overflow-hidden rounded-md border border-white/[0.12] bg-ink-950/80">
      {/* drawing area on a faint drafting grid; scrolls on its own when wider than the card */}
      <div
        className="overflow-x-auto"
        style={{
          backgroundImage:
            "linear-gradient(rgba(148,163,184,0.045) 1px, transparent 1px), linear-gradient(90deg, rgba(148,163,184,0.045) 1px, transparent 1px)",
          backgroundSize: "16px 16px",
        }}
      >
        {n === 0 ? (
          <p className="px-4 py-10 text-center text-[11px] text-slate-500">{t("No string inputs seen in the last 7 days.")}</p>
        ) : (
          <svg width={W} height={H} className="mx-auto block" role="group" aria-label={t("DC single-line diagram")}>
            {/* AC output */}
            <line x1={acX} y1={G.acTop} x2={acX} y2={acEnd} className={line} strokeWidth={1.8} />
            <path d={`M ${acX - 4} ${G.acTop + 6} L ${acX} ${G.acTop - 2} L ${acX + 4} ${G.acTop + 6}`} fill="none" className={line} strokeWidth={1.4} />
            <circle cx={acX} cy={acEnd} r={3} className="fill-slate-300" />
            <text x={acX + 9} y={G.acTop + 8} className={cn(text, "text-[10px] font-semibold", lang === "th" ? "" : "tracking-wider")}>
              {t("AC OUTPUT")}
            </text>
            <text x={acX + 9} y={G.acTop + 21} className={cn(dim, "num text-[9.5px]")}>
              {ac != null ? t("{kw} kW rated", { kw: fmt(ac, 0) }) : t("rating not reported")}
            </text>

            {art ? (
              <>
                {/* inverter as the MAX illustration; its DC connectors feed the MPPT input strip below */}
                <g>
                  <title>{t("Illustration: Growatt MAX series, not this unit")}</title>
                  <image href={MAX_ART} x={acX - ART_W / 2} y={G.box} width={ART_W} height={artH} preserveAspectRatio="xMidYMin meet" />
                </g>
                <line x1={acX} y1={G.box + artH * 0.94} x2={acX} y2={Y.strip} className={line} strokeWidth={1.8} />
                <circle cx={acX} cy={Y.strip} r={3} className="fill-slate-300" />
                <text x={acX + 9} y={(G.box + artH * 0.94 + Y.strip) / 2 + 4} className={cn(dim, "text-[9.5px] font-semibold")}>
                  DC
                </text>
                <rect x={x0} y={Y.strip} width={boxW} height={Y.boxEnd - Y.strip} fill="none" className={line} strokeWidth={1.8} />
              </>
            ) : (
              <>
            {/* inverter: square with diagonal, ~ (AC) and ⎓ (DC), MPPT inputs below a partition */}
            <rect x={x0} y={G.box} width={boxW} height={Y.boxEnd - G.box} fill="none" className={line} strokeWidth={1.8} />
            <line x1={x0} y1={Y.strip} x2={x1} y2={G.box} className={thin} strokeWidth={0.9} />
            <path d={`M ${x0 + 16} ${G.box + 24} q 6 -10 12 0 t 12 0`} fill="none" className={line} strokeWidth={1.5} />
            <line x1={x1 - 46} y1={Y.strip - 22} x2={x1 - 18} y2={Y.strip - 22} className={line} strokeWidth={1.5} />
            <line x1={x1 - 46} y1={Y.strip - 15} x2={x1 - 18} y2={Y.strip - 15} className={line} strokeWidth={1.5} strokeDasharray="5 3" />
            <line x1={x0} y1={Y.strip} x2={x1} y2={Y.strip} className={thin} strokeWidth={0.9} />
              </>
            )}
            {groups.map((g) => {
              const a = gx(g.from) + 3;
              const w = gx(g.to + 1) - gx(g.from) - 6;
              const wide = g.to > g.from;
              const warn = mismatch.has(g.mppt);
              return (
                <g key={g.mppt}>
                  <title>{`MPPT ${g.mppt}${g.kwp != null ? ` · ${fmt(g.kwp, 2)} kWp` : ""}`}</title>
                  <rect
                    x={a}
                    y={Y.strip + 5}
                    width={w}
                    height={Y.boxEnd - Y.strip - 10}
                    rx={2}
                    fill="none"
                    className={warn ? "stroke-amber-300" : thin}
                    strokeWidth={warn ? 1.2 : 0.9}
                  />
                  <text
                    x={a + w / 2}
                    y={Y.strip + (wide ? 19 : 23)}
                    textAnchor="middle"
                    className={cn("num text-[9.5px] font-semibold", warn ? "fill-amber-300" : text)}
                  >
                    {wide ? `MPPT ${g.mppt}` : `M${g.mppt}`}
                  </text>
                  {wide && (
                    <text x={a + w / 2} y={Y.strip + 30} textAnchor="middle" className={cn(dim, "num text-[8.5px]")}>
                      {g.kwp != null ? `${fmt(g.kwp, 1)} kWp` : "— kWp"}
                    </text>
                  )}
                </g>
              );
            })}

            {/* nameplate, as on a drawing */}
            <text x={plateX} y={G.box + 14} className="fill-white text-[12px] font-bold tracking-wide">
              {name}
            </text>
            <text x={plateX} y={G.box + 30} className={cn(text, "num text-[10px]")}>
              {model ? `Growatt ${model}` : "—"}
            </text>
            <text x={plateX} y={G.box + 44} className={cn(dim, "num text-[10px]")}>
              {`${ac != null ? `${fmt(ac, 0)} kW AC` : "— kW AC"} · SN ${inv.device_sn}`}
            </text>
            <text x={plateX} y={G.box + 58} className={cn(dim, "num text-[10px]")}>
              {`DC ${kwp > 0 ? `${fmt(kwp, 1)} kWp` : "—"}${!complete && kwp > 0 ? ` ${t("(partial)")}` : ""} · DC/AC ${ratio != null ? fmt(ratio, 2) : "—"}`}
            </text>

            {/* unequal MPPTs: dashed amber outline around their generators */}
            {groups
              .filter((g) => mismatch.has(g.mppt))
              .map((g) => (
                <rect
                  key={g.mppt}
                  x={gx(g.from) + 2}
                  y={Y.pv - 7}
                  width={gx(g.to + 1) - gx(g.from) - 4}
                  height={G.pvH + 14}
                  rx={3}
                  fill="none"
                  className="stroke-amber-300/80"
                  strokeDasharray="4 3"
                />
              ))}

            {/* DC cables and PV generators */}
            {terms.map(({ mppt, no: inputNo, slot }, i) => {
              const x = tx(i);
              const wasRemoved = !slot && removedInputs.has(inputNo);
              if (!slot)
                return (
                  <g
                    key={`spare-${inputNo}`}
                    {...(canEdit
                      ? {
                          role: "button",
                          tabIndex: 0,
                          "aria-label": t("Add a string at input {n} (MPPT {m})", { n: inputNo, m: mppt }),
                          onClick: () => edits.onAdd(inputNo, mppt),
                          onKeyDown: (e: React.KeyboardEvent) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              edits.onAdd(inputNo, mppt);
                            }
                          },
                          className: "group cursor-pointer outline-none",
                        }
                      : {})}
                  >
                    <title>
                      {wasRemoved
                        ? canEdit
                          ? t("Input {n} · MPPT {m}: string removed from the layout; its readings stay in String Diagnostics. Click to add a string here, which brings it back", { n: inputNo, m: mppt })
                          : t("Input {n} · MPPT {m}: string removed from the layout; its readings stay in String Diagnostics. Adding a string here brings it back", { n: inputNo, m: mppt })
                        : canEdit
                        ? t("Input {n} · MPPT {m}: spare. Click to add a string", { n: inputNo, m: mppt })
                        : t("Input {n} · MPPT {m}: spare", { n: inputNo, m: mppt })}
                    </title>
                    {canEdit && <rect x={x - pitch / 2} y={Y.boxEnd + 4} width={pitch} height={H - Y.boxEnd - 4} fill="transparent" />}
                    <circle cx={x} cy={Y.boxEnd} r={2.6} className="fill-ink-950 stroke-slate-500" strokeWidth={1.2} />
                    <text x={x + 4} y={Y.boxEnd + 13} className={cn(dim, "num text-[8.5px]")}>
                      {inputNo}
                    </text>
                    {/* open stub: input not connected */}
                    <line x1={x} y1={Y.boxEnd + 2.6} x2={x} y2={Y.tick + 6} className="stroke-slate-600" strokeWidth={1.1} strokeDasharray="2 3" />
                    <line x1={x - 5} y1={Y.tick + 6} x2={x + 5} y2={Y.tick + 6} className="stroke-slate-500" strokeWidth={1.2} />
                    <g transform={`translate(${x} ${Y.label}) rotate(-90)`}>
                      <text
                        x={0}
                        y={3}
                        textAnchor="end"
                        className={cn(
                          "num fill-slate-600 text-[9.5px] italic",
                          canEdit && "group-hover:fill-sky-300 group-focus-visible:fill-sky-300"
                        )}
                      >
                        {spareLabel(inputNo)}
                      </text>
                    </g>
                  </g>
                );
              const live = slot.s.active;
              const wire = live ? line : "stroke-slate-500";
              const dash = live ? undefined : "3 3";
              const sym = slot.invalid
                ? "fill-red-500/15 stroke-red-400"
                : slot.dirty
                ? "fill-sky-400/15 stroke-sky-300"
                : !live
                ? "fill-transparent stroke-slate-500"
                : slot.m != null
                ? "fill-solar-400/15 stroke-solar-300"
                : "fill-transparent stroke-slate-400";
              const annot = annotOf(slot);
              return (
                <g key={slot.k}>
                  {/* terminal on the inverter */}
                  <circle cx={x} cy={Y.boxEnd} r={2.6} className="fill-ink-950 stroke-slate-300" strokeWidth={1.2} />
                  <text x={x + 4} y={Y.boxEnd + 13} className={cn(dim, "num text-[8.5px]")}>
                    {slot.s.string_no}
                  </text>
                  {/* cable: two conductors (+ / −), connector */}
                  <line x1={x} y1={Y.boxEnd + 2.6} x2={x} y2={Y.pv} className={wire} strokeWidth={1.3} strokeDasharray={dash} />
                  <line x1={x - 4} y1={Y.tick + 4} x2={x + 4} y2={Y.tick - 2} className={wire} strokeWidth={1} />
                  <line x1={x - 4} y1={Y.tick + 9} x2={x + 4} y2={Y.tick + 3} className={wire} strokeWidth={1} />
                  <path
                    d={`M ${x - 4} ${Y.conn - 3} L ${x} ${Y.conn + 1} L ${x + 4} ${Y.conn - 3} M ${x - 4} ${Y.conn + 3} L ${x} ${Y.conn + 7} L ${x + 4} ${Y.conn + 3}`}
                    fill="none"
                    className={wire}
                    strokeWidth={1.1}
                  />
                  {/* PV generator + annotation: the editor */}
                  <StringEditor slot={slot} mppt={mppt} sn={inv.device_sn} canEdit={canEdit} fleetWp={fleetWp} onChange={onChange} edits={edits}>
                    <g
                      role="button"
                      tabIndex={0}
                      aria-label={`${strLabel(slot.s.string_no)}: ${annot}`}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          (e.currentTarget as unknown as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
                        }
                      }}
                      className="group cursor-pointer outline-none"
                    >
                      <title>{`${strLabel(slot.s.string_no)} · MPPT ${mppt} — ${annot}`}</title>
                      <rect x={x - pitch / 2} y={Y.pv - 4} width={pitch} height={H - Y.pv} fill="transparent" />
                      {/* PV module illustration, framed in the string's state colour */}
                      <rect
                        x={x - pvW / 2 - 2.5}
                        y={Y.pv - 2.5}
                        width={pvW + 5}
                        height={G.pvH + 5}
                        rx={2}
                        className={cn(sym, "transition group-hover:stroke-sky-300 group-focus-visible:stroke-sky-300")}
                        strokeWidth={1.4}
                        strokeDasharray={live ? undefined : "3 2"}
                      />
                      <image
                        href={PV_ART}
                        x={x - pvW / 2}
                        y={Y.pv}
                        width={pvW}
                        height={G.pvH}
                        preserveAspectRatio="xMidYMid meet"
                        opacity={live ? 1 : 0.4}
                      />
                      {/* annotation, read bottom to top as on a drawing */}
                      <g transform={`translate(${x} ${Y.label}) rotate(-90)`}>
                        <text x={0} y={-3} textAnchor="end" className="num fill-white text-[10px] font-semibold">
                          {strLabel(slot.s.string_no)}
                        </text>
                        <text
                          x={0}
                          y={9}
                          textAnchor="end"
                          className={cn(
                            "num text-[9px]",
                            slot.invalid ? "fill-red-300" : slot.dirty ? "fill-sky-300" : slot.m != null && live ? "fill-slate-300" : "fill-slate-500"
                          )}
                        >
                          {annot}
                        </text>
                      </g>
                    </g>
                  </StringEditor>
                </g>
              );
            })}
          </svg>
        )}
      </div>

    </div>
  );
};

/** A string's editor: modules × Wp, azimuth, tilt, opened from its generator in the drawing. */
const StringEditor: React.FC<{
  slot: TopologySlot;
  mppt: number;
  sn: string;
  canEdit: boolean;
  fleetWp: number | null;
  onChange: OnChange;
  edits: StringEdits;
  children: React.ReactElement;
}> = ({ slot: { s, k, d, kwp, invalid, added }, mppt, sn, canEdit, fleetWp, onChange, edits, children }) => {
  const { t } = useI18n();
  const label = strLabel(s.string_no);
  const status = s.active || added ? (kwp != null ? `${fmt(kwp, 2)} kWp` : t("not set")) : t("no current (7 d)");
  return (
    <Popover defaultOpen={k === edits.openKey} onOpenChange={(o) => !o && k === edits.openKey && edits.onEditorClosed()}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent className="w-64 text-xs" align="center">
        <div className="flex items-center justify-between">
          <span className="num font-bold text-solar-300">
            {label} · MPPT {mppt}
          </span>
          <span className="num text-[11px] text-slate-500">{status}</span>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex flex-1 items-center gap-1.5">
            <Input
              className="num h-7 w-full min-w-0 px-2 text-[11px]"
              inputMode="numeric"
              placeholder="—"
              aria-label={t("{sn} {str} modules", { sn, str: label })}
              value={d.modules}
              disabled={!canEdit}
              onChange={(e) => onChange(k, "modules", e.target.value)}
              autoFocus
            />
            <span className="text-[11px] text-slate-500">{t("mod")}</span>
          </label>
          <span className="text-slate-500">×</span>
          <label className="flex flex-1 items-center gap-1.5">
            <Input
              className="num h-7 w-full min-w-0 px-2 text-[11px]"
              inputMode="decimal"
              aria-label={t("{sn} {str} module Wp", { sn, str: label })}
              placeholder={fleetWp != null ? String(fleetWp) : "Wp"}
              value={d.wp}
              disabled={!canEdit}
              onChange={(e) => onChange(k, "wp", e.target.value)}
            />
            <span className="text-[11px] text-slate-500">Wp</span>
          </label>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex flex-1 items-center gap-1.5" title={t("Array azimuth in degrees (0–360°), used to group same-orientation peers")}>
            <Input
              className="num h-7 w-full min-w-0 px-2 text-[11px]"
              inputMode="decimal"
              placeholder={t("Az°")}
              aria-label={t("{sn} {str} azimuth degrees", { sn, str: label })}
              value={d.azimuth}
              disabled={!canEdit}
              onChange={(e) => onChange(k, "azimuth", e.target.value)}
            />
            <span className="text-[10px] text-slate-500">{t("az°")}</span>
          </label>
          <label className="flex flex-1 items-center gap-1.5" title={t("Array tilt in degrees (0–90°), used to group same-tilt peers")}>
            <Input
              className="num h-7 w-full min-w-0 px-2 text-[11px]"
              inputMode="decimal"
              placeholder={t("Tilt°")}
              aria-label={t("{sn} {str} tilt degrees", { sn, str: label })}
              value={d.tilt}
              disabled={!canEdit}
              onChange={(e) => onChange(k, "tilt", e.target.value)}
            />
            <span className="text-[10px] text-slate-500">{t("tilt°")}</span>
          </label>
        </div>
        {invalid && (
          <p className="text-[11px] text-red-300">
            {added && d.modules.trim() === "" ? t("Enter the modules of the new string.") : t("Modules must be a whole number.")}
          </p>
        )}
        {canEdit && (
          <div className="flex items-center justify-between gap-2 border-t border-white/[0.06] pt-2">
            {s.active ? (
              // a string with current is kept by a "removed" mark on save; its readings stay
              <span className="text-[10px] text-slate-500">{t("Has current in the last 7 days. Removing it hides it from the layout; its readings stay in String Diagnostics.")}</span>
            ) : (
              <span className="text-[10px] text-slate-500">{added ? t("New string, not saved yet") : t("No current in the last 7 days")}</span>
            )}
            <Button
              type="button"
              size="xs"
              variant="destructive"
              onClick={() => edits.onRemove(k)}
              title={s.active ? t("Hide this string from the layout; its readings stay in String Diagnostics") : undefined}
            >
              <Trash2 data-icon="inline-start" />
              {t("Remove string")}
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
};
