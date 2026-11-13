/** Plant Overview: today's weather-sensor chart, the same one as the Sensors tab's "Today". */
import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import type { GrowattPlantOverview } from "../../api/client";
import { PanelChart } from "../../components/PanelChart";
import { LoadingState } from "../../components/ui";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { plantNow } from "../sensors/format";
import { useSensorDayChart } from "../sensors/useSensorDayChart";
import type { SensorRef } from "../sensors/useSensorDetail";

/** Plant-local now, re-read every minute (the chart's "Now" line and later-today shading). */
const usePlantNow = () => {
  const [now, setNow] = useState(plantNow);
  useEffect(() => {
    const id = window.setInterval(() => setNow(plantNow()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  return now;
};

/**
 * Today only, whatever day the overview's stored figures are: the stored 5-min records (DB), then
 * the records Growatt holds that are not stored yet (memory only, shaded "Live, not stored yet"),
 * with the plant's AC power under irradiance. With several sensors, line tabs pick one.
 */
export const SensorTodayCard: React.FC<{ ov: GrowattPlantOverview; href: string }> = ({ ov, href }) => {
  const now = usePlantNow();
  const list = ov.weather?.sensors ?? [];
  const [picked, setPicked] = useState<string | null>(null);
  const refs: SensorRef[] = list.map((s) => ({
    key: `${s.datalogger_sn}:${s.address}`,
    datalogger_sn: s.datalogger_sn,
    address: s.address,
    plant_id: ov.plant.plant_id,
    // re-read the stored day when the overview (refreshed every 5 min) brings newer weather
    last_reading_at: ov.weather?.data_until ?? null,
  }));
  const sensor = refs.find((s) => s.key === picked) ?? refs[0] ?? null;
  const { daySpec, dayStored, storedError, liveDayError, pts, tailPts } = useSensorDayChart(sensor, now, { ov });

  if (!sensor) return null;
  const last = tailPts.length ? tailPts[tailPts.length - 1].timestamp : pts.length ? pts[pts.length - 1].timestamp : null;

  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          Weather sensor · Today
          {last && (
            <span
              className="num text-[11px] font-normal text-muted-foreground"
              title={tailPts.length ? `${tailPts.length} record(s) from Growatt live, not stored yet` : "Newest stored 5-min record"}
            >
              to {last.slice(11, 16)}
            </span>
          )}
        </CardTitle>
        <CardAction>
          <Button asChild variant="ghost" size="icon-sm" aria-label="Weather sensor details" title="Weather sensor details">
            <Link to={`${href}#weather-station`}>
              <ArrowRight />
            </Link>
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {refs.length > 1 && (
          <Tabs value={sensor.key} onValueChange={setPicked}>
            <TabsList variant="line" aria-label="Sensors of this plant">
              {refs.map((s) => (
                <TabsTrigger key={s.key} value={s.key} className="num">
                  {s.datalogger_sn}#{s.address}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        )}
        {daySpec ? (
          <PanelChart spec={daySpec} height={120 + daySpec.panels.length * 110} legendToggle />
        ) : !dayStored && !storedError ? (
          <LoadingState label="Loading today's readings…" shape="chart" className="border-0 bg-transparent p-0 shadow-none" />
        ) : (
          <Empty className="border border-dashed border-white/[0.08] py-10">
            <EmptyHeader>
              <EmptyTitle>No readings today yet</EmptyTitle>
              <EmptyDescription>{storedError ?? "Neither the stored history nor Growatt has a record for today yet."}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
        {liveDayError && <p className="text-[11px] text-amber-300">Today's live records failed: {liveDayError}</p>}
      </CardContent>
    </Card>
  );
};
