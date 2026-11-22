/**
 * The Energy & Billing baseline for the Production card's period: the PWA contract's expected kWh
 * per day (`/pwa/meter/plants/{id}/baseline`, modelled; a report day keeps the figure it was billed
 * against). Only whole days: none for a time-of-day window. A plant without a PWA report site
 * answers 404 once and is not asked again. DB only, read once per plant and period.
 */
import { useEffect, useState } from "react";
import { ApiError, api } from "../../api/client";
import type { PwaPlantBaseline } from "../../api/client";

/** plants that answered 404 (not a PWA report site), so a period change does not ask again */
const noSite = new Set<number>();

export const usePlantBaseline = (plantId: number | null, day: string | null, endDay: string | null, windowed: boolean): PwaPlantBaseline | null => {
  const end = endDay ?? day;
  const key = plantId != null && day && end && !windowed && !noSite.has(plantId) ? `${plantId}|${day}|${end}` : null;
  const [res, setRes] = useState<{ key: string; data: PwaPlantBaseline | null } | null>(null);
  useEffect(() => {
    if (!key || plantId == null || !day || !end) return;
    let cancelled = false;
    api.getPwaMeterPlantBaseline(plantId, day, end).then(
      (d) => !cancelled && setRes({ key, data: d }),
      (e) => {
        if (e instanceof ApiError && e.status === 404) noSite.add(plantId);
        if (!cancelled) setRes({ key, data: null });
      }
    );
    return () => {
      cancelled = true;
    };
  }, [key, plantId, day, end]);
  return key && res?.key === key ? res.data : null;
};
