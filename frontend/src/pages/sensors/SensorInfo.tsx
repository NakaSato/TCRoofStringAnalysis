/** Sensors Info view: one sensor's live state, newest reading, stored data and the plant's alarms by hour. */
import React, { useMemo } from "react";
import { Link } from "react-router-dom";
import { CloudOff, Code, Database, Gauge, Info, Sun } from "lucide-react";
import type { GrowattWeatherField } from "../../api/client";
import { plantPath } from "../../context/routes";
import { EmptyState, LoadingState, Meter, Panel, StatusBadge, fmt, fmtInt } from "../../components/ui";
import { FIELD_LABEL, FlagList, STATUS_VIEW } from "../../components/sensorView";
import type { ViewRow } from "../../components/sensorView";
import { PanelChart } from "../../components/PanelChart";
import { alarmHourSpec, inverterEvents } from "../../components/alarmEvents";
import { plantToday, useAlarmLog } from "../../context/alarmLogStore";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FIELD_UNIT, FIELDS, hhmm, minutesBetween, fmtAge, coverageTone, compass, DIGITS } from "./format";
import { useSensorDetail } from "./useSensorDetail";

export const Row: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="flex items-baseline justify-between gap-4 border-b border-white/[0.04] py-1.5 last:border-0">
    <span className="text-xs text-slate-400">{label}</span>
    <span className="num text-right text-sm text-slate-100">{children}</span>
  </div>
);

/**
 * Today's Growatt alarms of the sensor's plant by start hour (stored alarm log, the same
 * `/growatt/alarms` read as Active Alarm, kept in tab memory), next to the sensor's own series.
 */
const PlantAlarmsByHour: React.FC<{ plantId: number; plantName: string }> = ({ plantId, plantName }) => {
  const today = plantToday();
  const { view } = useAlarmLog(today);
  const result = view?.result ?? null;
  const events = useMemo(() => inverterEvents(result, true).filter((e) => e.plant_id === plantId), [result, plantId]);
  const spec = useMemo(() => alarmHourSpec(events), [events]);
  const synced = result?.plants.find((p) => p.plant_id === plantId);
  return (
    <Panel
      title="Alarms by hour"
      subtitle={`${plantName} · today · ${fmtInt(events.length)} alarm${events.length === 1 ? "" : "s"}`}
      actions={
        <Link to={`/alarms?plant=${plantId}`} className="text-xs text-solar-300 hover:text-solar-200">
          Active Alarm →
        </Link>
      }
    >
      {!result ? (
        view?.error ? (
          <EmptyState title="Alarm log unavailable" description={view.error} className="py-8" />
        ) : (
          <LoadingState label="Loading alarms…" shape="table" />
        )
      ) : spec ? (
        <PanelChart spec={spec} height={180} />
      ) : (
        <EmptyState title={synced && synced.synced_inverters > 0 ? "No alarms today" : "Not synced yet"} className="py-8" />
      )}
    </Panel>
  );
};

/**
 * One sensor: identity, live state and newest reading (`/growatt/live/sensors/{dl}/{addr}`,
 * polled on `refresh_in_s` while open; memory only), plus today's stored series and coverage (DB).
 * The raw record is sent to admins only.
 */
