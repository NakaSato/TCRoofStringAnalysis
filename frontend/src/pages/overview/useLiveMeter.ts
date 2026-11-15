/**
 * The plant's energy meter, live (`/growatt/live/plants/{id}/meter`, memory only): one poll shared by
 * the Energy meter card and the Production chart. Each answer's grid record is kept as a point in
 * component memory (today only, never stored), so the chart can continue the stored meter curve.
 */
import { useEffect, useState } from "react";
import { api, ApiError } from "../../api/client";
import type { GrowattLive, GrowattLiveMeter } from "../../api/client";
import { useLivePoll } from "../../context/useLivePoll";
import { plantToday } from "../../context/alarmLogStore";
import type { PowerCurve } from "../generation/charts";

type Row = PowerCurve["ts"][number];

/** one meter record: import / export measured, load derived (null when the backend could not derive it) */
export interface MeterPoint {
  timestamp: string;
  grid_import_kw: number | null;
  grid_export_kw: number | null;
  load_kw: number | null;
}

const MAX_POINTS = 288; // a day of 5-min records

export const useLiveMeter = (plantId: number | null) => {
  const [res, setRes] = useState<GrowattLive<GrowattLiveMeter> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [noMeter, setNoMeter] = useState(false);
  const [points, setPoints] = useState<MeterPoint[]>([]);
  useEffect(() => {
    setRes(null);
    setError(null);
    setNoMeter(false);
    setPoints([]);
  }, [plantId]);

  useLivePoll(
    plantId != null && !noMeter,
    plantId,
    () => api.getGrowattLiveMeter(plantId as number),
    (r) => {
      setRes(r);
      setError(null);
      const g = r.data.grid;
      if (!g.timestamp || g.timestamp.slice(0, 10) !== plantToday()) return;
      const p: MeterPoint = {
        timestamp: g.timestamp,
        grid_import_kw: g.grid_import_kw,
        grid_export_kw: g.grid_export_kw,
        load_kw: r.data.load?.load_kw ?? null,
      };
      setPoints((ps) =>
        [...ps.filter((x) => x.timestamp !== p.timestamp && x.timestamp.slice(0, 10) === p.timestamp.slice(0, 10)), p]
          .sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1))
          .slice(-MAX_POINTS)
      );
    },
    (err) => {
      if (err instanceof ApiError && err.status === 404) setNoMeter(true);
      else setError(err instanceof Error ? err.message : String(err));
    }
  );

  return { res, error, noMeter, points };
};

const slotOf = (t: string) => `${t.slice(0, 14)}${String(Math.floor(Number(t.slice(14, 16)) / 5) * 5).padStart(2, "0")}:00`;

/**
 * Today's curve continued with the live meter records past the newest stored slot, in 5-min slots
 * like the backend: into the live inverter slot of the same time when there is one, else a row of
 * its own with PV unknown (null, never 0). Flagged `live`; a stored slot is never changed.
 */
export const withLiveMeter = (rows: Row[], points: MeterPoint[], day: string): Row[] => {
  const stored = rows.filter((r) => !r.live);
  const after = stored.length ? stored[stored.length - 1].timestamp : "";
  const bySlot = new Map<string, MeterPoint>();
  for (const p of points) {
    const slot = slotOf(p.timestamp);
    if (slot.slice(0, 10) !== day || slot <= after) continue;
    bySlot.set(slot, p); // points are in time order: the newest record of a slot wins
  }
  if (!bySlot.size) return rows;
  const out = rows.map((r) => {
    const p = r.live ? bySlot.get(r.timestamp) : undefined;
    if (!p) return r;
    bySlot.delete(r.timestamp);
    return { ...r, grid_import_kw: p.grid_import_kw, grid_export_kw: p.grid_export_kw, load_kw: p.load_kw };
  });
  for (const [slot, p] of bySlot)
    out.push({
      timestamp: slot,
      pac_kw: null,
      ppv_kw: null,
      expected_kw: null,
      temp_c: null,
      freq_hz: null,
      grid_import_kw: p.grid_import_kw,
      grid_export_kw: p.grid_export_kw,
      load_kw: p.load_kw,
      live: true,
    });
  return out.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
};
