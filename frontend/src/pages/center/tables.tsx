/** Engineering O&M tables: the issues to fix first and one row per plant. Rows come sorted from the
 * page; these only render. Missing values show "—"; modelled columns say so in the header. No
 * estimated lost kWh / ฿: the page shows stored measurements, the report and entered costs only. */
import React from "react";
import { Link } from "react-router-dom";
import { MoreHorizontal, Route } from "lucide-react";
import type { OmCenterIssue, OmCenterPlant, PwaMeterSiteSummary } from "../../api/client";
import { plantPath } from "../../context/routes";
import { fmt, fmtInt } from "../../components/ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { newClaimHref } from "@/lib/claimLinks";
import { routeHref } from "../visitRoute/href";
import { STATUS as CLAIM_STATUS } from "../claims/format";
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

/** the issue's linked claims: the newest open one as a badge (others in the tooltip), else the newest closed one muted */
const LinkedClaims: React.FC<{ claims: OmCenterIssue["claims"] }> = ({ claims }) => {
  const { t } = useI18n();
  if (!claims?.length) return <span className="text-muted-foreground">—</span>;
  const shown = claims.find((c) => c.open) ?? claims[0];
  const rest = claims.filter((c) => c !== shown);
  return (
    <Link
      to={`/claims?tab=all&claim=${shown.id}`}
      className="inline-flex items-center gap-1 whitespace-nowrap hover:text-solar-400"
      title={rest.length ? rest.map((c) => `${c.number} · ${t(CLAIM_STATUS[c.status]?.label ?? c.status)}`).join("\n") : undefined}
    >
      <span className={shown.open ? "num" : "num text-muted-foreground"}>{shown.number}</span>
      <Badge variant={shown.open ? (CLAIM_STATUS[shown.status]?.variant ?? "neutral") : "neutral"}>{t(CLAIM_STATUS[shown.status]?.label ?? shown.status)}</Badge>
      {rest.length > 0 && <span className="text-[11px] text-muted-foreground">+{rest.length}</span>}
    </Link>
  );
};

export const IssuesTable: React.FC<{ rows: OmCenterIssue[]; onPlanTask?: (i: OmCenterIssue) => void }> = ({ rows, onPlanTask }) => {
  const { t } = useI18n();
  return (
  <Table containerClassName="table-wrap">
    <TableHeader>
      <TableRow>
        <TableHead>{t("Tier")}</TableHead>
        <TableHead>{t("Issue")}</TableHead>
        <TableHead>{t("Plant")}</TableHead>
        <TableHead>{t("Where")}</TableHead>
        <TableHead className="text-right">{t("Open for")}</TableHead>
        <TableHead>{t("Acknowledged")}</TableHead>
        <TableHead>{t("Next visit")}</TableHead>
        <TableHead>{t("Claim")}</TableHead>
        <TableHead className="w-16">
          <span className="sr-only">{t("Actions")}</span>
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
          <TableCell>
            <LinkedClaims claims={i.claims} />
          </TableCell>
          <TableCell className="w-16 py-0.5">
            <div className="flex items-center justify-end">
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
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="icon-xs" variant="ghost" aria-label={t("Actions for issue #{id}", { id: i.id })}>
                    <MoreHorizontal />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-52">
                  {onPlanTask && <DropdownMenuItem onSelect={() => onPlanTask(i)}>{t("Plan a visit…")}</DropdownMenuItem>}
                  <DropdownMenuItem asChild>
                    <Link to={newClaimHref("issue", { plantId: i.plant_id, sn: i.device_sn, stringNo: i.string_no, ref: i.id })}>{t("Open a claim…")}</Link>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem asChild>
                    <Link to={issueHref(i)}>{t("Show the evidence")}</Link>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </TableCell>
        </TableRow>
      ))}
    </TableBody>
  </Table>
  );
};

export const PlantSortKeys = ["issues", "name", "billed", "epi", "pr", "avail", "contract", "clean", "visit", "spend", "claims"] as const;
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
    claims: r.open_claims,
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
  onPlanTask?: (plantId: number) => void;
}> = ({ rows, sort, desc, onSort, sites, onOpenSite, onPlanTask }) => {
  const { t } = useI18n();
  const h = { sort, desc, onSort };
  return (
    <Table containerClassName="table-wrap">
      <TableHeader>
        <TableRow>
          <SortHead k="name" label={t("Plant")} {...h} />
          <SortHead k="billed" label={<>{t("Billed")}<span className="ml-0.5 text-[10px] font-normal text-muted-foreground">MWh</span></>} className="text-right" title={t("PWA meter report: the site's billed meter energy for the report days in the period (measured). — = not in the report.")} {...h} />
          <SortHead k="contract" label={<>{t("Meter vs contract")}<span className="ml-0.5 text-[10px] font-normal text-muted-foreground">{t("mod.")}</span></>} className="text-right" title={t("PWA meter report: billed meter energy / the contract's expected energy (modelled), for the report days in the period. Opens the site's days.")} {...h} />
          <SortHead k="issues" label={t("Issues")} className="text-right" {...h} />
          <SortHead k="avail" label={t("Availability")} className="text-right" title={t("Inverter minutes not in fault / off / standby / daylight minutes with data")} {...h} />
          <SortHead k="epi" label="EPI" className="text-right" title={t("Median of the period: measured / modelled energy (modelled). Days with a suspect sensor left out.")} {...h} />
          <SortHead k="pr" label="PR′" className="text-right" title={t("Median temperature-corrected PR of the period. Days with a suspect sensor left out.")} {...h} />
          <SortHead k="clean" label={t("Since cleaning")} className="text-right" title={t("Days since the last cleaning in the Site log")} {...h} />
          <SortHead k="visit" label={t("Next visit")} {...h} />
          <SortHead k="spend" label={t("O&M spend")} className="text-right" title={t(ENTERED)} {...h} />
          <SortHead k="claims" label={t("Open claims")} className="text-right" {...h} />
          <TableHead className="w-8">
            <span className="sr-only">{t("Actions")}</span>
          </TableHead>
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
                  <Button type="button" variant="link" size="xs" onClick={() => onOpenSite(site.site_id)} className={`h-auto rounded-none p-0 align-baseline text-[length:inherit] font-normal text-current underline-offset-auto ${contractTone(site.vs_contract_pct)}`}>
                    {site.vs_contract_pct == null ? "—" : `${fmt(site.vs_contract_pct, 1)} %`}
                  </Button>
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
            <TableCell className="num text-right">
              {r.open_claims ? (
                <Link to={`/claims?plant=${r.plant_id}`} className="hover:text-solar-400">
                  {fmtInt(r.open_claims)}
                </Link>
              ) : (
                "—"
              )}
            </TableCell>
            <TableCell className="w-8 py-0.5">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="icon-xs" variant="ghost" aria-label={t("Actions for {plant}", { plant: r.name })}>
                    <MoreHorizontal />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-52">
                  {onPlanTask && <DropdownMenuItem onSelect={() => onPlanTask(r.plant_id)}>{t("Plan a visit…")}</DropdownMenuItem>}
                  <DropdownMenuItem asChild>
                    <Link to={routeHref({ plantIds: [r.plant_id] })}>{t("Add to route")}</Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <Link to={`/calendar?view=list&plant=${r.plant_id}&user=all`}>{t("Plant's tasks in the Calendar")}</Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <Link to={`/claims?plant=${r.plant_id}&tab=all`}>{t("Plant's claims")}</Link>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
};
