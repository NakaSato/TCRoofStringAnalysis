/** Plant Overview: weather card (the plant's Growatt sensors as reported + Google rain at 09/12/17). */
import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, CloudOff, CloudRain, Compass, Droplets, PanelsTopLeft, Sun, SunMedium, Thermometer, Wind } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { api } from "../../api/client";
import type { GoogleWeatherDay, GrowattLive, GrowattLiveWeather, GrowattWeatherField, SensorRow } from "../../api/client";
import { Led, fmt } from "../../components/ui";
import { plantPath } from "../../context/routes";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { IconStat, IconStats } from "./IconStat";

const FIELDS: Array<[GrowattWeatherField, string, string, number, LucideIcon]> = [
  ["irradiance_wm2", "Irradiance", "W/m²", 0, Sun],
  ["module_temp_c", "Module temperature", "°C", 1, PanelsTopLeft],
  ["ambient_temp_c", "Ambient temperature", "°C", 1, Thermometer],
  ["humidity_pct", "Humidity", "%", 0, Droplets],
  ["wind_speed_ms", "Wind speed", "m/s", 1, Wind],
  ["wind_dir_deg", "Wind direction", "°", 0, Compass],
];
const RAIN_SLOTS = ["09", "12", "17"] as const;
const todayBkk = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Bangkok" });

type LiveReading = GrowattLiveWeather["sensors"][number];

/** Which record of a sensor to show: the live one when at least as new as the stored one, else the stored record. */
const pickReading = (sensor: SensorRow, live: LiveReading | null, envelopeStale: boolean) => {
  const useLive = live != null && (!sensor.last_reading_at || live.timestamp >= sensor.last_reading_at);
  return {
    useLive,
    at: useLive ? live.timestamp : sensor.last_reading_at,
    values: (useLive ? live : sensor.last) as Partial<Record<GrowattWeatherField, number | null>> | null,
    stale: useLive && (envelopeStale || Boolean(live.stale)),
  };
};

/** Live / Last sync · time of the reading shown. */
const Freshness: React.FC<{ r: ReturnType<typeof pickReading> }> = ({ r }) => (
  <span className="num inline-flex shrink-0 items-center gap-1.5 text-[11px] font-normal text-muted-foreground">
    {r.at ? (
      <>
        <Led level={r.useLive ? (r.stale ? "warn" : "ok") : "off"} pulse={r.useLive && !r.stale} />
        {r.useLive ? (r.stale ? "Stale" : "Live") : "Last sync"} · {r.at.slice(0, 10) === todayBkk() ? r.at.slice(11, 16) : r.at.slice(0, 16)}
      </>
    ) : (
      "No reading yet"
    )}
  </span>
);

/** One sensor's newest reading as tiles; the id + freshness line only when the plant has several sensors. */
const SensorReading: React.FC<{ sensor: SensorRow; r: ReturnType<typeof pickReading>; showHeader: boolean }> = ({ sensor, r, showHeader }) => {
  const fitted = (f: GrowattWeatherField) => !sensor.measured || sensor.measured.includes(f);
  const values = r.values;
  return (
    <div className="flex flex-col gap-2">
      {showHeader && (
        <div className="flex items-center justify-between gap-3 text-[11px]">
          <span className="num truncate text-muted-foreground">
            {sensor.datalogger_sn}#{sensor.address}
          </span>
          <Freshness r={r} />
        </div>
      )}
      {values && (
        <IconStats cols="grid-cols-3">
          {FIELDS.map(([f, label, unit, digits, icon]) => (
            <IconStat
              key={f}
              icon={icon}
              label={label}
              value={fitted(f) ? fmt(values[f], digits) : "—"}
              unit={unit}
              hint={fitted(f) ? undefined : "Not fitted on this sensor"}
            />
          ))}
        </IconStats>
      )}
    </div>
  );
};

