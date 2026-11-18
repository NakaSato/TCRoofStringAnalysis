/** API types: Weather: Growatt sensor history, Google Maps Weather (modelled) and live sensor weather. */

export type GrowattWeatherField =
  | "irradiance_wm2"
  | "ambient_temp_c"
  | "module_temp_c"
  | "humidity_pct"
  | "wind_speed_ms"
  | "wind_dir_deg";

export interface GrowattWeatherSensor {
  datalogger_sn: string;
  address: number;
  device_name: string | null;
  samples: number;
  first_reading: string | null;
  last_reading: string | null;
  /** fields the sensor actually reported that day (others read 0 all day = not fitted) */
  measured: GrowattWeatherField[];
}

export interface GrowattWeatherKpis {
  insolation_kwh_m2: number | null;
  peak_irradiance_wm2: number | null;
  avg_ambient_temp_c: number | null;
  max_ambient_temp_c: number | null;
  avg_module_temp_daylight_c: number | null;
  irradiance_weighted_module_temp_c?: number | null;
  max_module_temp_c: number | null;
  avg_humidity_pct: number | null;
  avg_wind_speed_ms: number | null;
  max_wind_speed_ms: number | null;
  stale_irradiance_slots?: number;
  poa_filtered_slots?: number;
}

export interface GrowattIecPr {
  pr_pct: number | null;
  pr_temp_corrected_pct?: number | null;
  irradiance_weighted_module_temp_c?: number | null;
  epi?: number | null;
  reference_yield_h: number | null;
  final_yield_h: number | null;
  coverage_pct: number | null;
  /** why pr_pct is null */
  reason: string | null;
}

export type GrowattWeatherPoint = { timestamp: string } & Record<GrowattWeatherField, number | null>;

/** /growatt/plants/{id}/weather — stored 5-minute weather-sensor history (DB only). */
export interface GrowattWeatherDay {
  meta: {
    source: "db";
    day: string | null;
    data_until: string | null;
    /** plant-local time-of-day window (HH:MM, inclusive) the series and KPIs cover; null = whole day */
    window: { start: string | null; end: string | null } | null;
    /** the one sensor the series and KPIs cover (`?sensor=`); null = average of all sensors */
    sensor?: { datalogger_sn: string; address: number } | null;
  };
  has_sensor: boolean;
  sensors: GrowattWeatherSensor[];
  kpis: GrowattWeatherKpis;
  series: GrowattWeatherPoint[];
}

/** Google Maps Weather values: modelled for the plant's grid cell, not measured at the plant. */
export interface GoogleWeatherValues {
  condition: string | null;
  is_daytime: boolean | null;
  temp_c: number | null;
  feels_like_c: number | null;
  dew_point_c: number | null;
  humidity_pct: number | null;
  cloud_cover_pct: number | null;
  uv_index: number | null;
  precip_mm: number | null;
  precip_prob_pct: number | null;
  thunder_prob_pct: number | null;
  wind_speed_ms: number | null;
  wind_gust_ms: number | null;
  wind_dir_deg: number | null;
  pressure_hpa: number | null;
  visibility_km: number | null;
}

export interface GoogleWeatherCell {
  key: string;
  latitude: number;
  longitude: number;
}

export interface GoogleWeatherSlot {
  raining: boolean | null;
  status_th: "ฝนตก" | "ไม่มีฝน" | null;
  condition: string | null;
  precip_mm: number | null;
  precip_prob_pct: number | null;
  cloud_cover_pct: number | null;
  temp_c: number | null;
}

/** /growatt/plants/{id}/google-weather — stored hourly Google weather for one day (DB only). */
export interface GoogleWeatherDay {
  meta: { source: "db"; provider: string; modelled: true; day: string | null; cell: GoogleWeatherCell | null };
  configured: boolean;
  has_location: boolean;
  hours: Array<{ hour: string } & GoogleWeatherValues>;
  kpis: {
    hours: number;
    complete: boolean;
    rain_mm: number | null;
    rain_hours: number | null;
    temp_max_c: number | null;
    temp_min_c: number | null;
    cloud_cover_daytime_pct: number | null;
    uv_max: number | null;
    humidity_avg_pct: number | null;
    wind_gust_max_ms: number | null;
    thunder_prob_max_pct: number | null;
    condition: string | null;
    rained: boolean | null;
  };
  /** rain status at 09:00, 12:00, 17:00 (null = hour not stored yet) */
  slots: Record<"09" | "12" | "17", GoogleWeatherSlot | null>;
  rain: { days_since_rain: number | null; last_rain_day: string | null; last_rain_mm: number | null };
}

