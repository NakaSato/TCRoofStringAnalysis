/** Calendar Team task dialog: plan a task, edit / move / reassign it, change its status, mark it
 * done (writes the Site log event: same type, dates capped at today) and read its history.
 * A done task is read-only except its note: its record is the Site log event. */
import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api/client";
import type { GrowattInverter, GrowattPlant, Issue, OmAssignees, OmTask, OmTaskDetail, OmTaskPatch, OmTaskType } from "../../api/client";
import { plantToday } from "../../context/alarmLogStore";
import { plantPath } from "../../context/routes";
import { dayLabel } from "@/lib/day";
import { dateLocale, translate, useI18n } from "@/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { DayPicker, PlantPicker } from "./fields";
import { TASK_TYPES, personName, statusOf } from "./format";

const NONE = "__none";

export interface TaskDialogTarget {
  /** null = a new task */
  task: OmTask | null;
  /** new task: preset plant (fixed when `lockPlant`) and day */
  plantId?: number | null;
  lockPlant?: boolean;
  day?: string;
}

interface Draft {
  plant_id: number | null;
  task_type: OmTaskType;
  title: string;
  start_day: string;
  end_day: string;
  device_sn: string;
  string_no: string;
  team_id: string;
  assignee_ids: number[];
  issue_id: string;
  est_cost_thb: string;
  note: string;
  comment: string;
}

const draftOf = (t: TaskDialogTarget, me: number | undefined): Draft => {
  const x = t.task;
  const day = t.day ?? plantToday();
  return {
    plant_id: x?.plant_id ?? t.plantId ?? null,
    task_type: x?.task_type ?? "cleaning",
    title: x?.title ?? "",
    start_day: x?.start_day ?? day,
    end_day: x?.end_day ?? day,
    device_sn: x?.device_sn ?? NONE,
    string_no: x?.string_no != null ? String(x.string_no) : "",
    team_id: x?.team ? String(x.team.id) : NONE,
    assignee_ids: x ? x.assignees.map((a) => a.id) : me != null ? [me] : [],
    issue_id: x?.issue_id != null ? String(x.issue_id) : NONE,
    est_cost_thb: x?.est_cost_thb != null ? String(x.est_cost_thb) : "",
    note: x?.note ?? "",
    comment: "",
  };
};

const num = (s: string): number | null => {
  const v = s.trim() === "" ? NaN : Number(s);
  return Number.isFinite(v) ? v : null;
};

const changeText = (change: Record<string, unknown>) =>
  Object.entries(change)
    .map(([k, v]) => {
      if (k === "created") return translate("created");
      if (Array.isArray(v) && v.length === 2) return `${k.replace(/_/g, " ")}: ${fmtVal(v[0])} → ${fmtVal(v[1])}`;
      return k.replace(/_/g, " ");
    })
    .join(" · ");
const fmtVal = (v: unknown) => (v == null || v === "" ? "—" : Array.isArray(v) ? (v.length ? v.join(", ") : translate("none")) : String(v));

