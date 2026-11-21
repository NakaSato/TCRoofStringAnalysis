/** Plan a cleaning round (admin, Phase 2): choose the start, crews and working days, preview how the
 * plants spread over the days (longest-uncleaned first, grouped to keep travel short, tariff holidays
 * skipped), drop rows you don't want, then save them all as planned cleaning tasks. */
import React, { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { api } from "../../api/client";
import type { OmPerson, OmRoundPreview, OmTeam } from "../../api/client";
import { plantToday } from "../../context/alarmLogStore";
import { fmtInt } from "../../components/ui";
import { useI18n } from "@/i18n";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DayPicker } from "./fields";
import { personName, shortDay, spanLabel } from "./format";

const NONE = "__none";

export const RoundDialog: React.FC<{ plantIds: number[] | null; onClose: () => void; onSaved: (msg: string) => void }> = ({ plantIds, onClose, onSaved }) => {
  const { t } = useI18n();
  const today = plantToday();
  const open = plantIds != null;
  const [start, setStart] = useState(today);
  const [crews, setCrews] = useState(1);
  const [saturday, setSaturday] = useState(false);
  const [groupBy, setGroupBy] = useState<"city" | "phase" | "none">("city");
  const [title, setTitle] = useState("Cleaning round");
  const [teamId, setTeamId] = useState<number | null>(null);
  const [assignees, setAssignees] = useState<number[]>([]);
  const [users, setUsers] = useState<OmPerson[]>([]);
  const [teams, setTeams] = useState<OmTeam[]>([]);
  const [preview, setPreview] = useState<OmRoundPreview | null>(null);
  const [dropped, setDropped] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setPreview(null);
    setDropped(new Set());
    setError(null);
    setStart(plantToday());
    api
      .listOmAssignees()
      .then((a) => {
        setUsers(a.users);
        setTeams(a.teams);
      })
      .catch(() => undefined);
  }, [open]);

  const items = useMemo(() => (preview?.items ?? []).filter((x) => !dropped.has(x.plant_id)), [preview, dropped]);

  const runPreview = async () => {
    if (!plantIds) return;
    setBusy(true);
    setError(null);
    try {
      setPreview(await api.previewOmRound({ plant_ids: plantIds, start_day: start, crews, include_saturday: saturday, group_by: groupBy }));
      setDropped(new Set());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const out = await api.saveOmRound({
        title: title.trim() || null,
        team_id: teamId,
        assignee_ids: assignees,
        note: null,
        items: items.map((x) => ({ plant_id: x.plant_id, start_day: x.start_day, end_day: x.end_day, crew: crews > 1 ? x.crew : null })),
      });
      const left = Object.keys(out.dropped_assignees).length;
      onSaved(left ? t("Planned {n} cleaning tasks (assignees left off {left} plants they may not work on).", { n: out.created, left }) : t("Planned {n} cleaning tasks.", { n: out.created }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const cost = items.reduce((s, x) => s + (x.cost_thb ?? 0), 0);
  const costMissing = items.filter((x) => x.cost_thb == null).length;
  const noDuration = items.filter((x) => !x.duration_set).length;
  const already = items.filter((x) => x.already_planned).length;
  const end = items.reduce<string | null>((m, x) => (m == null || x.end_day > m ? x.end_day : m), null);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("Plan a cleaning round")}</DialogTitle>
          <DialogDescription>
            {t(
              "{n} plants. Longest without a recorded cleaning goes first; none recorded counts as most urgent. Public holidays from the tariff setting are skipped.",
              { n: plantIds?.length ?? 0 }
            )}
          </DialogDescription>
        </DialogHeader>

        {error && <p className="text-xs text-red-300">{error}</p>}

        {!preview ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <DayPicker id="round-start" label={t("Start on")} value={start} min={today} onChange={setStart} />
            <div className="space-y-1.5">
              <Label htmlFor="round-crews">{t("Crews working at once")}</Label>
              <Input id="round-crews" type="number" min={1} max={20} value={crews} onChange={(e) => setCrews(Math.min(20, Math.max(1, Number(e.target.value) || 1)))} className="num w-24" />
              <p className="text-[11px] text-muted-foreground">{t("Each crew cleans one plant at a time. A plant takes its entered crew-days; not entered = 1 day.")}</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="round-group">{t("Keep together")}</Label>
              <Select value={groupBy} onValueChange={(v) => setGroupBy(v as "city" | "phase" | "none")}>
                <SelectTrigger id="round-group" size="sm" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="city">{t("Plants in the same province")}</SelectItem>
                  <SelectItem value="phase">{t("Plants of the same phase")}</SelectItem>
                  <SelectItem value="none">{t("No grouping (strict priority)")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <label className="flex items-center gap-2 self-end pb-2 text-xs">
              <Checkbox checked={saturday} onCheckedChange={(c) => setSaturday(c === true)} />
              {t("Work Saturdays too (Mon–Fri by default)")}
            </label>
            <div className="space-y-1.5">
              <Label htmlFor="round-title">{t("Task title")}</Label>
              <Input id="round-title" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="round-team">{t("Team / crew")}</Label>
              <Select value={teamId == null ? NONE : String(teamId)} onValueChange={(v) => setTeamId(v === NONE ? null : Number(v))}>
                <SelectTrigger id="round-team" size="sm" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>{t("No team")}</SelectItem>
                  {teams.map((x) => (
                    <SelectItem key={x.id} value={String(x.id)}>
                      {x.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label>{t("Assignees")}</Label>
              <div className="flex flex-wrap gap-x-4 gap-y-2">
                {users.map((u) => (
                  <label key={u.id} className="flex items-center gap-2 text-xs">
                    <Checkbox checked={assignees.includes(u.id)} onCheckedChange={(c) => setAssignees(c ? [...assignees, u.id] : assignees.filter((x) => x !== u.id))} />
                    {personName(u)}
                  </label>
                ))}
              </div>
              <p className="text-[11px] text-muted-foreground">{t("Each task gets those of them who may work on its plant.")}</p>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs">
              <span>
                <span className="num font-medium">{items.length}</span> {t("plants")}
              </span>
              {end && (
                <span className="num">
                  {shortDay(preview.start_day)} → {shortDay(end)}
                </span>
              )}
              <span>
                {t(crews > 1 ? "{n} crews" : "{n} crew", { n: crews })}
              </span>
              <span className="num">
                {t("Est. cost")} {costMissing === items.length ? "—" : `฿${fmtInt(cost)}`}
                {costMissing > 0 && costMissing < items.length ? ` + ${t("{n} not entered", { n: costMissing })}` : ""}
              </span>
            </div>
            {(noDuration > 0 || already > 0 || preview.holidays_skipped.length > 0) && (
              <div className="flex flex-wrap gap-2">
                {noDuration > 0 && <Badge variant="warn">{t("{n} without crew-days: counted as 1 day", { n: noDuration })}</Badge>}
                {already > 0 && <Badge variant="warn">{t("{n} already have a cleaning planned", { n: already })}</Badge>}
                {preview.holidays_skipped.length > 0 && <Badge variant="neutral">{t("Holidays skipped: {days}", { days: preview.holidays_skipped.map(shortDay).join(", ") })}</Badge>}
              </div>
            )}
            {preview.unscheduled.length > 0 && (
              <Alert>
                <AlertDescription>
                  {t("{n} plants don't fit within 120 days: {names}. Add crews or plan them in another round.", {
                    n: preview.unscheduled.length,
                    names: preview.unscheduled.map((u) => u.name).join(", "),
                  })}
                </AlertDescription>
              </Alert>
            )}
            {preview.too_long.length > 0 && (
              <Alert>
                <AlertDescription>
                  {t(
                    preview.too_long.length === 1
                      ? "Left out: {names}. Each one's crew-days would make a single task last {days} days or more. Plan it as separate tasks."
                      : "Left out: {names}. Each one's crew-days would make a single task last {days} days or more. Plan them as separate tasks.",
                    { names: preview.too_long.map((u) => u.name).join(", "), days: preview.max_task_days }
                  )}
                </AlertDescription>
              </Alert>
            )}
            <Table containerClassName="table-wrap max-h-[50vh]">
              <TableHeader>
                <TableRow>
                  {crews > 1 && <TableHead>{t("Crew")}</TableHead>}
                  <TableHead>{t("Days")}</TableHead>
                  <TableHead>{t("Plant")}</TableHead>
                  <TableHead>{t("Since cleaning")}</TableHead>
                  <TableHead className="text-right">{t("Crew-days")}</TableHead>
                  <TableHead className="text-right">{t("Est. cost")}</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((x) => (
                  <TableRow key={x.plant_id}>
                    {crews > 1 && <TableCell className="num">{x.crew}</TableCell>}
                    <TableCell className="num whitespace-nowrap">{spanLabel(x)}</TableCell>
                    <TableCell className="max-w-56">
                      <div className="truncate">{x.plant_name}</div>
                      <div className="text-[11px] text-muted-foreground">
                        {[x.city, x.phase != null ? t("Phase {n}", { n: x.phase }) : null].filter(Boolean).join(" · ")}
                        {x.already_planned && <span className="text-amber-300"> · {t("cleaning already planned {day}", { day: shortDay(x.already_planned) })}</span>}
                      </div>
                    </TableCell>
                    <TableCell className="num">{x.days_since_cleaning == null ? <span className="text-muted-foreground">{t("None recorded")}</span> : t("{n} d", { n: fmtInt(x.days_since_cleaning) })}</TableCell>
                    <TableCell className="num text-right">{x.duration_set ? x.crew_days : <span className="text-amber-300" title={t("Not entered: counted as 1 day")}>1*</span>}</TableCell>
                    <TableCell className="num text-right">{x.cost_thb == null ? "—" : `฿${fmtInt(x.cost_thb)}`}</TableCell>
                    <TableCell className="w-8">
                      <Button variant="ghost" size="icon-sm" aria-label={t("Leave {name} out", { name: x.plant_name })} onClick={() => setDropped(new Set([...dropped, x.plant_id]))}>
                        <X />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {dropped.size > 0 && (
              <p className="text-[11px] text-muted-foreground">
                {t("{n} left out (their days stay free; preview again to close the gaps).", { n: dropped.size })}{" "}
                <button type="button" className="underline" onClick={() => setDropped(new Set())}>
                  {t("Put them back")}
                </button>
              </p>
            )}
          </div>
        )}

        <DialogFooter className="gap-2">
          {preview ? (
            <>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => setPreview(null)}>
                {t("Back")}
              </Button>
              <Button size="sm" disabled={busy || items.length === 0} onClick={() => void save()}>
                {busy && <Spinner data-icon="inline-start" className="size-3" />}
                {t("Plan {n} tasks", { n: items.length })}
              </Button>
            </>
          ) : (
            <Button size="sm" disabled={busy || !plantIds?.length} onClick={() => void runPreview()}>
              {busy && <Spinner data-icon="inline-start" className="size-3" />}
              {t("Preview")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
