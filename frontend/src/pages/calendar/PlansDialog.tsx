/** Calendar Team recurring plans (Phase 2). Admins create and edit them; engineers read the plans
 * covering their plants. Saving generates the plan's planned tasks for the next 90 days (the
 * worker keeps them topped up nightly); tasks someone moved, started or finished never change. */
import React, { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { api } from "../../api/client";
import type { GrowattPlant, OmPerson, OmPlan, OmPlanBody, OmPlanPreset, OmTaskType, OmTeam } from "../../api/client";
import { plantToday } from "../../context/alarmLogStore";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { DayPicker, PlantMultiPicker } from "./fields";
import { MONTHS, TASK_TYPES, TYPE_CHIP, WEEKDAY_NAMES, personName, planRule, shortDay } from "./format";

const NONE = "__none";

type Draft = OmPlanBody & { id: number | null };

const fromPlan = (p: OmPlan): Draft => ({
  id: p.id,
  name: p.name,
  task_type: p.task_type,
  every_n: p.every_n,
  unit: p.unit,
  season_from_month: p.season_from_month,
  season_to_month: p.season_to_month,
  weekday: p.weekday,
  duration_days: p.duration_days,
  default_team_id: p.team?.id ?? null,
  assignee_ids: p.assignees.map((a) => a.id),
  plant_ids: p.plant_ids,
  starts_on: p.starts_on,
  ends_on: p.ends_on,
  active: p.active,
  note: p.note,
});

const fromPreset = (x: OmPlanPreset | null, today: string): Draft => ({
  id: null,
  name: x?.name ?? "",
  task_type: x?.task_type ?? "cleaning",
  every_n: x?.every_n ?? 1,
  unit: x?.unit ?? "month",
  season_from_month: x?.season_from_month ?? null,
  season_to_month: x?.season_to_month ?? null,
  weekday: null,
  duration_days: x?.duration_days ?? 1,
  default_team_id: null,
  assignee_ids: [],
  plant_ids: [],
  starts_on: today,
  ends_on: null,
  active: true,
  note: null,
});

export const PlansDialog: React.FC<{
  open: boolean;
  admin: boolean;
  plants: GrowattPlant[];
  onClose: () => void;
  onChanged: () => void;
}> = ({ open, admin, plants, onClose, onChanged }) => {
  const today = plantToday();
  const [plans, setPlans] = useState<OmPlan[] | null>(null);
  const [presets, setPresets] = useState<OmPlanPreset[]>([]);
  const [users, setUsers] = useState<OmPerson[]>([]);
  const [teams, setTeams] = useState<OmTeam[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = async () => {
    try {
      const [p, a] = await Promise.all([api.listOmPlans(), api.listOmAssignees()]);
      setPlans(p.plans);
      setPresets(p.presets);
      setUsers(a.users);
      setTeams(a.teams);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    if (!open) return;
    setDraft(null);
    setPlans(null);
    setNotice(null);
    void load();
  }, [open]);

  const edit = (d: Draft) => {
    setConfirmDelete(false);
    setError(null);
    setNotice(null);
    setDraft(d);
  };
  const set = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));

  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    try {
      const msg = await fn();
      setDraft(null);
      setConfirmDelete(false);
      setNotice(msg);
      await load();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const save = () => {
    if (!draft) return;
    const { id, ...body } = draft;
    const clean: OmPlanBody = { ...body, name: body.name.trim(), note: body.note?.trim() || null };
    void run(async () => {
      const out = id == null ? await api.createOmPlan(clean) : await api.patchOmPlan(id, clean);
      const r = out.result;
      const parts = [r.created && `${r.created} created`, r.updated && `${r.updated} updated`, r.deleted && `${r.deleted} removed`].filter(Boolean);
      return `Saved "${out.name}": ${parts.length ? parts.join(", ") : "no task changes"} in the next 90 days.`;
    });
  };

  const valid = !!draft && draft.name.trim() !== "" && draft.plant_ids.length > 0 && draft.every_n >= 1 && (draft.season_from_month == null) === (draft.season_to_month == null);
  const people = users.filter((u) => u.role === "admin" || u.role === "engineer");

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{draft ? (draft.id == null ? "New recurring plan" : "Edit plan") : "Recurring plans"}</DialogTitle>
          <DialogDescription>
            {draft
              ? "Tasks are planned up to 90 days ahead and topped up every night. Tasks someone moved, started or finished are never changed."
              : admin
                ? "Repeating work, such as cleaning every 2 months in the dry season. Each plan keeps its tasks planned 90 days ahead."
                : "Repeating work planned on your plants. Admins set the plans."}
          </DialogDescription>
        </DialogHeader>

        {error && <p className="text-xs text-red-300">{error}</p>}
        {notice && !draft && <p className="text-xs text-emerald-300">{notice}</p>}

        {!draft ? (
          plans == null ? (
            <div className="flex h-24 items-center justify-center">
              <Spinner className="size-4" />
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {plans.length === 0 ? (
                <p className="py-4 text-center text-sm text-muted-foreground">No plans yet.</p>
              ) : (
                <ul className="divide-y divide-white/[0.06] rounded-md border border-white/[0.06]">
                  {plans.map((p) => (
                    <li key={p.id}>
                      <button
                        type="button"
                        disabled={!admin}
                        onClick={() => edit(fromPlan(p))}
                        className="flex w-full flex-col gap-1 px-3 py-2 text-left enabled:hover:bg-white/[0.03]"
                      >
                        <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                          <span className={cn("rounded border px-1 text-[10px]", TYPE_CHIP[p.task_type])}>{p.label}</span>
                          {p.name}
                          {!p.active && <Badge variant="outline">Paused</Badge>}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {planRule(p)} · {p.plants.length === 1 ? (p.plants[0].name ?? `Plant ${p.plants[0].plant_id}`) : `${p.plants.length} plants`}
                          {p.team ? ` · ${p.team.name}` : ""}
                        </div>
                        <div className="num text-[11px] text-muted-foreground">
                          {p.next_days.length ? `Next: ${p.next_days.map(shortDay).join(", ")}` : "No upcoming days"} · {p.upcoming_tasks} planned tasks
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {admin && presets.length > 0 && (
                <div className="flex flex-col gap-1.5">
                  <span className="eyebrow">Start from a preset</span>
                  <div className="flex flex-wrap gap-2">
                    {presets.map((x) => (
                      <Button key={x.key} variant="outline" size="sm" onClick={() => edit(fromPreset(x, today))}>
                        {x.name}
                      </Button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="plan-name">Name</Label>
              <Input id="plan-name" value={draft.name} maxLength={120} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Dry-season cleaning, phase 1" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="plan-type">Task type</Label>
              <Select value={draft.task_type} onValueChange={(v) => set({ task_type: v as OmTaskType })}>
                <SelectTrigger id="plan-type" size="sm" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TASK_TYPES.map((t) => (
                    <SelectItem key={t.value} value={t.value}>
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="plan-plants">Plants</Label>
              <PlantMultiPicker id="plan-plants" plants={plants} value={draft.plant_ids} onChange={(ids) => set({ plant_ids: ids })} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="plan-every">Repeat every</Label>
              <div className="flex gap-2">
                <Input
                  id="plan-every"
                  type="number"
                  min={1}
                  max={draft.unit === "week" ? 104 : 36}
                  value={draft.every_n}
                  onChange={(e) => set({ every_n: Math.max(1, Number(e.target.value) || 1) })}
                  className="num w-20"
                />
                <Select value={draft.unit} onValueChange={(v) => set({ unit: v as "week" | "month" })}>
                  <SelectTrigger size="sm" className="flex-1" aria-label="Unit">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="week">{draft.every_n === 1 ? "week" : "weeks"}</SelectItem>
                    <SelectItem value="month">{draft.every_n === 1 ? "month" : "months"}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="plan-weekday">On</Label>
              <Select value={draft.weekday == null ? NONE : String(draft.weekday)} onValueChange={(v) => set({ weekday: v === NONE ? null : Number(v) })}>
                <SelectTrigger id="plan-weekday" size="sm" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>First working day (Mon–Fri, not a holiday)</SelectItem>
                  {WEEKDAY_NAMES.map((w, i) => (
                    <SelectItem key={w} value={String(i)}>
                      {w}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Season</Label>
              <div className="flex items-center gap-2">
                <Select
                  value={draft.season_from_month == null ? NONE : String(draft.season_from_month)}
                  onValueChange={(v) =>
                    v === NONE ? set({ season_from_month: null, season_to_month: null }) : set({ season_from_month: Number(v), season_to_month: draft.season_to_month ?? Number(v) })
                  }
                >
                  <SelectTrigger size="sm" className="flex-1" aria-label="Season from">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>All year</SelectItem>
                    {MONTHS.map((m, i) => (
                      <SelectItem key={m} value={String(i + 1)}>
                        From {m}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {draft.season_from_month != null && (
                  <Select value={String(draft.season_to_month ?? draft.season_from_month)} onValueChange={(v) => set({ season_to_month: Number(v) })}>
                    <SelectTrigger size="sm" className="flex-1" aria-label="Season to">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {MONTHS.map((m, i) => (
                        <SelectItem key={m} value={String(i + 1)}>
                          to {m}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="plan-duration">Each task takes (days)</Label>
              <Input
                id="plan-duration"
                type="number"
                min={1}
                max={31}
                value={draft.duration_days}
                onChange={(e) => set({ duration_days: Math.min(31, Math.max(1, Number(e.target.value) || 1)) })}
                className="num w-24"
              />
            </div>
            <DayPicker id="plan-start" label="Starts on" value={draft.starts_on} onChange={(d) => set({ starts_on: d, ends_on: draft.ends_on && draft.ends_on < d ? null : draft.ends_on })} />
            <div className="space-y-1.5">
              <DayPicker id="plan-end" label="Ends on (optional)" value={draft.ends_on} min={draft.starts_on} onChange={(d) => set({ ends_on: d })} />
              {draft.ends_on && (
                <Button variant="ghost" size="xs" onClick={() => set({ ends_on: null })}>
                  No end
                </Button>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="plan-team">Team / crew</Label>
              <Select value={draft.default_team_id == null ? NONE : String(draft.default_team_id)} onValueChange={(v) => set({ default_team_id: v === NONE ? null : Number(v) })}>
                <SelectTrigger id="plan-team" size="sm" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>No team</SelectItem>
                  {teams.map((t) => (
                    <SelectItem key={t.id} value={String(t.id)}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label>Assignees</Label>
              <p className="text-[11px] text-muted-foreground">Each task gets those of them who may work on its plant (admins, or engineers assigned to it).</p>
              <div className="flex flex-wrap gap-x-4 gap-y-2">
                {people.map((u) => (
                  <label key={u.id} className="flex items-center gap-2 text-xs">
                    <Checkbox
                      checked={draft.assignee_ids.includes(u.id)}
                      onCheckedChange={(c) => set({ assignee_ids: c ? [...draft.assignee_ids, u.id] : draft.assignee_ids.filter((x) => x !== u.id) })}
                    />
                    {personName(u)}
                  </label>
                ))}
              </div>
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="plan-note">Note</Label>
              <Textarea id="plan-note" rows={2} value={draft.note ?? ""} maxLength={2000} onChange={(e) => set({ note: e.target.value })} />
            </div>
            <label className="flex items-center gap-2 text-xs sm:col-span-2">
              <Checkbox checked={draft.active} onCheckedChange={(c) => set({ active: c === true })} />
              Active (a paused plan removes its untouched future tasks)
            </label>
          </div>
        )}

        {(admin || draft) && (
        <DialogFooter className="flex-wrap gap-2 sm:justify-between">
          <div className="flex gap-2">
            {draft?.id != null &&
              (confirmDelete ? (
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      const r = await api.deleteOmPlan(draft.id!);
                      return `Plan deleted: ${r.deleted} untouched future tasks removed, ${r.kept} kept as one-off tasks.`;
                    })
                  }
                >
                  Delete plan and its untouched future tasks
                </Button>
              ) : (
                <Button variant="outline" size="sm" disabled={busy} onClick={() => setConfirmDelete(true)}>
                  Delete…
                </Button>
              ))}
          </div>
          <div className="flex gap-2">
            {draft ? (
              <>
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => setDraft(null)}>
                  Back
                </Button>
                <Button size="sm" disabled={busy || !valid} onClick={save}>
                  {busy && <Spinner data-icon="inline-start" className="size-3" />}
                  {draft.id == null ? "Create plan" : "Save"}
                </Button>
              </>
            ) : (
              admin && (
                <Button size="sm" onClick={() => edit(fromPreset(null, today))} disabled={plans == null}>
                  <Plus data-icon="inline-start" />
                  New plan
                </Button>
              )
            )}
          </div>
        </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
};
