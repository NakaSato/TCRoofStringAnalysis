import React, { useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Cpu,
  Gauge,
  Search,
  Zap,
  SlidersHorizontal,
  ArrowUpRight,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
} from "lucide-react";
import { pick, useUrlState } from "@/lib/useUrlState";
import { useAppContext } from "../context/AppContext";
import { api } from "../api/client";
import type { GrowattStringDetail } from "../api/client";
import { PanelChart } from "../components/PanelChart";
import type { PanelChartSpec } from "../components/PanelChart";
import { SERIES, STATUS } from "../components/chartTheme";
import { ivPvSpecFrom, stringProfileSpecFrom } from "../components/ivPvSpec";
import {
  Panel,
  KpiTile,
  StatusBadge,
  Led,
  Meter,
  EmptyState,
  LoadingState,
  statusLevel,
  fmt,
} from "../components/ui";
import { SelectedPlantBanner } from "../components/SelectedPlantBanner";
import { StringStatusMatrix } from "../components/StringStatusMatrix";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TablePager, pageBounds } from "../components/TablePager";

const STATUS_FILTERS = ["ALL", "Healthy", "Warning", "Critical"] as const;
const PAGE_SIZES = [25, 50, 100] as const;

type StringRow = NonNullable<ReturnType<typeof useAppContext>["selectedPlantOverview"]>["strings"][number];
const STATUS_RANK: Record<StringRow["status"], number> = { Healthy: 0, Warning: 1, Critical: 2 };
const byText = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
const byPosition = (a: StringRow, b: StringRow) => byText(a.device_sn, b.device_sn) || a.string_no - b.string_no;

/** Sortable table columns (`?sort=&desc=`); ties fall back to inverter + string order. */
const TABLE_SORTS = [
  // first click: worst first
  { key: "status", label: "Status", firstDesc: true, cmp: (a: StringRow, b: StringRow) => STATUS_RANK[a.status] - STATUS_RANK[b.status] },
  { key: "string", label: "String ID", firstDesc: false, cmp: (a: StringRow, b: StringRow) => a.string_no - b.string_no },
  { key: "inverter", label: "Inverter SN", firstDesc: false, cmp: (a: StringRow, b: StringRow) => byText(a.device_sn, b.device_sn) },
  { key: "mppt", label: "MPPT", firstDesc: false, cmp: (a: StringRow, b: StringRow) => a.mppt_no - b.mppt_no },
] as const;
type TableSortKey = (typeof TABLE_SORTS)[number]["key"];
const TABLE_SORT_KEYS = TABLE_SORTS.map((c) => c.key);

