/** Stored detail of one string for a period (DB only: `/growatt/plants/{id}/strings/{sn}/{no}`). */
import { useEffect, useState } from "react";
import { api } from "../../api/client";
import type { GrowattStringDetail } from "../../api/client";
import { isWindowed } from "./period";
import type { StringPeriod } from "./period";
import { translate } from "../../i18n";

export function useStringDetail(plantId: number | null, deviceSn: string | null, stringNo: number | null, period: StringPeriod) {
  const [detail, setDetail] = useState<GrowattStringDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const windowed = isWindowed(period);
  const { day, endDay, start, end } = period;

  useEffect(() => {
    if (plantId == null || !deviceSn || stringNo == null) {
      setDetail(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .getGrowattStringDetail(plantId, deviceSn, stringNo, {
        day: day ?? undefined,
        endDay: endDay ?? undefined,
        start: windowed ? start || undefined : undefined,
        end: windowed ? end || undefined : undefined,
      })
      .then((res) => {
        if (!cancelled) setDetail(res);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setDetail(null);
        setError(err instanceof Error ? err.message : translate("Could not load the stored data"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [plantId, deviceSn, stringNo, day, endDay, windowed, start, end]);

  return { detail, error, loading };
}
