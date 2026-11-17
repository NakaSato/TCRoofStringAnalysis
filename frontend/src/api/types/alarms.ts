/** API types: Growatt alarm log, live (`/growatt/live/plants/{id}/alarms`) and stored (`/growatt/alarms`). */

/** One record of the Growatt alarm / fault log (`device/max/alarm_data`); times are plant-local. */
export interface GrowattAlarm {
  device_sn: string;
  start_time: string | null;
  end_time: string | null;
  alarm_code: number | string | null;
  alarm_message: string | null;
  /** as Growatt labels it: "Warning", "Fault", … */
  fault_type: string | null;
  status: number | null;
}

/** /growatt/live/plants/{id}/alarms — memory only, never stored. */
export interface GrowattLiveAlarms {
  plant_id: number;
  /** first / last plant-local day of the window */
  from: string;
  to: string;
  alarms: GrowattAlarm[];
  /** inverter-days whose log could not be read ("SN YYYY-MM-DD" -> error) */
  errors: Record<string, string>;
}

/** One plant's alarm-log coverage for a day in /growatt/alarms. */
export interface FleetAlarmPlant {
  plant_id: number;
  name: string;
  inverters: number;
  /** inverters whose log for the day the worker has read (0 = not synced yet, not "no alarms") */
  synced_inverters: number;
  /** oldest read among them (UTC ISO); null when none was read */
  synced_at: string | null;
}

/** /growatt/alarms — stored alarm log of every visible plant for one plant-local day (DB only). */
export interface FleetAlarmDay {
  day: string;
  /** `read_at`: when this inverter's log was last read (UTC ISO), the reference for "still open" */
  alarms: Array<GrowattAlarm & { plant_id: number; plant_name: string; read_at?: string | null }>;
  plants: FleetAlarmPlant[];
  meta: {
    source: "db";
    synced_at: string | null;
    /** when the worker's `alarms` job last started (UTC ISO) */
    last_run_at?: string | null;
    /** when it will next start (UTC ISO); today only */
    next_run_at?: string | null;
  };
}
