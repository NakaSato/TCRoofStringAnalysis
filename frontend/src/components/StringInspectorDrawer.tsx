import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  X,
  Cpu,
  Activity,
  Zap,
  AlertTriangle,
  Wrench,
  CheckCircle2,
  ArrowUpRight,
  Sliders,
  Gauge,
} from "lucide-react";
import { useAppContext } from "../context/AppContext";
import { api } from "../api/client";
import type { GrowattStringDetail } from "../api/client";
import { PanelChart } from "./PanelChart";
import type { PanelChartSpec } from "./PanelChart";
import { ivPvSpecFrom } from "./ivPvSpec";
import { StatusBadge, Led, Meter, LoadingState, statusLevel, fmt } from "./ui";
import { Button } from "@/components/ui/button";

export const StringInspectorDrawer: React.FC = () => {
  const {
    inspectedStringId,
    setInspectedStringId,
    analysisRun,
    activePlant,
    selectedGrowattPlantId,
  } = useAppContext();
  const navigate = useNavigate();
  const [dispatching, setDispatching] = useState(false);
  const [dispatchedMsg, setDispatchedMsg] = useState<string | null>(null);
  const [stringDetail, setStringDetail] = useState<GrowattStringDetail | null>(null);
  const [loadingCurve, setLoadingCurve] = useState(false);

  const allStrings = analysisRun?.string_summary_json || [];
  const row = allStrings.find((s) => String(s.string_id) === inspectedStringId) || null;

  useEffect(() => {
    if (!inspectedStringId || !row || !selectedGrowattPlantId || !row.device_sn || !row.string_no) {
      setStringDetail(null);
      return;
    }
    let cancelled = false;
    setLoadingCurve(true);
    api
      .getGrowattStringDetail(selectedGrowattPlantId, String(row.device_sn), Number(row.string_no))
      .then((res) => {
        if (!cancelled) setStringDetail(res);
      })
      .catch(() => {
        if (!cancelled) setStringDetail(null);
      })
      .finally(() => {
        if (!cancelled) setLoadingCurve(false);
      });
    return () => {
      cancelled = true;
    };
  }, [inspectedStringId, row?.device_sn, row?.string_no, selectedGrowattPlantId]);

  const ivPvSpec = useMemo<PanelChartSpec | null>(
    () => (stringDetail ? ivPvSpecFrom(stringDetail.iv_pv_curve) : null),
    [stringDetail],
  );

  if (!inspectedStringId || !analysisRun || !row) return null;

  // Peer strings on the same inverter for quick switching
  const peerStrings = allStrings.filter((s) => s.inverter_id === row.inverter_id);
  const tariff = activePlant?.tariff_thb_per_kwh ?? analysisRun.tariff_thb_per_kwh ?? 4.2;

  const lvl = statusLevel(row.status);
  const peerGap = Number(row.current_mismatch_pct ?? row.peer_gap_pct ?? 0);
  const lossKwh = Number(row.energy_loss_kwh ?? row.estimated_loss_kwh ?? 0);
  const lossThb = lossKwh * tariff;
  const vAvg = Number(row.v_avg ?? row.avg_vmp_v ?? 620);
  const vMax = Number(row.v_max ?? vAvg * 1.15);
  const iAvg = Number(row.i_avg ?? row.avg_imp_a ?? 8.5);
  const iMax = Number(row.i_max ?? iAvg * 1.15);

  const handleDispatchCm = async () => {
    setDispatching(true);
    setDispatchedMsg(null);
    try {
      await api.regenerateCmWorkOrders(analysisRun.id);
      setDispatchedMsg(`Synced CM work order queue for ${inspectedStringId}.`);
    } catch (err: any) {
      setDispatchedMsg(`Failed: ${err.message}`);
    } finally {
      setDispatching(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div
        className="absolute inset-0 bg-black/65 backdrop-blur-sm"
        onClick={() => {
          setDispatchedMsg(null);
          setInspectedStringId(null);
        }}
      />
      <aside className="relative flex h-full w-full max-w-xl flex-col border-l border-white/10 bg-ink-900 shadow-2xl">
        {/* Top Header */}
        <div className="border-b border-white/[0.07] bg-ink-950/60 px-5 py-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <span className="eyebrow">String I-V & Telemetry Inspector</span>
                <span className="num inline-flex items-center gap-1 rounded border border-energy-400/25 bg-energy-500/10 px-1.5 py-0.5 text-[11px] font-semibold text-energy-300">
                  <Cpu className="h-3 w-3" />
                  {row.inverter_id} / {row.mppt_id}
                </span>
              </div>
              <div className="mt-1 flex items-center gap-2.5">
                <h3 className="num text-xl font-extrabold tracking-tight text-white">
                  {row.string_id}
                </h3>
                <StatusBadge status={row.status} />
              </div>
            </div>
            <Button
              onClick={() => {
                setDispatchedMsg(null);
                setInspectedStringId(null);
              }}
              variant="ghost"
              size="icon"
              aria-label="Close string inspector"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>

          {/* Quick String Switcher Pills (Inverter Peers) */}
          <div className="mt-3 flex flex-wrap gap-1">
            {peerStrings.map((s) => {
              const id = String(s.string_id);
              const label = String(s.short_label || s.string_id);
              const active = id === inspectedStringId;
              const sLvl = statusLevel(s.status);
              return (
                <button
                  key={id}
                  onClick={() => {
                    setDispatchedMsg(null);
                    setInspectedStringId(id);
                  }}
                  className={`num inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-semibold transition ${
                    active
                      ? "border-solar-400/60 bg-solar-500/20 text-solar-300 shadow-[0_0_12px_-4px_rgba(245,180,42,0.7)]"
                      : "border-white/[0.07] bg-ink-850 text-slate-400 hover:border-white/20 hover:text-slate-200"
                  }`}
                >
                  <Led level={sLvl === "info" || sLvl === "neutral" ? "ok" : sLvl} />
                  {label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Scrollable Body */}
        <div className="flex-1 space-y-5 overflow-y-auto p-5 text-xs">
          {/* Primary Diagnosis Banner */}
          <div
            className={
              lvl === "crit" ? "callout-crit" : lvl === "warn" ? "callout-warn" : "callout-ok"
            }
          >
            <div className="flex items-start gap-2.5">
              {lvl === "ok" ? (
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
              ) : (
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              )}
              <div className="space-y-1">
                <div className="font-bold text-slate-100">
                  {row.diagnosis || row.primary_diagnosis || "String Operating Diagnostics"}
                </div>
                <div className="text-[11px] opacity-90">
                  {row.recommended_action ||
                    "Inspect string I-V curve, MPPT balance, and connector terminations."}
                </div>
              </div>
            </div>
          </div>

          {/* 4 Key KPI Tiles */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-xl border border-white/[0.07] bg-ink-850/80 p-3">
              <div className="eyebrow">Health Score</div>
              <div className="num mt-1 text-xl font-bold text-white">
                {fmt(row.health_score, 1)}
                <span className="text-xs text-slate-500">/100</span>
              </div>
              <Meter
                value={Number(row.health_score || 0)}
                tone={lvl === "crit" ? "crit" : lvl === "warn" ? "warn" : "ok"}
                className="mt-2"
              />
            </div>

            <div className="rounded-xl border border-white/[0.07] bg-ink-850/80 p-3">
              <div className="eyebrow">String PR</div>
              <div className="num mt-1 text-xl font-bold text-solar-400">
                {fmt(row.pr_pct, 1)}
                <span className="text-xs text-slate-500">%</span>
              </div>
              <div className="num mt-1 text-[11px] text-slate-400">
                Energy: {fmt(row.actual_energy_kwh, 1)} kWh
              </div>
            </div>

            <div className="rounded-xl border border-white/[0.07] bg-ink-850/80 p-3">
              <div className="eyebrow">Peer Deviation</div>
              <div
                className={`num mt-1 text-xl font-bold ${
                  peerGap < -10 ? "text-red-400" : peerGap < -4 ? "text-amber-400" : "text-emerald-400"
                }`}
              >
                {peerGap >= 0 ? "+" : ""}
                {fmt(peerGap, 1)}%
              </div>
              <div className="num mt-1 text-[11px] text-slate-400">
                Peak: {fmt(Number(row.p_max_w || 0) / 1000, 2)} kW
              </div>
            </div>

            <div className="rounded-xl border border-white/[0.07] bg-ink-850/80 p-3">
              <div className="eyebrow">Mismatch Loss</div>
              <div className="num mt-1 text-xl font-bold text-red-400">
                {fmt(lossKwh, 1)} <span className="text-xs text-slate-500">kWh</span>
              </div>
              <div className="num mt-1 text-[11px] text-amber-300">
                ≈ ฿{Math.round(lossThb).toLocaleString()}
              </div>
            </div>
          </div>

          {/* Embedded Live I-V & P-V Curve */}
          <div className="rounded-xl border border-white/[0.07] bg-ink-850/70 p-4 space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5 font-semibold text-slate-100">
                <Gauge className="h-3.5 w-3.5 text-sky-400" />
                Reconstructed I-V & P-V Characteristic Curves
              </div>
              {stringDetail && (
                <span className="num text-[11px] text-emerald-400">
                  MPP: {fmt(stringDetail.summary.p_max_w, 0)} W @ {fmt(stringDetail.summary.v_mpp, 0)} V
                </span>
              )}
            </div>
            {loadingCurve ? (
              <LoadingState label="Reconstructing I-V & P-V curves…" />
            ) : ivPvSpec ? (
              <PanelChart spec={ivPvSpec} height={300} />
            ) : null}
          </div>

          {/* Operating Electrical Telemetry */}
          <div className="rounded-xl border border-white/[0.07] bg-ink-850/60 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5 font-semibold text-slate-100">
                <Sliders className="h-3.5 w-3.5 text-solar-400" />
                Electrical Operating Point ({row.mppt_id})
              </div>
              <span className="num text-[11px] text-slate-400">
                {row.modules != null && <>{row.modules} modules{row.module_wp ? ` × ${fmt(row.module_wp, 0)} Wp` : ""} · </>}
                Capacity: {fmt(row.capacity_kwp, 2)} kWp
              </span>
            </div>

            <div className="space-y-2.5">
              <div>
                <div className="mb-1 flex justify-between text-[11px]">
                  <span className="text-slate-400">Operating Voltage (Avg / Max)</span>
                  <span className="num text-slate-200">
                    <strong>{fmt(vAvg, 1)} V</strong> / {fmt(vMax, 1)} V Peak
                  </span>
                </div>
                <Meter value={vAvg} max={Math.max(800, vMax * 1.1)} tone="solar" />
              </div>

              <div>
                <div className="mb-1 flex justify-between text-[11px]">
                  <span className="text-slate-400">Operating Current (Avg / Peak)</span>
                  <span className="num text-slate-200">
                    <strong>{fmt(iAvg, 2)} A</strong> / {fmt(iMax, 2)} A Peak
                  </span>
                </div>
                <Meter value={iAvg} max={Math.max(15, iMax * 1.15)} tone="energy" />
              </div>

              <div>
                <div className="mb-1 flex justify-between text-[11px]">
                  <span className="text-slate-400">
                    String Energy vs. Peer Median
                    {row.peer_basis === "raw" && " (raw — module count not set for every string)"}
                    {row.peer_basis === "per_module" && " (scaled per module)"}
                    {row.peer_basis === "per_kwp" && " (scaled per kWp)"}
                  </span>
                  <span className="num text-slate-200">
                    <strong>{fmt(row.actual_energy_kwh, 2)} kWh</strong> /{" "}
                    {fmt(row.expected_energy_kwh, 2)} kWh Peer
                  </span>
                </div>
                <Meter
                  value={Number(row.actual_energy_kwh || 0)}
                  max={Math.max(1, Number(row.expected_energy_kwh || 1))}
                  tone="ok"
                />
              </div>
            </div>
          </div>

          {dispatchedMsg && (
            <div className="callout-ok flex items-center justify-between">
              <span>{dispatchedMsg}</span>
              <Button
                onClick={() => {
                  setInspectedStringId(null);
                  navigate("/maintenance");
                }}
                size="sm"
              >
                View CM Queue <ArrowUpRight className="h-3 w-3" />
              </Button>
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-white/[0.07] bg-ink-950/70 px-5 py-3.5">
          <Button
            onClick={() => {
              setInspectedStringId(null);
              navigate("/strings");
            }}
          >
            <Activity className="h-3.5 w-3.5 text-energy-400" />
            Full String I-V Page
          </Button>
          <Button onClick={handleDispatchCm} disabled={dispatching} variant="default">
            <Wrench className="h-3.5 w-3.5" />
            {dispatching ? "Syncing CM Queue…" : "Dispatch CM Work Order"}
          </Button>
        </div>
      </aside>
    </div>
  );
};
