/**
 * Generation page: the stored day per inverter, sortable (`?sort=&desc=`). Stored values only:
 * live state is on the Inverters tab, where a row click opens that inverter.
 */
import React from "react";
import { useNavigate } from "react-router-dom";
import { ArrowDown, ArrowUp } from "lucide-react";
import { fmt } from "../../components/ui";
import { usePlantHref } from "../../context/AppContext";
import { pick, useUrlState } from "@/lib/useUrlState";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { HOT_C, invName } from "../inverters/shared";
import type { OverviewInverter } from "../inverters/shared";
import { prTone } from "./charts";

const COLS = [
  { key: "name", label: "Inverter", get: (i: OverviewInverter) => invName(i) },
  { key: "kwp", label: "DC kWp", get: (i: OverviewInverter) => i.capacity_kwp },
  { key: "yield", label: "Yield kWh", get: (i: OverviewInverter) => i.yield_today_kwh },
  { key: "sy", label: "kWh/kWp", get: (i: OverviewInverter) => i.specific_yield },
  { key: "pr", label: "PR %", get: (i: OverviewInverter) => i.pr_pct },
  { key: "pdc", label: "Peak DC kW", get: (i: OverviewInverter) => i.peak_dc_kw },
  { key: "pac", label: "Peak AC kW", get: (i: OverviewInverter) => i.peak_ac_kw },
  { key: "eff", label: "Eff. %", get: (i: OverviewInverter) => i.efficiency_pct },
  { key: "temp", label: "Avg / max °C", get: (i: OverviewInverter) => i.max_temp_c },
  { key: "hz", label: "Grid Hz", get: (i: OverviewInverter) => i.avg_freq_hz },
  { key: "total", label: "Lifetime MWh", get: (i: OverviewInverter) => i.total_yield_kwh },
] as const;
type SortKey = (typeof COLS)[number]["key"];
const SORT_KEYS = COLS.map((c) => c.key);

/** Nulls always last, whichever direction. */
const compare = (a: string | number | null, b: string | number | null, desc: boolean) => {
  if (a == null) return b == null ? 0 : 1;
  if (b == null) return -1;
  const r = typeof a === "string" ? a.localeCompare(String(b), undefined, { numeric: true }) : a - (b as number);
  return desc ? -r : r;
};

export const InverterTable: React.FC<{ inverters: OverviewInverter[]; target: number; dayText: string }> = ({ inverters, target, dayText }) => {
  const navigate = useNavigate();
  const plantHref = usePlantHref();
  const { t } = useI18n();
  const [url, setUrl] = useUrlState();
  const sortParam = url.get("sort");
  const sort: SortKey | null = sortParam ? pick(sortParam, SORT_KEYS, "name") : null;
  const desc = url.get("desc") === "1";

  const rows = sort ? [...inverters].sort((a, b) => compare(COLS.find((c) => c.key === sort)!.get(a), COLS.find((c) => c.key === sort)!.get(b), desc)) : inverters;
  const toggle = (k: SortKey) => {
    // first click: names A→Z, numbers high→low; second click flips; third back to registry order
    const firstDesc = k !== "name";
    if (sort !== k) setUrl({ sort: k, desc: firstDesc ? "1" : null });
    else if (desc === firstDesc) setUrl({ desc: desc ? null : "1" });
    else setUrl({ sort: null, desc: null });
  };
  const open = (sn: string) => navigate(`${plantHref("inverters")}?sn=${encodeURIComponent(sn)}`);

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          {t("Inverters")}
          <Badge variant="neutral" className="num">
            {inverters.length}
          </Badge>
        </CardTitle>
        <CardDescription>{t("Stored day · {day}. Click a column to sort, a row to open the inverter.", { day: dayText })}</CardDescription>
      </CardHeader>
      <CardContent>
        <Table containerClassName="table-wrap">
          <TableHeader>
            <TableRow>
              {COLS.map((c) => {
                const active = sort === c.key;
                const Arrow = desc ? ArrowDown : ArrowUp;
                return (
                  <TableHead
                    key={c.key}
                    className={cn("whitespace-nowrap", c.key !== "name" && "text-right")}
                    aria-sort={active ? (desc ? "descending" : "ascending") : undefined}
                  >
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={() => toggle(c.key)}
                      className={cn(
                        "h-auto gap-1 rounded-none p-0 font-semibold tracking-[inherit] text-inherit hover:bg-transparent hover:text-slate-100",
                        c.key !== "name" && "flex-row-reverse",
                        active && "text-slate-100"
                      )}
                    >
                      {t(c.label)}
                      {active && <Arrow className="size-3" />}
                    </Button>
                  </TableHead>
                );
              })}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((i) => (
              <TableRow
                key={i.device_sn}
                tabIndex={0}
                onClick={() => open(i.device_sn)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    open(i.device_sn);
                  }
                }}
                className="cursor-pointer outline-none focus-visible:bg-white/[0.04]"
              >
                <TableCell>
                  <div className="font-semibold whitespace-nowrap text-slate-100">{invName(i)}</div>
                  <div className="num text-[11px] whitespace-nowrap text-muted-foreground">
                    {i.alias ? `${i.device_sn} · ` : ""}
                    {i.model}
                  </div>
                </TableCell>
                <TableCell className="num text-right whitespace-nowrap text-slate-300">{fmt(i.capacity_kwp, 1)}</TableCell>
                <TableCell className="num text-right font-semibold whitespace-nowrap text-slate-100">{fmt(i.yield_today_kwh, 1)}</TableCell>
                <TableCell className="num text-right whitespace-nowrap text-slate-300">{fmt(i.specific_yield, 2)}</TableCell>
                <TableCell className={cn("num text-right font-semibold whitespace-nowrap", prTone(i.pr_pct, target))}>{fmt(i.pr_pct, 1)}</TableCell>
                <TableCell className="num text-right whitespace-nowrap text-slate-300">{fmt(i.peak_dc_kw, 1)}</TableCell>
                <TableCell className="num text-right whitespace-nowrap text-slate-300">{fmt(i.peak_ac_kw, 1)}</TableCell>
                <TableCell className="num text-right whitespace-nowrap text-slate-300">{fmt(i.efficiency_pct, 2)}</TableCell>
                <TableCell className="num text-right whitespace-nowrap text-slate-300">
                  {fmt(i.avg_temp_c, 1)} /{" "}
                  <span className={cn(i.max_temp_c != null && i.max_temp_c >= HOT_C && "text-amber-300")}>{fmt(i.max_temp_c, 1)}</span>
                </TableCell>
                <TableCell className="num text-right whitespace-nowrap text-slate-300">{fmt(i.avg_freq_hz, 2)}</TableCell>
                <TableCell className="num text-right whitespace-nowrap text-slate-300">
                  {fmt(i.total_yield_kwh == null ? null : i.total_yield_kwh / 1000, 2)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <p className="mt-3 text-[11px] text-muted-foreground">
          {t(
            "PR here is peer-relative: each inverter's strings compared with the plant's other strings (modelled), not IEC 61724. Green ≥ target {target} %, amber within 5 pts, red below. Max temperature amber from {hot} °C.",
            { target: fmt(target, 0), hot: HOT_C }
          )}
        </p>
      </CardContent>
    </Card>
  );
};
