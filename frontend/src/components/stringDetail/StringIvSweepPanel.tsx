/**
 * String page: Measured I-V curve sweeps & IEC 60891 Procedure 1 STC translation.
 * Enforces:
 * - Every curve requires G (POA W/m²), T (module °C), and sweep timestamp.
 * - Quality gate: G >= 700 W/m² and |ΔG| <= 2% during sweep.
 * - IEC 60891 Procedure 1 translation to STC (1000 W/m², 25 °C).
 * - Extracted parameters: Isc, Voc, Imp, Vmp, Pmax, FF, slope near Voc (Rs), slope near Isc (Rsh), step count.
 * - 8 fault signatures + ±3–5% field dead band + 2-source warranty agreement (I-V + IR or I-V + time-series trend).
 */
import React, { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Flame, Plus, ShieldCheck, Upload, Zap } from "lucide-react";
import { api } from "../../api/client";
import type { IvSweep } from "../../api/types/growatt";
import { useAppContext } from "../../context/AppContext";
import { PanelChart } from "../PanelChart";
import type { ChartSeries, PanelChartSpec } from "../PanelChart";
import { SERIES, STATUS } from "../chartTheme";
import { Panel, fmt } from "../ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export const StringIvSweepPanel: React.FC<{ plantId: number; sn: string; stringNo: number }> = ({
  plantId,
  sn,
  stringNo,
}) => {
  const { user } = useAppContext();
  const canEdit = user?.role === "admin" || user?.role === "engineer";

  const [sweeps, setSweeps] = useState<IvSweep[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showUpload, setShowUpload] = useState(false);

  // Upload form state
  const [sweptAt, setSweptAt] = useState(() => new Date().toISOString().slice(0, 16));
  const [irrG, setIrrG] = useState("850");
  const [tempC, setTempC] = useState("45");
  const [irrChangePct, setIrrChangePct] = useState("0.8");
  const [deadBandPct, setDeadBandPct] = useState("4.0");
  const [irConfirmed, setIrConfirmed] = useState(false);
  const [csvText, setCsvText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitErr, setSubmitErr] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    setError(null);
    api
      .listIvSweeps(plantId, { sn, stringNo, limit: 20 })
      .then((res) => {
        setSweeps(res.sweeps);
        if (res.sweeps.length > 0 && (selectedId == null || !res.sweeps.some((s) => s.id === selectedId))) {
          setSelectedId(res.sweeps[0].id);
        }
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
  }, [plantId, sn, stringNo]);

  const active = useMemo(
    () => sweeps.find((s) => s.id === selectedId) ?? sweeps[0] ?? null,
    [sweeps, selectedId]
  );

  const spec = useMemo<PanelChartSpec | null>(() => {
    if (!active) return null;
    const rawPts = active.measured?.points ?? [];
    const stcPts = active.stc?.points ?? [];
    const refPts = active.stc?.reference_points ?? [];
    if (rawPts.length === 0 && stcPts.length === 0) return null;

    const amps = (v: number) => `${fmt(v, 2)} A`;
    const watts = (v: number) => `${fmt(v, 0)} W`;
    const current: ChartSeries[] = [];
    const power: ChartSeries[] = [];

    if (refPts.length > 0) {
      current.push({
        key: "ref-i",
        name: "STC Reference (Datasheet · modelled)",
        type: "line",
        dash: "dash",
        width: 1.5,
        color: SERIES.reference,
        x: refPts.map((p) => p.v),
        y: refPts.map((p) => p.i),
        format: amps,
      });
    }
    if (rawPts.length > 0) {
      current.push({
        key: "raw-i",
        name: `Measured (${fmt(active.irradiance_wm2, 0)} W/m², ${fmt(active.module_temp_c, 1)} °C)`,
        type: "line",
        dash: "dot",
        width: 1.5,
        color: SERIES.ambient,
        x: rawPts.map((p) => p.v),
        y: rawPts.map((p) => p.i),
        format: amps,
      });
      power.push({
        key: "raw-p",
        name: "Measured P-V",
        type: "line",
        dash: "dot",
        width: 1.5,
        color: SERIES.ambient,
        x: rawPts.map((p) => p.v),
        y: rawPts.map((p) => p.p),
        format: watts,
      });
    }
    if (stcPts.length > 0) {
      current.push({
        key: "stc-i",
        name: "STC (IEC 60891 Proc. 1 · 1000 W/m², 25 °C)",
        type: "line",
        color: SERIES.ac,
        x: stcPts.map((p) => p.v),
        y: stcPts.map((p) => p.i),
        format: amps,
      });
      power.push({
        key: "stc-p",
        name: "STC P-V (IEC 60891)",
        type: "line",
        color: SERIES.dc,
        x: stcPts.map((p) => p.v),
        y: stcPts.map((p) => p.p),
        format: watts,
      });
    }
    const stcParams = active.stc?.parameters;
    if (stcParams) {
      power.push({
        key: "stc-mpp",
        name: `STC Pmax ${fmt(stcParams.p_max_w, 0)} W @ ${fmt(stcParams.v_mp_v, 0)} V`,
        type: "points",
        symbol: "diamond",
        size: 11,
        color: STATUS.good,
        x: [stcParams.v_mp_v],
        y: [stcParams.p_max_w],
        noTip: true,
      });
    }

    const basePts = stcPts.length > 0 ? stcPts : rawPts;
    return {
      xKind: "linear",
      xZero: true,
      x: basePts.map((p) => p.v),
      xLabel: "String DC voltage (V)",
      xTipNumber: (v) => `${fmt(v, 0)} V`,
      panels: [
        { key: "i", title: "Current (A)", series: current },
        { key: "p", title: "Power (W)", series: power },
      ],
    };
  }, [active]);

  const toggleIr = async (sweep: IvSweep) => {
    try {
      const updated = await api.patchIvSweep(plantId, sweep.id, {
        ir_confirmed: !sweep.ir_confirmed,
      });
      setSweeps((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleUpload = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitErr(null);
    const g = Number(irrG);
    const t = Number(tempC);
    if (!Number.isFinite(g) || g <= 0 || !Number.isFinite(t)) {
      setSubmitErr("Irradiance G (W/m²) and module temperature T (°C) are required to interpret an I-V curve.");
      return;
    }
    if (!csvText.trim()) {
      setSubmitErr("Provide (V, I) points (one pair per line: V, I).");
      return;
    }
    setSubmitting(true);
    try {
      const created = await api.createIvSweep(plantId, {
        device_sn: sn,
        string_no: stringNo,
        swept_at: new Date(sweptAt).toISOString(),
        irradiance_wm2: g,
        module_temp_c: t,
        irradiance_change_pct: irrChangePct.trim() !== "" ? Number(irrChangePct) : null,
        dead_band_pct: deadBandPct.trim() !== "" ? Number(deadBandPct) : 4.0,
        ir_confirmed: irConfirmed,
        csv_text: csvText,
      });
      setSweeps((prev) => [created, ...prev]);
      setSelectedId(created.id);
      setShowUpload(false);
      setCsvText("");
    } catch (err) {
      setSubmitErr(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const stcParams = active?.stc?.parameters;

  return (
    <Panel
      icon={Zap}
      title="Measured I-V curve analysis · IEC 60891 STC"
      subtitle="Sweep conditions (G ≥ 700 W/m², ΔG ≤ 2%), IEC 60891 Procedure 1 STC translation, fault signatures, and two-source warranty check"
      actions={
        canEdit ? (
          <Button variant="outline" size="xs" onClick={() => setShowUpload((v) => !v)}>
            <Plus data-icon="inline-start" className="h-3.5 w-3.5" />
            {showUpload ? "Cancel" : "Ingest I-V sweep"}
          </Button>
        ) : undefined
      }
    >
      <div className="space-y-4">
        {showUpload && (
          <form onSubmit={handleUpload} className="space-y-3 rounded-lg border border-white/[0.08] bg-ink-950/60 p-3.5 text-xs">
            <div className="font-semibold text-white">Ingest field or online smart I-V sweep (requires G, T, and timestamp)</div>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
              <label className="space-y-1">
                <span className="text-[11px] text-slate-400">Sweep time</span>
                <Input type="datetime-local" value={sweptAt} onChange={(e) => setSweptAt(e.target.value)} className="num h-8 text-xs" required />
              </label>
              <label className="space-y-1">
                <span className="text-[11px] text-slate-400">POA G (W/m² ≥ 700)</span>
                <Input type="number" step="1" value={irrG} onChange={(e) => setIrrG(e.target.value)} className="num h-8 text-xs" required />
              </label>
              <label className="space-y-1">
                <span className="text-[11px] text-slate-400">Back-of-module T (°C)</span>
                <Input type="number" step="0.1" value={tempC} onChange={(e) => setTempC(e.target.value)} className="num h-8 text-xs" required />
              </label>
              <label className="space-y-1">
                <span className="text-[11px] text-slate-400">Sweep ΔG (% ≤ 2%)</span>
                <Input type="number" step="0.1" value={irrChangePct} onChange={(e) => setIrrChangePct(e.target.value)} className="num h-8 text-xs" />
              </label>
              <label className="space-y-1">
                <span className="text-[11px] text-slate-400">Dead band (±%)</span>
                <Input type="number" step="0.5" value={deadBandPct} onChange={(e) => setDeadBandPct(e.target.value)} className="num h-8 text-xs" />
              </label>
            </div>
            <label className="block space-y-1">
              <span className="text-[11px] text-slate-400">Curve points (one V, I pair per line, e.g. `0, 13.8` ... `820, 0`)</span>
              <textarea
                rows={4}
                value={csvText}
                onChange={(e) => setCsvText(e.target.value)}
                placeholder={"0.0, 13.85\n200.0, 13.80\n650.0, 13.10\n780.0, 0.0"}
                className="num w-full rounded-md border border-white/10 bg-ink-900 px-2.5 py-1.5 text-xs text-white focus:outline-none"
                required
              />
            </label>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label className="inline-flex items-center gap-2 text-slate-300">
                <input type="checkbox" checked={irConfirmed} onChange={(e) => setIrConfirmed(e.target.checked)} />
                Confirmed by IR thermography (drone / handheld IR)
              </label>
              <Button type="submit" size="xs" disabled={submitting}>
                <Upload data-icon="inline-start" className="h-3.5 w-3.5" />
                {submitting ? "Translating to STC…" : "Analyze & Store Sweep"}
              </Button>
            </div>
            {submitErr && <div className="text-xs text-red-400">{submitErr}</div>}
          </form>
        )}

        {error && <div className="text-xs text-red-400">{error}</div>}

        {loading && sweeps.length === 0 ? (
          <div className="text-xs text-slate-500">Loading stored I-V sweeps…</div>
        ) : sweeps.length === 0 ? (
          <div className="text-xs text-slate-500">
            No field or online smart I-V sweeps stored for this string yet. Use <strong>Ingest I-V sweep</strong> to translate a measured sweep to STC (IEC 60891 Procedure 1) and classify fault signatures.
          </div>
        ) : (
          active && (
            <div className="space-y-4">
              {/* Sweep selector + conditions bar */}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-1.5">
                  {sweeps.map((sw) => (
                    <button
                      key={sw.id}
                      type="button"
                      onClick={() => setSelectedId(sw.id)}
                      className={`num rounded-md border px-2.5 py-1 text-[11px] font-medium transition ${
                        sw.id === active.id
                          ? "border-solar-400/60 bg-solar-500/20 text-solar-300"
                          : "border-white/[0.08] bg-ink-850 text-slate-400 hover:text-white"
                      }`}
                    >
                      {sw.swept_at.replace("T", " ").slice(0, 16)} · {fmt(sw.irradiance_wm2, 0)} W/m² · {fmt(sw.module_temp_c, 1)} °C
                    </button>
                  ))}
                </div>
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <Badge variant={active.quality_gate_passed ? "ok" : "warn"}>
                    {active.quality_gate_passed
                      ? "Valid sweep (G ≥ 700 W/m², stable)"
                      : active.gate_reasons?.join(" · ") || "Unstable conditions"}
                  </Badge>
                  {active.classification?.in_dead_band ? (
                    <Badge variant="neutral">Inside ±{fmt(active.classification.dead_band_pct, 0)}% dead band</Badge>
                  ) : (
                    <Badge variant="crit">Outside dead band ({fmt(active.pmax_dev_pct, 1)}%)</Badge>
                  )}
                  {active.warranty_claim_ready ? (
                    <Badge variant="crit" title="Agreed by two independent sources">
                      <ShieldCheck className="mr-1 h-3 w-3" /> Warranty claim ready (2 sources)
                    </Badge>
                  ) : null}
                  {canEdit && (
                    <Button variant="ghost" size="xs" onClick={() => toggleIr(active)} title="Toggle IR thermography confirmation (2nd source for warranty claims)">
                      <Flame className={`mr-1 h-3.5 w-3.5 ${active.ir_confirmed ? "text-amber-400" : "text-slate-500"}`} />
                      {active.ir_confirmed ? "IR confirmed" : "Mark IR confirmed"}
                    </Button>
                  )}
                </div>
              </div>

              {/* Fault signature callout */}
              {active.classification && (
                <div className={!active.is_finding ? "callout-ok" : "callout-warn"}>
                  <div className="flex items-start gap-2.5 text-xs">
                    {!active.is_finding ? (
                      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
                    ) : (
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
                    )}
                    <div className="space-y-0.5">
                      <div className="font-semibold text-white">
                        {active.classification.observation} · <span className="num text-solar-300">{active.classification.signature}</span>
                        {active.ticket_recommended ? " · Ticket recommended" : ""}
                      </div>
                      <div className="text-slate-300">
                        {active.classification.likely_cause} — {active.classification.recommended_action}
                      </div>
                      <div className="num text-[11px] text-slate-400">
                        Expected STC Pmax: {fmt(active.expected_pmax_stc_w, 0)} W · Measured STC Pmax: {fmt(active.p_max_stc_w, 0)} W ({fmt(active.pmax_dev_pct, 1)}%) · Two-source warranty check:{" "}
                        {active.ir_confirmed ? "IR confirmed" : "IR not marked"} / {active.timeseries_trend_confirmed ? "Time-series trend confirmed" : "No open time-series trend"}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* STC Extracted parameters grid */}
              {stcParams && (
                <div className="grid grid-cols-2 gap-2.5 text-xs sm:grid-cols-4 xl:grid-cols-9">
                  <div className="rounded-lg bg-ink-950/60 p-2.5">
                    <div className="text-[10px] uppercase text-slate-500">STC Pmax</div>
                    <div className="num font-bold text-white">{fmt(stcParams.p_max_w, 0)} W</div>
                  </div>
                  <div className="rounded-lg bg-ink-950/60 p-2.5">
                    <div className="text-[10px] uppercase text-slate-500">STC Isc</div>
                    <div className="num font-bold text-white">{fmt(stcParams.i_sc_a, 2)} A</div>
                  </div>
                  <div className="rounded-lg bg-ink-950/60 p-2.5">
                    <div className="text-[10px] uppercase text-slate-500">STC Voc</div>
                    <div className="num font-bold text-white">{fmt(stcParams.v_oc_v, 1)} V</div>
                  </div>
                  <div className="rounded-lg bg-ink-950/60 p-2.5">
                    <div className="text-[10px] uppercase text-slate-500">STC Imp</div>
                    <div className="num font-bold text-white">{fmt(stcParams.i_mp_a, 2)} A</div>
                  </div>
                  <div className="rounded-lg bg-ink-950/60 p-2.5">
                    <div className="text-[10px] uppercase text-slate-500">STC Vmp</div>
                    <div className="num font-bold text-white">{fmt(stcParams.v_mp_v, 1)} V</div>
                  </div>
                  <div className="rounded-lg bg-ink-950/60 p-2.5">
                    <div className="text-[10px] uppercase text-slate-500">Fill Factor</div>
                    <div className="num font-bold text-white">{fmt(stcParams.fill_factor * 100, 1)} %</div>
                  </div>
                  <div className="rounded-lg bg-ink-950/60 p-2.5" title="Inverse slope near Voc (-dV/dI)">
                    <div className="text-[10px] uppercase text-slate-500">Rs (near Voc)</div>
                    <div className="num font-bold text-white">{fmt(stcParams.slope_voc_ohm, 2)} Ω</div>
                  </div>
                  <div className="rounded-lg bg-ink-950/60 p-2.5" title="Inverse slope near Isc (-dV/dI)">
                    <div className="text-[10px] uppercase text-slate-500">Rsh (near Isc)</div>
                    <div className="num font-bold text-white">{fmt(stcParams.slope_isc_ohm, 0)} Ω</div>
                  </div>
                  <div className="rounded-lg bg-ink-950/60 p-2.5">
                    <div className="text-[10px] uppercase text-slate-500">Steps / Notches</div>
                    <div className={`num font-bold ${stcParams.steps_count > 0 ? "text-amber-400" : "text-emerald-400"}`}>
                      {stcParams.steps_count}
                    </div>
                  </div>
                </div>
              )}

              {spec && <PanelChart spec={spec} height={340} legendToggle />}
            </div>
          )
        )}
      </div>
    </Panel>
  );
};
