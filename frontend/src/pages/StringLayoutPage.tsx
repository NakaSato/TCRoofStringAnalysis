import React, { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Cpu,
  Grid3x3,
  RotateCcw,
  Save,
} from "lucide-react";
import { useAppContext } from "../context/AppContext";
import { api } from "../api/client";
import type { FleetModuleOut, GrowattStringLayout, GrowattStringLayoutEntry } from "../api/client";
import { SelectedPlantBanner } from "../components/SelectedPlantBanner";
import { EmptyState, LoadingState, fmt } from "../components/ui";

/** `wp` blank = the fleet module's rating (global setting), so a fleet change applies everywhere. */
type Draft = { modules: string; wp: string };
type Filter = "all" | "incomplete" | "mismatch";
const keyOf = (sn: string, no: number) => `${sn}|${no}`;
const toInt = (v: string) => (/^\d+$/.test(v.trim()) ? Number(v) : null);
const toNum = (v: string) => (v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const strLabel = (no: number) => `STR-${String(no).padStart(2, "0")}`;

const draftFrom = (l: GrowattStringLayout) => {
  const d: Record<string, Draft> = {};
  for (const inv of l.inverters)
    for (const s of inv.strings)
      d[keyOf(inv.device_sn, s.string_no)] = {
        modules: s.modules != null ? String(s.modules) : "",
        wp: s.module_wp != null ? String(s.module_wp) : "",
      };
  return d;
};

/**
 * Plant view tab: as-built modules per string (and module Wp) for the selected Growatt plant.
 * Growatt does not report module counts; once every active string of an inverter has one, the
 * backend compares strings per module / per kWp so a short string is not flagged as a fault.
 */
export const StringLayoutPage: React.FC = () => {
  const { selectedGrowattPlantId, user, refreshAll } = useAppContext();
  // admins: any plant; engineers: the list only holds their assigned plants (the backend checks too)
  const canEdit = user?.role === "admin" || user?.role === "engineer";

  const [fleetModule, setFleetModule] = useState<FleetModuleOut | null>(null);
  const [layout, setLayout] = useState<GrowattStringLayout | null>(null);
  const [baseline, setBaseline] = useState<Record<string, Draft>>({});
  const [draft, setDraft] = useState<Record<string, Draft>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "crit"; text: string } | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  useEffect(() => {
    api.getFleetModule().then(setFleetModule).catch(() => {});
  }, []);

  useEffect(() => {
    setMsg(null);
    setLayout(null);
    setFilter("all");
    setCollapsed(new Set());
    if (selectedGrowattPlantId == null) return;
    setLoading(true);
    api
      .getGrowattStringLayout(selectedGrowattPlantId)
      .then((l) => {
        const d = draftFrom(l);
        setLayout(l);
        setBaseline(d);
        setDraft(d);
      })
      .catch((e) => setMsg({ tone: "crit", text: `Failed to load string layout: ${e.message}` }))
      .finally(() => setLoading(false));
  }, [selectedGrowattPlantId]);

  const fleetWp = fleetModule?.wp ?? layout?.fleet_module_wp ?? null;
  const set = (k: string, field: keyof Draft, value: string) =>
    setDraft((d) => ({ ...d, [k]: { ...(d[k] ?? { modules: "", wp: "" }), [field]: value } }));
  const isDirty = (k: string) => {
    const a = draft[k] ?? { modules: "", wp: "" };
    const b = baseline[k] ?? { modules: "", wp: "" };
    return a.modules.trim() !== b.modules.trim() || a.wp.trim() !== b.wp.trim();
  };

  // per-inverter view model
  const invs = useMemo(
    () =>
      (layout?.inverters ?? []).map((inv) => {
        const rows = inv.strings.map((s) => {
          const k = keyOf(inv.device_sn, s.string_no);
          const d = draft[k] ?? { modules: "", wp: "" };
          const m = toInt(d.modules);
          const wp = toNum(d.wp) ?? fleetWp;
          return { s, k, d, m, kwp: m != null && wp != null ? (m * wp) / 1000 : null, invalid: d.modules.trim() !== "" && m == null };
        });
        // strings in parallel on one MPPT share its voltage, so unequal lengths there lose energy
        const mismatch = new Set(
          rows
            .filter((r) => r.m != null && rows.some((o) => o !== r && o.s.mppt_no === r.s.mppt_no && o.m != null && o.m !== r.m))
            .map((r) => r.s.mppt_no)
        );
        const mppts = new Map<number, typeof rows>();
        for (const r of rows) mppts.set(r.s.mppt_no, [...(mppts.get(r.s.mppt_no) ?? []), r]);
        const active = rows.filter((r) => r.s.active);
        return {
          inv,
          rows,
          mppts: [...mppts.entries()].sort((a, b) => a[0] - b[0]),
          mismatch,
          filled: rows.filter((r) => r.m != null).length,
          complete: active.length > 0 && active.every((r) => r.m != null),
          kwp: rows.reduce((t, r) => t + (r.kwp ?? 0), 0),
          dirty: rows.filter((r) => isDirty(r.k)).length,
        };
      }),
    [layout, draft, baseline, fleetWp]
  );

  const totals = useMemo(() => {
    const strings = invs.reduce((t, i) => t + i.rows.length, 0);
    const filled = invs.reduce((t, i) => t + i.filled, 0);
    return {
      strings,
      filled,
      complete: invs.filter((i) => i.complete).length,
      kwp: invs.reduce((t, i) => t + i.kwp, 0),
      mismatchInv: invs.filter((i) => i.mismatch.size > 0).length,
      dirty: invs.reduce((t, i) => t + i.dirty, 0),
      invalid: invs.reduce((t, i) => t + i.rows.filter((r) => r.invalid).length, 0),
    };
  }, [invs]);

  const shown = invs.filter((i) =>
    filter === "incomplete" ? !i.complete : filter === "mismatch" ? i.mismatch.size > 0 : true
  );

  // warn before leaving the page with unsaved edits
  useEffect(() => {
    if (!totals.dirty) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [totals.dirty]);

  const save = async () => {
    if (!layout || selectedGrowattPlantId == null) return;
    const entries: GrowattStringLayoutEntry[] = [];
    for (const inv of layout.inverters)
      for (const s of inv.strings) {
        const d = draft[keyOf(inv.device_sn, s.string_no)];
        const m = toInt(d?.modules ?? "");
        if (m == null) continue;
        entries.push({ device_sn: inv.device_sn, string_no: s.string_no, modules: m, module_wp: toNum(d?.wp ?? "") });
      }
    setSaving(true);
    setMsg(null);
    try {
      const saved = await api.putGrowattStringLayout(selectedGrowattPlantId, entries);
      const d = draftFrom(saved);
      setLayout(saved);
      setBaseline(d);
      setDraft(d);
      await refreshAll();
      const p = saved.published;
      const where = p?.sink === "firestore" ? "Firestore" : p?.sink ?? "the summary sink";
      setMsg(
        p?.error
          ? { tone: "crit", text: `Saved ${entries.length} string module counts. Publishing to ${where} failed (${p.error}); the next publish job retries.` }
          : p?.deferred
          ? { tone: "ok", text: `Saved ${entries.length} string module counts. Today's write budget is used up; inverters publish on the next quota day.` }
          : { tone: "ok", text: `Saved ${entries.length} string module counts and published ${p?.written ?? 0} inverter doc(s) to ${where}. Diagnostics recalculated.` }
      );
    } catch (e: any) {
      setMsg({ tone: "crit", text: `Save failed: ${e.message}` });
    } finally {
      setSaving(false);
    }
  };

  const toggle = (sn: string) =>
    setCollapsed((c) => {
      const n = new Set(c);
      if (n.has(sn)) n.delete(sn);
      else n.add(sn);
      return n;
    });

  if (selectedGrowattPlantId == null) {
    return (
      <div className="space-y-6">
        <SelectedPlantBanner />
        <EmptyState icon={Grid3x3} title="Select a Growatt plant" description="Pick a plant in the fleet view first." />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <SelectedPlantBanner />

      {loading || (!layout && !msg) ? (
        <LoadingState label="Loading string layout…" />
      ) : !layout ? (
        msg && <div className="callout-crit">{msg.text}</div>
      ) : (
        <>
          {msg && (
            <div className={`${msg.tone === "ok" ? "callout-ok" : "callout-crit"} flex items-center gap-2`}>
              {msg.tone === "ok" ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : <AlertTriangle className="h-4 w-4 shrink-0" />}
              <span>{msg.text}</span>
            </div>
          )}

          {/* Sticky action bar: filters, save */}
          <div className="sticky top-2 z-20 flex flex-wrap items-center gap-2 rounded-xl border border-white/[0.08] bg-ink-900/95 px-4 py-2.5 text-xs shadow-lg backdrop-blur">
            <div className="flex rounded-lg border border-white/[0.08] p-0.5">
              {(
                [
                  ["all", `All (${invs.length})`],
                  ["incomplete", `Incomplete (${invs.length - totals.complete})`],
                  ["mismatch", `MPPT mismatch (${totals.mismatchInv})`],
                ] as [Filter, string][]
              ).map(([f, label]) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setFilter(f)}
                  className={`rounded-md px-2.5 py-1 font-semibold transition ${
                    filter === f ? "bg-sky-500/20 text-sky-200" : "text-slate-400 hover:text-slate-200"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            <div className="ml-auto flex items-center gap-2">
              {totals.invalid > 0 && (
                <span className="text-red-300">{totals.invalid} invalid value{totals.invalid > 1 ? "s" : ""}</span>
              )}
              {totals.dirty > 0 ? (
                <span className="text-amber-300">
                  {totals.dirty} unsaved change{totals.dirty > 1 ? "s" : ""}
                </span>
              ) : (
                <span className="text-slate-500">All changes saved</span>
              )}
              {canEdit ? (
                <>
                  <button
                    type="button"
                    className="btn-ghost btn-sm"
                    onClick={() => setDraft(baseline)}
                    disabled={!totals.dirty || saving}
                  >
                    <RotateCcw className="h-3.5 w-3.5" /> Discard
                  </button>
                  <button
                    type="button"
                    className="btn-primary btn-sm"
                    onClick={save}
                    disabled={!totals.dirty || saving || totals.invalid > 0}
                  >
                    <Save className="h-3.5 w-3.5" />
                    {saving ? "Saving…" : "Save layout"}
                  </button>
                </>
              ) : (
                <span className="text-slate-500">Read only</span>
              )}
            </div>
          </div>

          {invs.length === 0 && <EmptyState icon={Cpu} title="This plant has no inverters in the registry" />}
          {invs.length > 0 && shown.length === 0 && (
            <EmptyState icon={CheckCircle2} title="Nothing to show" description="No inverter matches this filter." />
          )}

          {/* Inverter cards, strings laid out by MPPT */}
          <div className="space-y-4">
            {shown.map(({ inv, rows, mppts, mismatch, filled, complete, kwp, dirty }) => {
              const open = !collapsed.has(inv.device_sn);
              return (
                <section key={inv.device_sn} className="panel overflow-hidden">
                  <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-white/[0.06] px-4 py-3 text-xs">
                    <button
                      type="button"
                      onClick={() => toggle(inv.device_sn)}
                      className="flex items-center gap-2 text-left"
                      aria-expanded={open}
                    >
                      <ChevronDown className={`h-4 w-4 text-slate-500 transition ${open ? "" : "-rotate-90"}`} />
                      <span className="num text-sm font-bold text-white">{inv.device_sn}</span>
                      <span className="num text-slate-500">{inv.model}</span>
                    </button>
                    <span className={complete ? "badge badge-ok" : "badge badge-warn"}>
                      {complete ? "Compared per module" : "Raw comparison"}
                    </span>
                    {mismatch.size > 0 && (
                      <span className="badge badge-warn">
                        <AlertTriangle className="h-3 w-3" /> MPPT {[...mismatch].join(", ")} unequal
                      </span>
                    )}
                    {dirty > 0 && <span className="text-amber-300">{dirty} unsaved</span>}
                    <div className="ml-auto flex items-center gap-4">
                      <span className="num text-slate-400">
                        {filled}/{rows.length} set
                      </span>
                      <span className="num font-semibold text-solar-300">{kwp > 0 ? `${fmt(kwp, 2)} kWp` : "— kWp"}</span>
                    </div>
                  </header>

                  {open &&
                    (rows.length === 0 ? (
                      <p className="px-4 py-4 text-xs text-slate-500">No string inputs seen in the last 7 days.</p>
                    ) : (
                      <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                        {mppts.map(([mppt, slots]) => (
                          <div
                            key={mppt}
                            className={`rounded-lg border p-2.5 ${
                              mismatch.has(mppt) ? "border-amber-400/40 bg-amber-400/[0.03]" : "border-white/[0.06]"
                            }`}
                          >
                            <div className="mb-2 flex items-center justify-between text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                              <span className="num">MPPT {mppt}</span>
                              {mismatch.has(mppt) && (
                                <span
                                  className="flex items-center gap-1 normal-case text-amber-300"
                                  title="Strings on one MPPT share its voltage, so the longer string runs off its maximum power point."
                                >
                                  <AlertTriangle className="h-3 w-3" /> unequal
                                </span>
                              )}
                            </div>
                            <div className="space-y-2">
                              {slots.map(({ s, k, d, kwp: skwp, invalid }) => {
                                const changed = isDirty(k);
                                return (
                                  <div
                                    key={k}
                                    className={`rounded-md border px-2.5 py-2 ${
                                      invalid
                                        ? "border-red-500/50 bg-red-500/[0.05]"
                                        : changed
                                        ? "border-sky-400/40 bg-sky-500/[0.06]"
                                        : "border-white/[0.05] bg-ink-950/40"
                                    } ${s.active ? "" : "opacity-60"}`}
                                  >
                                    <div className="mb-1.5 flex items-center justify-between">
                                      <span className="num text-xs font-bold text-solar-300">{strLabel(s.string_no)}</span>
                                      <span className="num text-[11px] text-slate-500">
                                        {s.active ? (skwp != null ? `${fmt(skwp, 2)} kWp` : "not set") : "no current (7 d)"}
                                      </span>
                                    </div>
                                    <div className="flex items-center gap-2">
                                      <label className="flex flex-1 items-center gap-1.5">
                                        <input
                                          className="input input-sm num w-full min-w-0"
                                          inputMode="numeric"
                                          placeholder="—"
                                          aria-label={`${inv.device_sn} ${strLabel(s.string_no)} modules`}
                                          value={d.modules}
                                          disabled={!canEdit}
                                          onChange={(e) => set(k, "modules", e.target.value)}
                                        />
                                        <span className="text-[11px] text-slate-500">mod</span>
                                      </label>
                                      <span className="text-slate-500">×</span>
                                      <label className="flex flex-1 items-center gap-1.5">
                                        <input
                                          className="input input-sm num w-full min-w-0"
                                          inputMode="decimal"
                                          aria-label={`${inv.device_sn} ${strLabel(s.string_no)} module Wp`}
                                          placeholder={fleetWp != null ? String(fleetWp) : "Wp"}
                                          value={d.wp}
                                          disabled={!canEdit}
                                          onChange={(e) => set(k, "wp", e.target.value)}
                                        />
                                        <span className="text-[11px] text-slate-500">Wp</span>
                                      </label>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        ))}
                      </div>
                    ))}
                </section>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
};
