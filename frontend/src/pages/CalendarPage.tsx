/**
 * Operations → Calendar (`/calendar`, everyone): the team's planned O&M work (cleaning, PM,
 * repairs, …) per plant. DB only. Month grid, week lanes (one row per person / team, double
 * bookings marked) and a list; drag a planned task to another day to move it. Engineers see full
 * tasks on their plants and masked "Busy" blocks for work elsewhere; they open on their own tasks
 * (`user=me`). A done task writes the Site log event. "Due" is the monthly plan per plant (last /
 * next cleaning, overdue work), where admins plan cleaning rounds; "Plans" holds the recurring
 * plans. Pieces in `pages/calendar/`; docs/plans/calendar-team.md.
 *
 * URL: `view` (month | week | list | due), `d` (a day in the period), `type`, `status`, `team`,
 * `user` (me | all | id; default me for engineers, all for admins), `plant`; Due adds `show`, `days`, `q`.
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarPlus, ChevronLeft, ChevronRight, Plus, Repeat, Users } from "lucide-react";
import { api } from "../api/client";
import type { OmAssignees, OmTask, OmTaskList, OmTaskStatus, OmTaskType } from "../api/client";
import { useAppContext } from "../context/AppContext";
import { isAdmin } from "../auth/access";
import { plantToday } from "../context/alarmLogStore";
import { pick, pickDay, useUrlState } from "@/lib/useUrlState";
import { cn } from "@/lib/utils";
import { fmtInt } from "../components/ui";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PlantPicker } from "./calendar/fields";
import { TaskDialog } from "./calendar/TaskDialog";
import { TeamsDialog } from "./calendar/TeamsDialog";
import { PlansDialog } from "./calendar/PlansDialog";
import { FeedDialog } from "./calendar/FeedDialog";
import { RoundDialog } from "./calendar/RoundDialog";
import { DueView } from "./calendar/DueView";
import type { TaskDialogTarget } from "./calendar/TaskDialog";
import { MonthGrid, TaskList, WeekLanes } from "./calendar/views";
import { STATUSES, STATUS_KEYS, TASK_TYPES, TYPE_KEYS, VIEWS, addDays, addMonths, monthLabel, personName, rangeFor, tasksCsv, weekLabel, weekStart } from "./calendar/format";
import type { View } from "./calendar/format";

const ALL = "all";

const Stat: React.FC<{ label: string; value: number | null; tone?: string; onClick?: () => void; active?: boolean }> = ({ label, value, tone, onClick, active }) => (
  <button type="button" onClick={onClick} className={cn("flex flex-col gap-1 px-5 py-3 text-left transition-colors hover:bg-muted", active && "bg-muted")}>
    <span className="eyebrow">{label}</span>
    <span className={cn("num text-2xl font-bold tracking-tight", value ? tone : "text-muted-foreground")}>{value == null ? "—" : fmtInt(value)}</span>
  </button>
);

export const CalendarPage: React.FC = () => {
  const { user, growattPlants } = useAppContext();
  const admin = isAdmin(user);
  const me = user?.id;
  const [url, setUrl] = useUrlState();
  const today = plantToday();
  const view = pick(url.get("view"), VIEWS, "month") as View;
  const day = pickDay(url.get("d")) ?? today;
  const type = pick(url.get("type"), [ALL, ...TYPE_KEYS] as const, ALL);
  const status = pick(url.get("status"), [ALL, "overdue", ...STATUS_KEYS] as const, ALL);
  const userDefault = admin ? "all" : "me";
  const userParam = url.get("user") ?? userDefault;
  const userId = userParam === "me" ? me : /^\d+$/.test(userParam) ? Number(userParam) : undefined;
  const teamId = /^\d+$/.test(url.get("team") ?? "") ? Number(url.get("team")) : undefined;
  const plantId = /^\d+$/.test(url.get("plant") ?? "") ? Number(url.get("plant")) : undefined;
  const { from, to } = rangeFor(view, day);

  const [data, setData] = useState<OmTaskList | null>(null);
  const [lanes, setLanes] = useState<OmAssignees | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<TaskDialogTarget | null>(null);
  const [teamsOpen, setTeamsOpen] = useState(false);
  const [plansOpen, setPlansOpen] = useState(false);
  const [feedOpen, setFeedOpen] = useState(false);
  const [round, setRound] = useState<number[] | null>(null);
  const [dueVersion, setDueVersion] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [lanesVersion, setLanesVersion] = useState(0);

  const load = useCallback(async () => {
    if (view === "due") {
      setDueVersion((v) => v + 1);
      return;
    }
    setLoading(true);
    try {
      const out = await api.listOmTasks({
        from,
        to,
        plant_id: plantId,
        type: type === ALL ? undefined : (type as OmTaskType),
        status: status === ALL || status === "overdue" ? undefined : (status as OmTaskStatus),
        overdue: status === "overdue" || undefined,
        user_id: userId,
        team_id: teamId,
      });
      setData(out);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [view, from, to, plantId, type, status, userId, teamId]);

  useEffect(() => {
    if (view !== "due") void load(); // Due loads by itself; Refresh bumps it through load()
  }, [load, view]);

  useEffect(() => {
    let live = true;
    api.listOmAssignees().then((x) => live && setLanes(x)).catch(() => live && setLanes(null));
    return () => {
      live = false;
    };
  }, [lanesVersion]);

  const tasks = useMemo(() => data?.tasks ?? [], [data]);
  const lanePeople = useMemo(() => {
    const all = lanes?.users ?? [];
    return userId != null ? all.filter((u) => u.id === userId) : all;
  }, [lanes, userId]);

  const step = (n: number) => {
    const next = view === "week" ? addDays(weekStart(day), 7 * n) : addMonths(day, n);
    setUrl({ d: next === today ? null : next });
  };
  const periodLabel = view === "week" ? weekLabel(weekStart(day)) : monthLabel(day);
  const open = (t: OmTask) => setDialog({ task: t });
  const move = async (t: OmTask, d: string) => {
    try {
      await api.patchOmTask(t.plant_id, t.id, { start_day: d });
      setNotice(`Moved "${t.title || t.label}" (${t.plant_name ?? t.plant_id}) to ${d}.`);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    void load();
  };
  const create = (d?: string) => setDialog({ task: null, day: d && d >= today ? d : today, plantId: plantId ?? null });

  const exportCsv = () => {
    const blob = new Blob([tasksCsv(tasks)], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `om-tasks_${from}_${to}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const s = data?.summary;
  const n = (k: OmTaskStatus) => (s ? s.by_status[k] ?? 0 : null);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col">
          <h1 className="text-lg font-semibold">Calendar</h1>
          <p className="text-xs text-muted-foreground">Planned O&M work: cleaning rounds, PM and repairs, by week and month</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            {loading && <Spinner data-icon="inline-start" className="size-3" />}
            {loading ? "Refreshing…" : "Refresh"}
          </Button>
          <Button variant="outline" size="sm" onClick={() => setPlansOpen(true)}>
            <Repeat data-icon="inline-start" />
            Plans
          </Button>
          <Button variant="outline" size="sm" onClick={() => setFeedOpen(true)}>
            <CalendarPlus data-icon="inline-start" />
            Subscribe
          </Button>
          {admin && (
            <Button variant="outline" size="sm" onClick={() => setTeamsOpen(true)}>
              <Users data-icon="inline-start" />
              Teams
            </Button>
          )}
          <Button size="sm" onClick={() => create()}>
            <Plus data-icon="inline-start" />
            Plan task
          </Button>
        </div>
      </div>

      {notice && !error && (
        <Alert>
          <AlertDescription className="flex items-center justify-between gap-2">
            {notice}
            <Button variant="ghost" size="xs" onClick={() => setNotice(null)}>
              Dismiss
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertTitle>Could not load the calendar</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {view !== "due" && (
      <Card className="py-0">
        <CardContent className="grid grid-cols-2 divide-white/[0.06] px-0 sm:grid-cols-5 lg:divide-x">
          <Stat label="Tasks" value={data?.total ?? null} tone="text-foreground" onClick={() => setUrl({ status: null })} active={status === ALL} />
          <Stat label="Planned" value={n("planned")} tone="text-sky-300" onClick={() => setUrl({ status: "planned" })} active={status === "planned"} />
          <Stat label="In progress" value={n("in_progress")} tone="text-amber-300" onClick={() => setUrl({ status: "in_progress" })} active={status === "in_progress"} />
          <Stat label="Done" value={n("done")} tone="text-emerald-300" onClick={() => setUrl({ status: "done" })} active={status === "done"} />
          <Stat label="Overdue" value={s?.overdue ?? null} tone="text-red-300" onClick={() => setUrl({ status: "overdue" })} active={status === "overdue"} />
        </CardContent>
      </Card>
      )}

      <Card>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-1">
              <Button variant="outline" size="icon-sm" onClick={() => step(-1)} aria-label="Previous">
                <ChevronLeft />
              </Button>
              <Button variant="outline" size="sm" onClick={() => setUrl({ d: null })} disabled={day === today}>
                Today
              </Button>
              <Button variant="outline" size="icon-sm" onClick={() => step(1)} aria-label="Next">
                <ChevronRight />
              </Button>
              <span className="ml-2 text-sm font-medium">{periodLabel}</span>
            </div>
            <Tabs value={view} onValueChange={(v) => setUrl({ view: v === "month" ? null : v })}>
              <TabsList variant="line">
                <TabsTrigger value="month">Month</TabsTrigger>
                <TabsTrigger value="week">Week</TabsTrigger>
                <TabsTrigger value="list">List</TabsTrigger>
                <TabsTrigger value="due">Due</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>

          {view !== "due" && (
          <div className="flex flex-wrap items-center gap-2">
            <Select value={userParam} onValueChange={(v) => setUrl({ user: v === userDefault ? null : v })}>
              <SelectTrigger size="sm" className="w-44" aria-label="Person">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="me">My tasks</SelectItem>
                <SelectItem value="all">Everyone</SelectItem>
                {(lanes?.users ?? [])
                  .filter((u) => u.id !== me)
                  .map((u) => (
                    <SelectItem key={u.id} value={String(u.id)}>
                      {personName(u)}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            <Select value={teamId != null ? String(teamId) : ALL} onValueChange={(v) => setUrl({ team: v === ALL ? null : v })}>
              <SelectTrigger size="sm" className="w-40" aria-label="Team">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All teams</SelectItem>
                {(lanes?.teams ?? []).map((t) => (
                  <SelectItem key={t.id} value={String(t.id)}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={type} onValueChange={(v) => setUrl({ type: v === ALL ? null : v })}>
              <SelectTrigger size="sm" className="w-40" aria-label="Task type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All types</SelectItem>
                {TASK_TYPES.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={status} onValueChange={(v) => setUrl({ status: v === ALL ? null : v })}>
              <SelectTrigger size="sm" className="w-36" aria-label="Status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All statuses</SelectItem>
                <SelectItem value="overdue">Overdue</SelectItem>
                {STATUSES.map((x) => (
                  <SelectItem key={x.value} value={x.value}>
                    {x.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <PlantPicker
              id="cal-plant"
              plants={growattPlants}
              value={plantId ?? null}
              onChange={(id) => setUrl({ plant: id })}
              placeholder="All plants"
              allowAll
              className="w-52 justify-between"
            />
            {view === "list" && (
              <Button variant="outline" size="sm" className="ml-auto" onClick={exportCsv} disabled={!tasks.length}>
                Export CSV
              </Button>
            )}
          </div>
          )}

          {view === "due" ? (
            <DueView month={day} admin={admin} version={dueVersion} onPlanRound={setRound} />
          ) : !data && loading ? (
            <div className="flex h-40 items-center justify-center">
              <Spinner className="size-5" />
            </div>
          ) : view === "month" ? (
            <MonthGrid
              from={from}
              month={day}
              today={today}
              tasks={tasks}
              onOpen={open}
              onCreate={create}
              onShowDay={(d) => setUrl({ view: "week", d })}
              onMove={move}
            />
          ) : view === "week" ? (
            <WeekLanes from={from} today={today} tasks={tasks} busy={data?.busy ?? []} people={lanePeople} teams={lanes?.teams ?? []} only={userId} me={me} onOpen={open} onCreate={create} onMove={move} />
          ) : (
            <TaskList tasks={tasks} onOpen={open} />
          )}
          {view === "week" && !admin && (data?.busy.length ?? 0) > 0 && (
            <p className="text-[11px] text-muted-foreground">“Busy” = work on a plant you are not assigned to: only the dates are shown.</p>
          )}
        </CardContent>
      </Card>

      <FeedDialog open={feedOpen} onClose={() => setFeedOpen(false)} />
      <PlansDialog open={plansOpen} admin={admin} plants={growattPlants} onClose={() => setPlansOpen(false)} onChanged={() => void load()} />
      {admin && (
        <RoundDialog
          plantIds={round}
          onClose={() => setRound(null)}
          onSaved={(msg) => {
            setRound(null);
            setNotice(msg);
            setDueVersion((v) => v + 1);
          }}
        />
      )}
      {admin && (
        <TeamsDialog
          open={teamsOpen}
          onClose={() => setTeamsOpen(false)}
          onChanged={() => {
            setLanesVersion((v) => v + 1);
            void load();
          }}
        />
      )}
      <TaskDialog target={dialog} plants={growattPlants} me={me} admin={admin} onClose={() => setDialog(null)} onChanged={() => void load()} />
    </div>
  );
};
