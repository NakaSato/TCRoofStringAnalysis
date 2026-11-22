/* Visit Route helpers: reason kinds, number / time formats, error text, the Google Maps link labels
   and the plain-text stop list. Missing values are "—", never 0 (CLAUDE.md rule 3). */
import type { GrowattPlant, RouteFallbackReason, RouteMethod, RouteReasonKind, RouteSolveResponse } from "../../api/client";
import { ApiError } from "../../api/client";
import { translate } from "../../i18n";
import { fmt, fmtInt } from "../../components/ui";

/** At most this many stops per day (backend: more = 422 "split the day"). */
export const MAX_STOPS = 25;
/** Backend bounds of the time on site. */
export const SERVICE_MIN_MAX = 720;
/** Time on site when a plant is added with no candidate behind it (the backend's default). */
export const DEFAULT_SERVICE_MIN = 45;
export const DEFAULT_LEAVE = "08:00";
export const DEFAULT_LATEST = "18:00";
/** re-solve after a reorder / time change, once the edits pause */
export const RESOLVE_DEBOUNCE_MS = 600;

/** Reason kinds in the order the candidates panel lists them. */
export const REASON_KINDS: readonly RouteReasonKind[] = ["alarm", "issue", "task", "claim", "cleaning_due", "pm_due"];

/** The coordinate test of the Plant Map's `hasLocation`: set, finite, in range and not 0,0. */
export const hasLocation = (lat: number | null | undefined, lon: number | null | undefined): boolean =>
  lat != null &&
  lon != null &&
  Number.isFinite(lat) &&
  Number.isFinite(lon) &&
  !(lat === 0 && lon === 0) &&
  Math.abs(lat) <= 90 &&
  Math.abs(lon) <= 180;

export const plantLocated = (p: GrowattPlant): boolean => hasLocation(p.latitude, p.longitude);

/** Today in Bangkok, "YYYY-MM-DD". */
export const bangkokToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Bangkok" });

export const isHhmm = (v: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(v);

/** "1 h 25 min" / "55 min"; "—" for null. */
export const fmtDuration = (min: number | null | undefined): string => {
  if (min == null || !Number.isFinite(min)) return "—";
  const m = Math.round(min);
  if (m < 60) return translate("{m} min", { m });
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? translate("{h} h {m} min", { h, m: r }) : translate("{h} h", { h });
};

/** "123.4 km" (one decimal below 100 km, whole km above); "—" for null. */
export const fmtKm = (km: number | null | undefined): string =>
  km == null || !Number.isFinite(km) ? "—" : `${km < 100 ? fmt(km, 1) : fmtInt(km)} km`;

/** "HH:MM+1" → { time: "HH:MM", day: 1 }; no offset = day 0; missing = "—" */
export const splitClock = (v: string | null | undefined): { time: string; day: number } => {
  if (!v) return { time: "—", day: 0 };
  const m = /^(\d{2}:\d{2})\+(\d+)$/.exec(v);
  return m ? { time: m[1], day: Number(m[2]) } : { time: v, day: 0 };
};

/** "arrive–leave" with a day offset written once: "15:45–16:30 (+2 day)"; when the visit crosses
 * midnight each end keeps its own. "—" when either is missing. */
export const fmtSpan = (eta: string | null | undefined, etd: string | null | undefined): string => {
  if (!eta || !etd) return "—";
  const a = splitClock(eta);
  const b = splitClock(etd);
  if (a.day !== b.day) return `${fmtClock(eta)}–${fmtClock(etd)}`;
  const span = `${a.time}–${b.time}`;
  return a.day ? translate("{time} (+{n} day)", { time: span, n: a.day }) : span;
};

/** "HH:MM+1" → "HH:MM (+1 day)" */
export const fmtClock = (v: string | null | undefined): string => {
  if (!v) return "—";
  const m = /^(\d{2}:\d{2})\+(\d+)$/.exec(v);
  return m ? translate("{time} (+{n} day)", { time: m[1], n: m[2] }) : v;
};

/** A candidate reason's short English label in the UI language: "Cleaning (planned)",
 * "Cleaning overdue", "Claim CL-2026-001 next action", "Open fault alarm"; anything else (issue
 * rule names) through `translate`, so it stays as sent when there is no Thai. */
export const reasonLabel = (label: string): string => {
  let m = /^(.*) \((planned|in progress|overdue)\)$/.exec(label);
  if (m) return translate("{task} ({state})", { task: translate(m[1]), state: translate(m[2]) });
  m = /^Claim (\S+) next action$/.exec(label);
  if (m) return translate("Claim {no}: next action", { no: m[1] });
  m = /^(.*) overdue$/.exec(label);
  if (m) return translate("{task} overdue", { task: translate(m[1]) });
  return translate(label);
};

export const fmtThb = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? "—" : `฿${fmtInt(v)}`);

