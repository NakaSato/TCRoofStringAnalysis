/** O&M Dashboard tables: the issues to fix first and one row per plant. Rows come sorted from the
 * page; these only render. Missing values show "—"; estimated columns say so in the header. */
import React from "react";
import { Link } from "react-router-dom";
import type { OmCenterIssue, OmCenterPlant, PwaMeterSiteSummary } from "../../api/client";
import { plantPath } from "../../context/routes";
import { fmt, fmtInt } from "../../components/ui";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SortHead } from "../pwaMeter/tables";
import { EST, ENTERED, fmtDay, thb } from "./format";

const Est: React.FC = () => <span className="ml-0.5 text-[10px] font-normal text-muted-foreground">est.</span>;

const tierVariant = (i: OmCenterIssue) => (i.safety || i.tier === "P1" ? "crit" : i.tier === "P2" ? "warn" : "neutral");

/** where the evidence of an issue is: the string page, the inverter's Issues tab, else the plant */
const issueHref = (i: OmCenterIssue): string =>
  i.device_sn && i.string_no != null
    ? `${plantPath(i.plant_id, "string")}?sn=${encodeURIComponent(i.device_sn)}&no=${i.string_no}`
    : i.device_sn
      ? `${plantPath(i.plant_id, "inverters")}?sn=${encodeURIComponent(i.device_sn)}&tab=issues`
      : plantPath(i.plant_id);

export const IssuesTable: React.FC<{ rows: OmCenterIssue[] }> = ({ rows }) => (
  <Table containerClassName="table-wrap">
    <TableHeader>
      <TableRow>
        <TableHead>Tier</TableHead>
        <TableHead>Issue</TableHead>
        <TableHead>Plant</TableHead>
        <TableHead>Where</TableHead>
        <TableHead className="text-right" title={`${EST} Mean of the last 3 days the issue fired.`}>
          ฿ / day
          <Est />
        </TableHead>
        <TableHead className="text-right" title={EST}>
          ฿ so far
          <Est />
        </TableHead>
        <TableHead className="text-right">Age</TableHead>
        <TableHead>Acknowledged</TableHead>
        <TableHead>Next visit</TableHead>
        <TableHead className="text-right" title="฿ / day × days until the plant's next planned visit (Calendar). An estimate.">
          Cost of waiting
          <Est />
        </TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      {rows.map((i) => (
        <TableRow key={i.id}>
          <TableCell>
            <Badge variant={tierVariant(i)}>{i.safety ? "Safety" : i.tier}</Badge>
          </TableCell>
          <TableCell className="whitespace-nowrap">
            <Link to={issueHref(i)} className="hover:text-solar-400">
              {i.name}
            </Link>
            <span className="num ml-1.5 text-[11px] text-muted-foreground">{i.rule}</span>
            {i.shadow && (
              <Badge variant="info" className="ml-1.5" title="Rule still in shadow mode: not shown to engineers">
                Shadow
              </Badge>
            )}
          </TableCell>
          <TableCell className="max-w-[220px] truncate">
            <Link to={plantPath(i.plant_id)} className="hover:text-solar-400">
              {i.plant_name ?? `Plant ${i.plant_id}`}
            </Link>
          </TableCell>
          <TableCell className="whitespace-nowrap text-muted-foreground">
            {i.device_sn ? (i.inverter_name ?? i.device_sn) : "Plant"}
            {i.string_no != null ? ` · String ${i.string_no}` : ""}
          </TableCell>
          <TableCell className="num text-right">{thb(i.thb_per_day_est)}</TableCell>
          <TableCell className="num text-right">{thb(i.thb_total_est)}</TableCell>
          <TableCell className="num whitespace-nowrap text-right">{i.age_days} d</TableCell>
          <TableCell className="whitespace-nowrap text-muted-foreground">{i.ack_by ?? "—"}</TableCell>
          <TableCell className="num whitespace-nowrap">
            {i.next_visit ? (
              <Link to={`/calendar?plant=${i.plant_id}`} className="hover:text-solar-400">
                {fmtDay(i.next_visit)}
                <span className="ml-1 text-[11px] text-muted-foreground">{i.days_to_visit === 0 ? "today" : `in ${i.days_to_visit} d`}</span>
              </Link>
            ) : (
              <span className="text-amber-300">None planned</span>
            )}
          </TableCell>
          <TableCell className="num text-right">{thb(i.cost_of_waiting_thb_est)}</TableCell>
        </TableRow>
      ))}
    </TableBody>
  </Table>
);

