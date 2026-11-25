/** Plant Overview: Longdo radar rain over the plant now, +15 / +30 min and within 10 km (radar-derived, memory only). */
import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { ApiError, api } from "../../api/client";
import type { RainRadar } from "../../api/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
  const { t } = useI18n();
  useEffect(() => {
    let cancelled = false;
    api
      .getRainRadar()
      .then((r) => !cancelled && setRadar(r.data))
      .catch((err) => !cancelled && err instanceof ApiError && err.status === 404 && setOff(true));
    return () => {
      cancelled = true;
    };
  }, []);

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
        {radar ? <PlantRainRow plantId={plantId} legend={radar.legend} bare /> : <p className="text-[11px] text-slate-400">{t("Loading…")}</p>}
      </CardContent>
    </Card>
  );
};