export const TaskDialog: React.FC<{
  target: TaskDialogTarget | null;
  plants: GrowattPlant[];
  me: number | undefined;
  admin: boolean;
  onClose: () => void;
  onChanged: () => void;
}> = ({ target, plants, me, admin, onClose, onChanged }) => {
  const { t } = useI18n();
  const [d, setD] = useState<Draft | null>(null);
  const [detail, setDetail] = useState<OmTaskDetail | null>(null);
  const [people, setPeople] = useState<OmAssignees | null>(null);
  const [inverters, setInverters] = useState<GrowattInverter[]>([]);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [mode, setMode] = useState<"edit" | "done">("edit");
  const [done, setDone] = useState({ day: "", end_day: "", cost: "", note: "", close_issue: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const task = target?.task ?? null;
  const today = plantToday();

  useEffect(() => {
    if (!target) return;
    setD(draftOf(target, me));
    setDetail(null);
    setMode("edit");
    setError(null);
    if (target.task) {
      let live = true;
      api
        .getOmTask(target.task.plant_id, target.task.id)
        .then((x) => live && setDetail(x))
        .catch(() => undefined);
      return () => {
        live = false;
      };
    }
  }, [target, me]);

  const plantId = d?.plant_id ?? null;
  useEffect(() => {
    if (plantId == null) {
      setPeople(null);
      setInverters([]);
      setIssues([]);
      return;
    }
    let live = true;
    api.listOmAssignees(plantId).then((x) => live && setPeople(x)).catch(() => live && setPeople(null));
    api
      .listGrowattInverters(plantId)
      .then((l) => live && setInverters([...l].sort((a, b) => (a.alias || a.device_sn).localeCompare(b.alias || b.device_sn, undefined, { numeric: true }))))
      .catch(() => live && setInverters([]));
    api
      .listIssues({ plant_id: plantId, status: "active", include_shadow: admin || undefined })
      .then((l) => live && setIssues(l.issues))
      .catch(() => live && setIssues([]));
    return () => {
      live = false;
    };
  }, [plantId, admin]);

  const locked = task?.status === "done";
  const set = (p: Partial<Draft>) => setD((x) => (x ? { ...x, ...p } : x));
  // assignees: who may be picked on this plant, plus anyone already on the task
  const pickable = useMemo(() => {
    const list = [...(people?.users ?? [])];
    for (const a of task?.assignees ?? []) if (!list.some((u) => u.id === a.id)) list.push(a);
    return list;
  }, [people, task]);
  const teams = useMemo(() => {
    const list = [...(people?.teams ?? [])];
    if (task?.team && !list.some((x) => x.id === task.team!.id)) list.push({ ...task.team, active: false, members: [] });
    return list;
  }, [people, task]);

  if (!target || !d) return null;

  const body = () => ({
    task_type: d.task_type,
    title: d.title.trim() || null,
    start_day: d.start_day,
    end_day: d.end_day,
    device_sn: d.device_sn === NONE ? null : d.device_sn,
    string_no: d.device_sn === NONE ? null : num(d.string_no),
    team_id: d.team_id === NONE ? null : Number(d.team_id),
    assignee_ids: d.assignee_ids,
    issue_id: d.issue_id === NONE ? null : Number(d.issue_id),
    est_cost_thb: num(d.est_cost_thb),
    note: d.note.trim() || null,
  });

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChanged();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const save = () =>
    run(async () => {
      if (!task) {
        if (d.plant_id == null) throw new Error(t("Pick a plant"));
        await api.createOmTask(d.plant_id, body());
        return;
      }
      const patch: OmTaskPatch = locked ? { note: d.note.trim() || null } : body();
      if (d.comment.trim()) patch.comment = d.comment.trim();
      await api.patchOmTask(task.plant_id, task.id, patch);
    });
  const setStatus = (status: NonNullable<OmTaskPatch["status"]>) =>
    run(() => api.patchOmTask(task!.plant_id, task!.id, { status, comment: d.comment.trim() || null }));
  const startDone = () => {
    const day = task!.start_day < today ? task!.start_day : today;
    const end = task!.end_day < today ? task!.end_day : today;
    setDone({ day, end_day: end < day ? day : end, cost: task!.est_cost_thb != null ? String(task!.est_cost_thb) : "", note: task!.note ?? "", close_issue: false });
    setMode("done");
  };
  const finish = () =>
    run(() =>
      api.finishOmTask(task!.plant_id, task!.id, {
        day: done.day,
        end_day: done.end_day,
        cost_thb: num(done.cost),
        note: done.note.trim() || null,
        close_issue: done.close_issue,
      })
    );

  const active = task && (task.status === "planned" || task.status === "in_progress");
  const plantName = task?.plant_name ?? plants.find((p) => p.plant_id === d.plant_id)?.name;

  const form = (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="space-y-1.5 sm:col-span-2">
        <Label htmlFor="om-plant">{t("Plant")}</Label>
        {task || target.lockPlant ? (
          <p className="text-sm">{plantName ?? t("Plant {id}", { id: d.plant_id })}</p>
        ) : (
          <PlantPicker id="om-plant" plants={plants} value={d.plant_id} onChange={(id) => set({ plant_id: id, device_sn: NONE, string_no: "", issue_id: NONE, assignee_ids: me != null ? [me] : [] })} />
        )}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="om-type">{t("Type")}</Label>
        <Select value={d.task_type} onValueChange={(v) => set({ task_type: v as OmTaskType })} disabled={locked}>
          <SelectTrigger id="om-type" size="sm" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TASK_TYPES.map((x) => (
              <SelectItem key={x.value} value={x.value}>
                {t(x.label)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="om-title">{t("Title (optional)")}</Label>
        <Input id="om-title" value={d.title} maxLength={160} onChange={(e) => set({ title: e.target.value })} disabled={locked} placeholder={t("e.g. Whole roof, wet clean")} />
      </div>
      <DayPicker id="om-start" label={t("Start")} value={d.start_day} disabled={locked} onChange={(v) => set({ start_day: v, end_day: d.end_day < v ? v : d.end_day })} />
      <DayPicker id="om-end" label={t("End")} value={d.end_day} min={d.start_day} disabled={locked} onChange={(v) => set({ end_day: v })} />
      <div className="space-y-1.5">
        <Label htmlFor="om-inv">{t("Inverter")}</Label>
        <Select value={d.device_sn} onValueChange={(v) => set({ device_sn: v, string_no: v === NONE ? "" : d.string_no })} disabled={locked || d.plant_id == null}>
          <SelectTrigger id="om-inv" size="sm" className="w-full">
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
        <Label htmlFor="om-string">{t("String (optional)")}</Label>
        <Input id="om-string" type="number" min={1} max={64} value={d.string_no} onChange={(e) => set({ string_no: e.target.value })} disabled={locked || d.device_sn === NONE} placeholder={t("PV no.")} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="om-team">{t("Team / crew")}</Label>
        <Select value={d.team_id} onValueChange={(v) => set({ team_id: v })} disabled={locked}>
          <SelectTrigger id="om-team" size="sm" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>{t("No team")}</SelectItem>
            {teams.map((x) => (
              <SelectItem key={x.id} value={String(x.id)}>
                {x.name}
                {x.active ? "" : ` ${t("(inactive)")}`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="om-cost">{t("Estimated cost (THB)")}</Label>
        <Input id="om-cost" type="number" min={0} value={d.est_cost_thb} onChange={(e) => set({ est_cost_thb: e.target.value })} disabled={locked} placeholder="—" />
      </div>
      <div className="space-y-1.5 sm:col-span-2">
        <Label>{t("Assignees")}</Label>
        {d.plant_id == null ? (
          <p className="text-xs text-muted-foreground">{t("Pick a plant first.")}</p>
        ) : pickable.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("Nobody can be assigned to this plant yet (an admin assigns plants in Users & Access).")}</p>
        ) : (
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {pickable.map((u) => {
              const on = d.assignee_ids.includes(u.id);
              return (
                <label key={u.id} className="flex items-center gap-2 text-xs">
                  <Checkbox
                    checked={on}
                    disabled={locked}
                    onCheckedChange={(c) => set({ assignee_ids: c ? [...d.assignee_ids, u.id] : d.assignee_ids.filter((x) => x !== u.id) })}
                  />
                  {personName(u)}
                  {u.id === me ? ` ${t("(you)")}` : ""}
                </label>
              );
            })}
          </div>
        )}
      </div>
      {(issues.length > 0 || d.issue_id !== NONE) && (
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="om-issue">{t("Answers issue (optional)")}</Label>
          <Select value={d.issue_id} onValueChange={(v) => set({ issue_id: v })} disabled={locked}>
            <SelectTrigger id="om-issue" size="sm" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>{t("No issue")}</SelectItem>
              {task?.issue && !issues.some((i) => i.id === task.issue!.id) && (
                <SelectItem value={String(task.issue.id)}>
                  #{task.issue.id} {task.issue.rule} ({task.issue.status})
                </SelectItem>
              )}
              {issues.map((i) => (
                <SelectItem key={i.id} value={String(i.id)}>
                  #{i.id} {i.rule} {i.name} · {i.inverter_name || i.device_sn || t("plant")}
                  {i.string_no != null ? ` · PV${i.string_no}` : ""}
                  {i.shadow ? ` ${t("(shadow)")}` : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      <div className="space-y-1.5 sm:col-span-2">
        <Label htmlFor="om-note">{t("Note")}</Label>
        <Textarea id="om-note" rows={2} maxLength={2000} value={d.note} onChange={(e) => set({ note: e.target.value })} />
      </div>
      {task && !locked && (
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="om-comment">{t("Reason for the change (optional, kept in the history)")}</Label>
          <Input id="om-comment" maxLength={2000} value={d.comment} onChange={(e) => set({ comment: e.target.value })} placeholder={t("e.g. moved: rain forecast")} />
        </div>
      )}
    </div>
  );

  const doneForm = task && (
    <div className="grid gap-3 sm:grid-cols-2">
      <p className="text-xs text-muted-foreground sm:col-span-2">
        {/* the type is bold, so the sentence is split at its placeholder (t() without vars keeps "{type}") */}
        {t("This writes a {type} event to the plant's Site log with the real dates (today or earlier). After that, only the task's note can change.")
          .split("{type}")
          .map((part, i) => (
            <React.Fragment key={i}>
              {i > 0 && <b>{t(task.label)}</b>}
              {part}
            </React.Fragment>
          ))}
      </p>
      <DayPicker id="om-done-day" label={t("Work started")} value={done.day} max={today} onChange={(v) => setDone((x) => ({ ...x, day: v, end_day: x.end_day < v ? v : x.end_day }))} />
      <DayPicker id="om-done-end" label={t("Work finished")} value={done.end_day} min={done.day} max={today} onChange={(v) => setDone((x) => ({ ...x, end_day: v }))} />
      <div className="space-y-1.5">
        <Label htmlFor="om-done-cost">{t("Cost paid (THB)")}</Label>
        <Input id="om-done-cost" type="number" min={0} value={done.cost} onChange={(e) => setDone((x) => ({ ...x, cost: e.target.value }))} placeholder="—" />
      </div>
      {task.issue_id != null && (
        <label className="flex items-center gap-2 self-end text-xs">
          <Checkbox checked={done.close_issue} onCheckedChange={(c) => setDone((x) => ({ ...x, close_issue: c === true }))} />
          {t("Resolve issue #{id} (confirmed)", { id: task.issue_id })}
        </label>
      )}
      <div className="space-y-1.5 sm:col-span-2">
        <Label htmlFor="om-done-note">{t("Note for the Site log")}</Label>
        <Textarea id="om-done-note" rows={2} maxLength={2000} value={done.note} onChange={(e) => setDone((x) => ({ ...x, note: e.target.value }))} />
      </div>
    </div>
  );

  const history = (
    <div className="max-h-80 space-y-2 overflow-y-auto text-xs">
      {!detail ? (
        <Spinner className="size-4" />
      ) : detail.history.length === 0 ? (
        <p className="text-muted-foreground">{t("No changes yet.")}</p>
      ) : (
        detail.history.map((h, i) => (
          <div key={i} className="border-b border-white/[0.06] pb-2">
            <div className="text-muted-foreground">
              {h.at ? new Date(h.at).toLocaleString(dateLocale(), { timeZone: "Asia/Bangkok", dateStyle: "medium", timeStyle: "short" }) : "—"} · {h.by ?? "—"}
            </div>
            <div>{changeText(h.change) || t("comment")}</div>
            {h.comment && <div className="text-muted-foreground">“{h.comment}”</div>}
          </div>
        ))
      )}
    </div>
  );

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{task ? (mode === "done" ? t("Mark done") : task.title || t(task.label)) : t("Plan a task")}</DialogTitle>
          <DialogDescription className="flex flex-wrap items-center gap-2">
            {task ? (
              <>
                <Badge variant={statusOf(task.status).variant}>{t(statusOf(task.status).label)}</Badge>
                {task.overdue && <Badge variant="crit">{t("Overdue")}</Badge>}
                <span>
                  {task.plant_name ?? t("Plant {id}", { id: task.plant_id })} · {dayLabel(task.start_day)}
                  {task.end_day !== task.start_day ? ` → ${dayLabel(task.end_day)}` : ""}
                </span>
                {task.site_event_id != null && (
                  <Link className="underline" to={`${plantPath(task.plant_id, "maintenance")}`} onClick={onClose}>
                    {t("Site log")}
                  </Link>
                )}
              </>
            ) : (
              t("Planned work on one plant. Dates may be in the future; mark it done when the work is finished.")
            )}
          </DialogDescription>
        </DialogHeader>

        {mode === "done" ? (
          doneForm
        ) : task ? (
          <Tabs defaultValue="details">
            <TabsList variant="line">
              <TabsTrigger value="details">{t("Details")}</TabsTrigger>
              <TabsTrigger value="history">{t("History")}</TabsTrigger>
            </TabsList>
            <TabsContent value="details" className="pt-3">
              {form}
            </TabsContent>
            <TabsContent value="history" className="pt-3">
              {history}
            </TabsContent>
          </Tabs>
        ) : (
          form
        )}

        {error && <p className="text-xs text-red-300">{error}</p>}

        <DialogFooter className="flex-wrap gap-2 sm:justify-between">
          <div className="flex flex-wrap gap-2">
            {mode === "edit" && task && detail?.can_delete && (
              <Button variant="destructive" size="sm" disabled={busy} onClick={() => run(() => api.deleteOmTask(task.plant_id, task.id))}>
                {t("Delete")}
              </Button>
            )}
            {mode === "edit" && task?.status === "planned" && (
              <Button variant="outline" size="sm" disabled={busy} onClick={() => setStatus("in_progress")}>
                {t("Start")}
              </Button>
            )}
            {mode === "edit" && active && (
              <>
                <Button variant="outline" size="sm" disabled={busy} onClick={() => setStatus("skipped")}>
                  {t("Skip")}
                </Button>
                <Button variant="outline" size="sm" disabled={busy} onClick={() => setStatus("cancelled")}>
                  {t("Cancel task")}
                </Button>
              </>
            )}
            {mode === "edit" && (task?.status === "skipped" || task?.status === "cancelled") && (
              <Button variant="outline" size="sm" disabled={busy} onClick={() => setStatus("planned")}>
                {t("Reopen")}
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            {mode === "done" ? (
              <>
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => setMode("edit")}>
                  {t("Back")}
                </Button>
                <Button size="sm" disabled={busy || !done.day} onClick={finish}>
                  {busy && <Spinner data-icon="inline-start" className="size-3" />}
                  {t("Mark done")}
                </Button>
              </>
            ) : (
              <>
                {active && (
                  <Button variant="accent" size="sm" disabled={busy} onClick={startDone}>
                    {t("Mark done…")}
                  </Button>
                )}
                <Button size="sm" disabled={busy || (!task && d.plant_id == null)} onClick={save}>
                  {busy && <Spinner data-icon="inline-start" className="size-3" />}
                  {task ? t("Save") : t("Plan task")}
                </Button>
              </>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
