/**
 * String page: Measured I-V curve sweeps & IEC 60891 Procedure 1 STC translation.
 * Enforces:
 * - Every curve requires G (POA W/m²), T (module °C), and sweep timestamp.
 * - Quality gate: G >= 700 W/m² and |ΔG| <= 2% during sweep for the STC comparison (warnings below
 *   800 W/m² and above 1%); the curve shape (steps) is read from 400 W/m².
 * - IEC 60891 Procedure 1 translation to STC (1000 W/m², 25 °C).
 * - Extracted parameters: Isc, Voc, Imp, Vmp, Pmax, FF, slope near Voc (Rs), slope near Isc (Rsh), step count.
 * - 8 fault signatures + ±5% field dead band. Below warranted power + a second source (IR or a
 *   time-series trend) = candidate for module-level testing; a string sweep is not warranty evidence.
 */
import React, { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Flame, Plus, ShieldCheck, Upload, Zap } from "lucide-react";
import { Link } from "react-router-dom";
import { api } from "../../api/client";
import { newClaimHref } from "@/lib/claimLinks";
import type { IvCellTechnology, IvSiteCoefficients, IvSweep } from "../../api/types/growatt";
import { Spinner } from "@/components/ui/spinner";
import { useAppContext } from "../../context/AppContext";
import { PanelChart } from "../PanelChart";
import type { ChartSeries, PanelChartSpec } from "../PanelChart";
import { SERIES, STATUS } from "../chartTheme";
import { Panel, fmt } from "../ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** A ratio (0.968) as a percentage of the reference ("96.8%"); "—" when there is none. */
const pct = (ratio: number | null | undefined): string => (ratio == null ? "—" : `${fmt(ratio * 100, 1)}%`);

const UNCERTAINTY_TEXT: Record<string, string> = {
  irradiance_sensor: "Irradiance sensor",
  irradiance_change: "Irradiance change during sweep",
  module_temperature: "Module temperature",
  temperature_coefficient: "Temperature coefficient",
  translation: "Translation",
};

