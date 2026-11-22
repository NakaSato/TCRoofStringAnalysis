/** Engineering O&M tables: the issues to fix first and one row per plant. Rows come sorted from the
 * page; these only render. Missing values show "—"; modelled columns say so in the header. No
 * estimated lost kWh / ฿: the page shows stored measurements, the report and entered costs only. */
import React from "react";
import { Link } from "react-router-dom";
import { Route } from "lucide-react";
import type { OmCenterIssue, OmCenterPlant, PwaMeterSiteSummary } from "../../api/client";
import { plantPath } from "../../context/routes";
import { fmt, fmtInt } from "../../components/ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { routeHref } from "../visitRoute/href";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SortHead } from "../pwaMeter/tables";
import { ENTERED, fmtDay, thb } from "./format";
import { useI18n } from "../../i18n";

const tierVariant = (i: OmCenterIssue) => (i.safety || i.tier === "P1" ? "crit" : i.tier === "P2" ? "warn" : "neutral");

/** where the evidence of an issue is: the string page, the inverter's Issues tab, else the plant */
const issueHref = (i: OmCenterIssue): string =>
  i.device_sn && i.string_no != null
    ? `${plantPath(i.plant_id, "string")}?sn=${encodeURIComponent(i.device_sn)}&no=${i.string_no}`
    : i.device_sn
      ? `${plantPath(i.plant_id, "inverters")}?sn=${encodeURIComponent(i.device_sn)}&tab=issues`
      : plantPath(i.plant_id);

export const IssuesTable: React.FC<{ rows: OmCenterIssue[] }> = ({ rows }) => {
  const { t } = useI18n();
  return (
  <Table containerClassName="table-wrap">
    <TableHeader>
      <TableRow>
        <TableHead>{t("Tier")}</TableHead>
        <TableHead>{t("Issue")}</TableHead>
        <TableHead>{t("Plant")}</TableHead>
        <TableHead>{t("Where")}</TableHead>
        <TableHead className="text-right">{t("Age")}</TableHead>
        <TableHead>{t("Acknowledged")}</TableHead>
        <TableHead>{t("Next visit")}</TableHead>
        <TableHead className="w-8">
          <span className="sr-only">{t("Add to route")}</span>
        </TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      {rows.map((i) => (
        <TableRow key={i.id}>
          <TableCell>
            <Badge variant={tierVariant(i)}>{i.safety ? t("Safety") : i.tier}</Badge>
          </TableCell>
          <TableCell className="whitespace-nowrap">
            <Link to={issueHref(i)} className="hover:text-solar-400">
              {i.name}
            </Link>
            <span className="num ml-1.5 text-[11px] text-muted-foreground">{i.rule}</span>
            {i.shadow && (
              <Badge variant="info" className="ml-1.5" title={t("Rule still in shadow mode: not shown to engineers")}>
                {t("Shadow")}
              </Badge>
            )}
          </TableCell>
          <TableCell className="max-w-[220px] truncate">
            <Link to={plantPath(i.plant_id)} className="hover:text-solar-400">
              {i.plant_name ?? t("Plant {id}", { id: i.plant_id })}
            </Link>
          </TableCell>
          <TableCell className="whitespace-nowrap text-muted-foreground">
            {i.device_sn ? (i.inverter_name ?? i.device_sn) : t("Plant")}
            {i.string_no != null ? ` · ${t("String {n}", { n: i.string_no })}` : ""}
          </TableCell>
          <TableCell className="num whitespace-nowrap text-right">{t("{n} d", { n: i.age_days })}</TableCell>
          <TableCell className="whitespace-nowrap text-muted-foreground">{i.ack_by ?? "—"}</TableCell>
          <TableCell className="num whitespace-nowrap">
            {i.next_visit ? (
              <Link to={`/calendar?plant=${i.plant_id}`} className="hover:text-solar-400">
                {fmtDay(i.next_visit)}
                <span className="ml-1 text-[11px] text-muted-foreground">{i.days_to_visit === 0 ? t("today") : t("in {n} d", { n: i.days_to_visit })}</span>
              </Link>
            ) : (
              <span className="text-amber-300">{t("None planned")}</span>
            )}
          </TableCell>
          <TableCell className="w-8 py-0.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button asChild variant="ghost" size="icon-xs" aria-label={t("Add {plant} to route", { plant: i.plant_name ?? t("Plant {id}", { id: i.plant_id }) })}>
                  <Link to={routeHref({ plantIds: [i.plant_id] })}>
                    <Route />
                  </Link>
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t("Add to route")}</TooltipContent>
            </Tooltip>
          </TableCell>
        </TableRow>
      ))}
    </TableBody>
  </Table>
  );
};

export const PlantSortKeys = ["issues", "name", "billed", "epi", "pr", "avail", "contract", "clean", "visit", "spend"] as const;
export type PlantSort = (typeof PlantSortKeys)[number];

export const plantSortValue = (r: OmCenterPlant, k: PlantSort, sites?: Map<number, PwaMeterSiteSummary>): number | string | null =>
  ({
    contract: sites?.get(r.plant_id)?.vs_contract_pct ?? null,
    billed: sites?.get(r.plant_id)?.meter_mwh ?? null,
    name: r.name,
    issues: r.active_issues,
    epi: r.epi_median,
    pr: r.pr_temp_corrected_median_pct,
    avail: r.availability_pct,
    clean: r.days_since_cleaning,
    visit: r.next_visit,
    spend: r.spend_thb,
  })[k];

