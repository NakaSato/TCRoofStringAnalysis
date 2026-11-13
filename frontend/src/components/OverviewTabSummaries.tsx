/**
 * Plant Overview: one high-level card per detail tab (2 Performance Ratio, 3 Inverters,
 * 4 Sensors, 5 String Diagnostics), each linking to its tab. Everything comes from the plant overview
 * already loaded (stored history + the live overlay); a missing value shows as "—".
 */
import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Activity, ArrowRight, Cpu, Gauge, TrendingUp } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { api } from "../api/client";
import type { GrowattLive, GrowattLiveWeather, GrowattPlantOverview, GrowattWeatherField, SensorRow } from "../api/client";
import { useLivePoll } from "../context/useLivePoll";
import { Led, fmt } from "./ui";
import { Button } from "@/components/ui/button";
import { Card as UiCard } from "@/components/ui/card";
import { PanelChart } from "./PanelChart";
import type { PanelChartSpec } from "./PanelChart";
import { SERIES } from "./chartTheme";
import { plantPath } from "../context/routes";
import type { PlantPage } from "../context/routes";

const Card: React.FC<{
  to: string;
  step: number;
  icon: LucideIcon;
  title: string;
  children: React.ReactNode;
}> = ({ to, step, icon: Icon, title, children }) => (
  <UiCard className="gap-0 py-0">
    <header className="panel-header">
      <h2 className="panel-title">
        <Icon className="h-4 w-4 text-solar-400" />
        <span className="truncate">
          {step}. {title}
        </span>
      </h2>
      <Button asChild variant="ghost" size="sm">
        <Link to={to}>
          Open <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </Button>
    </header>
    <div className="flex flex-1 flex-col gap-3 p-4">{children}</div>
  </UiCard>
);

const Stat: React.FC<{
  label: string;
  value: string;
  unit?: string;
  note?: string;
}> = ({ label, value, unit, note }) => (
  <div className="min-w-0 rounded-lg border border-white/[0.06] bg-ink-950/40 px-3 py-2">
    <div className="eyebrow truncate">{label}</div>
    <div className="num mt-0.5 truncate text-lg font-bold text-white">
      {value}
      {unit && value !== "—" && (
        <span className="ml-1 text-xs font-medium text-slate-400">{unit}</span>
      )}
    </div>
    {note && <div className="truncate text-[11px] text-slate-500">{note}</div>}
  </div>
);

const Line: React.FC<{ label: React.ReactNode; value: React.ReactNode }> = ({
  label,
  value,
}) => (
  <div className="flex items-center justify-between gap-3 text-xs">
    <span className="min-w-0 truncate text-slate-400">{label}</span>
    <span className="num shrink-0 font-semibold text-slate-100">{value}</span>
  </div>
);

const RECORD_FIELDS: Array<[GrowattWeatherField, string, string, number]> = [
  ["irradiance_wm2", "Irradiance", "W/m²", 0],
  ["module_temp_c", "Module", "°C", 1],
  ["ambient_temp_c", "Ambient", "°C", 1],
  ["humidity_pct", "Humidity", "%", 0],
  ["wind_speed_ms", "Wind", "m/s", 1],
  ["wind_dir_deg", "Wind dir", "°", 0],
];

type LiveSensorReading = GrowattLiveWeather["sensors"][number];

/** One sensor's newest reading as reported (nothing averaged, integrated or derived): the live
 * record when it is at least as new as the stored one, else the newest stored record. */