const FLAG_TEXT: Record<string, string> = {
  pmax_below_peers: "Pmax",
  isc_below_peers: "Isc",
  ff_below_peers: "FF",
  pmax_below_baseline: "Pmax below baseline",
  series_resistance_up: "series resistance up",
  shunt_resistance_down: "shunt resistance down",
};
const flagText = (flags: string[]): string => flags.map((f) => FLAG_TEXT[f] ?? f).join(", ");

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
  // the field holds wall-clock time; the backend stores it as the plant's local time, so no UTC conversion
  const [sweptAt, setSweptAt] = useState(() =>
    new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16)
  );
  const [irrG, setIrrG] = useState("850");
  const [tempC, setTempC] = useState("45");
  const [irrChangePct, setIrrChangePct] = useState("0.8");
  const [deadBandPct, setDeadBandPct] = useState("5.0");
  // optional conditions: empty = not recorded
  const [tempChangeK, setTempChangeK] = useState("");
  const [sweepMs, setSweepMs] = useState("");
  const [cellTech, setCellTech] = useState<IvCellTechnology | "">("");
  const [sensorUncPct, setSensorUncPct] = useState("");
  const [reversePmax, setReversePmax] = useState("");
  // coefficients fitted from this string's sweeps: loaded on request, for the sweeps listed now
  const [siteFit, setSiteFit] = useState<IvSiteCoefficients | null>(null);
  const [siteFitBusy, setSiteFitBusy] = useState(false);
  const [siteFitErr, setSiteFitErr] = useState<string | null>(null);
  useEffect(() => {
    setSiteFit(null);
    setSiteFitErr(null);
  }, [plantId, sn, stringNo, sweeps.length]);
  const loadSiteFit = () => {
    setSiteFitBusy(true);
    setSiteFitErr(null);
    api
      .getIvSiteCoefficients(plantId, sn, stringNo)
      .then(setSiteFit)
      .catch((e) => setSiteFitErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setSiteFitBusy(false));
  };
  const [sensorOffDeg, setSensorOffDeg] = useState("");
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
        swept_at: sweptAt.length === 16 ? `${sweptAt}:00` : sweptAt,
        irradiance_wm2: g,
        module_temp_c: t,
        irradiance_change_pct: irrChangePct.trim() !== "" ? Number(irrChangePct) : null,
        dead_band_pct: deadBandPct.trim() !== "" ? Number(deadBandPct) : 5.0,
        temp_change_k_per_min: tempChangeK.trim() !== "" ? Number(tempChangeK) : null,
        sweep_time_ms: sweepMs.trim() !== "" ? Number(sweepMs) : null,
        cell_technology: cellTech || null,
        irradiance_uncertainty_pct: sensorUncPct.trim() !== "" ? Number(sensorUncPct) : null,
        reverse_pmax_w: reversePmax.trim() !== "" ? Number(reversePmax) : null,
        sensor_misalignment_deg: sensorOffDeg.trim() !== "" ? Number(sensorOffDeg) : null,
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
  // steps are judged on the measured curve: translating a stepped curve can distort it
  const stepsCount = active?.measured?.parameters?.steps_count ?? stcParams?.steps_count ?? 0;

  return (
    <Panel
      icon={Zap}
      title="Measured I-V curve analysis · IEC 60891 STC"
      subtitle="Sweep conditions (G ≥ 700 W/m², ΔG ≤ 2%), IEC 60891 Procedure 1 STC translation with cross-checks, fault signatures, and module-test candidates (two sources)"
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
            <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
              <label className="space-y-1">
                <span className="text-[11px] text-slate-400">T change, last minute (K ≤ 1)</span>
                <Input type="number" step="0.1" min="0" value={tempChangeK} onChange={(e) => setTempChangeK(e.target.value)} placeholder="optional" className="num h-8 text-xs" />
              </label>
              <label className="space-y-1">
                <span className="text-[11px] text-slate-400">Sweep duration (ms)</span>
                <Input type="number" step="1" min="1" value={sweepMs} onChange={(e) => setSweepMs(e.target.value)} placeholder="optional" className="num h-8 text-xs" />
              </label>
              <label className="space-y-1">
                <span className="text-[11px] text-slate-400">Cell technology</span>
                <select
                  value={cellTech}
                  onChange={(e) => setCellTech(e.target.value as IvCellTechnology | "")}
                  className="h-8 w-full rounded-md border border-white/10 bg-ink-900 px-2 text-xs text-white focus:outline-none"
                >
                  <option value="">Not given</option>
                  <option value="perc">PERC</option>
                  <option value="topcon">TOPCon</option>
                  <option value="hjt">HJT</option>
                  <option value="ibc">IBC</option>
                </select>
              </label>
              <label className="space-y-1">
                <span className="text-[11px] text-slate-400">Sensor uncertainty (±%, k=2)</span>
                <Input type="number" step="0.1" min="0.1" value={sensorUncPct} onChange={(e) => setSensorUncPct(e.target.value)} placeholder="optional" className="num h-8 text-xs" />
              </label>
              <label className="space-y-1">
                <span className="text-[11px] text-slate-400">Sensor off array plane (° ≤ 2)</span>
                <Input type="number" step="0.1" min="0" value={sensorOffDeg} onChange={(e) => setSensorOffDeg(e.target.value)} placeholder="optional" className="num h-8 text-xs" />
              </label>
              <label className="space-y-1">
                <span className="text-[11px] text-slate-400">Pmax, opposite sweep (W)</span>
                <Input type="number" step="1" min="1" value={reversePmax} onChange={(e) => setReversePmax(e.target.value)} placeholder="optional" className="num h-8 text-xs" />
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
                  {active.classification?.gate_warnings?.map((w) => (
                    <Badge key={w} variant="warn">{w}</Badge>
                  ))}
                  {active.classification?.stc_comparison_valid === false ? (
                    <Badge variant="neutral" title="Below the STC gate, or a stepped curve: the translated power is for comparison only">
                      STC power not judged
                    </Badge>
                  ) : active.classification?.in_dead_band ? (
                    <Badge variant="neutral">Inside ±{fmt(active.classification.dead_band_pct, 0)}% dead band</Badge>
                  ) : (
                    <Badge variant="crit">Outside dead band ({fmt(active.pmax_dev_pct, 1)}%)</Badge>
                  )}
                  {active.module_test_candidate ? (
                    <Badge variant="crit" title="Below warranted power, agreed by two sources. A string sweep is not warranty evidence: test its modules one by one.">
                      <ShieldCheck className="mr-1 h-3 w-3" /> Module test candidate (2 sources)
                    </Badge>
                  ) : null}
                  {active.module_test_candidate ? (
                    <Button variant="ghost" size="xs" asChild title="Open a module warranty claim with this sweep linked">
                      <Link to={newClaimHref("sweep", { plantId, sn, stringNo, ref: active.id })}>Open claim</Link>
                    </Button>
                  ) : null}
                  {canEdit && (
                    <Button variant="ghost" size="xs" onClick={() => toggleIr(active)} title="Toggle IR thermography confirmation (2nd source for a module-test candidate)">
                      <Flame className={`mr-1 h-3.5 w-3.5 ${active.ir_confirmed ? "text-amber-400" : "text-slate-500"}`} />
                      {active.ir_confirmed ? "IR confirmed" : "Mark IR confirmed"}
                    </Button>
                  )}
                </div>
              </div>

              {/* Fault signature callout */}
              {active.classification && (
                <div className={!active.is_finding && active.signature !== "not_judged" ? "callout-ok" : "callout-warn"}>
                  <div className="flex items-start gap-2.5 text-xs">
                    {!active.is_finding && active.signature !== "not_judged" ? (
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

              {/* Same-time peers, own baseline, translation cross-check (flag levels are proposed defaults) */}
              {active.comparison && (
                <div className="space-y-1 rounded-lg bg-ink-950/60 p-2.5 text-[11px] text-slate-300">
                  {active.comparison.peer.setup_error_suspected && (
                    <div className="font-semibold text-amber-400">
                      Isc is low on every string swept together: check the irradiance sensor and setup before acting on the strings.
                    </div>
                  )}
                  <div className="num">
                    <span className="text-slate-500">vs same-time peers: </span>
                    {active.comparison.peer.ratios ? (
                      <>
                        Pmax {pct(active.comparison.peer.ratios.p_max)} · Isc {pct(active.comparison.peer.ratios.i_sc)} · Voc{" "}
                        {pct(active.comparison.peer.ratios.v_oc)} · FF {pct(active.comparison.peer.ratios.fill_factor)}{" "}
                        <span className="text-slate-500">
                          (median of strings {active.comparison.peer.peer_strings.join(", ")}, within {active.comparison.peer.window_min} min)
                        </span>
                        {active.comparison.peer.flags.length > 0 && (
                          <span className="ml-1 font-semibold text-amber-400">Below peers: {flagText(active.comparison.peer.flags)}</span>
                        )}
                      </>
                    ) : (
                      <span className="text-slate-500">— {active.comparison.peer.reason}</span>
                    )}
                  </div>
                  <div className="num">
                    <span className="text-slate-500">vs first sweep of this string: </span>
                    {active.comparison.baseline ? (
                      <>
                        Pmax {pct(active.comparison.baseline.ratios.p_max)} · FF {pct(active.comparison.baseline.ratios.fill_factor)} · Rs slope{" "}
                        {pct(active.comparison.baseline.ratios.slope_voc)} · Rsh slope {pct(active.comparison.baseline.ratios.slope_isc)}{" "}
                        <span className="text-slate-500">({active.comparison.baseline.swept_at.slice(0, 16)})</span>
                        {active.comparison.baseline.flags.length > 0 && (
                          <span className="ml-1 font-semibold text-amber-400">{flagText(active.comparison.baseline.flags)}</span>
                        )}
                      </>
                    ) : (
                      <span className="text-slate-500">— no earlier valid sweep</span>
                    )}
                  </div>
                  {(active.iec60891?.procedure_2 || active.iec60891?.site_reference) && (
                    <div className="num text-slate-400">
                      {active.iec60891.procedure_2 && (
                        <>
                          Procedure 2 cross-check ({active.iec60891.procedure_2.coefficients === "assumed" ? "assumed" : "fleet module"} coefficients): {fmt(active.iec60891.procedure_2.p_max_stc_w, 0)} W (
                          {fmt(active.iec60891.procedure_2.diff_vs_procedure_1_pct, 1)}% vs Procedure 1)
                        </>
                      )}
                      {active.iec60891.procedure_2 && active.iec60891.site_reference ? " · " : ""}
                      {active.iec60891.site_reference && (
                        <>
                          Pmax at 1000 W/m², {fmt(active.iec60891.site_reference.t_c, 0)} °C: {fmt(active.iec60891.site_reference.parameters.p_max_w, 0)} W
                        </>
                      )}
                    </div>
                  )}
                  {(active.iec60891?.procedure_4 || active.iec60891?.procedure_dynamic) && (
                    <div className="num text-slate-400">
                      {active.iec60891.procedure_4 && (
                        <>
                          Procedure 4 cross-check (default ε): {fmt(active.iec60891.procedure_4.p_max_stc_w, 0)} W (
                          {fmt(active.iec60891.procedure_4.diff_vs_procedure_1_pct, 1)}% vs Procedure 1)
                        </>
                      )}
                      {active.iec60891.procedure_4 && active.iec60891.procedure_dynamic ? " · " : ""}
                      {active.iec60891.procedure_dynamic && (
                        <>
                          Dynamic procedure: {fmt(active.iec60891.procedure_dynamic.p_max_stc_w, 0)} W (
                          {fmt(active.iec60891.procedure_dynamic.diff_vs_procedure_1_pct, 1)}% vs Procedure 1;{" "}
                          {active.iec60891.procedure_dynamic.shunt_neglected
                            ? "shunt current negligible"
                            : `Rsh ${fmt(active.iec60891.procedure_dynamic.r_sh_ohm, 0)} Ω from this curve`}
                          )
                        </>
                      )}
                    </div>
                  )}
                  {(active.classification?.equivalent_cell_temp || active.classification?.forward_reverse) && (
                    <div className="num text-slate-400">
                      {active.classification.equivalent_cell_temp && (
                        <span title="Worked out from Voc and the datasheet; right only when the string's Voc is healthy. Not used for the translation.">
                          Cell temperature from Voc (modelled): {fmt(active.classification.equivalent_cell_temp.t_c, 1)} °C (
                          {active.classification.equivalent_cell_temp.diff_vs_measured_k > 0 ? "+" : ""}
                          {fmt(active.classification.equivalent_cell_temp.diff_vs_measured_k, 1)} K vs measured)
                        </span>
                      )}
                      {active.classification.equivalent_cell_temp && active.classification.forward_reverse ? " · " : ""}
                      {active.classification.forward_reverse && (
                        <>
                          Opposite sweep Pmax {fmt(active.classification.forward_reverse.reverse_pmax_w, 0)} W: differs by{" "}
                          {fmt(active.classification.forward_reverse.diff_pct, 1)}%
                        </>
                      )}
                    </div>
                  )}
                  {active.classification?.uncertainty && (
                    <div
                      className="num text-slate-400"
                      title={active.classification.uncertainty.components
                        .map((c) => `${UNCERTAINTY_TEXT[c.name] ?? c.name} ±${fmt(c.pct, 1)}% (${c.source === "input" ? "given" : c.source === "procedure_spread" ? "spread between procedures" : "assumed"})`)
                        .join(" · ")}
                    >
                      Estimated uncertainty of STC Pmax: at least ±{fmt(active.classification.uncertainty.expanded_pct, 1)}% (k = 2;
                      tracer accuracy and repeatability not included)
                    </div>
                  )}
                  <div className="text-[10px] text-slate-500">Peer and baseline flag levels are proposed defaults, not from a standard; they do not open tickets.</div>
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
                    <div className={`num font-bold ${stepsCount > 0 ? "text-amber-400" : "text-emerald-400"}`}>
                      {stepsCount}
                    </div>
                  </div>
                </div>
              )}

              {spec && <PanelChart spec={spec} height={340} legendToggle />}

              <div className="space-y-1.5 rounded-lg border border-white/[0.06] bg-ink-950/40 p-3 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="font-semibold text-slate-200">Site coefficients from this string's sweeps (estimate)</div>
                  <Button variant="outline" size="xs" onClick={loadSiteFit} disabled={siteFitBusy}>
                    {siteFitBusy && <Spinner data-icon="inline-start" className="size-3" />}
                    {siteFit ? "Fit again" : "Fit"}
                  </Button>
                </div>
                {siteFitErr && <div className="text-red-400">{siteFitErr}</div>}
                {siteFit && (
                  <div className="num space-y-1 text-slate-300">
                    <div className="text-slate-400">
                      {siteFit.sweeps} of {siteFit.stored_sweeps} stored handheld sweeps used · irradiance span{" "}
                      {fmt(siteFit.irradiance_span_wm2, 0)} W/m² · temperature span {fmt(siteFit.temp_span_k, 1)} K
                    </div>
                    {siteFit.voc && (
                      <div>
                        Voc at STC {fmt(siteFit.voc.voc_stc_per_module_v, 2)} V per module (datasheet {fmt(siteFit.voc.datasheet_voc_stc_v, 2)}) · β{" "}
                        {fmt(siteFit.voc.beta_rel_pct_per_k, 3)} %/K (datasheet {fmt(siteFit.voc.datasheet_beta_rel_pct_per_k, 3)}) · B1{" "}
                        {fmt(siteFit.voc.b1, 3)} · fit error {fmt(siteFit.voc.fit_rms_pct, 2)}%
                      </div>
                    )}
                    {siteFit.resistance && (
                      <div>
                        Rs {fmt(siteFit.resistance.rs_ohm_per_module, 2)} Ω per module · κ {fmt(siteFit.resistance.kappa_ohm_per_k_per_module, 4)} Ω/K per module ·
                        spread of STC Pmax across the sweeps {fmt(siteFit.resistance.pmax_spread_before_pct, 2)}% → {fmt(siteFit.resistance.pmax_spread_after_pct, 2)}%
                      </div>
                    )}
                    {siteFit.procedure_3 && (
                      <div>
                        Procedure 3 ({siteFit.procedure_3.extrapolated ? "extrapolated" : "interpolated"} from the{" "}
                        {fmt(siteFit.procedure_3.from_irradiance_wm2[0], 0)} and {fmt(siteFit.procedure_3.from_irradiance_wm2[1], 0)} W/m² sweeps): Pmax{" "}
                        {fmt(siteFit.procedure_3.p_max_w, 0)} W at 1000 W/m², {fmt(siteFit.procedure_3.t_c, 1)} °C
                      </div>
                    )}
                    {siteFit.reasons.map((r) => (
                      <div key={r} className="text-amber-300/90">{r}</div>
                    ))}
                    <div className="text-[10px] text-slate-500">
                      Fitted when asked, never stored or applied. "—" = these sweeps cannot determine it. Values worth keeping go into the Fleet PV Module setting (admin).
                    </div>
                  </div>
                )}
              </div>
            </div>
          )
        )}
      </div>
    </Panel>
  );
};