export const PlantSortKeys = ["lost", "name", "share", "perday", "issues", "epi", "pr", "avail", "contract", "clean", "visit", "spend"] as const;
export type PlantSort = (typeof PlantSortKeys)[number];

export const plantSortValue = (r: OmCenterPlant, k: PlantSort, sites?: Map<number, PwaMeterSiteSummary>): number | string | null =>
  ({
    contract: sites?.get(r.plant_id)?.vs_contract_pct ?? null,
    lost: r.lost_thb_est,
    name: r.name,
    share: r.loss_share_pct,
    perday: r.thb_per_day_est,
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
  const h = { sort, desc, onSort };
  return (
    <Table containerClassName="table-wrap">
      <TableHeader>
        <TableRow>
          <SortHead k="name" label="Plant" {...h} />
          <SortHead k="lost" label={<>฿ lost<Est /></>} className="text-right" title={EST} {...h} />
          <SortHead k="share" label={<>Loss share<Est /></>} className="text-right" title="Lost kWh ÷ (produced + lost kWh) in the period" {...h} />
          <SortHead k="perday" label={<>฿ / day now<Est /></>} className="text-right" title="Active issues, mean of the last 3 days each fired" {...h} />
          <SortHead k="issues" label="Issues" className="text-right" {...h} />
          <SortHead k="avail" label="Availability" className="text-right" title="Inverter minutes not in fault / off / standby ÷ daylight minutes with data" {...h} />
          <SortHead k="epi" label="EPI" className="text-right" title="Median of the period: measured ÷ modelled energy (modelled). Days with a suspect sensor left out." {...h} />
          <SortHead k="pr" label="PR′" className="text-right" title="Median temperature-corrected PR of the period. Days with a suspect sensor left out." {...h} />
          <SortHead k="contract" label={<>Meter vs contract<span className="ml-0.5 text-[10px] font-normal text-muted-foreground">mod.</span></>} className="text-right" title="PWA meter report: billed meter energy ÷ the contract's expected energy (modelled), for the report days in the period. Opens the site's days." {...h} />
          <SortHead k="clean" label="Since cleaning" className="text-right" title="Days since the last cleaning in the Site log" {...h} />
          <SortHead k="visit" label="Next visit" {...h} />
          <SortHead k="spend" label="O&M spend" className="text-right" title={ENTERED} {...h} />
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
                {r.energy_kwh != null ? `${fmt(r.energy_kwh, 0)} kWh` : "no energy stored"}
              </span>
            </TableCell>
            <TableCell className="num text-right">{thb(r.lost_thb_est)}</TableCell>
            <TableCell className="num text-right">{r.loss_share_pct == null ? "—" : `${fmt(r.loss_share_pct, 1)} %`}</TableCell>
            <TableCell className="num text-right">{thb(r.thb_per_day_est)}</TableCell>
            <TableCell className="num text-right">{r.active_issues ? fmtInt(r.active_issues) : "—"}</TableCell>
            <TableCell className={`num text-right ${availTone(r.availability_pct)}`}>{r.availability_pct == null ? "—" : `${fmt(r.availability_pct, 1)} %`}</TableCell>
            <TableCell className="num text-right">{fmt(r.epi_median, 2)}</TableCell>
            <TableCell className="num text-right">{r.pr_temp_corrected_median_pct == null ? "—" : `${fmt(r.pr_temp_corrected_median_pct, 1)} %`}</TableCell>
            <TableCell className="num text-right">
              {(() => {
                const site = sites.get(r.plant_id);
                if (!site) return <span className="text-muted-foreground" title="Not in the PWA meter report">—</span>;
                return (
                  <button type="button" onClick={() => onOpenSite(site.site_id)} className={`hover:underline ${contractTone(site.vs_contract_pct)}`}>
                    {site.vs_contract_pct == null ? "—" : `${fmt(site.vs_contract_pct, 1)} %`}
                  </button>
                );
              })()}
            </TableCell>
            <TableCell className="num text-right">{r.days_since_cleaning == null ? <span className="text-muted-foreground">None recorded</span> : `${r.days_since_cleaning} d`}</TableCell>
            <TableCell className="num whitespace-nowrap">{r.next_visit ? fmtDay(r.next_visit) : "—"}</TableCell>
            <TableCell className="num text-right">{thb(r.spend_thb)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
};
