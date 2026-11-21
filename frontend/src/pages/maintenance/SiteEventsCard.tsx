/** Plant Maintenance: the site log. Work done on the plant (cleaning, repair, module or inverter
 * replaced, IR flight, curtailment) with its plant-local dates, optional inverter / string, cost
 * and note. An event can resolve the decision-rule issue it answered. DB only
 * (`/growatt/plants/{id}/events`); the cleaning dates are what Phase 4 measures recovery from.
 * Engineers and admins of the plant record and edit; delete = admin or whoever recorded it. */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { api } from "../../api/client";
import type { GrowattInverter, Issue, SiteEvent, SiteEventBody, SiteEventList, SiteEventType } from "../../api/client";
import { useAppContext } from "../../context/AppContext";
import { isAdmin } from "../../auth/access";
import { plantToday } from "../../context/alarmLogStore";
import { pick, useUrlState } from "../../lib/useUrlState";
import { dayLabel, fromDate, toDate } from "@/lib/day";
import { translate, useI18n } from "@/i18n";
import { fmtInt, LoadingState } from "../../components/ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";

export const EVENT_TYPES: ReadonlyArray<{ value: SiteEventType; label: string }> = [
  { value: "cleaning", label: "Cleaning" },
  { value: "repair", label: "Repair" },
  { value: "module_replaced", label: "Module replaced" },
  { value: "inverter_replaced", label: "Inverter replaced" },
  { value: "ir_flight", label: "IR flight" },
  { value: "pm_inspection", label: "PM inspection" },
  { value: "inverter_service", label: "Inverter service" },
  { value: "site_visit", label: "Site visit" },
  { value: "curtailment", label: "Curtailment" },
  { value: "other", label: "Other" },
];
const TYPE_KEYS = ["all", ...EVENT_TYPES.map((t) => t.value)] as const;
const TYPE_VARIANT: Record<SiteEventType, "info" | "ok" | "warn" | "neutral" | "default"> = {
  cleaning: "info",
  repair: "ok",
  module_replaced: "ok",
  inverter_replaced: "ok",
  ir_flight: "default",
  pm_inspection: "ok",
  inverter_service: "ok",
  site_visit: "neutral",
  curtailment: "warn",
  other: "neutral",
};
const NONE = "__none";

const thb = (v: number | null) => (v == null ? "—" : `฿${fmtInt(v)}`);
const span = (e: SiteEvent) => (e.end_day ? `${dayLabel(e.day)} → ${dayLabel(e.end_day)}` : dayLabel(e.day));
const where = (e: SiteEvent) => {
  const inv = e.inverter_name || e.device_sn;
  if (inv && e.string_no != null) return `${inv} · PV${e.string_no}`;
  return inv || translate("Whole plant");
};
const issueLabel = (i: Issue) =>
  `#${i.id} ${i.rule} ${i.name} · ${i.inverter_name || i.device_sn || translate("plant")}${i.string_no != null ? ` · PV${i.string_no}` : ""}${i.shadow ? ` ${translate("(shadow)")}` : ""}`;

const DayField: React.FC<{
  id: string;
  label: string;
  value: string | null;
  onChange: (d: string | null) => void;
  min?: string;
  optional?: boolean;
}> = ({ id, label, value, onChange, min, optional }) => {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const today = plantToday();
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex gap-1">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button id={id} variant="outline" size="sm" className="num w-full justify-start">
              {value ? dayLabel(value) : <span className="text-slate-500">{optional ? t("Same day") : t("Pick a day")}</span>}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-0" align="start">
            <Calendar
              mode="single"
              selected={value ? toDate(value) : undefined}
              defaultMonth={toDate(value ?? today)}
              disabled={[{ after: toDate(today) }, ...(min ? [{ before: toDate(min) }] : [])]}
              onSelect={(d) => {
                if (!d) return;
                onChange(fromDate(d));
                setOpen(false);
              }}
            />
          </PopoverContent>
        </Popover>
        {optional && value && (
          <Button variant="ghost" size="sm" onClick={() => onChange(null)} aria-label={t("Clear {label}", { label })}>
            {t("Clear")}
          </Button>
        )}
      </div>
    </div>
  );
};

