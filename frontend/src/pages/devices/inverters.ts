/**
 * Devices page, inverters: the DB list (`/growatt/devices/inverters`, read on mount / Refresh / when
 * "show not installed" changes, never polled) and the fleet inverter snapshot (`maxs_data`, backend
 * memory only, swept; polled on `refresh_in_s`), overlaid by serial. Shared by the header strip and
 * the Inverters tab, so both read one request each.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../../api/client";
import type { DeviceInverterList, GrowattInverterSnapshot, GrowattInverterSnapshotRow, GrowattLive } from "../../api/client";
import { useLivePoll } from "../../context/useLivePoll";

/** Live state filter values (`?status=`). */
export const LIVE_STATES = ["normal", "waiting", "fault", "offline", "unchecked"] as const;
export type LiveFilter = (typeof LIVE_STATES)[number];
/** "other" = a record from today with a status code other than 0 / 1 / 3 (shown with Growatt's label). */
export type LiveState = LiveFilter | "other";

/**
 * The plant directory's rule (`useFleetDirectory`): normal / waiting / fault = a status 1 / 0 / 3
 * record from today, offline = no record today (an old record is never read as current), not
 * checked = the sweep has not answered for it. `maxs_data`'s `lost` is ignored (true on every inverter).
 */
export const liveState = (r: GrowattInverterSnapshotRow | undefined, day: string | undefined): LiveState => {
  if (!r || !day) return "unchecked";
  if (!r.record_time || r.record_time.slice(0, 10) !== day) return "offline";
  if (r.status === 1) return "normal";
  if (r.status === 0) return "waiting";
  if (r.status === 3) return "fault";
  return "other";
};

export const STATE_LABEL: Record<LiveState, string> = {
  normal: "Normal",
  waiting: "Waiting",
  fault: "Fault",
  offline: "Offline",
  unchecked: "Not checked",
  other: "Other",
};

export const STATE_LED: Record<LiveState, "ok" | "warn" | "crit" | "off"> = {
  normal: "ok",
  waiting: "warn",
  fault: "crit",
  offline: "crit",
  unchecked: "off",
  other: "warn",
};

/** Sort rank of a state: what needs action first. */
export const STATE_RANK: Record<LiveState, number> = { fault: 0, offline: 1, other: 2, waiting: 3, normal: 4, unchecked: 5 };

export interface LiveCounts {
  normal: number;
  waiting: number;
  fault: number;
  offline: number;
  other: number;
  /** null until the device list has answered (it says which inverters exist) */
  unchecked: number | null;
  /** installed inverters the sweep has answered for */
  checked: number;
  /** installed inverters (device list), else the snapshot's row count */
  total: number;
}

export function useDeviceInverters(includeNotInstalled: boolean) {
  const [list, setList] = useState<DeviceInverterList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .listDeviceInverters(includeNotInstalled)
      .then((r) => !cancelled && (setList(r), setError(null)))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [includeNotInstalled, tick]);
  const reload = useCallback(() => setTick((n) => n + 1), []);

  // newest record of every inverter (realtime, backend memory only; never stored)
  const [snap, setSnap] = useState<GrowattLive<GrowattInverterSnapshot> | null>(null);
  const [snapError, setSnapError] = useState<string | null>(null);
  useLivePoll(
    true,
    "devices-inverter-snapshot",
    () => api.getGrowattInverterSnapshot(),
    (r) => {
      setSnap(r);
      setSnapError(null);
    },
    (e) => setSnapError(e instanceof Error ? e.message : String(e))
  );

  const counts = useMemo<LiveCounts | null>(() => {
    if (!snap) return null;
    const day = snap.data.day;
    const c: LiveCounts = { normal: 0, waiting: 0, fault: 0, offline: 0, other: 0, unchecked: null, checked: 0, total: 0 };
    const add = (st: LiveState) => {
      if (st === "unchecked") c.unchecked = (c.unchecked ?? 0) + 1;
      else {
        c[st] += 1;
        c.checked += 1;
      }
    };
    if (list) {
      c.unchecked = 0;
      for (const inv of list.inverters) {
        if (inv.not_installed) continue; // left out of every count
        c.total += 1;
        add(liveState(snap.data.inverters[inv.device_sn], day));
      }
    } else {
      for (const r of Object.values(snap.data.inverters)) {
        c.total += 1;
        add(liveState(r, day));
      }
    }
    return c;
  }, [list, snap]);

  const sweep = snap?.data.sweep;
  /** the backend sweep has a fresh answer for every chunk */
  const sweepDone = !!snap && !snap.stale && sweep != null && sweep.fresh >= sweep.total;

  return { list, error, loading, reload, snap, snapError, counts, sweepDone };
}

export type DeviceInverters = ReturnType<typeof useDeviceInverters>;

