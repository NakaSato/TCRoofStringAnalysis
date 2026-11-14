/**
 * String I-V & Telemetry Inspector: slide-over for one string of the open plant (from the string
 * tiles, tables, alarm centre and command palette). Stored day from the DB string detail
 * (`/growatt/plants/{id}/strings/{sn}/{no}`), the newest live record only in the "Now" strip.
 * I-V / P-V curves are modelled and labelled so; everything else is measured, missing = "—".
 * Keys: Esc closes, ← / → step through the strings of the same inverter.
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { X, Cpu, Activity, AlertTriangle, Wrench, CheckCircle2, ArrowUpRight, Sliders, Radio } from "lucide-react";
import { useAppContext, usePlantHref } from "../context/AppContext";
import { api } from "../api/client";
import type { GrowattStringDetail } from "../api/client";
import { PanelChart } from "./PanelChart";
import { ivPvSpecFrom, stringProfileSpecFrom } from "./ivPvSpec";
import { StatusBadge, Led, Meter, LoadingState, EmptyState, statusLevel, fmt } from "./ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

/** measured values only: the first finite one, else null ("—"), never a typical-looking stand-in */
const num = (...vals: unknown[]): number | null => {
  for (const v of vals) {
    if (v == null || v === "") continue;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
};
const str = (v: unknown): string | null => (v == null || v === "" ? null : String(v));
/** "2026-11-14 10:05:00" / ISO → "10:05" */
const hhmm = (ts: string | null) => (ts ? ts.replace("T", " ").slice(11, 16) : null);

const Tile: React.FC<{ label: string; title?: string; children: React.ReactNode; foot?: React.ReactNode }> = ({ label, title, children, foot }) => (
  <div className="rounded-xl border border-white/[0.07] bg-ink-850/80 p-3" title={title}>
    <div className="eyebrow">{label}</div>
    <div className="num mt-1 text-xl font-bold">{children}</div>
    {foot && <div className="num mt-1 text-[11px] text-slate-400">{foot}</div>}
  </div>
);

const Fact: React.FC<{ label: string; title?: string; children: React.ReactNode }> = ({ label, title, children }) => (
  <div title={title}>
    <div className="text-[10px] uppercase text-slate-500">{label}</div>
    <div className="num font-semibold text-slate-100">{children}</div>
  </div>
);

export const StringInspectorDrawer: React.FC = () => {
  const { inspectedStringId, setInspectedStringId, analysisRun, activePlant, selectedGrowattPlantId } = useAppContext();
  const navigate = useNavigate();
  const plantHref = usePlantHref();
  const [dispatching, setDispatching] = useState(false);
  const [dispatchedMsg, setDispatchedMsg] = useState<string | null>(null);
  const [stringDetail, setStringDetail] = useState<GrowattStringDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [chartTab, setChartTab] = useState<"iv" | "profile">("iv");
  const panelRef = useRef<HTMLElement>(null);

  const allStrings = analysisRun?.string_summary_json || [];
  const row = allStrings.find((s) => String(s.string_id) === inspectedStringId) || null;
  const deviceSn = str(row?.device_sn);
  const stringNo = num(row?.string_no);

  const peerStrings = row ? allStrings.filter((s) => s.inverter_id === row.inverter_id) : [];
  const peerIds = peerStrings.map((s) => String(s.string_id));

  const close = () => {
    setDispatchedMsg(null);
    setInspectedStringId(null);
  };
  const show = (id: string) => {
    setDispatchedMsg(null);
    setInspectedStringId(id);
  };

  useEffect(() => {
    if (!inspectedStringId || !selectedGrowattPlantId || !deviceSn || stringNo == null) {
      setStringDetail(null);
      setDetailError(null);
      return;
    }
    let cancelled = false;
    setLoadingDetail(true);
    setDetailError(null);
    api
      .getGrowattStringDetail(selectedGrowattPlantId, deviceSn, stringNo)
      .then((res) => {
        if (!cancelled) setStringDetail(res);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setStringDetail(null);
        setDetailError(err instanceof Error ? err.message : "Could not load the stored day");
      })
      .finally(() => {
        if (!cancelled) setLoadingDetail(false);
      });
    return () => {
      cancelled = true;
    };
  }, [inspectedStringId, deviceSn, stringNo, selectedGrowattPlantId]);

  // Esc closes, ← / → move through the inverter's strings; focus the panel on open
  const open = Boolean(inspectedStringId && analysisRun && row);
  useEffect(() => {
    if (!open) return;
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      } else if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && peerIds.length > 1) {
        const i = peerIds.indexOf(String(inspectedStringId));
        if (i < 0) return;
        e.preventDefault();
        show(peerIds[(i + (e.key === "ArrowRight" ? 1 : peerIds.length - 1)) % peerIds.length]);
      }
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, inspectedStringId, peerIds.join("|")]);

  const ivPvSpec = useMemo(() => (stringDetail ? ivPvSpecFrom(stringDetail.iv_pv_curve) : null), [stringDetail]);
  const profileSpec = useMemo(() => (stringDetail ? stringProfileSpecFrom(stringDetail) : null), [stringDetail]);

  if (!open || !row || !analysisRun) return null;

  const tariff = num(activePlant?.tariff_thb_per_kwh, analysisRun.tariff_thb_per_kwh);
  const lvl = statusLevel(row.status);
  const tone = lvl === "crit" ? "crit" : lvl === "warn" ? "warn" : "ok";
  const health = num(row.health_score);
  const pr = num(row.pr_pct);
  const peerGap = num(row.current_mismatch_pct, row.peer_gap_pct);
  const lossKwh = num(row.energy_loss_kwh, row.estimated_loss_kwh);
  const lossThb = lossKwh == null || tariff == null ? null : lossKwh * tariff;
  const energy = num(row.actual_energy_kwh);
  const peerEnergy = num(row.expected_energy_kwh);
  const vAvg = num(row.v_avg, row.avg_vmp_v);
  const vMax = num(row.v_max);
  const iAvg = num(row.i_avg, row.avg_imp_a);
  const iMax = num(row.i_max);
  const pMaxW = num(row.p_max_w);

  // newest live record (memory only, never stored)
  const liveI = num(row.live_current_a);
  const liveV = num(row.live_voltage_v);
  const liveP = num(row.live_power_w);
  const liveAt = str(row.live_at);
  const liveStatus = str(row.live_status);
  const liveReason = str(row.live_reason);

  const s = stringDetail?.summary;
  const day = stringDetail?.meta.day ?? null;
  const basisNote =
    row.peer_basis === "per_module" ? "scaled per module" : row.peer_basis === "per_kwp" ? "scaled per kWp" : row.peer_basis === "raw" ? "raw: module count not set for every string" : null;
  const stringsHref = `${plantHref("strings")}?string=${encodeURIComponent(String(row.string_id))}`;

  const handleDispatchCm = async () => {
    setDispatching(true);
    setDispatchedMsg(null);
    try {
      await api.regenerateCmWorkOrders(analysisRun.id);
      setDispatchedMsg(`Synced CM work order queue for ${inspectedStringId}.`);
    } catch (err: unknown) {
      setDispatchedMsg(`Failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setDispatching(false);
    }
  };

  const chartBody = (spec: ReturnType<typeof ivPvSpecFrom>, empty: string) =>
    loadingDetail ? (
      <LoadingState label="Loading the stored day…" shape="chart" />
    ) : detailError ? (
      <EmptyState icon={AlertTriangle} title="Stored day not available" description={detailError} className="py-8" />
    ) : spec ? (
      <PanelChart spec={spec} height={300} />
    ) : (
      <EmptyState icon={Activity} title="Nothing to draw" description={empty} className="py-8" />
    );

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/65 backdrop-blur-sm" onClick={close} aria-hidden />
      <aside
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={`String inspector ${row.string_id}`}
        className="relative flex h-full w-full lg:w-1/2 flex-col border-l border-white/10 bg-ink-900 shadow-2xl outline-none"
      >
        {/* Header */}
        <div className="border-b border-white/[0.07] bg-ink-950/60 px-5 py-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="eyebrow">String I-V & Telemetry Inspector</span>
                <span className="num inline-flex items-center gap-1 rounded border border-energy-400/25 bg-energy-500/10 px-1.5 py-0.5 text-[11px] font-semibold text-energy-300">
                  <Cpu className="h-3 w-3" />
                  {String(row.inverter_id)} / {String(row.mppt_id)}
                </span>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-2.5">
                <h3 className="num truncate text-xl font-extrabold tracking-tight text-white">{String(row.string_id)}</h3>
                <StatusBadge status={row.status} />
                {day && (
                  <Badge variant="neutral" className="num" title="Figures, curves and the profile are of this stored day">
                    Stored day {day}
                  </Badge>
                )}
              </div>
            </div>
            <Button onClick={close} variant="ghost" size="icon" aria-label="Close string inspector" title="Close (Esc)">
              <X className="h-4 w-4" />
            </Button>
          </div>

          {/* Strings of the same inverter */}
          {peerStrings.length > 1 && (
            <div className="mt-3 flex flex-wrap items-center gap-1">
              {peerStrings.map((p) => {
                const id = String(p.string_id);
                const active = id === inspectedStringId;
                const pLvl = statusLevel(p.status);
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => show(id)}
                    aria-current={active ? "true" : undefined}
                    title={`${id} · ${String(p.status ?? "")}`}
                    className={`num inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-semibold transition ${
                      active
                        ? "border-solar-400/60 bg-solar-500/20 text-solar-300 shadow-[0_0_12px_-4px_rgba(245,180,42,0.7)]"
                        : "border-white/[0.07] bg-ink-850 text-slate-400 hover:border-white/20 hover:text-slate-200"
                    }`}
                  >
                    <Led level={pLvl === "info" || pLvl === "neutral" ? "ok" : pLvl} />
                    {String(p.short_label || p.string_id)}
                  </button>
                );
              })}
              <span className="ml-1 text-[10px] text-slate-500">← / → to switch</span>
            </div>
          )}
        </div>

        {/* Body */}
        <div className="flex-1 space-y-5 overflow-y-auto p-5 text-xs">
          {/* Diagnosis of the stored day */}
          <div className={lvl === "crit" ? "callout-crit" : lvl === "warn" ? "callout-warn" : "callout-ok"}>
            <div className="flex items-start gap-2.5">
              {lvl === "ok" ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />}
              <div className="space-y-1">
                <div className="font-bold text-slate-100">{String(row.diagnosis || row.primary_diagnosis || "String operating diagnostics")}</div>
                {str(row.recommended_action) && <div className="text-[11px] opacity-90">{String(row.recommended_action)}</div>}
              </div>
            </div>
          </div>

          {/* Now (live, not stored) */}
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-sky-400/20 bg-sky-500/[0.05] px-3.5 py-2.5">
            <span className="inline-flex items-center gap-1.5 font-semibold text-sky-200">
              <Radio className="h-3.5 w-3.5" />
              {liveI != null ? `Now · ${hhmm(liveAt) ?? "live"}` : "Now"}
            </span>
            {liveI != null ? (
              <span className="num flex flex-wrap items-center gap-3 text-slate-200">
                <span>{fmt(liveV, 0)} V</span>
                <span>{fmt(liveI, 2)} A</span>
                <span>{fmt(liveP == null ? null : liveP / 1000, 2)} kW</span>
                {liveStatus && <StatusBadge status={liveStatus} />}
              </span>
            ) : (
              <span className="text-slate-500">No live record for this string</span>
            )}
            {liveI != null && liveReason && <div className="w-full text-[11px] text-slate-400">{liveReason}</div>}
          </div>

          {/* Stored-day KPIs */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Tile label="Health score" foot={health != null && <Meter value={health} tone={tone} className="mt-1" />}>
              <span className="text-white">{fmt(health, 1)}</span>
              <span className="text-xs text-slate-500">/100</span>
            </Tile>
            <Tile label="String PR" title="Peer-relative PR (modelled): energy vs. the inverter's other strings, not IEC 61724" foot={`${fmt(energy, 2)} kWh`}>
              <span className="text-solar-400">{fmt(pr, 1)}</span>
              <span className="text-xs text-slate-500">% · peer</span>
            </Tile>
            <Tile label="Current vs peers" title="Current mismatch against the inverter's other strings" foot={`Peak ${fmt(pMaxW == null ? null : pMaxW / 1000, 2)} kW`}>
              <span className={peerGap == null ? "text-slate-400" : peerGap < -10 ? "text-red-400" : peerGap < -4 ? "text-amber-400" : "text-emerald-400"}>
                {peerGap != null && peerGap >= 0 ? "+" : ""}
                {fmt(peerGap, 1)}%
              </span>
            </Tile>
            <Tile
              label="Energy gap"
              title={tariff == null ? "No plant tariff set" : `At the plant tariff ฿${fmt(tariff, 2)}/kWh`}
              foot={lossThb == null ? "—" : `≈ ฿${Math.round(lossThb).toLocaleString()}`}
            >
              <span className="text-red-400">{fmt(lossKwh, 1)}</span> <span className="text-xs text-slate-500">kWh</span>
            </Tile>
          </div>

          {/* Charts of the stored day */}
          <div className="space-y-3 rounded-xl border border-white/[0.07] bg-ink-850/70 p-4">
            <Tabs value={chartTab} onValueChange={(v) => setChartTab(v as "iv" | "profile")}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <TabsList variant="line">
                  <TabsTrigger value="iv">I-V & P-V</TabsTrigger>
                  <TabsTrigger value="profile">5-min profile</TabsTrigger>
                </TabsList>
                <span className="text-[11px] text-slate-500">
                  {chartTab === "iv" ? "Curves modelled · dots measured" : "Measured · peer = mean of the other strings"}
                </span>
              </div>
              <TabsContent value="iv" className="mt-3 space-y-3">
                {chartBody(ivPvSpec, `No record on ${day ?? "the stored day"} has both voltage and current, so no curve can be modelled.`)}
                {s && !loadingDetail && (
                  <div className="grid grid-cols-2 gap-3 rounded-lg border border-white/[0.06] bg-ink-950/60 p-3 text-center sm:grid-cols-4">
                    <Fact label="V_mpp / V_oc est." title="V_oc is estimated from the day's highest voltage (modelled)">
                      {fmt(s.v_mpp, 0)} / {fmt(s.v_oc_est, 0)} V
                    </Fact>
                    <Fact label="I_mpp / I_sc est." title="I_sc is estimated from the day's highest current (modelled)">
                      {fmt(s.i_mpp, 2)} / {fmt(s.i_sc_est, 2)} A
                    </Fact>
                    <Fact label="Peak power (MPP)" title="Record with the day's highest power">
                      {fmt(s.p_max_w, 0)} W
                    </Fact>
                    <Fact label="Energy / peer avg" title="Integrated energy of this string vs. the average peer string">
                      {fmt(s.energy_kwh, 2)} / {fmt(s.peer_energy_kwh, 2)} kWh
                    </Fact>
                  </div>
                )}
              </TabsContent>
              <TabsContent value="profile" className="mt-3">
                {chartBody(profileSpec, `No stored records on ${day ?? "the stored day"}.`)}
              </TabsContent>
            </Tabs>
          </div>

          {/* Operating point of the stored day */}
          <div className="space-y-3 rounded-xl border border-white/[0.07] bg-ink-850/60 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 font-semibold text-slate-100">
                <Sliders className="h-3.5 w-3.5 text-solar-400" />
                Electrical operating point ({String(row.mppt_id)})
              </div>
              <span className="num text-[11px] text-slate-400">
                {row.modules != null && (
                  <>
                    {String(row.modules)} modules{row.module_wp ? ` × ${fmt(row.module_wp, 0)} Wp` : ""} ·{" "}
                  </>
                )}
                {fmt(row.capacity_kwp, 2)} kWp
              </span>
            </div>

            <div className="space-y-2.5">
              <div>
                <div className="mb-1 flex justify-between text-[11px]">
                  <span className="text-slate-400">MPPT voltage (avg / max)</span>
                  <span className="num text-slate-200">
                    <strong>{fmt(vAvg, 1)} V</strong> / {fmt(vMax, 1)} V
                  </span>
                </div>
                {vAvg != null && vMax != null && vMax > 0 && <Meter value={vAvg} max={vMax} tone="solar" />}
              </div>
              <div>
                <div className="mb-1 flex justify-between text-[11px]">
                  <span className="text-slate-400">String current (avg / peak)</span>
                  <span className="num text-slate-200">
                    <strong>{fmt(iAvg, 2)} A</strong> / {fmt(iMax, 2)} A
                  </span>
                </div>
                {iAvg != null && iMax != null && iMax > 0 && <Meter value={iAvg} max={iMax} tone="energy" />}
              </div>
              <div>
                <div className="mb-1 flex justify-between gap-2 text-[11px]">
                  <span className="text-slate-400">
                    Energy vs. peer median{basisNote && <span className="text-slate-500"> ({basisNote})</span>}
                  </span>
                  <span className="num shrink-0 text-slate-200">
                    <strong>{fmt(energy, 2)} kWh</strong> / {fmt(peerEnergy, 2)} kWh
                  </span>
                </div>
                {energy != null && peerEnergy != null && peerEnergy > 0 && <Meter value={energy} max={peerEnergy} tone={tone} />}
              </div>
            </div>
          </div>

          {dispatchedMsg && (
            <div className="callout-ok flex items-center justify-between">
              <span>{dispatchedMsg}</span>
              <Button
                onClick={() => {
                  close();
                  navigate(plantHref("maintenance"));
                }}
                size="sm"
              >
                View CM queue <ArrowUpRight data-icon="inline-end" className="h-3 w-3" />
              </Button>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-white/[0.07] bg-ink-950/70 px-5 py-3.5">
          <Button
            onClick={() => {
              close();
              navigate(stringsHref);
            }}
          >
            <Activity data-icon="inline-start" className="h-3.5 w-3.5 text-energy-400" />
            Open in String Diagnostics
          </Button>
          {analysisRun.id ? (
            <Button onClick={handleDispatchCm} disabled={dispatching} variant="default">
              <Wrench data-icon="inline-start" className="h-3.5 w-3.5" />
              {dispatching ? "Syncing CM queue…" : "Dispatch CM work order"}
            </Button>
          ) : null}
        </div>
      </aside>
    </div>
  );
};
