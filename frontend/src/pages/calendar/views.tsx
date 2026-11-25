/** Calendar Team views: month grid, week lanes (one row per person / team) and the task list.
 * Planned / started tasks can be dragged to another day in the month and week views (keeps the
 * task's length; `onMove`). */
import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Route } from "lucide-react";
import type { OmBusyBlock, OmCleaningSuggestion, OmPerson, OmTask, OmTeam } from "../../api/client";
import { SuggestionChip } from "./Suggestions";
import { plantPath } from "../../context/routes";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n";
import { fmtInt } from "../../components/ui";
import { TablePager, pageBounds } from "../../components/TablePager";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { BUSY_CHIP, TYPE_CHIP, WEEKDAYS, addDays, weekdayName, covers, daysBetween, personName, spanLabel, statusChip, statusOf, taskTitle, taskWhere } from "./format";

const MAX_CHIPS = 3;
const DRAG_TYPE = "application/x-om-task";

const movable = (t: OmTask) => t.status === "planned" || t.status === "in_progress";

/** drop-target props for a day cell: highlights while a task hovers it, calls `onMove` on drop */
function useDrop(tasks: OmTask[], onMove?: (t: OmTask, day: string) => void) {
  const [over, setOver] = useState<string | null>(null);
  const props = (day: string) =>
    onMove
      ? {
          onDragOver: (e: React.DragEvent) => {
            if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            if (over !== day) setOver(day);
          },
          onDragLeave: () => setOver((d) => (d === day ? null : d)),
          onDrop: (e: React.DragEvent) => {
            setOver(null);
            const id = Number(e.dataTransfer.getData(DRAG_TYPE));
            const t = tasks.find((x) => x.id === id);
            if (!t) return;
            e.preventDefault();
            if (t.start_day !== day) onMove(t, day);
          },
        }
      : {};
  return { over, props };
}

