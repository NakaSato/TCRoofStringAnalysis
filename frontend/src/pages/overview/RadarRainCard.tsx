/** Plant Overview: Longdo radar rain over the plant now, +15 / +30 min and within 10 km (radar-derived, memory only). */
import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { ApiError, api } from "../../api/client";
import type { RainRadar } from "../../api/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { PlantRainRow } from "../plantMap/rainRadar";
import { useI18n } from "../../i18n";

/**
 * The snapshot list is read once for Longdo's legend and to know whether plant rain exists: hidden
 * when the backend has no Longdo key (404) or serves only the RainViewer fallback (`point_rain: false`).
 * The plant's rain is then polled by `PlantRainRow` when the backend says (`refresh_in_s`).
 */
export const RadarRainCard: React.FC<{ plantId: number; className?: string }> = ({ plantId, className }) => {
  const [radar, setRadar] = useState<RainRadar | null>(null);
  const [off, setOff] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const { t } = useI18n();
  useEffect(() => {
    let cancelled = false;
    setError(null);
    api
      .getRainRadar()
      .then((r) => !cancelled && setRadar(r.data))
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) setOff(true);
        else setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [tick]);

  if (off || radar?.point_rain === false) return null;

  return (
    <Card className={cn("gap-3", className)}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {t("Rain radar")}
          <Badge variant="info" title={t("What the Longdo weather radar shows over the plant (~1 km), not a measurement at the site.")}>
            {t("radar-derived")}
          </Badge>
        </CardTitle>
        <CardAction>
          <Button asChild variant="ghost" size="icon-sm" aria-label={t("Open Plant Map")} title={t("Open Plant Map")}>
            <Link to="/map">
              <ArrowRight />
            </Link>
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {radar ? (
          <PlantRainRow plantId={plantId} legend={radar.legend} bare />
        ) : error ? (
          <div className="flex items-center justify-between gap-2">
            <p className="callout-warn text-[11px]">{t("Rain radar unavailable: {error}", { error })}</p>
            <Button variant="outline" size="xs" onClick={() => setTick((n) => n + 1)}>
              {t("Try again")}
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-2" aria-label={t("Loading rain radar")}>
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        )}
      </CardContent>
    </Card>
  );
};
