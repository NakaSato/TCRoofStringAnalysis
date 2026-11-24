/** Calendar "Due" view, the monthly plan (Phase 2): every plant the user can see with its last
 * cleaning and PM (Site log), days since cleaning, next planned cleaning, the month's tasks and
 * overdue work. Admins tick plants for a cleaning round and enter each plant's crew-days and cost.
 * DB only (`/growatt/calendar/due?month=`). URL: `show`, `days`, `q`. */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api/client";
import type { OmDue, OmDueRow } from "../../api/client";
import { plantPath } from "../../context/routes";
import { LoadingState, Suspended, fmtInt } from "../../components/ui";
import { pick, useUrlState } from "@/lib/useUrlState";
import { useI18n } from "@/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { shortDay } from "./format";
import { TablePager, pageBounds } from "../../components/TablePager";

/** rows (plants) per page of the Due list */
const DUE_PAGE = 50;

const SHOWS = ["all", "due", "never", "unplanned", "overdue"] as const;
type Show = (typeof SHOWS)[number];
const SHOW_LABEL: Record<Show, string> = {
  all: "All plants",
  due: "Cleaning due",
  never: "No cleaning recorded",
  unplanned: "No cleaning planned",
  overdue: "With overdue work",
};
const OTHER: Array<{ key: "pm_inspection" | "inverter_service" | "ir_flight"; label: string }> = [
  { key: "pm_inspection", label: "PM" },
  { key: "inverter_service", label: "Inv. service" },
  { key: "ir_flight", label: "IR" },
];