export const METHOD_LABEL: Record<RouteMethod, string> = {
  exact: "Best order (exact)",
  heuristic: "Good order (heuristic)",
  fixed: "Your order",
  trivial: "Only one order",
};

export const FALLBACK_TEXT: Record<RouteFallbackReason, string> = {
  no_key: "Geoapify is not set up on the server (no API key).",
  error: "Geoapify did not answer or answered an error.",
  cooldown: "Geoapify failed a moment ago; the server waits before asking again.",
  budget: "Today's Geoapify credits are used up.",
};

/** Text of an API error for the page: the backend's message (`detail` string or `{message}`), a
 * validation error's first message, else the error's own text. */
export const apiErrorText = (e: unknown): string => {
  if (e instanceof ApiError) {
    const d = e.detail as unknown;
    if (typeof d === "string") return d;
    if (d && typeof d === "object" && !Array.isArray(d) && typeof (d as { message?: unknown }).message === "string") {
      return (d as { message: string }).message;
    }
    if (Array.isArray(d) && d.length && typeof d[0]?.msg === "string") return String(d[0].msg);
    return e.message;
  }
  return e instanceof Error ? e.message : String(e);
};

/** Plant ids a 422 "no location" answer names (empty for any other error). */
export const noLocationIds = (e: unknown): number[] => {
  if (!(e instanceof ApiError) || e.status !== 422) return [];
  const d = e.detail as { plants?: Array<{ plant_id?: unknown }> } | undefined;
  return Array.isArray(d?.plants) ? d!.plants!.map((p) => Number(p.plant_id)).filter(Number.isFinite) : [];
};

/** One label per Google Maps link by stop numbers, from the link's first to its last point: "Stops 3–5",
 * "Start–Stop 3" (leaves the start), "Stop 5–End" (back at the start), "Start–End". Each link's legs =
 * its waypoints + 1. */
export const navLabels = (r: RouteSolveResponse): string[] => {
  const n = r.stops.length;
  let at = 0;
  return r.google_maps_links.map((link) => {
    let legs = 1;
    try {
      const w = new URL(link).searchParams.get("waypoints");
      legs = w ? w.split("|").length + 1 : 1;
    } catch {
      /* not a URL: count one leg */
    }
    const from = at;
    at += legs;
    const fromStart = from === 0;
    const toEnd = at > n;
    if (fromStart && toEnd) return translate("Start–End");
    if (fromStart) return translate("Start–Stop {b}", { b: at });
    if (toEnd) return translate("Stop {a}–End", { a: from });
    return translate("Stops {a}–{b}", { a: from, b: at });
  });
};

/** Link `i` in the copied stop list: "Navigate" when one link covers the day, else "Navigate 3 → 6". */
export const navLabel = (r: RouteSolveResponse, labels: string[], i: number): string =>
  r.google_maps_links.length === 1 ? translate("Navigate") : translate("Navigate {range}", { range: labels[i] });

/** Google Maps search link for one point */
export const mapsPointLink = (lat: number, lon: number) =>
  `https://www.google.com/maps/search/?api=1&query=${lat.toFixed(5)},${lon.toFixed(5)}`;

/** The stop list as plain text (chat apps): day, start, each stop with ETA and a map link, the
 * navigation links. Drive times are estimates and say so. */
export const stopListText = (r: RouteSolveResponse, dayText: string): string => {
  const lines: string[] = [];
  lines.push(translate("Visit route {day}", { day: dayText }));
  lines.push(`${translate("Start point")}: ${r.start.kind === "point" ? translate(r.start.name) : r.start.name} · ${translate("Leave {time}", { time: r.totals.leave_at })}`);
  for (const s of r.stops) {
    lines.push(`${s.seq}. ${s.name} · ${translate("ETA {time}", { time: fmtClock(s.eta) })} · ${mapsPointLink(s.lat, s.lon)}`);
  }
  if (r.return_leg) lines.push(`${translate("Back at the start")} · ${fmtClock(r.return_leg.eta)}`);
  lines.push(
    `${translate("Drive")}: ${fmtKm(r.totals.drive_km)} · ${fmtDuration(r.totals.drive_min)} (${translate(
      r.source === "geoapify" ? "Road estimate (Geoapify, OpenStreetMap)" : "Straight line, not road"
    )})`
  );
  const labels = navLabels(r);
  r.google_maps_links.forEach((url, i) => lines.push(`${navLabel(r, labels, i)}: ${url}`));
  return lines.join("\n");
};

/** Clipboard API, else a hidden textarea + execCommand (older / insecure contexts). */
export const copyText = async (text: string): Promise<boolean> => {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the old way */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
};