export const SensorInfo: React.FC<{
  sensor: ViewRow | null;
  sensors: ViewRow[];
  now: string;
  until: string | null;
  onPick: (key: string) => void;
}> = ({ sensor, sensors, now, until, onPick }) => {
  const { detail, detailError, countdown, storedError, spec, today } = useSensorDetail(sensor, now);
  const picker = (
    <Select value={sensor?.key ?? ""} onValueChange={onPick}>
      <SelectTrigger size="sm" className="w-72" aria-label="Sensor">
        <SelectValue placeholder="Pick a sensor" />
      </SelectTrigger>
      <SelectContent>
        {sensors.map((s) => (
          <SelectItem key={s.key} value={s.key}>
            {s.plant_name} · {s.datalogger_sn}#{s.address}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
  if (!sensor)
    return (
      <Panel icon={Info} title="Sensor info" actions={picker}>
        <EmptyState icon={Gauge} title="No sensor selected" description="Pick one here, or click a row on the Status tab." />
      </Panel>
    );

  // the sensor's own live answer is newer than the fleet sweep's row once it has arrived
  const l = detail?.data.status ?? sensor.live;
  const stView = STATUS_VIEW[l && l.status !== "unknown" ? l.status : sensor.status];
  const rd = detail?.data.reading ?? null;
  const measured = detail?.data.measured !== undefined ? detail.data.measured : sensor.measured;
  const fitted = (f: GrowattWeatherField) => !measured || measured.includes(f);
  const raw = detail?.data.raw ?? null;
  const readingError = detail?.data.errors.reading;
  const infoFlags = [...sensor.flags, ...(l?.flags ?? [])];

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel icon={Info} title={`${sensor.datalogger_sn}#${sensor.address}`} subtitle={sensor.device_name ?? undefined} actions={picker}>
          <Row label="Status">
            <StatusBadge status={stView.label} level={stView.level} />
          </Row>
          <Row label="Plant">
            <Link to={`${plantPath(sensor.plant_id, "sensors")}#weather-station`} className="hover:text-solar-300">
              {sensor.plant_name}
            </Link>
          </Row>
          <Row label="Phase (Growatt account)">{sensor.phase ?? "—"}</Row>
          <Row label="Datalogger SN">{sensor.datalogger_sn}</Row>
          <Row label="Bus address">{sensor.address}</Row>
          <Row label="Device name">{sensor.device_name ?? "—"}</Row>
          <Row label="Last upload (Growatt)">
            {l?.last_update_time ? `${l.last_update_time} · ${fmtAge(minutesBetween(l.last_update_time, now))}` : "—"}
          </Row>
          <Row label="Growatt says lost">{l?.lost == null ? "—" : l.lost ? "Yes" : "No"}</Row>
          <Row label="Live check">
            {l?.checked_at ? `${hhmm(l.checked_at)}${l.stale ? " · stale" : ""}${l.listed === false ? " · not in the datalogger's list" : ""}` : "Not checked yet"}
          </Row>
          <Row label="Next refresh">{countdown == null ? (detailError ? "—" : "…") : countdown ? `in ${countdown} s` : "now"}</Row>
          <Row label="Health flags">{infoFlags.length ? `${infoFlags.length}` : "None"}</Row>
          {infoFlags.length > 0 && (
            <div className="mt-2">
              <FlagList flags={infoFlags} />
            </div>
          )}
          <p className="mt-3 text-[11px] text-slate-500">
            Online state comes from Growatt's live sensor list (memory only). Online = upload ≤ {detail?.data.thresholds.late_min ?? 15} min ago, late up to{" "}
            {detail?.data.thresholds.offline_min ?? 60} min.
            {detailError ? ` Live request failed: ${detailError}` : detail?.data.errors.status ? ` Status check failed: ${detail.data.errors.status}` : ""}
          </p>
        </Panel>

        <Panel
          icon={Sun}
          title="Newest reading"
          subtitle={rd ? `Record ${rd.timestamp} · ${fmtAge(minutesBetween(rd.timestamp, now))}` : "From Growatt, live"}
          actions={
            rd ? (
              <Badge variant={rd.stale ? "warn" : "ok"} className="px-2 py-0.5 text-[11px] font-semibold" title={`Fetched ${hhmm(rd.fetched_at)}`}>
                {rd.stale ? "LIVE (STALE)" : "LIVE"} {rd.timestamp.slice(11, 16)}
              </Badge>
            ) : null
          }
        >
          {!detail && !detailError ? (
            <LoadingState label="Asking Growatt for the newest reading…" shape="lines" />
          ) : !rd ? (
            <EmptyState
              icon={CloudOff}
              title="No live reading"
              description={readingError ?? detailError ?? "Growatt has no record for this sensor."}
              className="py-8"
            />
          ) : (
            <>
              <div className="mb-3 rounded-lg border border-white/[0.06] bg-ink-850/70 p-3">
                <div className="flex items-baseline justify-between">
                  <span className="eyebrow">Irradiance</span>
                  <span className="num text-xl font-bold text-solar-300">
                    {fitted("irradiance_wm2") ? fmt(rd.irradiance_wm2, 0) : "—"} <span className="text-xs font-normal text-slate-500">W/m²</span>
                  </span>
                </div>
                {fitted("irradiance_wm2") && rd.irradiance_wm2 != null && <Meter value={rd.irradiance_wm2} max={1100} tone="solar" className="mt-2" />}
              </div>
              {FIELDS.filter((f) => f !== "irradiance_wm2").map((f) => (
                <Row key={f} label={FIELD_LABEL[f]}>
                  {!fitted(f) ? (
                    <span className="text-slate-500">Not fitted</span>
                  ) : (
                    <>
                      {fmt(rd[f], DIGITS[f])} <span className="text-xs text-slate-500">{FIELD_UNIT[f]}</span>
                      {f === "wind_dir_deg" && rd[f] != null && <span className="ml-1 text-xs text-slate-400">{compass(rd[f])}</span>}
                    </>
                  )}
                </Row>
              ))}
            </>
          )}
          <p className="mt-3 text-[11px] text-slate-500">
            {measured
              ? "Live from Growatt, never stored here. Not fitted = the probe read 0 in every stored record of the last 7 days."
              : "Live from Growatt, never stored here. Nothing stored in the last 7 days, so every probe is shown as reported."}
          </p>
        </Panel>
      </div>

      <Panel icon={Database} title="Stored data" subtitle={`Today ${today} · 5-min records in the database`}>
        <div className="grid gap-x-8 md:grid-cols-3">
          <Row label="Newest stored reading">
            {sensor.last_reading_at ? `${sensor.last_reading_at.slice(11, 16)} · ${fmtAge(minutesBetween(sensor.last_reading_at, now))}` : "Nothing stored yet"}
          </Row>
          <Row label={`Coverage today (06:00–${until ?? "—"})`}>
            <span className={coverageTone(sensor.coverage_today_pct)}>{sensor.coverage_today_pct == null ? "—" : `${fmt(sensor.coverage_today_pct, 0)}%`}</span>
          </Row>
          <Row label="Probes reporting (7 d)">{sensor.measured ? sensor.measured.map((f) => FIELD_LABEL[f]).join(", ") || "none" : "—"}</Row>
        </div>
        <div className="mt-3">
          {spec ? (
            <PanelChart spec={spec} height={240} />
          ) : (
            <EmptyState
              icon={Sun}
              title="No readings stored today"
              description={storedError ?? "The worker stores this sensor's 5-min records every 30 min; nothing has arrived for today yet."}
              className="py-8"
            />
          )}
        </div>
      </Panel>

      <PlantAlarmsByHour plantId={sensor.plant_id} plantName={sensor.plant_name} />

      {raw && (
        <Panel icon={Code} title="Raw record" subtitle="Admin only · every field of the newest record as Growatt reported it">
          <details>
            <summary className="cursor-pointer text-xs text-slate-400 hover:text-white">Show {Object.keys(raw).length} fields</summary>
            <div className="mt-2 grid gap-x-8 sm:grid-cols-2 xl:grid-cols-3">
              {Object.entries(raw)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([k, v]) => (
                  <Row key={k} label={k}>
                    {v == null ? "null" : String(v)}
                  </Row>
                ))}
            </div>
            <p className="mt-2 text-[11px] text-slate-500">
              Only irradiance, temperatures, humidity and wind are used; the other fields are always 0 at these plants.
            </p>
          </details>
        </Panel>
      )}
    </div>
  );
};
