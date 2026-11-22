import React, { useEffect, useMemo, useState } from "react";
import { Radio, RefreshCw, Search, Zap, Gauge, AlertTriangle, Cpu } from "lucide-react";
import { api } from "../api/client";
import type { GrowattInverter } from "../api/client";
import { useAppContext } from "../context/AppContext";
import { OFFLINE_LABEL, inverterStatusLevel } from "../context/PlantContext";
import { PageHeader, Panel, KpiTile, StatusBadge, EmptyState, LoadingState, Suspended, fmt, fmtInt, LOADING_STATUS } from "../components/ui";
import type { StatusLevel } from "../components/ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Spinner } from "@/components/ui/spinner";
import { dateLocale, translate, useI18n } from "../i18n";
import { TablePager, pageBounds } from "../components/TablePager";

/** rows per page of the plant table */
const PLANT_PAGE = 50;

const PLANT_STATUS: Record<number, { label: string; level: StatusLevel }> = {
  1: { label: "Normal", level: "ok" },
  4: { label: "Offline / Fault", level: "crit" },
};

// Status is realtime only (never stored): null means live data is still loading or unavailable.
const plantStatus = (s: number | null): { label: string; level: StatusLevel; loading?: boolean } =>
  s == null
    ? { label: LOADING_STATUS, level: "neutral", loading: true }
    : PLANT_STATUS[s] ?? { label: translate("Status {n}", { n: s }), level: "warn" };

const inverterLevel = (inv: GrowattInverter): StatusLevel =>
  inv.lost ? "crit" : inverterStatusLevel(inv.status);

const sumKnown = (vals: Array<number | null>, div = 1): number | null => {
  const known = vals.filter((v): v is number => v != null);
  return known.length ? known.reduce((a, v) => a + v, 0) / div : null;
};

const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString(dateLocale(), { hour: "2-digit", minute: "2-digit" });

const liveLabel = (s: { fetchedAt: string | null; stale: boolean; error: string | null; loading: boolean }) =>
  s.loading
    ? translate("Loading live data…")
    : !s.fetchedAt
    ? translate("Live data unavailable — power and status not shown.")
    : s.stale
    ? translate("Live data stale (last {time}).", { time: fmtTime(s.fetchedAt) })
    : `${translate("Live")} · ${fmtTime(s.fetchedAt)}.`;

