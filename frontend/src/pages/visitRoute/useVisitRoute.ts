/* State of the Visit Route page: URL choices (`d`, `team`, `user`, `tab`), the candidates, the unsaved stop
   list (component state only), the start / end / times, and the solves.

   Solving costs Geoapify credits only for a new point set (start + stops): the backend caches the
   matrix 24 h. So "Plan best order" is a click, and only edits that keep the point set (order, time
   on site, windows, end, leave / latest time, day) re-solve by themselves, with `keep_order`,
   debounced. Adding / removing a stop or changing the start marks the plan outdated instead.

   Offices (`/growatt/routes/offices`, admins edit them in the start picker) are read once and again
   after each edit. A fresh page with no start takes the default office once they load; a start the
   user picked (or cleared) is never replaced. A start office that is renamed follows the edit; one
   that is deleted falls back to the new default, else no start. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "../../api/client";
import type {
  OmAssignees,
  RouteCandidate,
  RouteCandidates,
  RouteEndMode,
  RouteOffice,
  RouteOfficeIn,
  RouteOfficePatch,
  RouteServiceBasis,
  RouteSolveRequest,
  RouteSolveResponse,
} from "../../api/client";
import { useFleet } from "../../context/FleetContext";
import { pick, pickDay, useUrlState } from "@/lib/useUrlState";
import { notify } from "@/lib/notify";
import { translate } from "../../i18n";
import {
  DEFAULT_LATEST,
  DEFAULT_LEAVE,
  DEFAULT_SERVICE_MIN,
  MAX_STOPS,
  RESOLVE_DEBOUNCE_MS,
  SERVICE_MIN_MAX,
  apiErrorText,
  bangkokToday,
  hasLocation,
  isHhmm,
  noLocationIds,
  plantLocated,
} from "./format";

export interface StopDraft {
  plant_id: number;
  name: string;
  city: string | null;
  lat: number;
  lon: number;
  /** time on site as typed (minutes) */
  service: string;
  /** where the suggested time came from; "default" = no task type behind it */
  basis: RouteServiceBasis;
  windowOn: boolean;
  open: string;
  close: string;
}

export type StartChoice =
  | { kind: "plant"; plant_id: number; name: string; lat: number; lon: number }
  | { kind: "office"; office_id: number; name: string; address: string | null; lat: number; lon: number }
  | { kind: "point"; source: "gps" | "map"; label: string; lat: number; lon: number; accuracy_m: number | null };

export interface SolveError {
  text: string;
  kind: "rate" | "no_location" | "other";
  plantIds: number[];
}

interface Answer {
  res: RouteSolveResponse;
  /** start + the set of stops the answer was solved for */
  setKey: string;
  /** the whole request (stops in the answer's order), to tell when an edit needs a re-solve */
  key: string;
}

/** The panel's tabs: the plants that call for a visit, and the itinerary. */
export const ROUTE_TABS = ["plants", "route"] as const;
export type RouteTab = (typeof ROUTE_TABS)[number];

const numParam = (v: string | null): number | null => (v != null && /^\d+$/.test(v) ? Number(v) : null);

export const serviceValue = (s: StopDraft): number | null => {
  if (s.service.trim() === "") return null;
  const n = Number(s.service);
  return Number.isFinite(n) && n >= 0 && n <= SERVICE_MIN_MAX ? n : null;
};

/** null = no window; "invalid" = half filled or close before open */
export const windowValue = (s: StopDraft): { open: string; close: string } | null | "invalid" => {
  if (!s.windowOn) return null;
  if (!isHhmm(s.open) || !isHhmm(s.close) || s.close < s.open) return "invalid";
  return { open: s.open, close: s.close };
};

/** The start in the set key (a new key = "Plan best order" again). An office keys by its id and
 * coordinate, so a rename keeps the plan and a moved office does not. */
const startKey = (s: StartChoice | null): string => {
  if (s == null) return "";
  if (s.kind === "plant") return `p${s.plant_id}`;
  const at = `${s.lat.toFixed(5)},${s.lon.toFixed(5)}`;
  return s.kind === "office" ? `o${s.office_id}@${at}` : `g${at}`;
};
export const officeStart = (o: RouteOffice): StartChoice => ({
  kind: "office",
  office_id: o.id,
  name: o.name,
  address: o.address,
  lat: o.lat,
  lon: o.lon,
});
const setKeyOf = (start: StartChoice | null, stops: StopDraft[]) =>
  `${startKey(start)}|${stops.map((s) => s.plant_id).sort((a, b) => a - b).join(",")}`;

