/**
 * Operations → Measuring Tools (`/tools`, everyone): the O&M team's measuring instruments (drones,
 * thermal cameras, clamp meters, I-V tracers, …), who holds them and where, and when calibration or
 * drone documents run out. DB only. Engineers check out / in; admins also add, edit, retire and
 * record calibrations / renewals. Pieces in `pages/tools/`; docs/plans/measuring-tools.md.
 *
 * URL: `tab` (register | out | due), `q`, `cat`, `status`, `due`, `show` (retired), `sort`, `desc`,
 * `tool` (detail dialog open).
 */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { MoreHorizontal, Plus } from "lucide-react";
import type { DueKind, DueState, Instrument, InstrumentStatus } from "../api/client";
import { useAppContext } from "../context/AppContext";
import { isAdmin } from "../auth/access";
import { plantToday } from "../context/alarmLogStore";
import { pick, useUrlState } from "@/lib/useUrlState";
import { cn } from "@/lib/utils";
import { SkeletonRows, fmtInt } from "../components/ui";
import { TablePager, pageBounds } from "../components/TablePager";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toolsApi, useInstruments } from "./tools/useInstruments";
import { CheckedOutTable, DueTable, RegisterTable, SORT_KEYS } from "./tools/InstrumentTable";
import type { DueRow, SortKey } from "./tools/InstrumentTable";
import { CheckoutDialog, ConfirmDialog, DueDialog, InstrumentDialog, ReturnDialog } from "./tools/dialogs";
import { InstrumentDetail } from "./tools/InstrumentDetail";
import { CATEGORIES, CATEGORY_KEYS, DUE_KIND, DUE_RANK, DUE_STATE, DUE_STATE_KEYS, STATUS, STATUS_KEYS, categoryOf, downloadCsv, keySpec, whereText } from "./tools/format";

const TABS = ["register", "out", "due"] as const;
type Tab = (typeof TABS)[number];
const ALL = "all";
const PAGER_H = 52;
const BOTTOM_GAP = 24;

const Stat: React.FC<{ label: string; value: number | null; tone?: string; onClick?: () => void; title?: string }> = ({ label, value, tone, onClick, title }) => (
  <button type="button" onClick={onClick} title={title} className="flex flex-col gap-1 px-5 py-4 text-left transition-colors hover:bg-muted">
    <span className="eyebrow">{label}</span>
    <span className={cn("num text-3xl font-bold tracking-tight", value ? tone : "text-muted-foreground")}>{value == null ? "—" : fmtInt(value)}</span>
  </button>
);

