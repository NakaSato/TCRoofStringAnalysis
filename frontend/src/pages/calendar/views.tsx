/** Calendar Team views: month grid, week lanes (one row per person / team) and the task list. */
import React, { useMemo } from "react";
import { Link } from "react-router-dom";
import type { OmBusyBlock, OmPerson, OmTask } from "../../api/client";
import { plantPath } from "../../context/routes";
import { cn } from "@/lib/utils";
import { fmtInt } from "../../components/ui";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { BUSY_CHIP, TYPE_CHIP, WEEKDAYS, addDays, covers, daysBetween, personName, spanLabel, statusChip, statusOf, taskTitle, taskWhere } from "./format";

const MAX_CHIPS = 3;

const Chip: React.FC<{ task: OmTask; onOpen: (t: OmTask) => void; showPlant?: boolean }> = ({ task, onOpen, showPlant = true }) => (
  <button
    type="button"
    onClick={(e) => {
      e.stopPropagation();
      onOpen(task);
    }}
    title={`${task.label}${task.title ? `: ${task.title}` : ""} · ${task.plant_name ?? task.plant_id} · ${spanLabel(task)} · ${statusOf(task.status).label}${task.overdue ? " · overdue" : ""}`}
    className={cn("block w-full truncate rounded border px-1.5 py-0.5 text-left text-[11px] leading-4", TYPE_CHIP[task.task_type], statusChip(task))}
  >
    {showPlant ? `${task.plant_name ?? `#${task.plant_id}`} · ` : ""}
    {taskTitle(task)}
  </button>
);

const BusyChip: React.FC<{ block: OmBusyBlock }> = ({ block }) => (
  <Tooltip>
    <TooltipTrigger asChild>
      <span className={cn("block w-full truncate rounded border px-1.5 py-0.5 text-[11px] leading-4", BUSY_CHIP)}>Busy</span>
    </TooltipTrigger>
    <TooltipContent>Work on a plant you can't see ({spanLabel(block)})</TooltipContent>
  </Tooltip>
);

// --------------------------------------------------------------------------- month

export const MonthGrid: React.FC<{
  from: string;
  month: string;
  today: string;
  tasks: OmTask[];
  onOpen: (t: OmTask) => void;
  onCreate: (day: string) => void;
  onShowDay: (day: string) => void;
}> = ({ from, month, today, tasks, onOpen, onCreate, onShowDay }) => {
  const days = daysBetween(from, addDays(from, 41));
  return (
    <div className="overflow-x-auto">
      <div className="grid min-w-[640px] grid-cols-7 border-l border-t border-white/[0.06]">
        {WEEKDAYS.map((w) => (
          <div key={w} className="eyebrow border-b border-r border-white/[0.06] px-2 py-1.5">
            {w}
          </div>
        ))}
        {days.map((day) => {
          const here = tasks.filter((t) => covers(t, day));
          const inMonth = day.slice(0, 7) === month.slice(0, 7);
          return (
            <div
              key={day}
              role="button"
              tabIndex={0}
              aria-label={`Plan a task on ${day}`}
              onClick={() => onCreate(day)}
              onKeyDown={(e) => e.key === "Enter" && onCreate(day)}
              className={cn(
                "flex min-h-24 cursor-pointer flex-col gap-1 border-b border-r border-white/[0.06] p-1.5 transition-colors hover:bg-white/[0.03]",
                !inMonth && "bg-black/20 text-muted-foreground"
              )}
            >
              <span className={cn("num w-fit rounded px-1 text-[11px]", day === today && "bg-solar-500/20 font-semibold text-solar-200")}>{Number(day.slice(8))}</span>
              {here.slice(0, MAX_CHIPS).map((t) => (
                <Chip key={t.id} task={t} onOpen={onOpen} />
              ))}
              {here.length > MAX_CHIPS && (
                <button
                  type="button"
                  className="text-left text-[11px] text-muted-foreground hover:text-foreground"
                  onClick={(e) => {
                    e.stopPropagation();
                    onShowDay(day);
                  }}
                >
                  +{here.length - MAX_CHIPS} more
                </button>
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
}

export const WeekLanes: React.FC<{
  from: string;
  today: string;
  tasks: OmTask[];
  busy: OmBusyBlock[];
  people: OmPerson[];
  me: number | undefined;
  onOpen: (t: OmTask) => void;
  onCreate: (day: string) => void;
}> = ({ from, today, tasks, busy, people, me, onOpen, onCreate }) => {
  const days = daysBetween(from, addDays(from, 6));
  const lanes = useMemo<Lane[]>(() => {
    const out: Lane[] = [];
    const seen = new Set<number>();
    const persons = [...people];
    for (const t of tasks) for (const a of t.assignees) if (!persons.some((p) => p.id === a.id)) persons.push(a);
    for (const b of busy) for (const a of b.assignees) if (!persons.some((p) => p.id === a.id)) persons.push(a);
    persons.sort((a, b) => (a.id === me ? -1 : b.id === me ? 1 : personName(a).localeCompare(personName(b))));
    for (const p of persons) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      const mine = tasks.filter((t) => t.assignees.some((a) => a.id === p.id));
      const blocked = busy.filter((b) => b.assignees.some((a) => a.id === p.id));
      out.push({ key: `u${p.id}`, label: personName(p) + (p.id === me ? " (you)" : ""), tasks: mine, busy: blocked, person: true });
    }
    // a team gets a lane for its team-only work (e.g. a contractor crew with no logins)
    const teamOnly = new Map<number, { name: string; tasks: OmTask[] }>();
    for (const t of tasks) {
      if (!t.team || t.assignees.length) continue;
      const lane = teamOnly.get(t.team.id) ?? { name: t.team.name, tasks: [] };
      lane.tasks.push(t);
      teamOnly.set(t.team.id, lane);
    }
    for (const [id, lane] of [...teamOnly].sort((a, b) => a[1].name.localeCompare(b[1].name))) {
      out.push({ key: `t${id}`, label: lane.name, sub: "Team", tasks: lane.tasks, busy: [], person: false });
    }
    const loose = tasks.filter((t) => t.assignees.length === 0 && !t.team);
    if (loose.length) out.push({ key: "none", label: "Unassigned", tasks: loose, busy: [], person: false });
    return out;
  }, [tasks, busy, people, me]);

  return (
    <div className="table-wrap overflow-x-auto">
      <table className="w-full min-w-[820px] table-fixed border-collapse text-xs">
        <thead>
          <tr>
            <th className="eyebrow w-40 border-b border-white/[0.06] px-2 py-1.5 text-left">Who</th>
            {days.map((day, i) => (
              <th key={day} className={cn("eyebrow border-b border-white/[0.06] px-2 py-1.5 text-left", day === today && "text-solar-200")}>
                {WEEKDAYS[i]} <span className="num">{Number(day.slice(8))}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {lanes.length === 0 && (
            <tr>
              <td colSpan={8} className="px-2 py-6 text-center text-muted-foreground">
                Nothing planned this week.
              </td>
            </tr>
          )}
          {lanes.map((lane) => (
            <tr key={lane.key} className="align-top">
              <td className="border-b border-white/[0.06] px-2 py-1.5">
                <div className="truncate font-medium">{lane.label}</div>
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
                    className={cn(
                      "cursor-pointer space-y-1 border-b border-l border-white/[0.06] p-1 hover:bg-white/[0.03]",
                      day === today && "bg-solar-500/[0.04]",
                      clash && "bg-red-500/[0.06]"
                    )}
                  >
                    {clash && <div className="text-[10px] font-medium text-red-300">{active} jobs</div>}
                    {ts.map((t) => (
                      <Chip key={t.id} task={t} onOpen={onOpen} />
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

export const TaskList: React.FC<{ tasks: OmTask[]; onOpen: (t: OmTask) => void; showPlant?: boolean }> = ({ tasks, onOpen, showPlant = true }) => (
  <Table containerClassName="table-wrap">
    <TableHeader>
      <TableRow>
        <TableHead>When</TableHead>
        {showPlant && <TableHead>Plant</TableHead>}
        <TableHead>Task</TableHead>
        <TableHead>Who</TableHead>
        <TableHead>Status</TableHead>
        <TableHead className="text-right">Est. cost</TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      {tasks.length === 0 && (
        <TableRow>
          <TableCell colSpan={showPlant ? 6 : 5} className="py-6 text-center text-muted-foreground">
            No tasks.
          </TableCell>
        </TableRow>
      )}
      {tasks.map((t) => (
        <TableRow key={t.id} className="cursor-pointer" onClick={() => onOpen(t)}>
          <TableCell className="num whitespace-nowrap">{spanLabel(t)}</TableCell>
          {showPlant && (
            <TableCell className="max-w-48 truncate">
              <Link to={plantPath(t.plant_id, "maintenance")} onClick={(e) => e.stopPropagation()} className="hover:underline">
                {t.plant_name ?? `Plant ${t.plant_id}`}
              </Link>
            </TableCell>
          )}
          <TableCell className="max-w-64">
            <span className={cn("mr-1.5 inline-block rounded border px-1 text-[10px]", TYPE_CHIP[t.task_type])}>{t.label}</span>
            <span className="truncate">{t.title ?? ""}</span>
            <div className="text-[11px] text-muted-foreground">{taskWhere(t)}</div>
          </TableCell>
          <TableCell className="max-w-48 truncate">
            {[...t.assignees.map(personName), ...(t.team ? [t.team.name] : [])].join(", ") || <span className="text-muted-foreground">—</span>}
          </TableCell>
          <TableCell>
            <div className="flex flex-wrap gap-1">
              <Badge variant={statusOf(t.status).variant}>{statusOf(t.status).label}</Badge>
              {t.overdue && <Badge variant="crit">Overdue</Badge>}
            </div>
          </TableCell>
          <TableCell className="num text-right">{t.est_cost_thb == null ? "—" : `฿${fmtInt(t.est_cost_thb)}`}</TableCell>
        </TableRow>
      ))}
    </TableBody>
  </Table>
);