export const GrowattFleetPage: React.FC = () => {
  const { t } = useI18n();
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

  // PLANT_PAGE plants at a time; back to page 1 when the search changes
  const [page, setPage] = useState(0);
  useEffect(() => setPage(0), [query]);
  const { pageNo } = pageBounds(filtered.length, PLANT_PAGE, page);
  const pagePlants = filtered.slice(pageNo * PLANT_PAGE, (pageNo + 1) * PLANT_PAGE);

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
        title={t("Growatt Fleet")}
        description={`${t("Plant registry and history from the app database; power and status overlaid live from Growatt (memory cache, not stored).")} ${liveLabel(growattLiveStatus)}`}
        actions={
          <Button variant="ghost" size="sm" onClick={() => loadPlants()} disabled={loading}>
            {loading ? <Spinner data-icon="inline-start" className="size-3" /> : <RefreshCw data-icon="inline-start" />} {t("Refresh")}
          </Button>
        }
      />

      {error && (
        <Panel>
          <EmptyState icon={AlertTriangle} title={t("Could not load Growatt plants")} description={error} />
        </Panel>
      )}

      {!plants && !error && <LoadingState label={t("Loading plants…")} shape="table" />}

      {plants && (
        <Suspended busy={loading} label={t("Loading plants…")} contentClassName="space-y-6">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <KpiTile label={t("Plants")} value={fmtInt(totals.count)} icon={Radio} tone="solar"
              hint={totals.abnormal ? t("{n} not normal", { n: totals.abnormal }) : totals.unknown ? t("{n} status unknown", { n: totals.unknown }) : t("All normal")}
              hintTone={totals.abnormal ? "crit" : totals.unknown ? "warn" : "ok"} />
            <KpiTile label={t("Installed capacity")} value={fmt(totals.kwp / 1000, 2)} unit="MWp" icon={Gauge} tone="info" />
            <KpiTile label={t("Current power")} value={fmt(totals.kw, 0)} unit="kW" icon={Zap} tone="energy" />
            <KpiTile label={t("Lifetime energy")} value={fmt(totals.mwh, 0)} unit="MWh" icon={Zap} tone="ok" />
          </div>

          <div className="grid gap-6 xl:grid-cols-5">
            <Panel
              className="xl:col-span-3"
              title={t("Plants")}
              subtitle={t("{n} of {total}", { n: filtered.length, total: plants.length })}
              bodyClassName="p-0"
              actions={
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
                  <Input className="h-7 px-2 pl-7 text-[11px]" placeholder={t("Search name, city, ID")} value={query} onChange={(e) => setQuery(e.target.value)} />
                </div>
              }
            >
              <Table containerClassName="scroll-x-hint max-h-[640px] overflow-auto">
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("Plant")}</TableHead>
                      <TableHead className="text-right">kWp</TableHead>
                      <TableHead className="text-right">{t("Power kW")}</TableHead>
                      <TableHead className="text-right">{t("Load %")}</TableHead>
                      <TableHead>{t("Status")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pagePlants.map((p) => {
                      const st = plantStatus(p.status);
                      const kw = p.current_power_w == null ? null : p.current_power_w / 1000;
                      const load = kw != null && p.peak_power_kwp ? (kw / p.peak_power_kwp) * 100 : null;
                      return (
                        <TableRow
                          key={p.plant_id}
                          onClick={() => setSelectedId(p.plant_id)}
                          className={`cursor-pointer ${p.plant_id === selectedId ? "bg-solar-500/10" : ""}`}
                        >
                          <TableCell>
                            <div className="font-medium text-slate-200">{p.name}</div>
                            <div className="text-[11px] text-slate-500">{p.plant_id} · {p.city || "—"}</div>
                          </TableCell>
                          <TableCell className="num whitespace-nowrap text-right">{fmt(p.peak_power_kwp, 1)}</TableCell>
                          <TableCell className="num whitespace-nowrap text-right">{fmt(kw, 1)}</TableCell>
                          <TableCell className="num whitespace-nowrap text-right">{load == null ? "—" : fmt(load, 0)}</TableCell>
                          <TableCell><StatusBadge status={st.label} level={st.level} loading={st.loading} /></TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
              </Table>
              {filtered.length > 0 && <TablePager className="border-t border-white/[0.06] px-4 py-2.5" rows={filtered.length} pageSize={PLANT_PAGE} pageNo={pageNo} onPage={setPage} />}
            </Panel>

            <Panel
              className="xl:col-span-2"
              icon={Cpu}
              title={selected ? selected.name : t("Inverters")}
              subtitle={
                selected
                  ? `${t("Plant {id}", { id: selected.plant_id })}${inverters ? ` · ${t("{n} inverters", { n: inverters.length })}` : ""} · ${
                      liveInvAt ? `${t("Live")} ${fmtTime(liveInvAt)}` : invLoading ? t("Loading live status…") : t("Live status unavailable")
                    }`
                  : t("Select a plant")
              }
              bodyClassName="p-0"
              actions={
                selected && (
                  <Button variant="ghost" size="icon-sm" onClick={() => loadInverters(selected.plant_id)} disabled={invLoading} aria-label={t("Refresh inverters")}>
                    {invLoading ? <Spinner className="size-3.5" /> : <RefreshCw className="size-3.5" />}
                  </Button>
                )
              }
            >
              {!selected && <EmptyState icon={Cpu} title={t("No plant selected")} description={t("Click a plant to list its inverters.")} />}
              {selected && invLoading && !inverters && <div className="p-4"><LoadingState label={t("Fetching inverters…")} shape="table" /></div>}
              {selected && invError && <EmptyState icon={AlertTriangle} title={t("Could not load inverters")} description={invError} />}
              {selected && inverters && (
                <Suspended busy={invLoading} label={t("Fetching inverters…")} pill={false}>
                <Table containerClassName="scroll-x-hint max-h-[640px] overflow-auto">
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t("Serial")}</TableHead>
                        <TableHead>{t("Status")}</TableHead>
                        <TableHead>{t("Last update")}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {inverters.map((inv) => (
                        <TableRow key={inv.device_sn}>
                          <TableCell>
                            <div className="num font-medium text-slate-200">{inv.device_sn}</div>
                            <div className="text-[11px] text-slate-500" title={inv.model}>
                              {inv.device_types.join("/").toUpperCase()} · {t("logger {sn}", { sn: inv.datalogger_sn })}
                            </div>
                          </TableCell>
                          <TableCell>
                            <StatusBadge
                              status={inv.lost ? OFFLINE_LABEL : inv.status_label ?? LOADING_STATUS}
                              level={inverterLevel(inv)}
                              loading={!inv.lost && inv.status_label == null}
                            />
                          </TableCell>
                          <TableCell className="num whitespace-nowrap text-[11px] text-slate-400">{inv.last_update_time ?? "—"}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                </Table>
                </Suspended>
              )}
            </Panel>
          </div>
        </Suspended>
      )}
    </div>
  );
};

export default GrowattFleetPage;
