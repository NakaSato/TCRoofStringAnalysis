/** Plant Maintenance: the plant's planned work from the Calendar Team (overdue first, then the
 * next 60 days), with "Plan task". DB only (`/growatt/calendar/tasks?plant_id=`). A task marked
 * done here writes the Site log event below, so the page reloads both. */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Plus } from "lucide-react";
import { api } from "../../api/client";
import type { OmTask, OmTaskList } from "../../api/client";
import { useAppContext } from "../../context/AppContext";
import { isAdmin } from "../../auth/access";
import { plantToday } from "../../context/alarmLogStore";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { TaskDialog } from "../calendar/TaskDialog";
import type { TaskDialogTarget } from "../calendar/TaskDialog";
import { TaskList } from "../calendar/views";
import { addDays } from "../calendar/format";

const BACK_DAYS = 40; // overdue tasks still show (the API range is at most 100 days)
const AHEAD_DAYS = 60;

export const UpcomingTasksCard: React.FC<{ plantId: number; onDone?: () => void }> = ({ plantId, onDone }) => {
  const { user, growattPlants } = useAppContext();
  const [data, setData] = useState<OmTaskList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<TaskDialogTarget | null>(null);
  const today = plantToday();

  const load = useCallback(async () => {
    try {
      setData(await api.listOmTasks({ from: addDays(today, -BACK_DAYS), to: addDays(today, AHEAD_DAYS), plant_id: plantId }));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [plantId, today]);

  useEffect(() => {
    setData(null);
    void load();
  }, [load]);

  // open work only: overdue first, then by start day
  const tasks = useMemo(
    () =>
      (data?.tasks ?? [])
        .filter((t) => t.status === "planned" || t.status === "in_progress")
        .sort((a, b) => Number(b.overdue) - Number(a.overdue) || a.start_day.localeCompare(b.start_day)),
    [data]
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Upcoming work</CardTitle>
        <CardDescription>
          Planned and started tasks on this plant{data?.summary.overdue ? ` · ${data.summary.overdue} overdue` : ""}. Marking one done records it in the Site log.
        </CardDescription>
        <CardAction className="flex items-center gap-2">
          <Button asChild variant="ghost" size="sm">
            <Link to={`/calendar?view=list&plant=${plantId}&user=all`}>Calendar</Link>
          </Button>
          <Button size="sm" onClick={() => setDialog({ task: null, plantId, lockPlant: true })}>
            <Plus data-icon="inline-start" />
            Plan task
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {error ? (
          <p className="text-xs text-red-300">{error}</p>
        ) : !data ? (
          <Spinner className="size-4" />
        ) : (
          <TaskList tasks={tasks} onOpen={(t: OmTask) => setDialog({ task: t })} showPlant={false} />
        )}
      </CardContent>
      <TaskDialog
        target={dialog}
        plants={growattPlants}
        me={user?.id}
        admin={isAdmin(user)}
        onClose={() => setDialog(null)}
        onChanged={() => {
          void load();
          onDone?.();
        }}
      />
    </Card>
  );
};