/** Google Weather (modelled): rain status at 09:00, 12:00 and 17:00 of the overview's day, stored hours only. */
const RainSlots: React.FC<{ plantId: number; day: string | null }> = ({ plantId, day }) => {
  const [wx, setWx] = useState<GoogleWeatherDay | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setWx(null);
    setFailed(false);
    api
      .getGoogleWeatherDay(plantId, day ?? undefined)
      .then((r) => !cancelled && setWx(r))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [plantId, day]);

  const note = failed
    ? "Rain forecast unavailable"
    : !wx
      ? null
      : !wx.configured
        ? "Google Weather not configured"
        : !wx.has_location
          ? "No location for Google Weather"
          : null;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span title="Google Weather, modelled">Rain · modelled</span>
        {wx?.rain.days_since_rain != null && (
          <span className="num" title="Days since the last rain">
            {wx.rain.days_since_rain} d dry
          </span>
        )}
      </div>
      {note ? (
        <p className="text-xs text-muted-foreground">{note}</p>
      ) : (
        <div className="grid grid-cols-3 gap-1.5">
          {RAIN_SLOTS.map((h) => {
            const slot = wx?.slots[h] ?? null;
            const Icon = slot?.raining == null ? CloudOff : slot.raining ? CloudRain : SunMedium;
            return (
              <div
                key={h}
                className="flex items-center gap-2 rounded-md bg-white/[0.025] px-2.5 py-2"
                title={
                  slot
                    ? `${slot.status_th ?? slot.condition ?? ""} · ${fmt(slot.precip_mm, 1)} mm · cloud ${fmt(slot.cloud_cover_pct, 0)}%`
                    : "Not stored yet"
                }
              >
                {!wx ? (
                  <Skeleton className="h-4 w-full" />
                ) : (
                  <>
                    <Icon
                      className={cn(
                        "size-4 shrink-0",
                        slot?.raining == null ? "text-slate-600" : slot.raining ? "text-sky-300" : "text-amber-300"
                      )}
                      aria-hidden
                    />
                    <span className="num text-sm text-slate-200">{h}:00</span>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

/**
 * Weather of the plant: each Growatt sensor's newest reading (live from the page's poll, else the
 * newest stored record; nothing averaged or derived) and Google's modelled rain slots.
 */
export const WeatherCard: React.FC<{
  plantId: number;
  day: string | null;
  /** re-read the sensor list when the overview brings newer stored weather */
  storedUntil: string | null;
  liveWx: GrowattLive<GrowattLiveWeather> | null;
  liveWxFailed: boolean;
}> = ({ plantId, day, storedUntil, liveWx, liveWxFailed }) => {
  const [sensors, setSensors] = useState<SensorRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    api
      .listSensors(plantId)
      .then((r) => {
        if (cancelled) return;
        setSensors(r.sensors);
        setError(null);
      })
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      cancelled = true;
    };
  }, [plantId, storedUntil]);

  // a failed poll keeps the last answer on screen, but it is no longer live
  const envelopeStale = Boolean(liveWx?.stale) || liveWxFailed;
  const readings = (sensors ?? []).map((s) => ({
    s,
    r: pickReading(s, liveWx?.data.sensors.find((l) => l.datalogger_sn === s.datalogger_sn && l.address === s.address) ?? null, envelopeStale),
  }));
  const single = readings.length === 1;

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Weather
          {single && <Freshness r={readings[0].r} />}
          {sensors && sensors.length === 0 && (
            <Badge variant="neutral" title="Irradiance and IEC PR are not measured at this plant">
              no sensor
            </Badge>
          )}
        </CardTitle>
        <CardAction>
          <Button asChild variant="ghost" size="icon-sm" aria-label="Open Sensors" title="Open Sensors">
            <Link to={`${plantPath(plantId, "sensors")}#weather-station`}>
              <ArrowRight />
            </Link>
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {sensors == null ? (
          error ? (
            <p className="text-xs text-muted-foreground">Sensor data unavailable: {error}</p>
          ) : (
            <Skeleton className="h-24 w-full" aria-busy aria-label="Loading sensor data…" />
          )
        ) : (
          readings.map(({ s, r }) => <SensorReading key={s.key} sensor={s} r={r} showHeader={!single} />)
        )}
        <RainSlots plantId={plantId} day={day} />
      </CardContent>
    </Card>
  );
};
