/**
 * Operations → Faults (`/faults`, everyone, scoped to the user's plants): the field-fault register,
 * one physical or service problem on one plant, from the moment it is found to the day the plant
 * works again. DB only; dates, serials and positions as entered or scanned; restore time computed
 * from the fault's own times; no money. Pieces in `pages/faults/`; docs/plans/defects.md.
 *
 * URL: `tab` (open | restored | closed | all), `q`, `kind`, `sev`, `plant`, `wait` (us | them),
 * `due` (follow-up overdue), `sort`, `desc`, `fault` (detail dialog open), and `new=1` (+ `p` =
 * plant) for the Record fault dialog.
 */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { MoreHorizontal, Plus } from "lucide-react";
import type { Fault, FaultKind, FaultSeverity, FaultStatus, FaultTab } from "../api/client";
import { notify } from "../lib/notify";
import { useAppContext } from "../context/AppContext";
import { useI18n } from "../i18n";
import { plantToday } from "../context/alarmLogStore";
import { pick, useUrlState } from "@/lib/useUrlState";
import { cn } from "@/lib/utils";
import { SkeletonRows, Suspended, fmtInt } from "../components/ui";
import { TablePager, pageBounds } from "../components/TablePager";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { FAULT_LIMIT, faultsApi, useFaults } from "./faults/useFaults";
import { FaultTable, SORT_KEYS } from "./faults/FaultTable";
import type { SortKey } from "./faults/FaultTable";
import { FaultDetail } from "./faults/FaultDetail";
import { DecisionDialog, EditDialog, NoteDialog, StatusDialog } from "./faults/dialogs";
import { RecordDialog } from "./faults/RecordDialog";
import { CAUSE, DECISION, HOW_FOUND, KIND, KIND_KEYS, SEVERITY, SEVERITY_KEYS, STATUS, SUB_KIND, canDecide, canMove, downloadCsv, positionText } from "./faults/format";

const TABS = ["open", "restored", "closed", "all"] as const;
const ALL = "all";
const PAGER_H = 52;
const BOTTOM_GAP = 24;
const SEV_RANK: Record<FaultSeverity, number> = { S1: 0, S2: 1, S3: 2, S4: 3 };

const Stat: React.FC<{ label: string; value: number | null; tone?: string; active?: boolean; onClick?: () => void; title?: string }> = ({ label, value, tone, active, onClick, title }) => (
  <button
    type="button"
    onClick={onClick}
    title={title}
    disabled={!onClick}
    className={cn("flex flex-col gap-1 px-5 py-4 text-left transition-colors enabled:hover:bg-muted", active && "bg-muted")}
  >
    <span className="eyebrow">{label}</span>
    <span className={cn("num text-3xl font-bold tracking-tight", value ? tone : "text-muted-foreground")}>{value == null ? "—" : fmtInt(value)}</span>
  </button>
);

/** the search text sent to the API once typing pauses */
function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

