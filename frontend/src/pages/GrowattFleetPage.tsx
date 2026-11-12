import React, { useEffect, useMemo, useState } from "react";
import { Radio, RefreshCw, Search, Zap, Gauge, AlertTriangle, Cpu } from "lucide-react";
import { api } from "../api/client";
import type { GrowattInverter } from "../api/client";
import { useAppContext } from "../context/AppContext";
import { PageHeader, Panel, KpiTile, StatusBadge, EmptyState, LoadingState, fmt, fmtInt, LOADING_STATUS } from "../components/ui";
import type { StatusLevel } from "../components/ui";

const PLANT_STATUS: Record<number, { label: string; level: StatusLevel }> = {
  1: { label: "Normal", level: "ok" },
  4: { label: "Offline / Fault", level: "crit" },
};

// Status is realtime only (never stored): null means live data is still loading or unavailable.
const plantStatus = (s: number | null): { label: string; level: StatusLevel; loading?: boolean } =>
  s == null
    ? { label: LOADING_STATUS, level: "neutral", loading: true }
    : PLANT_STATUS[s] ?? { label: `Status ${s}`, level: "warn" };

const inverterLevel = (inv: GrowattInverter): StatusLevel =>
  inv.lost || inv.status === 0 ? "crit" : inv.status === 1 ? "ok" : inv.status == null ? "neutral" : "warn";

const sumKnown = (vals: Array<number | null>, div = 1): number | null => {
  const known = vals.filter((v): v is number => v != null);
  return known.length ? known.reduce((a, v) => a + v, 0) / div : null;
};

const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

const liveLabel = (s: { fetchedAt: string | null; stale: boolean; error: string | null; loading: boolean }) =>
  s.loading
    ? "Loading live data…"
    : !s.fetchedAt
    ? "Live data unavailable — power and status not shown."
    : s.stale
    ? `Live data stale (last ${fmtTime(s.fetchedAt)}).`
    : `Live · ${fmtTime(s.fetchedAt)}.`;

