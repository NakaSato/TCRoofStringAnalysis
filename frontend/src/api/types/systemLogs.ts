/** API types: System → Logs (`/system/logs`, admin only). */

/** /system/logs — one stored log record of the API or worker (admin only, already redacted). */
export type SystemLogLevel = "DEBUG" | "INFO" | "WARNING" | "ERROR" | "CRITICAL";
export type SystemLogSource = "api" | "worker" | "cli";
export interface SystemLogEntry {
  id: number;
  /** UTC ISO ("…Z") */
  ts: string;
  level: SystemLogLevel;
  source: SystemLogSource;
  host: string | null;
  logger: string;
  message: string;
  exc_text: string | null;
  /** `sync_runs.id` of the job run that logged it */
  run_id: number | null;
  job: string | null;
  request_id: string | null;
  extra: Record<string, unknown> | null;
}

export interface SystemLogPage {
  items: SystemLogEntry[];
  /** pass as `before_id` for older rows; null = no more in the window */
  next_before_id: number | null;
  meta: { source: "db"; since: string | null; retention_days: number; enabled: boolean; level: SystemLogLevel };
}

export interface SystemLogQuery {
  level?: SystemLogLevel;
  source?: SystemLogSource[];
  job?: string;
  run_id?: number;
  q?: string;
  since?: string;
  before_id?: number;
  after_id?: number;
  limit?: number;
}

export interface SystemLogSummary {
  since: string;
  total: number;
  by_level: Record<SystemLogLevel, number>;
  by_source: Record<SystemLogSource, number>;
  last_error: SystemLogEntry | null;
  newest_id: number | null;
  enabled: boolean;
}