export const ToolsPage: React.FC = () => {
  const { user, growattPlants } = useAppContext();
  const admin = isAdmin(user);
  const [url, setUrl] = useUrlState();
  const tab = pick(url.get("tab"), TABS, "register");
  const query = url.get("q") ?? "";
  const cat = pick(url.get("cat"), [ALL, ...CATEGORY_KEYS] as const, ALL);
  const status = pick(url.get("status"), [ALL, ...STATUS_KEYS] as const, ALL);
  const due = pick(url.get("due"), [ALL, ...DUE_STATE_KEYS] as const, ALL);
  const showRetired = url.get("show") === "retired";
  const sort = pick(url.get("sort"), SORT_KEYS, "due");
  const desc = url.get("desc") === "1";
  const toolId = /^\d+$/.test(url.get("tool") ?? "") ? Number(url.get("tool")) : null;

  const { data, loading, error, reload, mock } = useInstruments(showRetired || status === "retired");
  const [version, setVersion] = useState(0);
  const changed = useCallback(() => {
    setVersion((v) => v + 1);
    void reload();
  }, [reload]);

  const today = data?.meta.today ?? plantToday();
  const plantNames = useMemo(() => new Map(growattPlants.map((p) => [p.plant_id, p.name])), [growattPlants]);
  const plantName = useCallback((id: number) => plantNames.get(id) ?? `Plant ${id}`, [plantNames]);

  // dialogs
  const [editing, setEditing] = useState<{ instrument: Instrument | null } | null>(null);
  const [checkingOut, setCheckingOut] = useState<Instrument | null>(null);
  const [returning, setReturning] = useState<Instrument | null>(null);
  const [dueTarget, setDueTarget] = useState<{ instrument: Instrument; kind?: DueKind } | null>(null);
  const [confirm, setConfirm] = useState<{ title: string; text: string; label: string; run: () => Promise<unknown> } | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const setStatus = async (i: Instrument, s: InstrumentStatus) => {
    setBusyId(i.id);
    setActionError(null);
    try {
      await toolsApi.patchInstrument(i.id, { status: s });
      changed();
    } catch (e) {
      setActionError(`${i.asset_tag}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusyId(null);
    }
  };

  // ---- filtering
  const all = useMemo(() => data?.instruments ?? [], [data]);
  const matches = useCallback(
    (i: Instrument) => {
      const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
      if (cat !== ALL && i.category !== cat) return false;
      if (!words.length) return true;
      const text = [i.asset_tag, i.name, i.make, i.model, i.serial_no, i.open_checkout?.holder?.name, categoryOf(i.category).label]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return words.every((w) => text.includes(w));
    },
    [cat, query]
  );

  const registerRows = useMemo(() => {
    const STATUS_ORDER: Record<InstrumentStatus, number> = { checked_out: 0, repair: 1, at_calibration: 2, available: 3, retired: 4 };
    const rows = all.filter(
      (i) =>
        matches(i) &&
        (status === ALL ? showRetired || i.status !== "retired" : i.status === status) &&
        (due === ALL || i.due.some((d) => d.state === due))
    );
    const cmp = (a: Instrument, b: Instrument): number => {
      switch (sort) {
        case "tag":
          return a.asset_tag.localeCompare(b.asset_tag, undefined, { numeric: true });
        case "name":
          return a.name.localeCompare(b.name);
        case "category":
          return categoryOf(a.category).label.localeCompare(categoryOf(b.category).label) || a.name.localeCompare(b.name);
        case "status":
          return STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
        case "due":
          // no date last (whichever direction), then by date
          if (!a.next_due || !b.next_due) return Number(!a.next_due) - Number(!b.next_due);
          return a.next_due.localeCompare(b.next_due);
      }
    };
    return rows.sort((a, b) => {
      if (sort === "due" && (!a.next_due || !b.next_due)) return cmp(a, b);
      return desc ? -cmp(a, b) : cmp(a, b);
    });
  }, [all, matches, status, showRetired, due, sort, desc]);

  const outRows = useMemo(
    () =>
      all
        .filter((i) => i.open_checkout && matches(i))
        .sort((a, b) => Number(b.open_checkout!.overdue) - Number(a.open_checkout!.overdue) || a.open_checkout!.due_back.localeCompare(b.open_checkout!.due_back)),
    [all, matches]
  );

  const dueRows = useMemo<DueRow[]>(
    () =>
      all
        .filter((i) => i.status !== "retired" && matches(i))
        .flatMap((i) => i.due.map((d) => ({ i, d })))
        .filter((r) => due === ALL || r.d.state === due)
        .sort((a, b) => DUE_RANK[a.d.state] - DUE_RANK[b.d.state] || (a.d.next_due ?? "").localeCompare(b.d.next_due ?? "") || a.i.asset_tag.localeCompare(b.i.asset_tag)),
    [all, matches, due]
  );

  const rowCount = tab === "register" ? registerRows.length : tab === "out" ? outRows.length : dueRows.length;

  // ---- the table ends at the bottom of the screen (as on Active Alarm)
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
      const rowH = el.querySelector("tbody tr")?.getBoundingClientRect().height || 48;
      const pageSize = Math.max(5, Math.floor((height - headH) / rowH));
      setFit((f) => (f.height === height && f.pageSize === pageSize ? f : { height, pageSize }));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [rowCount > 0, firstRead, tab, mock, actionError]);
  useEffect(() => setPage(0), [tab, query, cat, status, due, showRetired, sort, desc]);
  const { pageNo } = pageBounds(rowCount, fit.pageSize, page);
  const slice = <T,>(rows: T[]) => rows.slice(pageNo * fit.pageSize, (pageNo + 1) * fit.pageSize);

  // ---- actions
  const open = (i: Instrument) => setUrl({ tool: i.id });
  const canReturn = (i: Instrument) => admin || (i.open_checkout?.holder?.id != null && i.open_checkout.holder.id === user?.id);

  const actions = (i: Instrument) => (
    <div className="inline-flex items-center gap-1">
      {i.status === "available" && (
        <Button size="xs" variant="outline" onClick={() => setCheckingOut(i)}>
          Check out
        </Button>
      )}
      {i.status === "checked_out" && canReturn(i) && (
        <Button size="xs" variant="outline" onClick={() => setReturning(i)}>
          Check in
        </Button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="icon-xs" variant="ghost" aria-label={`More for ${i.asset_tag}`} disabled={busyId === i.id}>
            {busyId === i.id ? <Spinner className="size-3" /> : <MoreHorizontal />}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem onSelect={() => open(i)}>Details</DropdownMenuItem>
          {admin && (
            <>
              <DropdownMenuItem onSelect={() => setEditing({ instrument: i })}>Edit</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setDueTarget({ instrument: i })}>
                {i.category === "drone" ? "Record renewal" : "Record calibration"}
              </DropdownMenuItem>
              {i.status !== "checked_out" && i.status !== "retired" && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel className="text-[11px] text-muted-foreground">Set status</DropdownMenuLabel>
                  {(["available", "at_calibration", "repair"] as const)
                    .filter((s) => s !== i.status)
                    .map((s) => (
                      <DropdownMenuItem key={s} onSelect={() => void setStatus(i, s)}>
                        {STATUS[s].label}
                      </DropdownMenuItem>
                    ))}
                </>
              )}
              <DropdownMenuSeparator />
              {i.status === "retired" ? (
                <DropdownMenuItem onSelect={() => void setStatus(i, "available")}>Bring back (available)</DropdownMenuItem>
              ) : (
                i.status !== "checked_out" && (
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={() =>
                      setConfirm({
                        title: `Retire ${i.asset_tag}`,
                        text: `${i.name} leaves the register (its history is kept). You can bring it back from Status → Retired.`,
                        label: "Retire",
                        run: () => toolsApi.patchInstrument(i.id, { status: "retired" }),
                      })
                    }
                  >
                    Retire
                  </DropdownMenuItem>
                )
              )}
              {i.checkout_count === 0 && i.status !== "checked_out" && (
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={() =>
                    setConfirm({
                      title: `Delete ${i.asset_tag}`,
                      text: `${i.name} and its calibration records are deleted. Only an instrument that was never checked out can be deleted.`,
                      label: "Delete",
                      run: () => toolsApi.deleteInstrument(i.id),
                    })
                  }
                >
                  Delete
                </DropdownMenuItem>
              )}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );

  const dueAction = ({ i, d }: DueRow) =>
    admin && i.status !== "retired" ? (
      <Button size="xs" variant="outline" onClick={() => setDueTarget({ instrument: i, kind: d.kind })}>
        {d.kind === "calibration" ? "Record calibration" : "Record renewal"}
      </Button>
    ) : null;

  const exportCsv = () => {
    if (tab === "due") {
      downloadCsv(
        `measuring-tools-due-${today}.csv`,
        ["asset_tag", "name", "category", "what", "last", "next_due", "state", "number", "issuer"],
        dueRows.map(({ i, d }) => [i.asset_tag, i.name, categoryOf(i.category).label, DUE_KIND[d.kind], d.last_day, d.next_due, d.state, d.number, d.issuer])
      );
    } else {
      const rows = tab === "out" ? outRows : registerRows;
      downloadCsv(
        `measuring-tools-${tab === "out" ? "checked-out" : "register"}-${today}.csv`,
        ["asset_tag", "name", "category", "make", "model", "serial_no", "key_spec", "status", "holder_place", "due_back", "next_due", "due_state"],
        rows.map((i) => [
          i.asset_tag,
          i.name,
          categoryOf(i.category).label,
          i.make,
          i.model,
          i.serial_no,
          keySpec(i),
          i.status,
          whereText(i, plantName),
          i.open_checkout?.due_back,
          i.next_due,
          i.due_state,
        ])
      );
    }
  };

  const s = data?.summary;
  const anyFilter = query.trim() !== "" || cat !== ALL || status !== ALL || due !== ALL || showRetired;
  const clearFilters = () => setUrl({ q: null, cat: null, status: null, due: null, show: null });
  const pickDue = (d: DueState) => setUrl({ tab: "due", due: due === d && tab === "due" ? null : d, status: null });
  const mine = useMemo(() => all.filter((i) => i.open_checkout?.holder?.id === user?.id).length, [all, user?.id]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col">
          <h1 className="text-lg font-semibold">Measuring Tools</h1>
          <p className="text-xs text-muted-foreground">
            Drones, meters & testers: who has them, where, and when calibration or documents run out
            {mine > 0 && ` · you hold ${mine}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void reload()} disabled={loading}>
            {loading && <Spinner data-icon="inline-start" className="size-3" />}
            {loading ? "Refreshing…" : "Refresh"}
          </Button>
          {admin && (
            <Button size="sm" onClick={() => setEditing({ instrument: null })}>
              <Plus data-icon="inline-start" />
              Add instrument
            </Button>
          )}
        </div>
      </div>

      {mock && (
        <Alert variant="warn">
          <AlertTitle>Mock data</AlertTitle>
          <AlertDescription>
            The backend has no <code>/tools</code> API yet. These instruments are examples, and changes stay in this tab only: a reload starts
            over and nothing is saved.
          </AlertDescription>
        </Alert>
      )}
      {error && !data && (
        <Alert variant="destructive">
          <AlertTitle>Could not load the instruments</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {actionError && (
        <Alert variant="destructive">
          <AlertDescription className="flex items-center justify-between gap-2">
            {actionError}
            <Button size="xs" variant="ghost" onClick={() => setActionError(null)}>
              Dismiss
            </Button>
          </AlertDescription>
        </Alert>
      )}

      <Card className="py-0">
        <CardContent className="grid grid-cols-2 divide-white/[0.06] px-0 sm:grid-cols-3 lg:grid-cols-6 lg:divide-x">
          <Stat label="Instruments" value={s?.total ?? null} tone="text-foreground" onClick={() => setUrl({ tab: null, status: null, due: null })} />
          <Stat
            label="Available"
            value={s?.available ?? null}
            tone="text-emerald-300"
            onClick={() => setUrl({ tab: null, due: null, status: status === "available" && tab === "register" ? null : "available" })}
          />
          <Stat label="Checked out" value={s?.checked_out ?? null} tone="text-sky-300" onClick={() => setUrl({ tab: "out" })} />
          <Stat label="Overdue back" value={s?.overdue_back ?? null} tone="text-red-300" onClick={() => setUrl({ tab: "out" })} title="Checked out past the due-back day" />
          <Stat
            label={`Due ≤ ${data?.meta.due_soon_days ?? 30} d`}
            value={s?.due_soon ?? null}
            tone="text-amber-300"
            onClick={() => pickDue("due_soon")}
            title="Instruments with a calibration or document due soon"
          />
          <Stat label="Overdue" value={s?.overdue ?? null} tone="text-red-300" onClick={() => pickDue("overdue")} title="Calibration or document past its due date" />
        </CardContent>
      </Card>

      <Card className="gap-0 py-0">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 pt-2 sm:px-5">
          <Tabs value={tab} onValueChange={(v) => setUrl({ tab: v === "register" ? null : v, status: null })}>
            <TabsList variant="line" className="border-0 p-0">
              <TabsTrigger value="register" className="px-3 py-2.5 text-sm">
                Register <span className="num text-muted-foreground">{fmtInt(s?.total)}</span>
              </TabsTrigger>
              <TabsTrigger value="out" className="px-3 py-2.5 text-sm">
                Checked out <span className={cn("num", s?.overdue_back ? "text-red-300" : "text-muted-foreground")}>{fmtInt(s?.checked_out)}</span>
              </TabsTrigger>
              <TabsTrigger value="due" className="px-3 py-2.5 text-sm">
                Due dates{" "}
                <span className={cn("num", s?.overdue ? "text-red-300" : s?.due_soon ? "text-amber-300" : "text-muted-foreground")}>
                  {fmtInt((s?.overdue ?? 0) + (s?.due_soon ?? 0))}
                </span>
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="flex items-center gap-2 pb-2">
            <Input
              className="h-8 w-60"
              placeholder="Search tag, name, serial, holder"
              value={query}
              onChange={(e) => setUrl({ q: e.target.value })}
              aria-label="Search instruments"
            />
            <Button variant="outline" size="sm" onClick={exportCsv} disabled={!rowCount}>
              Export CSV
            </Button>
          </div>
        </div>

        <CardContent className="flex flex-wrap items-center gap-2 border-b py-3">
          <Select value={cat} onValueChange={(v) => setUrl({ cat: v === ALL ? null : v })}>
            <SelectTrigger size="sm" className="w-48" aria-label="Category">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value={ALL}>All categories</SelectItem>
              </SelectGroup>
              <SelectSeparator />
              <SelectGroup>
                {CATEGORIES.map((c) => (
                  <SelectItem key={c.value} value={c.value}>
                    <c.icon />
                    {c.label} ({all.filter((i) => i.category === c.value && (showRetired || i.status !== "retired")).length})
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          {tab === "register" && (
            <Select value={status} onValueChange={(v) => setUrl({ status: v === ALL ? null : v })}>
              <SelectTrigger size="sm" className="w-40" aria-label="Status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All statuses</SelectItem>
                <SelectSeparator />
                {STATUS_KEYS.map((k) => (
                  <SelectItem key={k} value={k}>
                    {STATUS[k].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {tab !== "out" && (
            <Select value={due} onValueChange={(v) => setUrl({ due: v === ALL ? null : v })}>
              <SelectTrigger size="sm" className="w-40" aria-label="Due state">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>Any due state</SelectItem>
                <SelectSeparator />
                {DUE_STATE_KEYS.map((k) => (
                  <SelectItem key={k} value={k}>
                    {DUE_STATE[k].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {tab === "register" && status === ALL && (
            <Button variant={showRetired ? "secondary" : "ghost"} size="sm" onClick={() => setUrl({ show: showRetired ? null : "retired" })}>
              {showRetired ? "Hide retired" : "Show retired"}
            </Button>
          )}
          {anyFilter && (
            <Button variant="ghost" size="sm" onClick={clearFilters} className="ml-auto">
              Clear
            </Button>
          )}
        </CardContent>

        <CardContent ref={tableRef} className="overflow-x-auto overflow-y-hidden px-0" style={{ height: fit.height }}>
          {rowCount === 0 ? (
            firstRead ? (
              <SkeletonRows rows={8} className="p-4" />
            ) : (
              <Empty className="h-full">
                <EmptyHeader>
                  <EmptyTitle>
                    {!data ? "Instruments unavailable" : anyFilter ? "No matching instruments" : tab === "out" ? "Nothing checked out" : "No instruments yet"}
                  </EmptyTitle>
                  {!data && error && <EmptyDescription>{error}</EmptyDescription>}
                  {data && !anyFilter && tab === "register" && admin && <EmptyDescription>Add the first one with “Add instrument”.</EmptyDescription>}
                </EmptyHeader>
              </Empty>
            )
          ) : tab === "register" ? (
            <RegisterTable
              rows={slice(registerRows)}
              sort={sort}
              desc={desc}
              onSort={(k: SortKey) => setUrl({ sort: k === "due" ? null : k, desc: k === sort ? !desc : false })}
              today={today}
              plantName={plantName}
              onOpen={open}
              actions={actions}
            />
          ) : tab === "out" ? (
            <CheckedOutTable rows={slice(outRows)} today={today} plantName={plantName} onOpen={open} actions={actions} />
          ) : (
            <DueTable rows={slice(dueRows)} today={today} onOpen={open} actions={actions} dueAction={dueAction} />
          )}
        </CardContent>
        <CardContent className="border-t py-2.5">
          <TablePager rows={rowCount} pageSize={fit.pageSize} pageNo={pageNo} onPage={setPage} />
        </CardContent>
      </Card>

      <InstrumentDetail
        id={toolId}
        version={version}
        today={today}
        plantName={plantName}
        onClose={() => setUrl({ tool: null })}
        actions={(d) => (
          <>
            {d.status === "available" && (
              <Button size="xs" variant="outline" onClick={() => setCheckingOut(d)}>
                Check out
              </Button>
            )}
            {d.status === "checked_out" && canReturn(d) && (
              <Button size="xs" variant="outline" onClick={() => setReturning(d)}>
                Check in
              </Button>
            )}
            {admin && (
              <Button size="xs" variant="ghost" onClick={() => setEditing({ instrument: d })}>
                Edit
              </Button>
            )}
          </>
        )}
      />
      <InstrumentDialog open={editing != null} editing={editing?.instrument ?? null} onClose={() => setEditing(null)} onSaved={changed} />
      <CheckoutDialog instrument={checkingOut} onClose={() => setCheckingOut(null)} onDone={changed} />
      <ReturnDialog instrument={returning} onClose={() => setReturning(null)} onDone={changed} />
      <DueDialog target={dueTarget} onClose={() => setDueTarget(null)} onDone={changed} />
      <ConfirmDialog
        open={confirm != null}
        title={confirm?.title ?? ""}
        text={confirm?.text ?? ""}
        label={confirm?.label ?? ""}
        onClose={() => setConfirm(null)}
        onConfirm={() => confirm!.run()}
        onDone={changed}
      />
    </div>
  );
};

export default ToolsPage;