const Chip: React.FC<{ task: OmTask; onOpen: (t: OmTask) => void; showPlant?: boolean; draggable?: boolean }> = ({ task, onOpen, showPlant = true, draggable }) => {
  const { t } = useI18n();
  return (
  <button
    type="button"
    draggable={draggable && movable(task)}
    onDragStart={(e) => {
      e.dataTransfer.setData(DRAG_TYPE, String(task.id));
      e.dataTransfer.effectAllowed = "move";
    }}
    onClick={(e) => {
      e.stopPropagation();
      onOpen(task);
    }}
    title={`${t(task.label)}${task.title ? `: ${task.title}` : ""} · ${task.plant_name ?? task.plant_id} · ${spanLabel(task)} · ${t(statusOf(task.status).label)}${task.overdue ? ` · ${t("overdue")}` : ""}`}
    className={cn(
      "block w-full truncate rounded border px-1.5 py-0.5 text-left text-[11px] leading-4",
      TYPE_CHIP[task.task_type],
      statusChip(task),
      draggable && movable(task) && "cursor-grab active:cursor-grabbing"
    )}
  >
    {showPlant ? `${task.plant_name ?? `#${task.plant_id}`} · ` : ""}
    {task.title ? taskTitle(task) : t(task.label)}
  </button>
  );
};

const BusyChip: React.FC<{ block: OmBusyBlock }> = ({ block }) => {
  const { t } = useI18n();
  return (
  <Tooltip>
    <TooltipTrigger asChild>
      <span className={cn("block w-full truncate rounded border px-1.5 py-0.5 text-[11px] leading-4", BUSY_CHIP)}>{t("Busy")}</span>
    </TooltipTrigger>
    <TooltipContent>{t("Work on a plant you can't see ({span})", { span: spanLabel(block) })}</TooltipContent>
  </Tooltip>
  );
};

// --------------------------------------------------------------------------- month

export const MonthGrid: React.FC<{
  from: string;
  month: string;
  today: string;
  tasks: OmTask[];
  onOpen: (t: OmTask) => void;
  onCreate: (day: string) => void;
  onShowDay: (day: string) => void;
  onMove?: (t: OmTask, day: string) => void;
  /** Phase 4: suggested cleanings (estimates), drawn as dashed ghost chips on their suggested day */
  suggestions?: OmCleaningSuggestion[];
  onOpenSuggestion?: (s: OmCleaningSuggestion) => void;
}> = ({ from, month, today, tasks, onOpen, onCreate, onShowDay, onMove, suggestions, onOpenSuggestion }) => {
  const { t } = useI18n();
  const days = daysBetween(from, addDays(from, 41));
  const drop = useDrop(tasks, onMove);
  return (
    <div className="overflow-x-auto">
      <div className="grid min-w-[640px] grid-cols-7 border-l border-t border-white/[0.06]">
        {WEEKDAYS.map((w, i) => (
          <div key={w} className="eyebrow border-b border-r border-white/[0.06] px-2 py-1.5">
            {weekdayName(i)}
          </div>
        ))}
        {days.map((day) => {
          const here = tasks.filter((t) => covers(t, day));
          const ghosts = onOpenSuggestion ? (suggestions ?? []).filter((s) => s.suggested_day === day) : [];
          const inMonth = day.slice(0, 7) === month.slice(0, 7);
          return (
            <div
              key={day}
              role="button"
              tabIndex={0}
              aria-label={t("Plan a task on {day}", { day })}
              onClick={() => onCreate(day)}
              onKeyDown={(e) => e.key === "Enter" && onCreate(day)}
              {...drop.props(day)}
              className={cn(
                "flex min-h-24 cursor-pointer flex-col gap-1 border-b border-r border-white/[0.06] p-1.5 transition-colors hover:bg-white/[0.03]",
                !inMonth && "bg-black/20 text-muted-foreground",
                drop.over === day && "bg-solar-500/10 ring-1 ring-inset ring-solar-400/60"
              )}
            >
              <span className={cn("num w-fit rounded px-1 text-[11px]", day === today && "bg-solar-500/20 font-semibold text-solar-200")}>{Number(day.slice(8))}</span>
              {here.slice(0, MAX_CHIPS).map((x) => (
                <Chip key={x.id} task={x} onOpen={onOpen} draggable={!!onMove} />
              ))}
              {ghosts.slice(0, MAX_CHIPS).map((g) => (
                <SuggestionChip key={`s${g.plant_id}`} s={g} onOpen={onOpenSuggestion!} />
              ))}
              {ghosts.length > MAX_CHIPS && (
                <span className="text-[11px] text-sky-300/80">{t("+{n} suggested", { n: ghosts.length - MAX_CHIPS })}</span>
              )}
              {here.length > MAX_CHIPS && (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="h-auto justify-start rounded-none p-0 text-left text-[11px] font-normal text-muted-foreground hover:bg-transparent hover:text-foreground"
                  onClick={(e) => {
                    e.stopPropagation();
                    onShowDay(day);
                  }}
                >
                  {t("+{n} more", { n: here.length - MAX_CHIPS })}
                </Button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

// --------------------------------------------------------------------------- week lanes

interface Lane {
  key: string;
  label: string;
  sub?: string;
  tasks: OmTask[];
  busy: OmBusyBlock[];
  person: boolean;
  color?: string | null;
}

export const WeekLanes: React.FC<{
  from: string;
  today: string;
  tasks: OmTask[];
  busy: OmBusyBlock[];
  people: OmPerson[];
  /** teams with their members: a team's task is also each member's work */
  teams: OmTeam[];
  /** narrowed to one person: only their lane (plus team / unassigned lanes for what it doesn't show) */
  only?: number | null;
  me: number | undefined;
  onOpen: (t: OmTask) => void;
  onCreate: (day: string) => void;
  onMove?: (t: OmTask, day: string) => void;
  /** the Visit Route link for a day ("Plan route" in its header); none = no button */
  routeFor?: (day: string) => string;
}> = ({ from, today, tasks, busy, people, teams, only, me, onOpen, onCreate, onMove, routeFor }) => {
  const { t: tr } = useI18n();
  const days = daysBetween(from, addDays(from, 6));
  const drop = useDrop(tasks, onMove);
  const lanes = useMemo<Lane[]>(() => {
    const out: Lane[] = [];
    const seen = new Set<number>();
    const members = new Map(teams.map((t) => [t.id, new Set(t.members.map((m) => m.id))]));
    // a person's work: assigned directly or through a team they are in (as the API's user filter)
    // narrowed to one person, the API already returned only their work (an inactive team's members are not listed here)
    const isMine = (t: OmTask, id: number) =>
      id === only || t.assignees.some((a) => a.id === id) || (!!t.team && !!members.get(t.team.id)?.has(id));
    const persons = [...people];
    if (only == null) {
      for (const t of tasks) for (const a of t.assignees) if (!persons.some((p) => p.id === a.id)) persons.push(a);
      for (const b of busy) for (const a of b.assignees) if (!persons.some((p) => p.id === a.id)) persons.push(a);
    }
    persons.sort((a, b) => (a.id === me ? -1 : b.id === me ? 1 : personName(a).localeCompare(personName(b))));
    const shown = new Set<number>();
    for (const p of persons) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      const mine = tasks.filter((t) => isMine(t, p.id));
      for (const t of mine) shown.add(t.id);
      const blocked = busy.filter((b) => b.assignees.some((a) => a.id === p.id));
      out.push({ key: `u${p.id}`, label: p.id === me ? tr("{name} (you)", { name: personName(p) }) : personName(p), tasks: mine, busy: blocked, person: true });
    }
    // a team gets a lane for team work no person lane shows (e.g. a contractor crew with no logins)
    const teamOnly = new Map<number, { name: string; color: string | null; tasks: OmTask[] }>();
    for (const t of tasks) {
      if (!t.team || shown.has(t.id) || t.assignees.length) continue;
      const lane = teamOnly.get(t.team.id) ?? { name: t.team.name, color: t.team.color, tasks: [] };
      lane.tasks.push(t);
      teamOnly.set(t.team.id, lane);
    }
    for (const [id, lane] of [...teamOnly].sort((a, b) => a[1].name.localeCompare(b[1].name))) {
      out.push({ key: `t${id}`, label: lane.name, sub: tr("Team"), color: lane.color, tasks: lane.tasks, busy: [], person: false });
    }
    const loose = tasks.filter((t) => t.assignees.length === 0 && !t.team);
    if (loose.length) out.push({ key: "none", label: tr("Unassigned"), tasks: loose, busy: [], person: false });
    return out;
  }, [tasks, busy, people, teams, only, me, tr]);

  return (
    <div className="table-wrap overflow-x-auto">
      <table className="w-full min-w-[820px] table-fixed border-collapse text-xs">
        <thead>
          <tr>
            <th className="eyebrow w-40 border-b border-white/[0.06] px-2 py-1.5 text-left">{tr("Who")}</th>
            {days.map((day, i) => (
              <th key={day} className={cn("eyebrow border-b border-white/[0.06] px-2 py-1.5 text-left", day === today && "text-solar-200")}>
                <div className="flex items-center justify-between gap-1">
                  <span>
                    {weekdayName(i)} <span className="num">{Number(day.slice(8))}</span>
                  </span>
                  {routeFor && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button asChild variant="ghost" size="icon-xs" aria-label={tr("Plan route for {day}", { day })}>
                          <Link to={routeFor(day)}>
                            <Route />
                          </Link>
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{tr("Plan route")}</TooltipContent>
                    </Tooltip>
                  )}
                </div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {lanes.length === 0 && (
            <tr>
              <td colSpan={8} className="px-2 py-6 text-center text-muted-foreground">
                {tr("Nothing planned this week.")}
              </td>
            </tr>
          )}
          {lanes.map((lane) => (
            <tr key={lane.key} className="align-top">
              <td className="border-b border-white/[0.06] px-2 py-1.5">
                <div className="flex items-center gap-1.5 truncate font-medium">
                  {lane.color && <span className="size-2 shrink-0 rounded-full" style={{ background: lane.color }} />}
                  {lane.label}
                </div>
                {lane.sub && <div className="text-[11px] text-muted-foreground">{lane.sub}</div>}
              </td>
              {days.map((day) => {
                const ts = lane.tasks.filter((t) => covers(t, day));
                const bs = lane.busy.filter((b) => covers(b, day));
                const active = ts.filter((t) => t.status !== "skipped" && t.status !== "cancelled").length + bs.length;
                const clash = lane.person && active > 1;
                return (
                  <td
                    key={day}
                    onClick={() => onCreate(day)}
                    {...drop.props(day)}
                    className={cn(
                      "cursor-pointer space-y-1 border-b border-l border-white/[0.06] p-1 hover:bg-white/[0.03]",
                      day === today && "bg-solar-500/[0.04]",
                      clash && "bg-red-500/[0.06]",
                      drop.over === day && "bg-solar-500/10 ring-1 ring-inset ring-solar-400/60"
                    )}
                  >
                    {clash && <div className="text-[10px] font-medium text-red-300">{tr("{n} jobs", { n: active })}</div>}
                    {ts.map((t) => (
                      <Chip key={t.id} task={t} onOpen={onOpen} draggable={!!onMove} />
                    ))}
                    {bs.map((b, i) => (
                      <BusyChip key={`b${i}`} block={b} />
                    ))}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

// --------------------------------------------------------------------------- list

/** rows per page of the task list */
const TASK_PAGE = 50;

export const TaskList: React.FC<{
  tasks: OmTask[];
  onOpen: (t: OmTask) => void;
  showPlant?: boolean;
  /** changes when the filters / period change: back to page 1 (a re-read after a save keeps the page) */
  resetKey?: string;
}> = ({ tasks, onOpen, showPlant = true, resetKey = "" }) => {
  const { t: tr } = useI18n();
  const [page, setPage] = useState(0);
  useEffect(() => setPage(0), [resetKey]);
  const { pageNo } = pageBounds(tasks.length, TASK_PAGE, page);
  const shown = tasks.slice(pageNo * TASK_PAGE, (pageNo + 1) * TASK_PAGE);
  return (
  <>
  <Table containerClassName="table-wrap">
    <TableHeader>
      <TableRow>
        <TableHead>{tr("When")}</TableHead>
        {showPlant && <TableHead>{tr("Plant")}</TableHead>}
        <TableHead>{tr("Task")}</TableHead>
        <TableHead>{tr("Who")}</TableHead>
        <TableHead>{tr("Status")}</TableHead>
        <TableHead className="text-right">{tr("Est. cost")}</TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      {tasks.length === 0 && (
        <TableRow>
          <TableCell colSpan={showPlant ? 6 : 5} className="py-6 text-center text-muted-foreground">
            {tr("No tasks.")}
          </TableCell>
        </TableRow>
      )}
      {shown.map((t) => (
        <TableRow key={t.id} className="cursor-pointer" onClick={() => onOpen(t)}>
          <TableCell className="num whitespace-nowrap">{spanLabel(t)}</TableCell>
          {showPlant && (
            <TableCell className="max-w-48 truncate">
              <Link to={plantPath(t.plant_id, "maintenance")} onClick={(e) => e.stopPropagation()} className="hover:underline">
                {t.plant_name ?? tr("Plant {id}", { id: t.plant_id })}
              </Link>
            </TableCell>
          )}
          <TableCell className="max-w-64">
            <span className={cn("mr-1.5 inline-block rounded border px-1 text-[10px]", TYPE_CHIP[t.task_type])}>{tr(t.label)}</span>
            <span className="truncate">{t.title ?? ""}</span>
            <div className="text-[11px] text-muted-foreground">{tr(taskWhere(t))}</div>
          </TableCell>
          <TableCell className="max-w-48 truncate">
            {[...t.assignees.map(personName), ...(t.team ? [t.team.name] : [])].join(", ") || <span className="text-muted-foreground">—</span>}
          </TableCell>
          <TableCell>
            <div className="flex flex-wrap gap-1">
              <Badge variant={statusOf(t.status).variant}>{tr(statusOf(t.status).label)}</Badge>
              {t.overdue && <Badge variant="crit">{tr("Overdue")}</Badge>}
            </div>
          </TableCell>
          <TableCell className="num text-right">{t.est_cost_thb == null ? "—" : `฿${fmtInt(t.est_cost_thb)}`}</TableCell>
        </TableRow>
      ))}
    </TableBody>
  </Table>
  {tasks.length > TASK_PAGE && <TablePager className="mt-3" rows={tasks.length} pageSize={TASK_PAGE} pageNo={pageNo} onPage={setPage} />}
  </>
  );
};