interface Draft {
  event_type: SiteEventType;
  day: string;
  end_day: string | null;
  device_sn: string;
  string_no: string;
  cost_thb: string;
  issue_id: string;
  close_issue: boolean;
  note: string;
}

const blank = (): Draft => ({
  event_type: "cleaning",
  day: plantToday(),
  end_day: null,
  device_sn: NONE,
  string_no: "",
  cost_thb: "",
  issue_id: NONE,
  close_issue: true,
  note: "",
});

const fromEvent = (e: SiteEvent): Draft => ({
  event_type: e.event_type,
  day: e.day,
  end_day: e.end_day,
  device_sn: e.device_sn ?? NONE,
  string_no: e.string_no != null ? String(e.string_no) : "",
  cost_thb: e.cost_thb != null ? String(e.cost_thb) : "",
  issue_id: e.issue_id != null ? String(e.issue_id) : NONE,
  close_issue: false,
  note: e.note ?? "",
});

const EventDialog: React.FC<{
  plantId: number;
  open: boolean;
  editing: SiteEvent | null;
  inverters: GrowattInverter[];
  onClose: () => void;
  onSaved: () => void;
}> = ({ plantId, open, editing, inverters, onClose, onSaved }) => {
  const { user } = useAppContext();
  const { t } = useI18n();
  const admin = isAdmin(user);
  const [d, setD] = useState<Draft>(blank);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }));

  useEffect(() => {
    if (!open) return;
    setD(editing ? fromEvent(editing) : blank());
    setError(null);
    let live = true;
    api
      .listIssues({ plant_id: plantId, status: "active", include_shadow: admin || undefined })
      .then((l) => live && setIssues(l.issues))
      .catch(() => live && setIssues([]));
    return () => {
      live = false;
    };
  }, [open, editing, plantId, admin]);

  // the linked issue may already be closed (not in the active list): keep it selectable
  const linked = editing?.issue && !issues.some((i) => i.id === editing.issue!.id) ? editing.issue : null;
  const chosen = issues.find((i) => String(i.id) === d.issue_id);

  const submit = async () => {
    const stringNo = d.string_no.trim() === "" ? null : Number(d.string_no);
    const cost = d.cost_thb.trim() === "" ? null : Number(d.cost_thb.replace(/,/g, ""));
    if (stringNo != null && (!Number.isInteger(stringNo) || stringNo < 1 || stringNo > 64)) return setError(t("String number: 1–64"));
    if (cost != null && (!Number.isFinite(cost) || cost < 0)) return setError(t("Cost: a number of baht, 0 or more"));
    const body: SiteEventBody = {
      event_type: d.event_type,
      day: d.day,
      end_day: d.end_day,
      device_sn: d.device_sn === NONE ? null : d.device_sn,
      string_no: d.device_sn === NONE ? null : stringNo,
      cost_thb: cost,
      issue_id: d.issue_id === NONE ? null : Number(d.issue_id),
      close_issue: d.issue_id !== NONE && d.close_issue && chosen != null,
      note: d.note,
    };
    setBusy(true);
    try {
      if (editing) await api.patchSiteEvent(plantId, editing.id, body);
      else await api.createSiteEvent(plantId, body);
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? t("Edit site event") : t("Record site event")}</DialogTitle>
          <DialogDescription>{t("Work done on the plant, with the plant-local date it was done.")}</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="ev-type">{t("Type")}</Label>
            <Select value={d.event_type} onValueChange={(v) => set({ event_type: v as SiteEventType })}>
              <SelectTrigger id="ev-type" size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EVENT_TYPES.map((x) => (
                  <SelectItem key={x.value} value={x.value}>
                    {t(x.label)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DayField
            id="ev-day"
            label={t("Date")}
            value={d.day}
            onChange={(v) => v && set({ day: v, end_day: d.end_day && d.end_day < v ? null : d.end_day })}
          />
          <DayField id="ev-end" label={t("Until (if several days)")} value={d.end_day} onChange={(v) => set({ end_day: v })} min={d.day} optional />
          <div className="space-y-1.5">
            <Label htmlFor="ev-inv">{t("Inverter")}</Label>
            <Select value={d.device_sn} onValueChange={(v) => set({ device_sn: v, string_no: v === NONE ? "" : d.string_no })}>
              <SelectTrigger id="ev-inv" size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>{t("Whole plant")}</SelectItem>
                {inverters.map((i) => (
                  <SelectItem key={i.device_sn} value={i.device_sn}>
                    {i.alias || i.device_sn}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ev-string">{t("String (PV no.)")}</Label>
            <Input
              id="ev-string"
              inputMode="numeric"
              value={d.string_no}
              disabled={d.device_sn === NONE}
              placeholder={d.device_sn === NONE ? t("Pick an inverter") : t("All strings")}
              onChange={(e) => set({ string_no: e.target.value })}
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="ev-cost">{t("Cost (THB)")}</Label>
            <Input
              id="ev-cost"
              inputMode="decimal"
              value={d.cost_thb}
              placeholder={t("Leave empty if not known")}
              onChange={(e) => set({ cost_thb: e.target.value })}
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="ev-issue">{t("Answers issue")}</Label>
            <Select value={d.issue_id} onValueChange={(v) => set({ issue_id: v })}>
              <SelectTrigger id="ev-issue" size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>{t("None")}</SelectItem>
                {linked && (
                  <SelectItem value={String(linked.id)}>
                    #{linked.id} {linked.rule} ({linked.status})
                  </SelectItem>
                )}
                {issues.map((i) => (
                  <SelectItem key={i.id} value={String(i.id)}>
                    {issueLabel(i)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {chosen && (
              <label className="flex items-center gap-2 text-xs text-slate-300">
                <input type="checkbox" checked={d.close_issue} onChange={(e) => set({ close_issue: e.target.checked })} />
                {t("Resolve this issue as a confirmed fault")}
              </label>
            )}
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="ev-note">{t("Note")}</Label>
            <Textarea
              id="ev-note"
              rows={3}
              value={d.note}
              onChange={(e) => set({ note: e.target.value })}
              placeholder={t("What was done, by whom (contractor), what was found")}
            />
          </div>
        </div>
        {error && <div className="callout-crit text-xs">{error}</div>}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t("Cancel")}
          </Button>
          <Button onClick={() => void submit()} disabled={busy || !d.day}>
            {busy && <Spinner data-icon="inline-start" className="size-3" />}
            {editing ? t("Save") : t("Record")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export const SiteEventsCard: React.FC<{ plantId: number }> = ({ plantId }) => {
  const { user } = useAppContext();
  const { t } = useI18n();
  const admin = isAdmin(user);
  const me = user?.username || user?.email;
  const [url, setUrl] = useUrlState();
  const type = pick(url.get("type"), TYPE_KEYS, "all");
  const [data, setData] = useState<SiteEventList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inverters, setInverters] = useState<GrowattInverter[]>([]);
  const [dialog, setDialog] = useState<{ editing: SiteEvent | null } | null>(null);
  const [deleting, setDeleting] = useState<SiteEvent | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api.listSiteEvents(plantId, { type: type === "all" ? undefined : type }));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [plantId, type]);

  useEffect(() => {
    setData(null);
    void load();
  }, [load]);

  useEffect(() => {
    let live = true;
    api
      .listGrowattInverters(plantId)
      .then((l) => live && setInverters([...l].sort((a, b) => (a.alias || a.device_sn).localeCompare(b.alias || b.device_sn, undefined, { numeric: true }))))
      .catch(() => live && setInverters([]));
    return () => {
      live = false;
    };
  }, [plantId]);

  const lastCleaning = useMemo(() => data?.events.find((e) => e.event_type === "cleaning"), [data]);

  const remove = async () => {
    if (!deleting) return;
    setBusy(true);
    try {
      await api.deleteSiteEvent(plantId, deleting.id);
      setDeleting(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("Site log")}</CardTitle>
        <CardDescription>
          {t("Cleanings, repairs and other work on this plant.")}
          {type === "all" && lastCleaning ? ` ${t("Last cleaning: {day}.", { day: dayLabel(lastCleaning.end_day ?? lastCleaning.day) })}` : ""}
          {data?.summary.cost_thb != null
            ? ` ${t(data.summary.costed === 1 ? "Cost entered: {cost} over {n} event." : "Cost entered: {cost} over {n} events.", { cost: thb(data.summary.cost_thb), n: fmtInt(data.summary.costed) })}`
            : ""}
        </CardDescription>
        <CardAction className="flex flex-wrap items-center gap-2">
          <Select value={type} onValueChange={(v) => setUrl({ type: v === "all" ? null : v })}>
            <SelectTrigger size="sm" className="w-40" aria-label={t("Event type")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("All types")}</SelectItem>
              {EVENT_TYPES.map((x) => (
                <SelectItem key={x.value} value={x.value}>
                  {t(x.label)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="sm" onClick={() => setDialog({ editing: null })}>
            <Plus data-icon="inline-start" />
            {t("Record event")}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="p-0">
        {error && <div className="callout-crit mx-4 mb-3 text-xs">{error}</div>}
        {!data ? (
          !error && <LoadingState label={t("Loading site log…")} shape="table" />
        ) : data.events.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>{type === "all" ? t("Nothing recorded yet") : t("No events of this type")}</EmptyTitle>
              <EmptyDescription>{t("Record each cleaning with its date: the platform measures what each one recovered from them.")}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Table containerClassName="scroll-x-hint max-h-[28rem] overflow-auto">
            <TableHeader>
              <TableRow>
                <TableHead>{t("Date")}</TableHead>
                <TableHead>{t("Type")}</TableHead>
                <TableHead>{t("Where")}</TableHead>
                <TableHead className="text-right">{t("Cost")}</TableHead>
                <TableHead>{t("Issue")}</TableHead>
                <TableHead>{t("Note")}</TableHead>
                <TableHead>{t("By")}</TableHead>
                <TableHead className="text-right" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.events.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="num whitespace-nowrap text-xs text-white">{span(e)}</TableCell>
                  <TableCell>
                    <Badge variant={TYPE_VARIANT[e.event_type]}>{t(e.label)}</Badge>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-slate-300">{where(e)}</TableCell>
                  <TableCell className="num whitespace-nowrap text-right text-xs">{thb(e.cost_thb)}</TableCell>
                  <TableCell className="whitespace-nowrap text-xs">
                    {e.issue ? (
                      <span className="text-slate-300" title={t("Issue #{id}", { id: e.issue.id })}>
                        {e.issue.rule} · {e.issue.status}
                      </span>
                    ) : (
                      <span className="text-slate-500">—</span>
                    )}
                  </TableCell>
                  <TableCell className="max-w-72 text-xs text-slate-400">
                    <span className="line-clamp-2" title={e.note ?? undefined}>
                      {e.note || "—"}
                    </span>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-slate-400">{e.created_by ?? "—"}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button size="icon-xs" variant="ghost" aria-label={t("Edit event")} title={t("Edit")} onClick={() => setDialog({ editing: e })}>
                        <Pencil />
                      </Button>
                      {(admin || e.created_by === me) && (
                        <Button size="icon-xs" variant="ghost" aria-label={t("Delete event")} title={t("Delete")} onClick={() => setDeleting(e)}>
                          <Trash2 />
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>

      <EventDialog
        plantId={plantId}
        open={dialog != null}
        editing={dialog?.editing ?? null}
        inverters={inverters}
        onClose={() => setDialog(null)}
        onSaved={() => void load()}
      />

      <Dialog open={deleting != null} onOpenChange={(o) => !o && setDeleting(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("Delete site event")}</DialogTitle>
            <DialogDescription>
              {deleting ? `${t("{type} on {when}", { type: t(deleting.label), when: span(deleting) })} · ${where(deleting)}.` : ""} {t("A resolved issue stays resolved.")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleting(null)} disabled={busy}>
              {t("Cancel")}
            </Button>
            <Button variant="destructive" onClick={() => void remove()} disabled={busy}>
              {busy && <Spinner data-icon="inline-start" className="size-3" />}
              {t("Delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
};