export const StringAnalysisPage: React.FC = () => {
  const {
    selectedGrowattPlantId,
    selectedPlantOverview,
    plantOverviewLoading,
    setInspectedStringId,
  } = useAppContext();

  // filters and the analysed string live in the URL (?inv=&status=&q=&string=)
  const [query, setQuery] = useUrlState();
  const selectedInverterSn = query.get("inv") ?? "ALL";
  const setSelectedInverterSn = (sn: string) => setQuery({ inv: sn === "ALL" ? null : sn });
  const statusFilter = pick(query.get("status"), STATUS_FILTERS, "ALL");
  const setStatusFilter = (st: (typeof STATUS_FILTERS)[number]) => setQuery({ status: st === "ALL" ? null : st });
  const searchQuery = query.get("q") ?? "";
  const setSearchQuery = (q: string) => setQuery({ q });
  const activeStringKey = query.get("string");
  const setActiveStringKey = (id: string | null) => setQuery({ string: id });
  const [stringDetail, setStringDetail] = useState<GrowattStringDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState<boolean>(false);

  const plant = selectedPlantOverview?.plant;
  const kpis = selectedPlantOverview?.kpis;
  const inverters = selectedPlantOverview?.inverters || [];
  const strings = selectedPlantOverview?.strings || [];
  const anomalies = selectedPlantOverview?.anomalies || [];

  // (switching plant drops the query, so the filters start over by themselves)

  const filteredStrings = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return strings.filter((s) => {
      if (selectedInverterSn !== "ALL" && s.device_sn !== selectedInverterSn) return false;
      if (statusFilter !== "ALL" && s.status !== statusFilter) return false;
      if (q && !`${s.string_id} ${s.mppt_id} ${s.diagnosis}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [strings, selectedInverterSn, statusFilter, searchQuery]);

  // Table order only (charts and the string picker keep the backend order)
  const sortParam = query.get("sort");
  const tableSort: TableSortKey | null = sortParam ? pick(sortParam, TABLE_SORT_KEYS, "status") : null;
  const tableDesc = query.get("desc") === "1";
  const toggleTableSort = (k: TableSortKey) => {
    // first click: the column's natural direction; second flips it; third back to the default order
    const firstDesc = TABLE_SORTS.find((c) => c.key === k)!.firstDesc;
    if (tableSort !== k) setQuery({ sort: k, desc: firstDesc ? "1" : null });
    else if (tableDesc === firstDesc) setQuery({ desc: tableDesc ? null : "1" });
    else setQuery({ sort: null, desc: null });
  };
  const tableStrings = useMemo(() => {
    const col = TABLE_SORTS.find((c) => c.key === tableSort);
    if (!col) return filteredStrings;
    return [...filteredStrings].sort((a, b) => (tableDesc ? -col.cmp(a, b) : col.cmp(a, b)) || byPosition(a, b));
  }, [filteredStrings, tableSort, tableDesc]);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<number>(PAGE_SIZES[0]);
  // back to the first page when the filters, the sort or the page size change
  useEffect(() => setPage(0), [selectedInverterSn, statusFilter, searchQuery, tableSort, tableDesc, pageSize]);
  const { pageNo } = pageBounds(tableStrings.length, pageSize, page);
  const pageStrings = tableStrings.slice(pageNo * pageSize, (pageNo + 1) * pageSize);

  // Default active string for the I-V / P-V Curve Analyzer (pick an anomaly or first string)
  const activeString = useMemo(() => {
    if (activeStringKey) {
      const found = strings.find((s) => s.string_id === activeStringKey);
      if (found) return found;
    }
    const pool = filteredStrings.length > 0 ? filteredStrings : strings;
    return (
      pool.find((s) => s.status === "Warning" || s.status === "Critical") ||
      pool[0] ||
      null
    );
  }, [activeStringKey, filteredStrings, strings]);

  // Fetch real I-V / P-V curve and 5-minute string telemetry when activeString changes
  useEffect(() => {
    if (!selectedGrowattPlantId || !activeString) {
      setStringDetail(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    api
      .getGrowattStringDetail(
        selectedGrowattPlantId,
        activeString.device_sn,
        activeString.string_no
      )
      .then((res) => {
        if (!cancelled) setStringDetail(res);
      })
      .catch(() => {
        if (!cancelled) setStringDetail(null);
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedGrowattPlantId, activeString?.device_sn, activeString?.string_no]);

  // 1. I-V curve above P-V curve, sharing the voltage axis (curves are modelled; dots are measured)
  const ivPvSpec = useMemo<PanelChartSpec | null>(() => {
    if (!stringDetail) return null;
    return ivPvSpecFrom(stringDetail.iv_pv_curve);
  }, [stringDetail]);

  // 2. 5-minute string current (vs peer average) above MPPT voltage
  const stringTimeseriesSpec = useMemo<PanelChartSpec | null>(
    () => (stringDetail ? stringProfileSpecFrom(stringDetail) : null),
    [stringDetail]
  );

  // 3. Peer-relative string PR (status-coloured) above peak current
  const peerBarSpec = useMemo<PanelChartSpec | null>(() => {
    const sub = filteredStrings.slice(0, 40);
    if (sub.length === 0) return null;
    return {
      xKind: "band",
      x: sub.map((s) => s.string_id),
      xTickLabel: (id) => sub.find((s) => s.string_id === id)?.short_label ?? String(id),
      legend: [
        { label: "Healthy", color: STATUS.good, shape: "bar" },
        { label: "Warning", color: STATUS.warn, shape: "bar" },
        { label: "Critical", color: STATUS.crit, shape: "bar" },
        { label: "Peak current", color: SERIES.secondary, shape: "line" },
      ],
      tipExtra: (i) => [{ label: "Diagnosis", value: sub[i].diagnosis }],
      panels: [
        {
          key: "pr",
          title: "Peer-relative PR (%) · modelled",
          weight: 1.5,
          yMin: 0,
          yMax: 105,
          tickSuffix: "%",
          series: [
            {
              key: "pr",
              name: "String PR",
              type: "bar",
              color: STATUS.good,
              y: sub.map((s) => s.pr_pct),
              colors: sub.map((s) => (s.status === "Critical" ? STATUS.crit : s.status === "Warning" ? STATUS.warn : STATUS.good)),
              format: (v) => `${fmt(v, 1)}%`,
            },
          ],
        },
        {
          key: "imax",
          title: "Peak current (A)",
          series: [
            { key: "imax", name: "Peak current", type: "line", color: SERIES.secondary, y: sub.map((s) => s.i_max), format: (v) => `${fmt(v, 2)} A` },
          ],
        },
      ],
    };
  }, [filteredStrings]);

  if (plantOverviewLoading && !selectedPlantOverview) {
    return (
      <div className="space-y-6">
        <SelectedPlantBanner />
        <LoadingState label="Analyzing string voltage, current & I-V / P-V curves for selected plant…" shape="page" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <SelectedPlantBanner />

      {/* String Health Summary KPIs */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiTile
          label="Monitored Strings"
          value={String(kpis?.string_count || strings.length)}
          unit="strings"
          icon={Cpu}
          tone="info"
          hint={`Across ${inverters.length} Growatt MAX inverters`}
        />
        <KpiTile
          label="Healthy Strings"
          value={String(kpis?.healthy_strings || 0)}
          unit={`/ ${kpis?.string_count || strings.length}`}
          icon={CheckCircle2}
          tone="ok"
          hint="Operating within nominal MPPT peer envelope"
          hintTone="ok"
        />
        <KpiTile
          label="Warning / Mismatch"
          value={String(kpis?.warning_strings || 0)}
          unit="strings"
          icon={AlertTriangle}
          tone="warn"
          hint="Current or voltage deviation vs. MPPT peer"
          hintTone={Number(kpis?.warning_strings || 0) > 0 ? "warn" : "ok"}
        />
        <KpiTile
          label="Critical String Faults"
          value={String(kpis?.critical_strings || 0)}
          unit="strings"
          icon={Zap}
          tone="crit"
          hint={`Avg String Health ${fmt(kpis?.avg_health_score, 1)} / 100`}
          hintTone={Number(kpis?.critical_strings || 0) > 0 ? "crit" : "ok"}
        />
      </div>

      {/* Inverter & Status Filter Bar */}
      <Card className="gap-0 px-5 py-3.5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-300">
              <SlidersHorizontal className="h-3.5 w-3.5 text-sky-400" />
              Inverter:
            </span>
            <button
              onClick={() => setSelectedInverterSn("ALL")}
              className={`rounded-lg px-2.5 py-1 text-xs font-semibold transition ${
                selectedInverterSn === "ALL"
                  ? "bg-sky-500/20 text-sky-200 ring-1 ring-sky-400/40"
                  : "bg-white/[0.04] text-slate-400 hover:text-white"
              }`}
            >
              All ({inverters.length})
            </button>
            {inverters.map((inv) => (
              <button
                key={inv.device_sn}
                onClick={() => setSelectedInverterSn(inv.device_sn)}
                className={`num rounded-lg px-2.5 py-1 text-xs font-semibold transition ${
                  selectedInverterSn === inv.device_sn
                    ? "bg-sky-500/20 text-sky-200 ring-1 ring-sky-400/40"
                    : "bg-white/[0.04] text-slate-400 hover:text-white"
                }`}
              >
                {inv.device_sn} ({inv.string_count})
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {(["ALL", "Healthy", "Warning", "Critical"] as const).map((st) => (
              <button
                key={st}
                onClick={() => setStatusFilter(st)}
                className={`rounded-lg px-2.5 py-1 text-xs font-semibold transition ${
                  statusFilter === st
                    ? "bg-solar-400/20 text-solar-300 ring-1 ring-solar-400/40"
                    : "bg-white/[0.04] text-slate-400 hover:text-white"
                }`}
              >
                {st}
              </button>
            ))}
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
              <Input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search STR / MPPT…"
                className="h-7 w-40 px-2 pl-8 text-[11px]"
              />
            </div>
          </div>
        </div>
      </Card>

      {/* ==================================================================== */}
      {/* INTERACTIVE I-V / P-V CURVE ANALYZER & 5-MINUTE TELEMETRY            */}
      {/* ==================================================================== */}
      {activeString && (
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-12">
          <Panel
            className="xl:col-span-6"
            icon={Gauge}
            title={`I-V & P-V Curve — ${activeString.string_id}`}
            subtitle={`5-minute Growatt telemetry (${activeString.mppt_id} · ${activeString.status})`}
            actions={
              <div className="flex items-center gap-1.5">
                <Select value={activeString.string_id} onValueChange={(v) => setActiveStringKey(v)}>
                  <SelectTrigger size="sm" className="w-44 text-[11px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {filteredStrings.map((s) => (
                      <SelectItem key={s.string_id} value={s.string_id}>
                        {s.string_id} ({fmt(s.pr_pct, 1)}%)
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  onClick={() => setInspectedStringId(activeString.string_id)}
                  variant="ghost"
                  size="sm"
                  className="text-sky-400"
                >
                  Drawer <ArrowUpRight className="h-3.5 w-3.5" />
                </Button>
              </div>
            }
          >
            {detailLoading ? (
              <LoadingState label={`Synthesizing I-V & P-V curves for ${activeString.string_id}…`} shape="chart" />
            ) : (
              <div className="space-y-3">
                <PanelChart spec={ivPvSpec} height={360} />
                {stringDetail && (
                  <div className="grid grid-cols-4 gap-2 rounded-lg border border-white/[0.06] bg-ink-950/60 p-3 text-center text-xs">
                    <div>
                      <div className="text-[11px] uppercase text-slate-500">V_mpp / V_oc</div>
                      <div className="num font-bold text-amber-300">
                        {fmt(stringDetail.summary.v_mpp, 1)} / {fmt(stringDetail.summary.v_oc_est, 1)} V
                      </div>
                    </div>
                    <div>
                      <div className="text-[11px] uppercase text-slate-500">I_mpp / I_sc</div>
                      <div className="num font-bold text-energy-300">
                        {fmt(stringDetail.summary.i_mpp, 2)} / {fmt(stringDetail.summary.i_sc_est, 2)} A
                      </div>
                    </div>
                    <div>
                      <div className="text-[11px] uppercase text-slate-500">Peak Power (MPP)</div>
                      <div className="num font-bold text-emerald-300">
                        {fmt(stringDetail.summary.p_max_w, 0)} W
                      </div>
                    </div>
                    <div>
                      <div className="text-[11px] uppercase text-slate-500">String PR</div>
                      <div className="num font-bold text-white">
                        {fmt(stringDetail.summary.pr_pct, 1)}%
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </Panel>

          <Panel
            className="xl:col-span-6"
            icon={Activity}
            title={`5-Minute String Current & Voltage Profile — ${activeString.string_id}`}
            subtitle={`Comparison against peer strings on inverter ${activeString.device_sn}`}
          >
            {detailLoading ? (
              <LoadingState label="Loading 5-minute string time series…" shape="chart" />
            ) : (
              <div className="space-y-3">
                <PanelChart spec={stringTimeseriesSpec} height={360} />
                <div className="rounded-lg border border-white/[0.06] bg-ink-950/60 px-3.5 py-2.5 text-xs text-slate-300">
                  <span className="font-semibold text-white">Automated Diagnosis: </span>
                  <span>{activeString.diagnosis}</span>
                </div>
              </div>
            )}
          </Panel>
        </div>
      )}

      {/* String tiles by inverter / MPPT (moved from Plant Overview) */}
      <StringStatusMatrix />

      {/* Peer String Comparison Bar Chart */}
      <Panel
        icon={Activity}
        title={`Peer String Performance Ratio & Peak Current Comparison (${filteredStrings.length} Strings)`}
        subtitle={`Showing strings for ${
          selectedInverterSn === "ALL" ? plant?.name || "All Inverters" : `Inverter ${selectedInverterSn}`
        }`}
      >
        <PanelChart spec={peerBarSpec} height={380} />
      </Panel>

      {/* Full String Diagnostics Table */}
      <Panel
        icon={Cpu}
        title={`String-Level Telemetry & Diagnostics Matrix (${filteredStrings.length} Strings)`}
        subtitle="Click any string row to load its I-V / P-V curves in the analyzer above, or click 'Inspect Drawer' for slide-over details"
        bodyClassName="p-0"
      >
        <Table containerClassName="scroll-x-hint">
            <TableHeader>
              <TableRow>
                {TABLE_SORTS.map((c) => {
                  const active = tableSort === c.key;
                  const Arrow = tableDesc ? ArrowDown : ArrowUp;
                  return (
                    <TableHead
                      key={c.key}
                      className="whitespace-nowrap"
                      aria-sort={active ? (tableDesc ? "descending" : "ascending") : undefined}
                    >
                      <button
                        type="button"
                        onClick={() => toggleTableSort(c.key)}
                        title={`Sort by ${c.label}`}
                        className={`inline-flex items-center gap-1 hover:text-slate-100 ${active ? "text-slate-100" : ""}`}
                      >
                        {c.label}
                        {active ? <Arrow className="size-3" /> : <ArrowUpDown className="size-3 opacity-40" />}
                      </button>
                    </TableHead>
                  );
                })}
                <TableHead className="text-right" title="Newest Growatt record (live, not stored)">Now V / I</TableHead>
                <TableHead className="text-right">Avg V (V)</TableHead>
                <TableHead className="text-right">Max V (V)</TableHead>
                <TableHead className="text-right">Avg I (A)</TableHead>
                <TableHead className="text-right">Peak I (A)</TableHead>
                <TableHead className="text-right">Peak P (kW)</TableHead>
                <TableHead className="text-right">Energy (kWh)</TableHead>
                <TableHead className="text-right">I Mismatch (%)</TableHead>
                <TableHead className="text-right">PR (%)</TableHead>
                <TableHead>Automated Diagnosis</TableHead>
                <TableHead className="text-right">I-V Curve</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pageStrings.map((s) => {
                const isSelected = activeString?.string_id === s.string_id;
                const lvl = statusLevel(s.status);
                return (
                  <TableRow
                    key={s.string_id}
                    onClick={() => setActiveStringKey(s.string_id)}
                    className={`cursor-pointer transition ${
                      isSelected ? "bg-sky-500/15" : "hover:bg-white/[0.03]"
                    }`}
                  >
                    <TableCell>
                      <StatusBadge status={s.status} level={lvl} dot />
                    </TableCell>
                    <TableCell className="num whitespace-nowrap font-bold text-white hover:text-sky-300">
                      {s.short_label}
                    </TableCell>
                    <TableCell className="num whitespace-nowrap text-xs text-slate-300">{s.device_sn}</TableCell>
                    <TableCell className="num whitespace-nowrap text-xs text-slate-400">{s.mppt_id}</TableCell>
                    <TableCell
                      className="num whitespace-nowrap text-right text-sky-300"
                      title={s.live_at ? `Live record ${s.live_at}` : "No live value"}
                    >
                      {s.live_current_a == null ? "—" : `${fmt(s.live_voltage_v, 0)} / ${fmt(s.live_current_a, 2)}`}
                    </TableCell>
                    <TableCell className="num whitespace-nowrap text-right text-amber-300">{fmt(s.v_avg, 1)}</TableCell>
                    <TableCell className="num whitespace-nowrap text-right text-slate-300">{fmt(s.v_max, 1)}</TableCell>
                    <TableCell className="num whitespace-nowrap text-right text-energy-300">{fmt(s.i_avg, 2)}</TableCell>
                    <TableCell className="num whitespace-nowrap text-right font-semibold text-energy-300">
                      {fmt(s.i_max, 2)}
                    </TableCell>
                    <TableCell className="num whitespace-nowrap text-right text-slate-200">{fmt(s.p_max_w / 1000, 2)}</TableCell>
                    <TableCell className="num whitespace-nowrap text-right font-semibold text-solar-300">
                      {fmt(s.actual_energy_kwh, 2)}
                    </TableCell>
                    <TableCell
                      className={`num whitespace-nowrap text-right font-semibold ${
                        s.current_mismatch_pct == null
                          ? "text-slate-400"
                          : s.current_mismatch_pct < -12
                          ? "text-red-400"
                          : s.current_mismatch_pct < -6
                          ? "text-amber-400"
                          : "text-emerald-400"
                      }`}
                    >
                      {s.current_mismatch_pct != null && s.current_mismatch_pct >= 0 ? "+" : ""}
                      {fmt(s.current_mismatch_pct, 1)}%
                    </TableCell>
                    <TableCell className="num whitespace-nowrap text-right font-bold text-white">{fmt(s.pr_pct, 1)}%</TableCell>
                    <TableCell className="max-w-xs truncate text-xs text-slate-400" title={s.diagnosis}>
                      {s.diagnosis}
                    </TableCell>
                    <TableCell className="text-right">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setInspectedStringId(s.string_id);
                        }}
                        className="rounded border border-sky-400/30 bg-sky-500/10 px-2 py-0.5 text-[11px] font-semibold text-sky-300 hover:bg-sky-500/20"
                      >
                        Inspect Drawer
                      </button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
        </Table>
        <TablePager
          className="border-t border-white/[0.06] px-4 py-2.5"
          rows={tableStrings.length}
          pageSize={pageSize}
          pageNo={pageNo}
          onPage={setPage}
          extra={
            <Select value={String(pageSize)} onValueChange={(v) => setPageSize(Number(v))}>
              <SelectTrigger size="sm" className="w-28 text-[11px]" aria-label="Rows per page">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PAGE_SIZES.map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    {n} per page
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
      </Panel>
    </div>
  );
};