export const GrowattFleetPage: React.FC = () => {
  // DB registry with realtime overlay, both owned by AppContext
  const { growattPlants, refreshGrowattPlants, growattLiveStatus } = useAppContext();
  const plants = growattPlants.length ? growattPlants : null;
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [liveInvAt, setLiveInvAt] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [inverters, setInverters] = useState<GrowattInverter[] | null>(null);
  const [invLoading, setInvLoading] = useState(false);
  const [invError, setInvError] = useState<string | null>(null);

  const loadPlants = async () => {
    setLoading(true);
    setError(null);
    try {
      await refreshGrowattPlants(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  // Registry from the DB, then overlay realtime status from the backend memory cache.
  const loadInverters = async (plantId: number) => {
    setInvLoading(true);
    setInvError(null);
    setLiveInvAt(null);
    try {
      const dbList = await api.listGrowattInverters(plantId);
      setInverters(dbList);
      try {
        const live = await api.getGrowattLiveInverters(plantId);
        const bySn = new Map(live.data.map((i) => [i.device_sn, i]));
        setInverters(dbList.map((i) => ({ ...i, ...(bySn.get(i.device_sn) ?? {}) })));
        setLiveInvAt(live.stale ? null : live.fetched_at);
      } catch {
        // live unavailable: status stays unknown (realtime values are never stored)
      }
    } catch (e) {
      setInverters(null);
      setInvError(e instanceof Error ? e.message : String(e));
    } finally {
      setInvLoading(false);
    }
  };

  useEffect(() => {
    if (selectedId != null) loadInverters(selectedId);
  }, [selectedId]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = plants ?? [];
    return q ? list.filter((p) => `${p.name} ${p.city ?? ""} ${p.plant_id}`.toLowerCase().includes(q)) : list;
  }, [plants, query]);

  const totals = useMemo(() => {
    const list = plants ?? [];
    return {
      count: list.length,
      kwp: list.reduce((a, p) => a + (p.peak_power_kwp ?? 0), 0),
      // realtime values: null ("—") until live data has arrived for at least one plant
      kw: sumKnown(list.map((p) => p.current_power_w), 1000),
      mwh: sumKnown(list.map((p) => p.total_energy_kwh), 1000),
      abnormal: list.filter((p) => p.status != null && p.status !== 1).length,
      unknown: list.filter((p) => p.status == null).length,
    };
  }, [plants]);

  const selected = plants?.find((p) => p.plant_id === selectedId) ?? null;

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Radio}
        eyebrow="Growatt OpenAPI v1"
        title="Growatt Fleet"
        description={`Plant registry and history from the app database; power and status overlaid live from Growatt (memory cache, not stored). ${liveLabel(growattLiveStatus)}`}
        actions={
          <button className="btn-ghost btn-sm" onClick={() => loadPlants()} disabled={loading}>
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
          </button>
        }
      />

      {error && (
        <Panel>
          <EmptyState icon={AlertTriangle} title="Could not load Growatt plants" description={error} />
        </Panel>
      )}

      {!plants && !error && <LoadingState label="Loading plants…" />}

      {plants && (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <KpiTile label="Plants" value={fmtInt(totals.count)} icon={Radio} tone="solar"
              hint={totals.abnormal ? `${totals.abnormal} not normal` : totals.unknown ? `${totals.unknown} status unknown` : "All normal"}
              hintTone={totals.abnormal ? "crit" : totals.unknown ? "warn" : "ok"} />
            <KpiTile label="Installed capacity" value={fmt(totals.kwp / 1000, 2)} unit="MWp" icon={Gauge} tone="info" />
            <KpiTile label="Current power" value={fmt(totals.kw, 0)} unit="kW" icon={Zap} tone="energy" />
            <KpiTile label="Lifetime energy" value={fmt(totals.mwh, 0)} unit="MWh" icon={Zap} tone="ok" />
          </div>

          <div className="grid gap-6 xl:grid-cols-5">
            <Panel
              className="xl:col-span-3"
              title="Plants"
              subtitle={`${filtered.length} of ${plants.length}`}
              bodyClassName="p-0"
              actions={
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
                  <input className="input-sm pl-7" placeholder="Search name, city, ID" value={query} onChange={(e) => setQuery(e.target.value)} />
                </div>
              }
            >
              <div className="max-h-[640px] overflow-auto">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Plant</th>
                      <th className="text-right">kWp</th>
                      <th className="text-right">Power kW</th>
                      <th className="text-right">Load %</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((p) => {
                      const st = plantStatus(p.status);
                      const kw = p.current_power_w == null ? null : p.current_power_w / 1000;
                      const load = kw != null && p.peak_power_kwp ? (kw / p.peak_power_kwp) * 100 : null;
                      return (
                        <tr
                          key={p.plant_id}
                          onClick={() => setSelectedId(p.plant_id)}
                          className={`cursor-pointer ${p.plant_id === selectedId ? "bg-solar-500/10" : ""}`}
                        >
                          <td>
                            <div className="font-medium text-slate-200">{p.name}</div>
                            <div className="text-[11px] text-slate-500">{p.plant_id} · {p.city || "—"}</div>
                          </td>
                          <td className="num text-right">{fmt(p.peak_power_kwp, 1)}</td>
                          <td className="num text-right">{fmt(kw, 1)}</td>
                          <td className="num text-right">{load == null ? "—" : fmt(load, 0)}</td>
                          <td><StatusBadge status={st.label} level={st.level} loading={st.loading} /></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Panel>

            <Panel
              className="xl:col-span-2"
              icon={Cpu}
              title={selected ? selected.name : "Inverters"}
              subtitle={
                selected
                  ? `Plant ${selected.plant_id}${inverters ? ` · ${inverters.length} inverters` : ""} · ${
                      liveInvAt ? `Live ${fmtTime(liveInvAt)}` : invLoading ? "Loading live status…" : "Live status unavailable"
                    }`
                  : "Select a plant"
              }
              bodyClassName="p-0"
              actions={
                selected && (
                  <button className="btn-ghost btn-sm" onClick={() => loadInverters(selected.plant_id)} disabled={invLoading}>
                    <RefreshCw className={`h-3.5 w-3.5 ${invLoading ? "animate-spin" : ""}`} />
                  </button>
                )
              }
            >
              {!selected && <EmptyState icon={Cpu} title="No plant selected" description="Click a plant to list its inverters." />}
              {selected && invLoading && !inverters && <div className="p-4"><LoadingState label="Fetching inverters…" /></div>}
              {selected && invError && <EmptyState icon={AlertTriangle} title="Could not load inverters" description={invError} />}
              {selected && inverters && (
                <div className="max-h-[640px] overflow-auto">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Serial</th>
                        <th>Status</th>
                        <th>Last update</th>
                      </tr>
                    </thead>
                    <tbody>
                      {inverters.map((inv) => (
                        <tr key={inv.device_sn}>
                          <td>
                            <div className="num font-medium text-slate-200">{inv.device_sn}</div>
                            <div className="text-[11px] text-slate-500" title={inv.model}>
                              {inv.device_types.join("/").toUpperCase()} · logger {inv.datalogger_sn}
                            </div>
                          </td>
                          <td>
                            <StatusBadge
                              status={inv.lost ? "Lost" : inv.status_label ?? LOADING_STATUS}
                              level={inverterLevel(inv)}
                              loading={!inv.lost && inv.status_label == null}
                            />
                          </td>
                          <td className="num text-[11px] text-slate-400">{inv.last_update_time ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>
          </div>
        </>
      )}
    </div>
  );
};

export default GrowattFleetPage;