/** /growatt/live/plants/{id}/google-weather — current conditions (memory only, cached 30 min per cell). */
export interface GoogleWeatherNow extends GoogleWeatherValues {
  plant_id: number;
  provider: string;
  modelled: true;
  cell: GoogleWeatherCell;
  condition_text: string | null;
  icon_uri: string | null;
  precip_type: string | null;
  time_utc: string | null;
  time_zone: string | null;
  past24h_precip_mm: number | null;
  past24h_max_temp_c: number | null;
  past24h_min_temp_c: number | null;
}

/** /growatt/live/plants/{id}/weather — newest reading per sensor (memory only, never stored). */
export interface GrowattLiveWeather {
  plant_id: number;
  sensors: Array<
    {
      datalogger_sn: string;
      address: number;
      timestamp: string;
      /** seconds between the sensor's last two live records (memory only); null until measured */
      interval_s: number | null;
      /** newest stored reading of this sensor (plant-local); live points after it are not in the DB yet */
      stored_until: string | null;
      stale?: boolean;
      fetched_at?: string;
    } & Record<
      GrowattWeatherField,
      number | null
    >
  >;
  errors: Record<string, string>;
}

/** Rain class the Longdo weather radar shows over a point: 0 = no rain … 5 = very heavy. */
export interface RadarRain {
  intensity: number;
  /** Longdo's own wording (Thai) */
  description: string | null;
}

/** `/growatt/live/rain-radar`: Longdo rain radar for the Plant Map (memory only on the backend). */
export interface RainRadar {
  provider: string;
  radar: true;
  /** Unix seconds of the radar snapshots available, oldest first */
  frames: number[];
  /** Leaflet tile URL with `{time}` for the snapshot; carries the Longdo Map browser key */
  tile_url: string;
  min_zoom: number;
  max_zoom: number;
  attribution: string;
  /** colour and label of each rain class; empty when Longdo's legend could not be read */
  legend: Array<{ intensity: number; label: string; color: string }>;
}

/** `/growatt/live/plants/{id}/rain`: radar rain over the plant, radar-derived and never measured. */
export interface PlantRadarRain {
  plant_id: number;
  provider: string;
  radar: true;
  cell: { key: string; latitude: number; longitude: number };
  /** null = Longdo gave no class, or the lookup is held back (the envelope is then `stale` with the reason in `error`) */
  now: RadarRain | null;
  /** where `now` comes from: the plant's own lookup, or the fleet sweep's cache while that lookup waits */
  now_via: "point" | "sweep" | null;
  /** nowcast; `rain` null = not available for that lead time */
  forecast: Array<{ lead_min: number | null; time: number | null; rain: RadarRain | null }>;
  forecast_error: string | null;
  /** rain within `radius_km` of the plant; `error` when Longdo refused that part or it is held back */
  area: {
    radius_km: number;
    now: RadarAreaStats | null;
    forecast: Array<{ lead_min: number | null; time: number | null; stats: RadarAreaStats | null }>;
    error: string | null;
  };
}

/** Share of a circle the radar shows rain over, and the strongest class in it. */
export interface RadarAreaStats {
  coverage_pct: number | null;
  max_intensity: number | null;
}

/** `/growatt/live/rain`: radar rain now over every visible plant (swept on the backend, memory only). */
export interface FleetRadarRain {
  provider: string;
  radar: true;
  plants: Array<{
    plant_id: number;
    /** false = not asked yet (or no location): `rain` is null, which is not "no rain" */
    checked: boolean;
    rain: RadarRain | null;
    /** "area" = no rain anywhere in the plant's region; "point" = asked for the plant itself */
    via: "area" | "point" | null;
    fetched_at: string | null;
  }>;
  located: number;
  checked: number;
  raining: number;
  usage: { monthly_budget: number; used_this_month: number; allowance_today: number; used_today: number };
}