const SensorRecord: React.FC<{ sensor: SensorRow; live: LiveSensorReading | null; envelopeStale: boolean }> = ({
  sensor,
  live,
  envelopeStale,
}) => {
  const fitted = (f: GrowattWeatherField) => !sensor.measured || sensor.measured.includes(f);
  const useLive = live != null && (!sensor.last_reading_at || live.timestamp >= sensor.last_reading_at);
  const at = useLive ? live.timestamp : sensor.last_reading_at;
  const values: Partial<Record<GrowattWeatherField, number | null>> | null = useLive ? live : sensor.last;
  const stale = useLive && (envelopeStale || Boolean(live.stale));
  return (
    <div className="space-y-2">
      <Line
        label={
          <span className="num text-slate-300">
            {sensor.datalogger_sn}#{sensor.address}
          </span>
        }
        value={
          at ? (
            <span className="inline-flex items-center gap-1.5">
              <Led level={useLive ? (stale ? "warn" : "ok") : "off"} pulse={useLive && !stale} />
              {useLive ? (stale ? "Stale" : "Live") : "Last sync"} · {at.slice(0, 10) === new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Bangkok" }) ? at.slice(11, 16) : at.slice(0, 16)}
            </span>
          ) : (
            "No reading yet"
          )
        }
      />
      {values && (
        <div className="grid grid-cols-3 gap-2">
          {RECORD_FIELDS.map(([f, label, unit, digits]) => (
            <Stat
              key={f}
              label={label}
              value={fitted(f) ? fmt(values[f], digits) : "—"}
              unit={unit}
              note={fitted(f) ? undefined : "not fitted"}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export const OverviewTabSummaries: React.FC<{
  overview: GrowattPlantOverview;
}> = ({ overview }) => {
  const { kpis, inverters, strings, timeseries, loss_waterfall } = overview;
  const plantHref = (page: PlantPage) => plantPath(overview.plant.plant_id, page);

  /* ---- 2. Generation & PR ---- */
  const powerSpec = useMemo<PanelChartSpec | null>(
    () =>
      timeseries.length
        ? {
            xKind: "time",
            x: timeseries.map((r) => r.timestamp),
            panels: [
              {
                key: "p",
                title: "Plant power today (kW)",
                series: [
                  {
                    key: "dc",
                    name: "DC input",
                    type: "line",
                    color: SERIES.dc,
                    width: 1.5,
                    y: timeseries.map((r) => r.ppv_kw),
                    unit: "kW",
                  },
                  {
                    key: "ac",
                    name: "AC output",
                    type: "line",
                    area: true,
                    color: SERIES.ac,
                    y: timeseries.map((r) => r.pac_kw),
                    unit: "kW",
                  },
                ],
              },
            ],
          }
        : null,
    [timeseries],
  );
  const lossKwh = loss_waterfall
    .filter((w) => w.type === "loss")
    .reduce((a, w) => a + Math.abs(w.kwh), 0);
  const hasIec = kpis.iec_pr_pct != null;

  /* ---- 3. Inverters ---- */
  const inv = useMemo(() => {
    const withYield = inverters.filter((i) => i.yield_today_kwh != null);
    const avg = withYield.length
      ? withYield.reduce((a, i) => a + (i.yield_today_kwh as number), 0) /
        withYield.length
      : null;
    const lowest = withYield.length
      ? withYield.reduce((a, b) =>
          (b.yield_today_kwh as number) < (a.yield_today_kwh as number) ? b : a,
        )
      : null;
    const withTemp = inverters.filter((i) => i.max_temp_c != null);
    const hottest = withTemp.length
      ? withTemp.reduce((a, b) =>
          (b.max_temp_c as number) > (a.max_temp_c as number) ? b : a,
        )
      : null;
    return {
      normal: inverters.filter((i) => !i.lost && i.status === 1).length,
      fault: inverters.filter((i) => i.lost || i.status === 0).length,
      other: inverters.filter(
        (i) => !i.lost && i.status != null && i.status !== 0 && i.status !== 1,
      ).length,
      curtailed: inverters.filter(
        (i) =>
          i.settings?.active_rate_pct != null &&
          i.settings.active_rate_pct < 100,
      ).length,
      off: inverters.filter((i) => i.settings?.on_off === 0).length,
      statusKnown: inverters.some((i) => i.status != null || i.lost != null),
      avg,
      lowest,
      hottest,
    };
  }, [inverters]);
  const name = (i: { alias?: string | null; device_sn: string }) =>
    i.alias || i.device_sn;

  /* ---- 4. Sensors: each sensor's newest reading as reported — live from Growatt (polled on
   * refresh_in_s, memory only), else the newest stored record ---- */
  const plantId = overview.plant.plant_id;
  const wxUntil = overview.weather?.data_until ?? null;
  const [sensorRows, setSensorRows] = useState<SensorRow[] | null>(null);
  const [sensorError, setSensorError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    api
      .listSensors(plantId)
      .then((r) => {
        if (cancelled) return;
        setSensorRows(r.sensors);
        setSensorError(null);
      })
      .catch((err) => !cancelled && setSensorError(err instanceof Error ? err.message : String(err)));
    return () => {
      cancelled = true;
    };
    // re-read when the overview brings newer stored weather
  }, [plantId, wxUntil]);
  const [liveWx, setLiveWx] = useState<GrowattLive<GrowattLiveWeather> | null>(null);
  const [liveWxError, setLiveWxError] = useState(false);
  useEffect(() => {
    setLiveWx(null);
    setLiveWxError(false);
  }, [plantId]);
  useLivePoll(
    Boolean(sensorRows?.length),
    plantId,
    () => api.getGrowattLiveWeather(plantId),
    (r) => {
      setLiveWx(r);
      setLiveWxError(false);
    },
    () => setLiveWxError(true),
  );

  /* ---- 5. String Diagnostics ---- */
  const worst = useMemo(
    () =>
      strings
        .filter((s) => s.status !== "Healthy")
        .sort((a, b) => (a.health_score ?? 101) - (b.health_score ?? 101))
        .slice(0, 3),
    [strings],
  );
  const stringLoss = strings.reduce((a, s) => a + (s.energy_loss_kwh ?? 0), 0);
  const total = kpis.string_count || 0;

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 2xl:grid-cols-4">
      <Card
        to={plantHref("generation")}
        step={2}
        icon={TrendingUp}
        title="Performance Ratio"
      >
        <div className="grid grid-cols-3 gap-2">
          <Stat
            label="Yield today"
            value={fmt(kpis.yield_today_kwh, 1)}
            unit="kWh"
          />
          <Stat
            label="Specific"
            value={fmt(kpis.specific_yield_kwh_per_kwp, 2)}
            unit="kWh/kWp"
          />
          <Stat
            label={hasIec ? "IEC PR" : "Peer PR"}
            value={fmt(hasIec ? kpis.iec_pr_pct : kpis.plant_pr_pct, 1)}
            unit="%"
            note={hasIec ? "measured" : "modelled"}
          />
        </div>
        <PanelChart
          spec={powerSpec}
          height={150}
          emptyLabel="No 5-minute records today."
        />
        <Line
          label="Losses in the waterfall"
          value={loss_waterfall.length ? `${fmt(lossKwh, 1)} kWh` : "—"}
        />
      </Card>

      <Card to={plantHref("inverters")} step={3} icon={Cpu} title="Inverters">
        <div className="grid grid-cols-3 gap-2">
          <Stat
            label="Online"
            value={
              kpis.online_inverters == null
                ? "—"
                : String(kpis.online_inverters)
            }
            unit={`/ ${kpis.inverter_count}`}
          />
          <Stat
            label="Efficiency"
            value={fmt(kpis.conversion_efficiency_pct, 1)}
            unit="%"
          />
          <Stat label="Max temp" value={fmt(kpis.max_temp_c, 1)} unit="°C" />
        </div>
        {!inv.statusKnown ? (
          <div className="text-xs text-slate-500">
            Inverter status arrives with the live data…
          </div>
        ) : (
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-300">
            <span className="flex items-center gap-1.5">
              <Led level="ok" />{" "}
              <span className="num font-semibold text-white">{inv.normal}</span>{" "}
              normal
            </span>
            <span className="flex items-center gap-1.5">
              <Led level="warn" />{" "}
              <span className="num font-semibold text-white">{inv.other}</span>{" "}
              other status
            </span>
            <span className="flex items-center gap-1.5">
              <Led level="crit" />{" "}
              <span className="num font-semibold text-white">{inv.fault}</span>{" "}
              fault / lost
            </span>
          </div>
        )}
        <div className="space-y-1.5">
          <Line
            label={
              inv.lowest ? `Lowest yield · ${name(inv.lowest)}` : "Lowest yield"
            }
            value={
              inv.lowest && inv.avg
                ? `${fmt(inv.lowest.yield_today_kwh, 1)} kWh (${fmt(((inv.lowest.yield_today_kwh as number) / inv.avg) * 100, 0)}% of avg)`
                : "—"
            }
          />
          <Line
            label={inv.hottest ? `Hottest · ${name(inv.hottest)}` : "Hottest"}
            value={inv.hottest ? `${fmt(inv.hottest.max_temp_c, 1)} °C` : "—"}
          />
          <Line
            label="Power-limited (active rate < 100 %)"
            value={inv.curtailed}
          />
          {inv.off > 0 && (
            <Line label="Switched off in settings" value={inv.off} />
          )}
        </div>
      </Card>

      <Card to={plantHref("sensors")} step={4} icon={Gauge} title="Sensors">
        {sensorRows == null ? (
          <div className="text-xs text-slate-500">
            {sensorError ? `Sensor data unavailable: ${sensorError}` : "Loading sensor data…"}
          </div>
        ) : !sensorRows.length ? (
          <div className="flex flex-1 items-center justify-center rounded-lg border border-dashed border-white/[0.08] px-4 py-8 text-center text-xs text-slate-500">
            No weather sensor at this plant, so irradiance and IEC PR are not measured here.
          </div>
        ) : (
          <>
            {sensorRows.map((s) => (
              <SensorRecord
                key={s.key}
                sensor={s}
                live={
                  liveWx?.data.sensors.find(
                    (l) => l.datalogger_sn === s.datalogger_sn && l.address === s.address,
                  ) ?? null
                }
                // a failed poll keeps the last answer on screen, but it is no longer live
                envelopeStale={Boolean(liveWx?.stale) || liveWxError}
              />
            ))}
            <div className="text-[11px] text-slate-500">
              Values exactly as the sensor reported them: live from Growatt
              (refreshes when a new record is due, never stored), else the
              newest stored record.{liveWxError ? (liveWx ? " Live refresh failing: showing the last reading as stale." : " Live unavailable right now.") : ""} — = no
              value, not fitted = probe reads 0 all week.
            </div>
          </>
        )}
      </Card>

      <Card to={plantHref("strings")} step={5} icon={Activity} title="String Diagnostics">
        <div className="grid grid-cols-3 gap-2">
          <Stat
            label="Health"
            value={fmt(kpis.avg_health_score, 1)}
            unit="/ 100"
          />
          <Stat
            label="Strings"
            value={String(total)}
            note={
              kpis.inactive_strings
                ? `${kpis.inactive_strings} inputs idle`
                : undefined
            }
          />
          <Stat
            label="Est. loss"
            value={strings.length ? fmt(stringLoss, 1) : "—"}
            unit="kWh"
            note="vs peers, modelled"
          />
        </div>
        <div className="flex h-2 overflow-hidden rounded-full bg-white/[0.05]">
          {total > 0 && (
            <>
              <div
                style={{ width: `${(kpis.healthy_strings / total) * 100}%` }}
                className="bg-emerald-400"
              />
              <div
                style={{ width: `${(kpis.warning_strings / total) * 100}%` }}
                className="ml-px bg-amber-400"
              />
              <div
                style={{ width: `${(kpis.critical_strings / total) * 100}%` }}
                className="ml-px bg-red-500"
              />
            </>
          )}
        </div>
        <div className="flex justify-between text-[11px] text-slate-300">
          <span>
            <span className="num font-semibold text-white">
              {kpis.healthy_strings}
            </span>{" "}
            healthy
          </span>
          <span>
            <span className="num font-semibold text-white">
              {kpis.warning_strings}
            </span>{" "}
            warning
          </span>
          <span>
            <span className="num font-semibold text-white">
              {kpis.critical_strings}
            </span>{" "}
            critical
          </span>
        </div>
        <div className="space-y-1.5">
          <div className="eyebrow">Needs attention</div>
          {worst.length ? (
            worst.map((s) => (
              <Line
                key={s.string_id}
                label={
                  <span className="flex items-center gap-1.5">
                    <Led level={s.status === "Critical" ? "crit" : "warn"} />
                    <span className="num font-semibold text-slate-200">
                      {s.short_label}
                    </span>
                    <span className="truncate">{s.diagnosis}</span>
                  </span>
                }
                value={
                  s.health_score == null ? "—" : `${fmt(s.health_score, 0)}/100`
                }
              />
            ))
          ) : (
            <div className="text-xs text-slate-500">
              {strings.length
                ? "Every string is healthy."
                : "No string records today."}
            </div>
          )}
        </div>
      </Card>
    </div>
  );
};
