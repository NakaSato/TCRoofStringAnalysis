import React, { useEffect, useMemo, useState } from "react";
import { Grid3x3, Save, Upload, Download, AlertTriangle } from "lucide-react";
import { useAppContext } from "../context/AppContext";
import { api, FleetModuleOut, GrowattStringLayout, GrowattStringLayoutEntry } from "../api/client";
import { Panel, EmptyState, LoadingState, fmt } from "./ui";

/** `wp` blank = the fleet module's rating (global setting), so a fleet change applies everywhere. */
type Draft = { modules: string; wp: string };
const keyOf = (sn: string, no: number) => `${sn}|${no}`;

/**
 * As-built module count per Growatt string input. Growatt does not report it; once every
 * string of an inverter has a count, the backend compares strings per module / per kWp so a
 * short string (e.g. 16 vs 18 modules) is not flagged as a fault.
 */
export const GrowattStringLayoutPanel: React.FC<{ fleetModule: FleetModuleOut | null }> = ({ fleetModule }) => {
  const { selectedGrowattPlantId, selectedGrowattPlant, user, refreshAll } = useAppContext();
  // admins: any plant; engineers: the list only holds their assigned plants (the backend checks too)
  const canEdit = user?.role === "admin" || user?.role === "engineer";
  const [layout, setLayout] = useState<GrowattStringLayout | null>(null);
  const [draft, setDraft] = useState<Record<string, Draft>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "crit"; text: string } | null>(null);
  const [csv, setCsv] = useState("");
  const [bulkModules, setBulkModules] = useState("");

  const load = (plantId: number) => {
    setLoading(true);
    api
      .getGrowattStringLayout(plantId)
      .then((l) => {
        setLayout(l);
        const d: Record<string, Draft> = {};
        for (const inv of l.inverters)
          for (const s of inv.strings)
            d[keyOf(inv.device_sn, s.string_no)] = {
              modules: s.modules != null ? String(s.modules) : "",
              wp: s.module_wp != null ? String(s.module_wp) : "",
            };
        setDraft(d);
      })
      .catch((e) => setMsg({ tone: "crit", text: `Failed to load string layout: ${e.message}` }))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    setMsg(null);
    setLayout(null);
    if (selectedGrowattPlantId != null) load(selectedGrowattPlantId);
  }, [selectedGrowattPlantId]);

  const set = (k: string, field: keyof Draft, value: string) =>
    setDraft((d) => ({ ...d, [k]: { ...(d[k] ?? { modules: "", wp: "" }), [field]: value } }));

  const fleetWp = fleetModule?.wp ?? layout?.fleet_module_wp ?? null;
  const toInt = (v: string) => (/^\d+$/.test(v.trim()) ? Number(v) : null);
  const toNum = (v: string) => (v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

  const stats = useMemo(() => {
    let total = 0;
    let filled = 0;
    for (const inv of layout?.inverters ?? [])
      for (const s of inv.strings) {
        total += 1;
        if (toInt(draft[keyOf(inv.device_sn, s.string_no)]?.modules ?? "") != null) filled += 1;
      }
    return { total, filled };
  }, [layout, draft]);

  const fillBlanks = () => {
    if (toInt(bulkModules) == null) return;
    setDraft((d) => {
      const next = { ...d };
      for (const [k, v] of Object.entries(d)) if (!v.modules.trim()) next[k] = { ...v, modules: bulkModules.trim() };
      return next;
    });
  };

  const importCsv = () => {
    if (!layout) return;
    const known = new Set(layout.inverters.map((i) => i.device_sn));
    const errors: string[] = [];
    const updates: Record<string, Draft> = {};
    csv
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !/^device_sn/i.test(l))
      .forEach((line, i) => {
        const [sn, no, mods, wp] = line.split(/[,;\t]/).map((c) => c.trim());
        const n = toInt(no ?? "");
        const m = toInt(mods ?? "");
        if (!known.has(sn) || n == null || m == null) {
          errors.push(`line ${i + 1}: "${line}"`);
          return;
        }
        updates[keyOf(sn, n)] = { modules: String(m), wp: wp && toNum(wp) != null ? wp : "" };
      });
    // CSV rows for string inputs not yet seen in history get their own row in the table
    setLayout((l) =>
      l && {
        ...l,
        inverters: l.inverters.map((inv) => {
          const extra = Object.keys(updates)
            .filter((k) => k.startsWith(`${inv.device_sn}|`))
            .map((k) => Number(k.split("|")[1]))
            .filter((no) => !inv.strings.some((s) => s.string_no === no))
            .map((no) => ({ string_no: no, mppt_no: Math.ceil(no / 2), modules: null, module_wp: null, active: false }));
          return { ...inv, strings: [...inv.strings, ...extra].sort((a, b) => a.string_no - b.string_no) };
        }),
      }
    );
    setDraft((d) => ({ ...d, ...updates }));
    setMsg(
      errors.length
        ? { tone: "crit", text: `Imported ${Object.keys(updates).length} rows; skipped ${errors.length}: ${errors.slice(0, 3).join(", ")}` }
        : { tone: "ok", text: `Imported ${Object.keys(updates).length} rows. Review, then Save.` }
    );
  };

  const exportCsv = () => {
    if (!layout) return;
    const lines = ["device_sn,string_no,modules,module_wp"];
    for (const inv of layout.inverters)
      for (const s of inv.strings) {
        const d = draft[keyOf(inv.device_sn, s.string_no)];
        lines.push([inv.device_sn, s.string_no, d?.modules ?? "", d?.modules ? d.wp : ""].join(","));
      }
    const url = URL.createObjectURL(new Blob([lines.join("\n") + "\n"], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `string-layout-${layout.plant_id}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

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
      setLayout(saved);
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

  return (
    <Panel
      icon={Grid3x3}
      title="Growatt String Layout (Modules per String)"
      subtitle={
        <>
          {selectedGrowattPlant?.name ?? "No Growatt plant selected"} · Growatt does not report module counts. When
          every string of an inverter has one, strings are compared per module instead of raw kWh / V.
        </>
      }
      actions={
        layout && (
          <span className="num text-[11px] text-slate-400">
            {stats.filled}/{stats.total} strings set
          </span>
        )
      }
    >
      {selectedGrowattPlantId == null ? (
        <EmptyState icon={Grid3x3} title="Select a Growatt plant" description="Pick a plant in the fleet view first." />
      ) : loading || !layout ? (
        <LoadingState label="Loading string layout…" />
      ) : (
        <div className="space-y-4 text-xs">
          {msg && <div className={msg.tone === "ok" ? "callout-ok" : "callout-crit"}>{msg.text}</div>}

          {canEdit && (
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-2">
                <label className="label">Fill blank strings with</label>
                <div className="flex gap-2">
                  <input
                    className="input input-sm num w-24"
                    placeholder="modules"
                    value={bulkModules}
                    onChange={(e) => setBulkModules(e.target.value)}
                  />
                  <button type="button" className="btn btn-sm" onClick={fillBlanks} disabled={toInt(bulkModules) == null}>
                    Apply to blanks
                  </button>
                </div>
                <p className="text-[11px] text-slate-500">
                  Leave Module Wp blank to use the fleet module
                  {fleetModule ? ` (${fleetModule.manufacturer} ${fleetModule.model}, ${fmt(fleetModule.wp, 0)} Wp)` : ""};
                  enter a value only for strings with a different module.
                </p>
              </div>
              <div className="space-y-2">
                <label className="label">Import CSV (device_sn,string_no,modules[,module_wp])</label>
                <textarea
                  className="input num h-16 w-full"
                  placeholder={"ABC1234567,1,18,570\nABC1234567,2,16,570"}
                  value={csv}
                  onChange={(e) => setCsv(e.target.value)}
                />
                <div className="flex gap-2">
                  <button type="button" className="btn btn-sm" onClick={importCsv} disabled={!csv.trim()}>
                    <Upload className="h-3.5 w-3.5" /> Import
                  </button>
                  <button type="button" className="btn btn-sm" onClick={exportCsv}>
                    <Download className="h-3.5 w-3.5" /> Export CSV
                  </button>
                </div>
              </div>
            </div>
          )}

          {layout.inverters.length === 0 && <EmptyState title="This plant has no inverters in the registry" />}

          <div className="grid gap-4 lg:grid-cols-2">
            {layout.inverters.map((inv) => {
              const rows = inv.strings.map((s) => {
                const d = draft[keyOf(inv.device_sn, s.string_no)] ?? { modules: "", wp: "" };
                return { s, d, m: toInt(d.modules), wp: toNum(d.wp) ?? fleetWp };
              });
              const complete = rows.length > 0 && rows.filter((r) => r.s.active).every((r) => r.m != null);
              // strings in parallel on one MPPT share its voltage, so unequal lengths there lose energy
              const mpptMismatch = new Set(
                rows
                  .filter((r) => r.m != null)
                  .filter((r) => rows.some((o) => o !== r && o.s.mppt_no === r.s.mppt_no && o.m != null && o.m !== r.m))
                  .map((r) => r.s.mppt_no)
              );
              return (
                <div key={inv.device_sn} className="rounded-xl border border-white/[0.07] bg-ink-850/60 p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <div className="num font-semibold text-slate-100">
                      {inv.device_sn} <span className="font-normal text-slate-500">{inv.model}</span>
                    </div>
                    <span className={complete ? "badge-ok" : "badge-warn"}>
                      {complete ? "Compared per module" : "Raw comparison"}
                    </span>
                  </div>
                  {rows.length === 0 ? (
                    <p className="text-slate-500">No string inputs seen in the last 7 days.</p>
                  ) : (
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>String</th>
                          <th>MPPT</th>
                          <th>Modules</th>
                          <th>Module Wp</th>
                          <th className="text-right">kWp</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map(({ s, d, m, wp }) => {
                          const k = keyOf(inv.device_sn, s.string_no);
                          return (
                            <tr key={k} className={s.active ? "" : "opacity-60"}>
                              <td className="num font-bold text-solar-400">
                                STR-{String(s.string_no).padStart(2, "0")}
                                {!s.active && <span className="ml-1 font-normal text-slate-500">(no current)</span>}
                              </td>
                              <td className="num">
                                {s.mppt_no}
                                {mpptMismatch.has(s.mppt_no) && (
                                  <AlertTriangle
                                    className="ml-1 inline h-3 w-3 text-amber-400"
                                    aria-label="Unequal string lengths on one MPPT"
                                  />
                                )}
                              </td>
                              <td>
                                <input
                                  className="input input-sm num w-16"
                                  value={d.modules}
                                  disabled={!canEdit}
                                  onChange={(e) => set(k, "modules", e.target.value)}
                                />
                              </td>
                              <td>
                                <input
                                  className="input input-sm num w-20"
                                  value={d.wp}
                                  placeholder={fleetWp != null ? String(fleetWp) : ""}
                                  disabled={!canEdit}
                                  onChange={(e) => set(k, "wp", e.target.value)}
                                />
                              </td>
                              <td className="num text-right text-slate-300">
                                {fmt(m != null && wp != null ? (m * wp) / 1000 : null, 2)}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                  {mpptMismatch.size > 0 && (
                    <p className="mt-2 text-[11px] text-amber-300">
                      <AlertTriangle className="mr-1 inline h-3 w-3" />
                      Strings on MPPT {[...mpptMismatch].join(", ")} have different lengths. They share one MPPT voltage,
                      so the longer string runs off its maximum power point.
                    </p>
                  )}
                </div>
              );
            })}
          </div>

          {canEdit ? (
            <button type="button" className="btn-primary" onClick={save} disabled={saving}>
              <Save className="h-4 w-4" />
              {saving ? "Saving…" : "Save String Layout"}
            </button>
          ) : (
            <p className="text-[11px] text-slate-500">Viewer accounts can't edit the string layout.</p>
          )}
        </div>
      )}
    </Panel>
  );
};