const availTone = (v: number | null) => (v == null ? "" : v >= 99 ? "text-emerald-300" : v < 95 ? "text-red-300" : "text-amber-300");

const contractTone = (v: number | null) => (v == null ? "" : v >= 100 ? "text-emerald-300" : v < 90 ? "text-red-300" : "text-amber-300");

export const PlantsTable: React.FC<{
  rows: OmCenterPlant[];
  sort: PlantSort;
  desc: boolean;
  onSort: (k: PlantSort) => void;
  /** the plant's site in the PWA meter report, by Growatt plant id (none = not in the report) */
  sites: Map<number, PwaMeterSiteSummary>;
  onOpenSite: (siteId: string) => void;
}> = ({ rows, sort, desc, onSort, sites, onOpenSite }) => {
  const { t } = useI18n();
  const h = { sort, desc, onSort };
  return (
    <Table containerClassName="table-wrap">
      <TableHeader>
        <TableRow>
          <SortHead k="name" label={t("Plant")} {...h} />
          <SortHead k="billed" label={<>{t("Billed")}<span className="ml-0.5 text-[10px] font-normal text-muted-foreground">MWh</span></>} className="text-right" title={t("PWA meter report: the site's billed meter energy for the report days in the period (measured). — = not in the report.")} {...h} />
          <SortHead k="contract" label={<>{t("Meter vs contract")}<span className="ml-0.5 text-[10px] font-normal text-muted-foreground">{t("mod.")}</span></>} className="text-right" title={t("PWA meter report: billed meter energy ÷ the contract's expected energy (modelled), for the report days in the period. Opens the site's days.")} {...h} />
          <SortHead k="issues" label={t("Issues")} className="text-right" {...h} />
          <SortHead k="avail" label={t("Availability")} className="text-right" title={t("Inverter minutes not in fault / off / standby ÷ daylight minutes with data")} {...h} />
          <SortHead k="epi" label="EPI" className="text-right" title={t("Median of the period: measured ÷ modelled energy (modelled). Days with a suspect sensor left out.")} {...h} />
          <SortHead k="pr" label="PR′" className="text-right" title={t("Median temperature-corrected PR of the period. Days with a suspect sensor left out.")} {...h} />
          <SortHead k="clean" label={t("Since cleaning")} className="text-right" title={t("Days since the last cleaning in the Site log")} {...h} />
          <SortHead k="visit" label={t("Next visit")} {...h} />
          <SortHead k="spend" label={t("O&M spend")} className="text-right" title={t(ENTERED)} {...h} />
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.plant_id}>
            <TableCell className="max-w-[260px]">
              <Link to={plantPath(r.plant_id)} className="block truncate hover:text-solar-400">
                {r.name}
              </Link>
              <span className="num block text-[11px] text-muted-foreground">
                {r.capacity_kwp != null ? `${fmt(r.capacity_kwp, 0)} kWp · ` : ""}
                {r.energy_kwh != null ? t("Growatt {v} kWh", { v: fmt(r.energy_kwh, 0) }) : t("no Growatt energy stored")}
              </span>
            </TableCell>
            <TableCell className="num text-right font-medium">
              {sites.get(r.plant_id)?.meter_mwh == null ? <span className="text-muted-foreground" title={t("Not in the PWA meter report")}>—</span> : fmt(sites.get(r.plant_id)!.meter_mwh, 1)}
            </TableCell>
            <TableCell className="num text-right">
              {(() => {
                const site = sites.get(r.plant_id);
                if (!site) return <span className="text-muted-foreground" title={t("Not in the PWA meter report")}>—</span>;
                return (
                  <button type="button" onClick={() => onOpenSite(site.site_id)} className={`hover:underline ${contractTone(site.vs_contract_pct)}`}>
                    {site.vs_contract_pct == null ? "—" : `${fmt(site.vs_contract_pct, 1)} %`}
                  </button>
                );
              })()}
            </TableCell>
            <TableCell className="num text-right">{r.active_issues ? fmtInt(r.active_issues) : "—"}</TableCell>
            <TableCell className={`num text-right ${availTone(r.availability_pct)}`}>{r.availability_pct == null ? "—" : `${fmt(r.availability_pct, 1)} %`}</TableCell>
            <TableCell className="num text-right">{fmt(r.epi_median, 2)}</TableCell>
            <TableCell className="num text-right">{r.pr_temp_corrected_median_pct == null ? "—" : `${fmt(r.pr_temp_corrected_median_pct, 1)} %`}</TableCell>
            <TableCell className="num text-right">{r.days_since_cleaning == null ? <span className="text-muted-foreground">{t("None recorded")}</span> : t("{n} d", { n: r.days_since_cleaning })}</TableCell>
            <TableCell className="num whitespace-nowrap">{r.next_visit ? fmtDay(r.next_visit) : "—"}</TableCell>
            <TableCell className="num text-right">{thb(r.spend_thb)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
};