export const FaultsPage: React.FC = () => {
  const { growattPlants } = useAppContext();
  const { t } = useI18n();
  const [url, setUrl] = useUrlState();
  const tab = pick(url.get("tab"), TABS, "open") as FaultTab;
  const query = url.get("q") ?? "";
  const kind = pick(url.get("kind"), [ALL, ...KIND_KEYS] as const, ALL);
  const sev = pick(url.get("sev"), [ALL, ...SEVERITY_KEYS] as const, ALL);
  const plantParam = /^\d+$/.test(url.get("plant") ?? "") ? Number(url.get("plant")) : null;
  const wait = pick(url.get("wait"), [ALL, "us", "them"] as const, ALL);
  const due = url.get("due") === "1";
  const sort = pick(url.get("sort"), SORT_KEYS, "found");
  // newest found first unless the person flips it
  const desc = url.get("desc") == null ? sort === "found" : url.get("desc") === "1";
  const faultId = /^\d+$/.test(url.get("fault") ?? "") ? Number(url.get("fault")) : null;
  const creating = url.get("new") != null;
  const newPlant = /^\d+$/.test(url.get("p") ?? "") ? Number(url.get("p")) : null;

  const q = useDebounced(query, 300);
  const apiQuery = useMemo(
    () => ({
      tab,
      kind: kind === ALL ? undefined : (kind as FaultKind),
      severity: sev === ALL ? undefined : (sev as FaultSeverity),
      plant_id: plantParam ?? undefined,
      waiting: wait === ALL ? undefined : wait,
      overdue: due || undefined,
      q: q.trim() || undefined,
    }),
    [tab, kind, sev, plantParam, wait, due, q]
  );
  const { data, loading, refreshing, error, reload } = useFaults(apiQuery);
  const [version, setVersion] = useState(0);
  const changed = useCallback(() => {
    setVersion((v) => v + 1);
    void reload();
  }, [reload]);

  const today = data?.meta.today ?? plantToday();
  const plantNames = useMemo(() => new Map(growattPlants.map((p) => [p.plant_id, p.name])), [growattPlants]);
  const plantName = useCallback((id: number) => plantNames.get(id) ?? t("Plant {id}", { id }), [plantNames, t]);
  const plants = useMemo(() => [...growattPlants].sort((a, b) => a.name.localeCompare(b.name)), [growattPlants]);

  // dialogs: the fault they act on (a list row or the open detail)
  const [statusOf, setStatusOf] = useState<{ fault: Fault; to: FaultStatus | null } | null>(null);
  const [decideOf, setDecideOf] = useState<Fault | null>(null);
  const [noteOf, setNoteOf] = useState<Fault | null>(null);
  const [editOf, setEditOf] = useState<Fault | null>(null);
  const [current, setCurrent] = useState<Fault | null>(null);

  // ---- sorting (the API filters)
  const all = useMemo(() => data?.faults ?? [], [data]);
  const rows = useMemo(() => {
    const cmp = (a: Fault, b: Fault): number => {
      switch (sort) {
        case "no":
          return a.no.localeCompare(b.no, undefined, { numeric: true });
        case "severity":
          return SEV_RANK[a.severity] - SEV_RANK[b.severity] || (a.found_at ?? "").localeCompare(b.found_at ?? "");
        case "next":
          // follow-up overdue first, then by next action day (none last)
          return Number(b.followup_overdue) - Number(a.followup_overdue) || (a.next_action_day ?? "9999").localeCompare(b.next_action_day ?? "9999");
        case "found":
          return (a.found_at ?? "").localeCompare(b.found_at ?? "") || a.id - b.id;
      }
    };
    return [...all].sort((a, b) => (desc ? -cmp(a, b) : cmp(a, b)));
  }, [all, sort, desc]);

  // ---- the table ends at the bottom of the screen (as on Claims)
  const tableRef = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState<{ height: number; pageSize: number }>({ height: 480, pageSize: 10 });
  const [page, setPage] = useState(0);
  const firstRead = loading && !data;
  useLayoutEffect(() => {
    const measure = () => {
      const el = tableRef.current;
      if (!el) return;
      const top = el.getBoundingClientRect().top + window.scrollY;
      const height = Math.max(300, window.innerHeight - top - PAGER_H - BOTTOM_GAP);
      const headH = el.querySelector("thead")?.getBoundingClientRect().height || 36;
      const rowH = el.querySelector("tbody tr")?.getBoundingClientRect().height || 52;
      const pageSize = Math.max(5, Math.floor((height - headH) / rowH));
      setFit((f) => (f.height === height && f.pageSize === pageSize ? f : { height, pageSize }));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [rows.length > 0, firstRead]);
  useEffect(() => setPage(0), [tab, q, kind, sev, plantParam, wait, due, sort, desc]);
  const { pageNo } = pageBounds(rows.length, fit.pageSize, page);
  const shown = rows.slice(pageNo * fit.pageSize, (pageNo + 1) * fit.pageSize);

  // ---- actions
  const open = (f: Fault | number) => setUrl({ fault: typeof f === "number" ? f : f.id, new: null, p: null });

  const actions = (f: Fault) => (
    <div className="inline-flex items-center gap-1">
      <Button size="xs" variant="outline" onClick={() => setStatusOf({ fault: f, to: null })}>
        {t("Status")}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="icon-xs" variant="ghost" aria-label={t("More for {name}", { name: f.no })}>
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem onSelect={() => open(f)}>{t("Open fault")}</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setStatusOf({ fault: f, to: null })}>{t("Change status")}</DropdownMenuItem>
          {canDecide(f.status) && <DropdownMenuItem onSelect={() => setDecideOf(f)}>{t("Decide")}</DropdownMenuItem>}
          <DropdownMenuItem onSelect={() => setNoteOf(f)}>{t("Add note")}</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setEditOf(f)}>{t("Edit")}</DropdownMenuItem>
          {canMove(f.status, "open") && <DropdownMenuItem onSelect={() => setStatusOf({ fault: f, to: "open" })}>{t("Reopen")}</DropdownMenuItem>}
          {canMove(f.status, "cancelled") && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => setStatusOf({ fault: f, to: "cancelled" })}>
                {t("Cancel fault")}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );

  // the rows shown (every filtered row the page holds, all pages); English, as every CSV
  const exportCsv = () =>
    downloadCsv(
      `faults-${tab}-${today}.csv`,
      [
        "no",
        "plant",
        "plant_id",
        "kind",
        "sub_kind",
        "device",
        "serial",
        "serial_input",
        "position",
        "severity",
        "status",
        "waiting_reason",
        "waiting_on",
        "decision",
        "decision_reason",
        "how_found",
        "cause",
        "symptom",
        "found_at",
        "found_by",
        "age_days",
        "next_action_day",
        "followup_overdue",
        "owner",
        "restored_at",
        "restore_hours",
        "closed_at",
        "reference",
        "evidence_urls",
      ],
      rows.map((f) => [
        f.no,
        f.plant_name ?? plantName(f.plant_id),
        f.plant_id,
        KIND[f.kind],
        f.sub_kind ? SUB_KIND[f.sub_kind] : null,
        f.device_label ?? f.inverter_sn,
        f.serial,
        f.serial_input,
        positionText(f.position),
        f.severity,
        STATUS[f.status].label,
        f.waiting_reason,
        f.waiting_on,
        f.decision ? DECISION[f.decision] : null,
        f.decision_reason,
        HOW_FOUND[f.how_found],
        f.cause ? CAUSE[f.cause] : null,
        f.symptom,
        f.found_at,
        f.found_by,
        f.age_days,
        f.next_action_day,
        f.followup_overdue ? "yes" : "",
        f.owner ? f.owner.full_name || f.owner.username : null,
        f.restored_at,
        f.restore_hours,
        f.closed_at,
        f.reference,
        f.evidence_urls.join(" "),
      ])
    );

  const s = data?.summary;
  const anyFilter = query.trim() !== "" || kind !== ALL || sev !== ALL || plantParam != null || wait !== ALL || due;
  const clearFilters = () => setUrl({ q: null, kind: null, sev: null, plant: null, wait: null, due: null });
  // a summary count sets its filter on the Open tab (a second click clears it)
  const pickStat = (patch: { sev?: string | null; wait?: string | null; due?: boolean | null }, active: boolean) =>
    setUrl(active ? { sev: null, wait: null, due: null } : { tab: null, sev: null, wait: null, due: null, ...patch });
  const isPlainOpen = tab === "open" && sev === ALL && wait === ALL && !due;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col">
          <h1 className="text-lg font-semibold">{t("Faults")}</h1>
          <p className="text-xs text-muted-foreground">{t("Field faults: what is broken on each plant, since when, what was decided and what it is waiting for")}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void reload()} disabled={loading}>
            {loading && <Spinner data-icon="inline-start" className="size-3" />}
            {loading ? t("Refreshing…") : t("Refresh")}
          </Button>
          <Button size="sm" onClick={() => setUrl({ new: 1, p: plantParam, fault: null })}>
            <Plus data-icon="inline-start" />
            {t("Record fault")}
          </Button>
        </div>
      </div>

      {error && !data && (
        <Alert variant="destructive">
          <AlertTitle>{t("Could not load the faults")}</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Card className="py-0">
        <CardContent className="grid grid-cols-2 divide-white/[0.06] px-0 sm:grid-cols-3 lg:grid-cols-5 lg:divide-x">
          <Stat label={t("Open")} value={s?.open ?? null} tone="text-foreground" active={isPlainOpen} onClick={() => setUrl({ tab: null, sev: null, wait: null, due: null })} />
          <Stat label={t("S1 open")} value={s?.s1_open ?? null} tone="text-red-300" active={tab === "open" && sev === "S1"} onClick={() => pickStat({ sev: "S1" }, tab === "open" && sev === "S1")} title={t("Safety faults still open")} />
          <Stat
            label={t("Waiting on us")}
            value={s?.waiting_us ?? null}
            tone="text-amber-300"
            active={wait === "us"}
            onClick={() => pickStat({ wait: "us" }, wait === "us")}
            title={t("Open, diagnosed, scheduled, or waiting for a part / site access")}
          />
          <Stat
            label={t("Waiting on others")}
            value={s?.waiting_them ?? null}
            tone="text-sky-300"
            active={wait === "them"}
            onClick={() => pickStat({ wait: "them" }, wait === "them")}
            title={t("Waiting for a claim, the supplier or the carrier")}
          />
          <Stat
            label={t("Follow-up overdue")}
            value={s?.followup_overdue ?? null}
            tone="text-red-300"
            active={due}
            onClick={() => pickStat({ due: true }, due)}
            title={t("The next action day entered has passed")}
          />
        </CardContent>
      </Card>

      <Card className="gap-0 py-0">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 pt-2 sm:px-5">
          <Tabs value={tab} onValueChange={(v) => setUrl({ tab: v === "open" ? null : v, ...(v === "open" ? {} : { wait: null, due: null }) })}>
            <TabsList variant="line" className="border-0 p-0">
              <TabsTrigger value="open" className="px-3 py-2.5 text-sm">
                {t("Open")} <span className="num text-muted-foreground">{s ? fmtInt(s.open) : "—"}</span>
              </TabsTrigger>
              <TabsTrigger value="restored" className="px-3 py-2.5 text-sm" title={t("Working again, not closed yet")}>
                {t("Restored")} <span className="num text-muted-foreground">{s ? fmtInt(s.restored) : "—"}</span>
              </TabsTrigger>
              <TabsTrigger value="closed" className="px-3 py-2.5 text-sm" title={t("Closed, cancelled or no action")}>
                {t("Closed")}
              </TabsTrigger>
              <TabsTrigger value="all" className="px-3 py-2.5 text-sm">
                {t("All")}
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="flex items-center gap-2 pb-2">
            <Input className="h-8 w-64" placeholder={t("Search no., plant, SN, text")} value={query} onChange={(e) => setUrl({ q: e.target.value })} aria-label={t("Search faults")} />
            <Button variant="outline" size="sm" onClick={exportCsv} disabled={!rows.length}>
              {t("Export CSV")}
            </Button>
          </div>
        </div>

        <CardContent className="flex flex-wrap items-center gap-2 border-b py-3">
          <Select value={kind} onValueChange={(v) => setUrl({ kind: v === ALL ? null : v })}>
            <SelectTrigger size="sm" className="w-48" aria-label={t("Kind")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{t("All kinds")}</SelectItem>
              <SelectSeparator />
              {KIND_KEYS.map((k) => (
                <SelectItem key={k} value={k}>
                  {t(KIND[k])}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={sev} onValueChange={(v) => setUrl({ sev: v === ALL ? null : v })}>
            <SelectTrigger size="sm" className="w-40" aria-label={t("Severity")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{t("All severities")}</SelectItem>
              <SelectSeparator />
              {SEVERITY_KEYS.map((k) => (
                <SelectItem key={k} value={k}>
                  {t(SEVERITY[k].label)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={plantParam != null ? String(plantParam) : ALL} onValueChange={(v) => setUrl({ plant: v === ALL ? null : v })}>
            <SelectTrigger size="sm" className="w-56" aria-label={t("Plant")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{t("All plants")}</SelectItem>
              <SelectSeparator />
              {plants.map((p) => (
                <SelectItem key={p.plant_id} value={String(p.plant_id)}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {wait !== ALL && <span className="text-xs text-muted-foreground">{wait === "us" ? t("Waiting on us") : t("Waiting on others")}</span>}
          {due && <span className="text-xs text-red-300">{t("Follow-up overdue")}</span>}
          {data && data.total > all.length && (
            <span className="text-xs text-amber-300">{t("Showing the first {n} of {total}; narrow the filters", { n: fmtInt(FAULT_LIMIT), total: fmtInt(data.total) })}</span>
          )}
          {anyFilter && (
            <Button variant="ghost" size="sm" onClick={clearFilters} className="ml-auto">
              {t("Clear")}
            </Button>
          )}
        </CardContent>

        <CardContent ref={tableRef} className="overflow-x-auto overflow-y-hidden px-0" style={{ height: fit.height }}>
          <Suspended busy={refreshing} label={t("Loading faults…")} className="h-full" contentClassName="h-full">
            {rows.length === 0 ? (
              firstRead ? (
                <SkeletonRows rows={8} className="p-4" />
              ) : (
                <Empty className="h-full">
                  <EmptyHeader>
                    <EmptyTitle>{!data ? t("Faults unavailable") : anyFilter ? t("No matching faults") : tab === "open" ? t("No open faults") : t("No faults here")}</EmptyTitle>
                    {!data && error && <EmptyDescription>{error}</EmptyDescription>}
                    {data && !anyFilter && tab === "open" && <EmptyDescription>{t("Record one with “Record fault” when something is found broken on a plant.")}</EmptyDescription>}
                  </EmptyHeader>
                </Empty>
              )
            ) : (
              <FaultTable
                rows={shown}
                sort={sort}
                desc={desc}
                onSort={(k: SortKey) => setUrl({ sort: k === "found" ? null : k, desc: k === sort ? (!desc ? 1 : 0) : null })}
                today={today}
                plantName={plantName}
                onOpen={open}
                actions={actions}
              />
            )}
          </Suspended>
        </CardContent>
        <CardContent className="border-t py-2.5">
          <TablePager rows={rows.length} pageSize={fit.pageSize} pageNo={pageNo} onPage={setPage} />
        </CardContent>
      </Card>

      <FaultDetail
        id={faultId}
        version={version}
        today={today}
        plantName={plantName}
        onClose={() => {
          setUrl({ fault: null });
          setCurrent(null);
        }}
        onLoaded={setCurrent}
        actions={{
          status: (to) => current && setStatusOf({ fault: current, to: to ?? null }),
          decide: () => current && setDecideOf(current),
          edit: () => current && setEditOf(current),
          note: () => current && setNoteOf(current),
          unlink: async (linkId) => {
            if (!current) return;
            try {
              await faultsApi.deleteFaultLink(current.id, linkId);
              changed();
            } catch (e) {
              notify("crit", t("Could not unlink: {error}", { error: e instanceof Error ? e.message : String(e) }));
            }
          },
        }}
      />
      <RecordDialog
        open={creating}
        plantId={newPlant}
        onClose={() => setUrl({ new: null, p: null })}
        onSaved={(f) => {
          changed();
          notify("ok", t("{no} recorded", { no: f.no }));
          setUrl({ new: null, p: null, fault: f.id });
        }}
        onOpenExisting={(id) => setUrl({ new: null, p: null, fault: id })}
      />
      <StatusDialog fault={statusOf?.fault ?? null} to={statusOf?.to ?? null} onClose={() => setStatusOf(null)} onDone={changed} />
      <DecisionDialog fault={decideOf} onClose={() => setDecideOf(null)} onDone={changed} />
      <NoteDialog fault={noteOf} onClose={() => setNoteOf(null)} onDone={changed} />
      <EditDialog fault={editOf} onClose={() => setEditOf(null)} onDone={changed} />
    </div>
  );
};

export default FaultsPage;
