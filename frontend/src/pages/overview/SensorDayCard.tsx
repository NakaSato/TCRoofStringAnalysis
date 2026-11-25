/** Plant Overview: the stored day's weather-sensor figures (measured; PR' derived from them). Only for a plant with a sensor. */
import React from "react";
import { Clock, Gauge, PanelsTopLeft, Percent, Sun, SunDim } from "lucide-react";
import type { GrowattPlantOverview } from "../../api/client";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { IconStat, IconStats } from "./IconStat";
import { useI18n } from "../../i18n";

export const SensorDayCard: React.FC<{ ov: GrowattPlantOverview; dayText: string; className?: string }> = ({ ov, dayText, className }) => {
  const { t } = useI18n();
  const k = ov.kpis;
  const iec = ov.weather?.iec_pr ?? null;
  const health = k.sensor_health ?? null;
  const suspect = health?.ok === false;
  const suspectHint = suspect ? t("Sensor suspect: {reasons}", { reasons: health.reasons.join("; ") }) : undefined;

  return (
    <Card className={cn("gap-3", className)}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {t("Sensor day")}
          <span className="num text-[11px] font-normal text-muted-foreground">{dayText}</span>
          {suspect ? (
            <Badge variant="warn" title={health.reasons.join("; ")}>
              {t("sensor suspect")}
            </Badge>
          ) : (
            <Badge variant="neutral" title={t("Stored weather-sensor records of the day")}>
              {t("measured")}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <IconStats cols="grid-cols-3">
          <IconStat icon={Sun} label={t("Insolation (POA)")} num={k.insolation_kwh_m2 ?? null} digits={2} unit="kWh/m²" hint={suspectHint} />
          <IconStat
            icon={Clock}
            label={t("Reference yield Yr")}
            num={iec?.reference_yield_h ?? null}
            digits={2}
            unit="h"
            hint={t("POA insolation / 1 kW/m²")}
          />
          <IconStat icon={SunDim} label={t("Peak irradiance")} num={k.peak_irradiance_wm2 ?? null} digits={0} unit="W/m²" />
          <IconStat
            icon={PanelsTopLeft}
            label={t("Module temperature (irradiance-weighted)")}
            num={k.irradiance_weighted_module_temp_c ?? null}
            digits={1}
            unit="°C"
          />
          <IconStat
            icon={Gauge}
            label={t("PR' (temperature-corrected)")}
            num={k.iec_pr_temp_corrected_pct ?? null}
            digits={1}
            unit="%"
            hint={iec?.pr_pct == null && iec?.reason ? iec.reason : t("IEC 61724 PR / [1 + γ(T_mod − 25 °C)]")}
            tone={suspect ? "text-amber-300" : undefined}
          />
          <IconStat
            icon={Percent}
            label={t("Sensor coverage")}
            num={iec?.coverage_pct ?? null}
            digits={0}
            unit="%"
            hint={t("Share of the day's daylight slots with a sensor record")}
          />
        </IconStats>
      </CardContent>
    </Card>
  );
};
