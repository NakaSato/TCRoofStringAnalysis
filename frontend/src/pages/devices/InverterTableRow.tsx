/** Devices page, Inverters tab: one inverter's row (identity, Now (live), Stored, Settings, Work). A click opens the inverter. */
import React from "react";
import { Link, useNavigate } from "react-router-dom";
import { Led, fmt, fmtInt } from "../../components/ui";
import { plantPath } from "../../context/routes";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { TableCell, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { fmtAge, minutesBetween } from "../sensors/format";
import { useI18n } from "../../i18n";
import { STATE_LABEL, STATE_LED } from "./inverters";
import { LIMIT_SOURCE, TIER_VARIANT, fmtStamp, kw, markedAt, modelOf } from "./invertersTable";
import type { Row } from "./invertersTable";

const SEP = "border-l border-white/[0.06]";

/** `day`: the snapshot's day (a live record from it is current); `listDay`: the DB list's day; `now`: plant-local now. */
export const InverterTableRow: React.FC<{ row: Row; day: string | undefined; listDay: string; now: string }> = ({ row, day, listDay, now }) => {
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const { inv: i, live, st } = row;
  const href = `${plantPath(i.plant_id, "inverters")}?sn=${encodeURIComponent(i.device_sn)}`;
  const recToday = !!live?.record_time && live.record_time.slice(0, 10) === day;
  const lastToday = !!i.last_record && i.last_record.slice(0, 10) === listDay;
  const ni0 = i.not_installed;
  const stamp = (ts: string | null | undefined) => fmtStamp(ts, now, locale);
  const notRead = <span className="text-muted-foreground" title={t("Not read")}>—</span>;

  return (
    <TableRow className={cn("cursor-pointer", ni0 && "opacity-50")} onClick={() => navigate(href)}>
      {/* Inverter */}
      <TableCell className="max-w-[240px] pl-4">
        <Link
          to={plantPath(i.plant_id)}
          onClick={(e) => e.stopPropagation()}
          className="block truncate font-medium text-foreground hover:text-sky-300"
          title={i.plant_name}
        >
          {i.plant_name}
        </Link>
        <span className="num text-[11px] text-muted-foreground">
          {i.plant_id}
          {i.site_code ? ` · ${i.site_code}` : ""}
        </span>
      </TableCell>
      <TableCell className="num text-muted-foreground">{i.phase ?? "—"}</TableCell>
      <TableCell className="max-w-[140px] truncate text-muted-foreground" title={i.province ?? undefined}>
        {i.province ?? "—"}
      </TableCell>
      <TableCell className="whitespace-nowrap">
        <span className="font-medium">{i.label || "—"}</span>
        {i.alias && i.alias !== i.label && <div className="max-w-[160px] truncate text-[11px] text-muted-foreground" title={i.alias}>{i.alias}</div>}
        {ni0 && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge variant="neutral" className="mt-0.5">
                {t("Not installed")}
              </Badge>
            </TooltipTrigger>
            <TooltipContent>
              <p>{t("Marked not installed {when} by {who}", { when: markedAt(ni0.at, locale), who: ni0.by ?? "—" })}</p>
              {ni0.note && <p>{ni0.note}</p>}
              <p>{t("Left out of every count, check and live call")}</p>
            </TooltipContent>
          </Tooltip>
        )}
      </TableCell>
      <TableCell className="num whitespace-nowrap text-muted-foreground">{i.device_sn}</TableCell>
      <TableCell className="whitespace-nowrap" title={i.model && i.device_model && i.model !== i.device_model ? i.model : undefined}>
        {modelOf(i) ?? "—"}
      </TableCell>
      <TableCell className="num text-right">{fmt(i.rated_kw, 0)}</TableCell>
      <TableCell className="num whitespace-nowrap text-muted-foreground">{i.fw_version ?? "—"}</TableCell>
      <TableCell className="num whitespace-nowrap text-muted-foreground" title={i.datalogger_model ?? undefined}>
        {i.datalogger_sn ?? "—"}
      </TableCell>

      {/* Now (live) */}
      <TableCell className={cn("whitespace-nowrap", SEP)}>
        {st == null ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <span className="inline-flex items-center gap-1.5" title={live?.status_label ?? undefined}>
            <Led level={STATE_LED[st]} />
            {st === "other" ? live?.status_label ?? t(STATE_LABEL.other) : t(STATE_LABEL[st])}
          </span>
        )}
      </TableCell>
      <TableCell className="num text-right">{recToday ? fmt(kw(live?.pac_w), 1) : "—"}</TableCell>
      <TableCell className="num text-right">{fmt(live?.eac_today_kwh, 1)}</TableCell>
      <TableCell className="num text-right">{recToday ? fmt(live?.temperature_c, 1) : "—"}</TableCell>
      <TableCell
        className={cn("num whitespace-nowrap", live?.record_time && !recToday ? "text-amber-300/80" : "text-muted-foreground")}
        title={live?.record_time && !recToday ? t("Not from today: Growatt's newest record is older") : undefined}
      >
        {stamp(live?.record_time)}
      </TableCell>

      {/* Stored */}
      <TableCell className={cn("num whitespace-nowrap", SEP, i.last_record && !lastToday && "text-amber-300/80")} title={i.last_record ?? t("Nothing stored")}>
        {i.last_record ? (
          <>
            {stamp(i.last_record)}
            <div className="text-[11px] text-muted-foreground">{fmtAge(minutesBetween(i.last_record, now))}</div>
          </>
        ) : (
          "—"
        )}
      </TableCell>
      <TableCell className="num text-right">{fmt(i.yield_today_kwh, 1)}</TableCell>
      <TableCell className="num text-right text-muted-foreground">{i.pct_of_plant_avg == null ? "—" : `${fmt(i.pct_of_plant_avg, 0)} %`}</TableCell>

      {/* Settings */}
      <TableCell className={cn("num text-right", SEP)}>
        {i.power_limit_pct == null ? (
          notRead
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className={cn(i.power_limit_pct < 100 && "font-semibold text-amber-300")}>{fmt(i.power_limit_pct, 0)} %</span>
            </TooltipTrigger>
            <TooltipContent>
              <p>{t("Configured setting, not a measurement")}</p>
              <p>{t("Source: {source}", { source: i.power_limit_source ? t(LIMIT_SOURCE[i.power_limit_source]) : "—" })}</p>
            </TooltipContent>
          </Tooltip>
        )}
      </TableCell>
      <TableCell>
        {i.on_off == null ? notRead : i.on_off === 0 ? <Badge variant="crit">{t("Off")}</Badge> : <span className="text-muted-foreground">{t("On")}</span>}
      </TableCell>

      {/* Work */}
      <TableCell className={cn("whitespace-nowrap", SEP)}>
        {i.open_issues > 0 ? (
          <span className="inline-flex items-center gap-1.5">
            <span className="num font-semibold">{fmtInt(i.open_issues)}</span>
            {i.top_tier && <Badge variant={TIER_VARIANT[i.top_tier] ?? "neutral"}>{i.top_tier}</Badge>}
          </span>
        ) : (
          <span className="num text-muted-foreground">0</span>
        )}
      </TableCell>
      <TableCell className="num whitespace-nowrap pr-4">
        {i.alarms_today == null ? (
          <span className="text-muted-foreground" title={t("The inverter's alarm log was not read today")}>—</span>
        ) : (
          <span className="inline-flex items-center gap-1.5">
            <span className={cn(i.alarms_today ? "font-semibold" : "text-muted-foreground")}>{fmtInt(i.alarms_today)}</span>
            {(i.alarms_open ?? 0) > 0 && <Badge variant="crit">{t("{n} open", { n: i.alarms_open ?? 0 })}</Badge>}
          </span>
        )}
      </TableCell>
    </TableRow>
  );
};