const SettingsDialog: React.FC<{ row: OmDueRow | null; onClose: () => void; onSaved: () => void }> = ({ row, onClose, onSaved }) => {
  const { t } = useI18n();
  const [days, setDays] = useState("");
  const [cost, setCost] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!row) return;
    setDays(row.settings.cleaning_crew_days == null ? "" : String(row.settings.cleaning_crew_days));
    setCost(row.settings.cleaning_cost_thb == null ? "" : String(row.settings.cleaning_cost_thb));
    setError(null);
  }, [row]);
  const num = (s: string) => (s.trim() === "" ? null : Number(s));
  const bad = (num(days) != null && !(num(days)! > 0)) || (num(cost) != null && !(num(cost)! >= 0));
  const save = async () => {
    if (!row) return;
    setBusy(true);
    try {
      await api.putOmPlantSettings(row.plant_id, { cleaning_crew_days: num(days), cleaning_cost_thb: num(cost) });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={row != null} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("Cleaning figures")}</DialogTitle>
          <DialogDescription>{t("{name}: as your crews or contractor quote them. Leave empty when not known.", { name: row?.name })}</DialogDescription>
        </DialogHeader>
        {error && <p className="text-xs text-red-300">{error}</p>}
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="om-crew-days">{t("Crew-days per cleaning")}</Label>
            <Input id="om-crew-days" type="number" min={0.25} step={0.25} value={days} onChange={(e) => setDays(e.target.value)} className="num" placeholder={t("Not entered")} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="om-cost">{t("Cost per cleaning (฿)")}</Label>
            <Input id="om-cost" type="number" min={0} step={100} value={cost} onChange={(e) => setCost(e.target.value)} className="num" placeholder={t("Not entered")} />
          </div>
        </div>
        <DialogFooter>
          <Button size="sm" disabled={busy || bad} onClick={() => void save()}>
            {busy && <Spinner data-icon="inline-start" className="size-3" />}
            {t("Save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export const DueView: React.FC<{ month: string; admin: boolean; version: number; onPlanRound: (ids: number[]) => void }> = ({ month, admin, version, onPlanRound }) => {
  const { t } = useI18n();
  const [url, setUrl] = useUrlState();
  const show = pick(url.get("show"), SHOWS, "all") as Show;
  const minDays = Math.max(1, Number(url.get("days")) || 60);
  const q = url.get("q") ?? "";
  const [data, setData] = useState<OmDue | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [editing, setEditing] = useState<OmDueRow | null>(null);

  const seq = useRef(0);
  const load = useCallback(async () => {
    const n = ++seq.current;
    setLoading(true);
    try {
      const out = await api.getOmDue(month.slice(0, 7));
      if (n !== seq.current) return;
      setData(out);
      setError(null);
    } catch (e) {
      if (n === seq.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }, [month]);

  useEffect(() => {
    void load();
  }, [load, version]);
  // a saved round: start the next selection from scratch
  useEffect(() => setSelected(new Set()), [version]);

  const rows = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const out = (data?.plants ?? []).filter((r) => {
      const hay = `${r.name} ${r.city ?? ""} ${r.plant_id} phase ${r.phase ?? ""}`.toLowerCase();
      if (!words.every((w) => hay.includes(w))) return false;
      if (show === "due") return !r.next_cleaning && (r.days_since_cleaning == null || r.days_since_cleaning >= minDays);
      if (show === "never") return r.days_since_cleaning == null;
      if (show === "unplanned") return !r.next_cleaning;
      if (show === "overdue") return r.overdue > 0;
      return true;
    });
    // never cleaned first, then the longest since the last cleaning
    return out.sort((a, b) => (b.days_since_cleaning ?? Infinity) - (a.days_since_cleaning ?? Infinity) || a.name.localeCompare(b.name));
  }, [data, q, show, minDays]);

  // DUE_PAGE plants at a time; back to page 1 when the month, the filter or the search changes.
  // The header tick still selects every plant the filter matches, on every page.
  const [page, setPage] = useState(0);
  useEffect(() => setPage(0), [month, q, show, minDays]);
  const { pageNo } = pageBounds(rows.length, DUE_PAGE, page);
  const pageRows = rows.slice(pageNo * DUE_PAGE, (pageNo + 1) * DUE_PAGE);

  const allOn = rows.length > 0 && rows.every((r) => selected.has(r.plant_id));
  const toggleAll = () => setSelected(allOn ? new Set([...selected].filter((id) => !rows.some((r) => r.plant_id === id))) : new Set([...selected, ...rows.map((r) => r.plant_id)]));
  const toggle = (id: number) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };
  const s = data?.summary;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input value={q} onChange={(e) => setUrl({ q: e.target.value })} placeholder={t("Search plant, province, id…")} className="h-8 w-56" aria-label={t("Search plants")} />
        <Select value={show} onValueChange={(v) => setUrl({ show: v === "all" ? null : v })}>
          <SelectTrigger size="sm" className="w-48" aria-label={t("Show")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SHOWS.map((x) => (
              <SelectItem key={x} value={x}>
                {t(SHOW_LABEL[x])}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {show === "due" && (
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            {t("not cleaned for")}
            <Input type="number" min={1} value={minDays} onChange={(e) => setUrl({ days: Number(e.target.value) === 60 ? null : e.target.value })} className="num h-8 w-20" aria-label={t("Days")} />
            {t("days or more, none planned")}
          </label>
        )}
        {admin && (
          <Button size="sm" className="ml-auto" disabled={selected.size === 0} onClick={() => onPlanRound([...selected])}>
            {selected.size ? t("Plan cleaning round ({n})…", { n: selected.size }) : t("Plan cleaning round…")}
          </Button>
        )}
      </div>

      {s && (
        <p className="text-xs text-muted-foreground">
          <span className="num">{fmtInt(s.plants)}</span> {t("plants")} · <span className="num">{fmtInt(s.never_cleaned)}</span> {t("with no cleaning recorded")} ·{" "}
          <span className="num">{fmtInt(s.cleaning_planned)}</span> {t("with a cleaning planned")} · <span className="num">{fmtInt(s.with_overdue)}</span> {t("with overdue work")} ·{" "}
          <span className="num">{fmtInt(s.month_tasks)}</span> {t("tasks this month. Last work comes from the Site log.")}
        </p>
      )}
      {error && <p className="text-xs text-red-300">{error}</p>}

      {!data ? (
        <LoadingState label={t("Loading the monthly plan…")} shape="table" className="border-0 bg-transparent p-0 shadow-none" />
      ) : (
        <Suspended busy={loading} label={t("Loading the monthly plan…")}>
        <Table containerClassName="table-wrap max-h-[65vh]">
          <TableHeader>
            <TableRow>
              {admin && (
                <TableHead className="w-8">
                  <Checkbox checked={allOn} onCheckedChange={toggleAll} aria-label={t("Select all shown")} />
                </TableHead>
              )}
              <TableHead>{t("Plant")}</TableHead>
              <TableHead>{t("Last cleaning")}</TableHead>
              <TableHead>{t("Next cleaning")}</TableHead>
              <TableHead>{t("Other work (last)")}</TableHead>
              <TableHead>{t("This month")}</TableHead>
              <TableHead>{t("Crew-days · cost")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={admin ? 7 : 6} className="py-6 text-center text-muted-foreground">
                  {t("No plants match.")}
                </TableCell>
              </TableRow>
            )}
            {pageRows.map((r) => {
              const other = OTHER.filter((o) => r.last[o.key]);
              const st = r.settings;
              return (
                <TableRow key={r.plant_id} data-state={selected.has(r.plant_id) ? "selected" : undefined}>
                  {admin && (
                    <TableCell>
                      <Checkbox checked={selected.has(r.plant_id)} onCheckedChange={() => toggle(r.plant_id)} aria-label={t("Select {name}", { name: r.name })} />
                    </TableCell>
                  )}
                  <TableCell className="max-w-56">
                    <Link to={plantPath(r.plant_id, "maintenance")} className="block truncate hover:underline">
                      {r.name}
                    </Link>
                    <div className="text-[11px] text-muted-foreground">
                      {[r.city, r.phase != null ? t("Phase {n}", { n: r.phase }) : null].filter(Boolean).join(" · ") || `#${r.plant_id}`}
                      {r.plans.length > 0 && ` · ${r.plans.join(", ")}`}
                    </div>
                  </TableCell>
                  <TableCell className="num whitespace-nowrap">
                    {r.last.cleaning ? (
                      <>
                        {shortDay(r.last.cleaning)} <span className="text-muted-foreground">({t("{n} d", { n: fmtInt(r.days_since_cleaning) })})</span>
                      </>
                    ) : (
                      <span className="text-muted-foreground">{t("None recorded")}</span>
                    )}
                  </TableCell>
                  <TableCell className="num whitespace-nowrap">{r.next_cleaning ? shortDay(r.next_cleaning) : <span className="text-muted-foreground">—</span>}</TableCell>
                  <TableCell className="text-[11px]">
                    {other.length ? other.map((o) => <div key={o.key} className="num whitespace-nowrap">{t(o.label)} {shortDay(r.last[o.key]!)}</div>) : <span className="text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap items-center gap-1">
                      {r.month.total ? (
                        <span className="num text-xs">
                          {t("{open} open · {done} done", { open: r.month.open, done: r.month.done })}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                      {r.overdue > 0 && <Badge variant="crit">{t("{n} overdue", { n: r.overdue })}</Badge>}
                    </div>
                  </TableCell>
                  <TableCell className="num whitespace-nowrap text-xs">
                    {admin ? (
                      <Button type="button" variant="link" size="xs" className="h-auto rounded-none p-0 align-baseline text-[length:inherit] font-normal text-current underline-offset-auto" onClick={() => setEditing(r)}>
                        {st.cleaning_crew_days == null && st.cleaning_cost_thb == null ? (
                          <span className="text-muted-foreground">{t("Not entered")}</span>
                        ) : (
                          `${t("{n} d", { n: st.cleaning_crew_days ?? "—" })} · ${st.cleaning_cost_thb == null ? "—" : `฿${fmtInt(st.cleaning_cost_thb)}`}`
                        )}
                      </Button>
                    ) : st.cleaning_crew_days == null && st.cleaning_cost_thb == null ? (
                      <span className="text-muted-foreground">{t("Not entered")}</span>
                    ) : (
                      `${t("{n} d", { n: st.cleaning_crew_days ?? "—" })} · ${st.cleaning_cost_thb == null ? "—" : `฿${fmtInt(st.cleaning_cost_thb)}`}`
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        {rows.length > 0 && <TablePager className="mt-3" rows={rows.length} pageSize={DUE_PAGE} pageNo={pageNo} onPage={setPage} />}
        </Suspended>
      )}
      <SettingsDialog
        row={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          void load();
        }}
      />
    </div>
  );
};