export function useVisitRoute() {
  const [url, setUrl] = useUrlState();
  const today = bangkokToday();
  const day = pickDay(url.get("d")) ?? today;
  const teamId = numParam(url.get("team"));
  const userId = numParam(url.get("user"));
  const addParam = url.get("add");
  const { growattPlants, plantListLoaded } = useFleet();

  // ---- people and teams (Calendar's lists)
  const [people, setPeople] = useState<OmAssignees | null>(null);
  useEffect(() => {
    let off = false;
    api
      .listOmAssignees()
      .then((a) => !off && setPeople(a))
      .catch(() => !off && setPeople({ users: [], teams: [] }));
    return () => {
      off = true;
    };
  }, []);

  // ---- candidates for the day / team / person
  const [cands, setCands] = useState<RouteCandidates | null>(null);
  const [candError, setCandError] = useState<string | null>(null);
  const [candLoading, setCandLoading] = useState(true);
  const [candVersion, setCandVersion] = useState(0);
  useEffect(() => {
    let off = false;
    setCandLoading(true);
    api
      .getRouteCandidates({ day, team_id: teamId, user_id: userId })
      .then((c) => {
        if (off) return;
        setCands(c);
        setCandError(null);
      })
      .catch((e) => {
        if (off) return;
        setCands(null);
        setCandError(apiErrorText(e));
      })
      .finally(() => !off && setCandLoading(false));
    return () => {
      off = true;
    };
  }, [day, teamId, userId, candVersion]);
  const reloadCandidates = useCallback(() => setCandVersion((v) => v + 1), []);
  const candById = useMemo(() => new Map((cands?.candidates ?? []).map((c) => [c.plant_id, c])), [cands]);
  const plantById = useMemo(() => new Map(growattPlants.map((p) => [p.plant_id, p])), [growattPlants]);

  // ---- route inputs (component state only: unsaved)
  const [stops, setStops] = useState<StopDraft[]>([]);
  // the newest list, for callbacks that run before a re-render (add several, solve)
  const stopsRef = useRef(stops);
  stopsRef.current = stops;
  const [start, setStartState] = useState<StartChoice | null>(null);
  /** the user chose (or cleared) the start: the default office never replaces it */
  const startTouched = useRef(false);
  const setStart = useCallback((s: StartChoice | null) => {
    startTouched.current = true;
    setStartState(s);
  }, []);
  const [endMode, setEndMode] = useState<RouteEndMode>("return");
  const [leaveAt, setLeaveAt] = useState(DEFAULT_LEAVE);
  const [latestFinish, setLatestFinish] = useState(DEFAULT_LATEST);

  // ---- saved offices (start points; admins edit them in the start picker)
  const [offices, setOffices] = useState<RouteOffice[] | null>(null);
  const [officesError, setOfficesError] = useState<string | null>(null);
  const reloadOffices = useCallback(async (): Promise<RouteOffice[] | null> => {
    try {
      const r = await api.listRouteOffices();
      setOffices(r.offices);
      setOfficesError(null);
      return r.offices;
    } catch (e) {
      setOfficesError(apiErrorText(e));
      setOffices((prev) => prev ?? []);
      return null;
    }
  }, []);
  useEffect(() => {
    void reloadOffices();
  }, [reloadOffices]);
  const defaultOffice = useMemo(() => offices?.find((o) => o.is_default) ?? null, [offices]);

  // the default office as the start of a fresh page, once, when the user has not chosen one
  const autoStartDone = useRef(false);
  useEffect(() => {
    if (autoStartDone.current || offices == null) return;
    autoStartDone.current = true;
    if (!startTouched.current && defaultOffice) setStartState((prev) => prev ?? officeStart(defaultOffice));
  }, [offices, defaultOffice]);

  // a start office follows edits to it; a deleted one falls back to the default, else no start
  useEffect(() => {
    if (offices == null) return;
    setStartState((prev) => {
      if (prev?.kind !== "office") return prev;
      const o = offices.find((x) => x.id === prev.office_id);
      if (!o) return defaultOffice ? officeStart(defaultOffice) : null;
      const next = officeStart(o) as Extract<StartChoice, { kind: "office" }>;
      return next.name === prev.name && next.address === prev.address && next.lat === prev.lat && next.lon === prev.lon ? prev : next;
    });
  }, [offices, defaultOffice]);

  /** admin: save an office (then start from it); the error text is thrown for the form */
  const createOffice = useCallback(
    async (body: RouteOfficeIn): Promise<RouteOffice> => {
      const o = await api.createRouteOffice(body);
      setStart(officeStart(o));
      await reloadOffices();
      return o;
    },
    [reloadOffices, setStart]
  );
  const updateOffice = useCallback(
    async (id: number, body: RouteOfficePatch): Promise<RouteOffice> => {
      const o = await api.updateRouteOffice(id, body);
      await reloadOffices();
      return o;
    },
    [reloadOffices]
  );
  const deleteOffice = useCallback(
    async (id: number) => {
      await api.deleteRouteOffice(id);
      await reloadOffices();
    },
    [reloadOffices]
  );

  const inRoute = useMemo(() => new Set(stops.map((s) => s.plant_id)), [stops]);
  const full = stops.length >= MAX_STOPS;

  /** a stop from a plant id: needs a visible plant with a location */
  const makeStop = useCallback(
    (plantId: number, cand?: RouteCandidate): StopDraft | null => {
      const p = plantById.get(plantId);
      const fromCand = cand?.has_location && hasLocation(cand.lat, cand.lon);
      const lat = fromCand ? cand!.lat : p && plantLocated(p) ? p.latitude : null;
      const lon = fromCand ? cand!.lon : p && plantLocated(p) ? p.longitude : null;
      if (lat == null || lon == null) return null;
      const suggested = cand ? Math.min(Math.max(0, Math.round(cand.default_service_min)), SERVICE_MIN_MAX) : DEFAULT_SERVICE_MIN;
      return {
        plant_id: plantId,
        name: cand?.name ?? p?.name ?? translate("Plant {id}", { id: plantId }),
        city: cand?.city ?? p?.city ?? null,
        lat,
        lon,
        service: String(suggested),
        basis: cand?.service_basis ?? "default",
        windowOn: false,
        open: "",
        close: "",
      };
    },
    [plantById]
  );

  const addStops = useCallback(
    (ids: number[]): { added: number; skipped: number } => {
      let added = 0;
      let skipped = 0;
      const next = [...stopsRef.current];
      for (const id of ids) {
        if (next.some((s) => s.plant_id === id)) continue;
        const s = next.length < MAX_STOPS ? makeStop(id, candById.get(id)) : null;
        if (s) {
          next.push(s);
          added++;
        } else skipped++;
      }
      if (added) {
        stopsRef.current = next;
        setStops(next);
      }
      return { added, skipped };
    },
    [makeStop, candById]
  );
  const addStop = useCallback((id: number) => void addStops([id]), [addStops]);
  const removeStop = useCallback((id: number) => setStops((prev) => prev.filter((s) => s.plant_id !== id)), []);
  const toggleStop = useCallback((id: number) => (inRoute.has(id) ? removeStop(id) : addStop(id)), [inRoute, removeStop, addStop]);
  const moveStop = useCallback((from: number, to: number) => {
    setStops((prev) => {
      if (from === to || from < 0 || to < 0 || from >= prev.length || to >= prev.length) return prev;
      const next = [...prev];
      const [s] = next.splice(from, 1);
      next.splice(to, 0, s);
      return next;
    });
  }, []);
  const patchStop = useCallback((id: number, patch: Partial<StopDraft>) => {
    setStops((prev) => prev.map((s) => (s.plant_id === id ? { ...s, ...patch } : s)));
  }, []);
  const clearStops = useCallback(() => setStops([]), []);

  // ---- `add=<id>,<id>` from Calendar / O&M Dashboard / Plant Map: once the fleet list and the
  // candidates (for the service defaults) are in, add what is visible and located, then drop it.
  const addDone = useRef(false);
  useEffect(() => {
    if (!addParam || addDone.current || !plantListLoaded || candLoading) return;
    addDone.current = true;
    const ids = [...new Set(addParam.split(",").map((x) => x.trim()).filter((x) => /^\d+$/.test(x)).map(Number))];
    const { skipped } = addStops(ids);
    setUrl({ add: null });
    if (skipped > 0) notify("warn", translate("{n} plants were not added: not visible to you, no location in Growatt, or over {max} stops.", { n: skipped, max: MAX_STOPS }));
  }, [addParam, plantListLoaded, candLoading, addStops, setUrl]);

  // ---- panel tab: URL `tab`; without one, chosen once when the page has loaded (after `add=`):
  // Route when there are stops, else Plants to visit. Adding a plant later never switches it.
  const tabParam = url.get("tab");
  const [autoTab, setAutoTab] = useState<RouteTab | null>(null);
  useEffect(() => {
    if (autoTab != null || !plantListLoaded || candLoading || addParam) return;
    setAutoTab(stops.length ? "route" : "plants");
  }, [autoTab, plantListLoaded, candLoading, addParam, stops.length]);
  const tab: RouteTab = tabParam != null ? pick(tabParam, ROUTE_TABS, "plants") : (autoTab ?? (stops.length ? "route" : "plants"));
  const setTab = useCallback((v: RouteTab) => setUrl({ tab: v }), [setUrl]);

  // ---- the request
  const buildRequest = useCallback(
    (list: StopDraft[], keepOrder: boolean): RouteSolveRequest | null => {
      if (!start || list.length === 0 || list.length > MAX_STOPS || !isHhmm(leaveAt) || !isHhmm(latestFinish)) return null;
      const out: RouteSolveRequest["stops"] = [];
      for (const s of list) {
        const service = serviceValue(s);
        const w = windowValue(s);
        if (service == null || w === "invalid") return null;
        out.push({ plant_id: s.plant_id, service_min: service, ...(w ? { window: w } : {}) });
      }
      return {
        start:
          start.kind === "plant"
            ? { kind: "plant", plant_id: start.plant_id }
            : start.kind === "office"
              ? { kind: "office", office_id: start.office_id }
              : { kind: "point", lat: Number(start.lat.toFixed(6)), lon: Number(start.lon.toFixed(6)), label: start.label },
        end_mode: endMode,
        day,
        leave_at: leaveAt,
        latest_finish: latestFinish,
        keep_order: keepOrder,
        stops: out,
      };
    },
    [start, endMode, day, leaveAt, latestFinish]
  );
  const keyOf = useCallback(
    (list: StopDraft[]) => {
      const r = buildRequest(list, true);
      return r ? JSON.stringify(r) : "";
    },
    [buildRequest]
  );

  const currentSetKey = setKeyOf(start, stops);
  const currentKey = keyOf(stops);
  const canSolve = currentKey !== "";

  // ---- solving
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [solving, setSolving] = useState(false);
  const [solveError, setSolveError] = useState<SolveError | null>(null);
  const failedKey = useRef<string | null>(null);
  const seq = useRef(0);

  const solve = useCallback(
    async (keepOrder: boolean) => {
      const list = stopsRef.current;
      const req = buildRequest(list, keepOrder);
      if (!req) return;
      const my = ++seq.current;
      const sentKey = keyOf(list);
      const sentSet = setKeyOf(start, list);
      setSolving(true);
      try {
        const res = await api.solveRoute(req);
        if (my !== seq.current) return;
        let ordered = list;
        if (!keepOrder) {
          // take the solved order into the list, so later edits keep it
          const byId = new Map(stopsRef.current.map((s) => [s.plant_id, s]));
          const solvedIds = res.stops.map((s) => s.plant_id);
          const same = solvedIds.length === stopsRef.current.length && solvedIds.every((id) => byId.has(id));
          if (same) {
            ordered = solvedIds.map((id) => byId.get(id)!);
            setStops(ordered);
          }
        }
        setAnswer({ res, setKey: sentSet, key: keepOrder ? sentKey : keyOf(ordered) });
        setSolveError(null);
        failedKey.current = null;
      } catch (e) {
        if (my !== seq.current) return;
        failedKey.current = sentKey;
        const status = e instanceof ApiError ? e.status : 0;
        setSolveError({
          text: apiErrorText(e),
          kind: status === 429 ? "rate" : status === 422 && noLocationIds(e).length ? "no_location" : "other",
          plantIds: noLocationIds(e),
        });
      } finally {
        if (my === seq.current) setSolving(false);
      }
    },
    [buildRequest, keyOf, start]
  );

  const sameSet = answer != null && answer.setKey === currentSetKey;
  const sameOrder =
    sameSet && answer!.res.stops.length === stops.length && answer!.res.stops.every((s, i) => s.plant_id === stops[i]?.plant_id);
  /** an edit that keeps the point set: re-solved by itself shortly */
  const pending = sameSet && canSolve && answer!.key !== currentKey;
  /** stops or start changed since the plan: "Plan best order" again */
  const outdated = answer != null && !sameSet;

  // debounced keep-order re-solve; never for a request that just failed (no 429 loop)
  useEffect(() => {
    if (!pending || solving || failedKey.current === currentKey) return;
    const id = window.setTimeout(() => void solve(true), RESOLVE_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [pending, solving, currentKey, solve]);

  const retry = useCallback(() => {
    failedKey.current = null;
    void solve(sameSet ? true : false);
  }, [solve, sameSet]);

  return {
    day,
    today,
    teamId,
    userId,
    setUrl,
    tab,
    setTab,
    people,
    cands,
    candById,
    candError,
    candLoading,
    reloadCandidates,
    plantById,
    growattPlants,
    plantListLoaded,
    stops,
    inRoute,
    full,
    addStop,
    addStops,
    removeStop,
    toggleStop,
    moveStop,
    patchStop,
    clearStops,
    start,
    setStart,
    offices,
    officesError,
    defaultOffice,
    reloadOffices,
    createOffice,
    updateOffice,
    deleteOffice,
    endMode,
    setEndMode,
    leaveAt,
    setLeaveAt,
    latestFinish,
    setLatestFinish,
    canSolve,
    solve,
    retry,
    solving,
    solveError,
    answer: answer?.res ?? null,
    sameSet,
    sameOrder,
    pending,
    outdated,
  };
}

export type VisitRoute = ReturnType<typeof useVisitRoute>;
