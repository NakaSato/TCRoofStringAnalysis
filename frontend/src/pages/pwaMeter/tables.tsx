/** PWA Meter tables: phase totals (admins), sites, outage events, meter check. Rows come filtered
 * and sorted from the page; these only render. Missing values show "—"; modelled / estimated
 * columns say so in the header and its tooltip. */
import React from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import type { PwaMeterCheck, PwaMeterPhaseSummary, PwaMeterSiteSummary, PwaOutageEvent } from "../../api/client";
import { fmt, fmtInt } from "../../components/ui";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EST, MODELLED, fmtDay, issueTone } from "./format";

export const SiteSortKeys = ["rank", "name", "meter", "contract", "pvsyst", "yield", "avail", "outage", "gaps"] as const;
export type SiteSort = (typeof SiteSortKeys)[number];
export const OutageSortKeys = ["days", "start", "lost", "name"] as const;
export type OutageSort = (typeof OutageSortKeys)[number];
export const CheckSortKeys = ["gap", "median", "name", "low"] as const;
export type CheckSort = (typeof CheckSortKeys)[number];

function SortHead<K extends string>({
  k,
  label,
  sort,
  desc,
  onSort,
  className,
  title,
}: {
  k: K;
  label: React.ReactNode;
  sort: K;
  desc: boolean;
  onSort: (k: K) => void;
  className?: string;
  title?: string;
}) {
  return (
    <TableHead className={cn("whitespace-nowrap", className)} aria-sort={sort === k ? (desc ? "descending" : "ascending") : undefined} title={title}>
      <button type="button" onClick={() => onSort(k)} className="inline-flex items-center gap-1 hover:text-foreground">
        {label}
        {sort === k && (desc ? <ArrowDown className="size-3" /> : <ArrowUp className="size-3" />)}
      </button>
    </TableHead>
  );
}

const Tag: React.FC<{ kind: "est" | "mod" }> = ({ kind }) => (
  <span className="ml-0.5 text-[10px] font-normal text-muted-foreground">{kind === "est" ? "est." : "mod."}</span>
);

const SiteCell: React.FC<{ name: string; siteId: string; region: string | null; onOpen?: () => void }> = ({ name, siteId, region, onOpen }) => {
  const body = (
    <>
      <span className="block truncate">{name}</span>
      <span className="num block truncate text-[11px] text-muted-foreground">
        {siteId}
        {region ? ` · ${region}` : ""}
      </span>
    </>
  );
  // a row that opens the site on click gets no inner button (a disabled button would swallow the click)
  return onOpen ? (
    <button type="button" onClick={onOpen} className="max-w-[240px] text-left hover:text-solar-400">
      {body}
    </button>
  ) : (
    <div className="max-w-[240px]">{body}</div>
  );
};

const pctTone = (v: number | null, good: number, bad: number) => (v == null ? "" : v >= good ? "text-emerald-300" : v < bad ? "text-red-300" : "text-amber-300");

export const PhaseTotals: React.FC<{ phases: PwaMeterPhaseSummary[] }> = ({ phases }) => (
  <Table containerClassName="table-wrap">
    <TableHeader>
      <TableRow>
        <TableHead>Phase</TableHead>
        <TableHead className="text-right">Sites</TableHead>
        <TableHead className="text-right">kWp</TableHead>
        <TableHead className="text-right">Meter MWh</TableHead>
        <TableHead className="text-right" title={MODELLED}>
          vs contract <Tag kind="mod" />
        </TableHead>
        <TableHead className="text-right" title="Pooled meter ÷ PVsyst on producing days of the sites that are not curtailed">
          PI_free
        </TableHead>
        <TableHead className="text-right" title="Share of site-days that were not an outage">
          Availability
        </TableHead>
        <TableHead className="text-right" title="Share of site-days with both readings">
          Data avail.
        </TableHead>
        <TableHead className="text-right" title={EST}>
          Curtail. MWh <Tag kind="est" />
        </TableHead>
        <TableHead className="text-right" title={EST}>
          Outage MWh <Tag kind="est" />
        </TableHead>
        <TableHead className="text-right" title={EST}>
          Under-perf. MWh <Tag kind="est" />
        </TableHead>
        <TableHead className="text-right" title="Meter energy × book price">
          Fee ฿
        </TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      {phases.map((p) => (
        <TableRow key={p.phase}>
          <TableCell className="whitespace-nowrap font-medium" title={`${fmtDay(p.first_day)} – ${fmtDay(p.last_day)}`}>
            Phase {p.phase}
          </TableCell>
          <TableCell className="num text-right">{fmtInt(p.sites)}</TableCell>
          <TableCell className="num text-right">{fmt(p.kwp, 0)}</TableCell>
          <TableCell className="num text-right">{fmt(p.meter_mwh, 1)}</TableCell>
          <TableCell className={cn("num text-right", pctTone(p.vs_contract_pct, 100, 95))}>{fmt(p.vs_contract_pct, 1)} %</TableCell>
          <TableCell className="num text-right">{fmt(p.pi_free_pct, 1)} %</TableCell>
          <TableCell className={cn("num text-right", pctTone(p.availability_pct, 99.5, 99))}>{fmt(p.availability_pct, 2)} %</TableCell>
          <TableCell className={cn("num text-right", pctTone(p.data_availability_pct, 99.5, 99))}>{fmt(p.data_availability_pct, 2)} %</TableCell>
          <TableCell className="num text-right">
            {fmt(p.curtailment_loss_mwh, 1)}
            <span className="ml-1 text-[11px] text-muted-foreground">({fmtInt(p.curtailed_sites)} sites)</span>
          </TableCell>
          <TableCell className="num text-right">{fmt(p.outage_loss_mwh, 1)}</TableCell>
          <TableCell className="num text-right">{fmt(p.under_loss_mwh, 1)}</TableCell>
          <TableCell className="num text-right">{fmtInt(p.fee_thb)}</TableCell>
        </TableRow>
      ))}
    </TableBody>
  </Table>
);

const lossMwh = (r: PwaMeterSiteSummary): number | null =>
  r.curtailment_loss_mwh == null && r.outage_loss_mwh == null && r.under_loss_mwh == null
    ? null
    : (r.curtailment_loss_mwh ?? 0) + (r.outage_loss_mwh ?? 0) + (r.under_loss_mwh ?? 0);

export const siteSortValue = (r: PwaMeterSiteSummary, k: SiteSort): number | string | null => {
  switch (k) {
    case "rank":
      return r.rank;
    case "name":
      return r.name;
    case "meter":
      return r.meter_mwh;
    case "contract":
      return r.vs_contract_pct;
    case "pvsyst":
      return r.vs_pvsyst_pct;
    case "yield":
      return r.yield_kwh_kwp;
    case "avail":
      return r.availability_pct;
    case "outage":
      return r.outage_days;
    case "gaps":
      return r.data_gap_days;
  }
};

export const SitesTable: React.FC<{
  rows: PwaMeterSiteSummary[];
  sort: SiteSort;
  desc: boolean;
  onSort: (k: SiteSort) => void;
  onOpen: (siteId: string) => void;
}> = ({ rows, sort, desc, onSort, onOpen }) => (
  <Table>
    <TableHeader className="sticky top-0 z-10 bg-card">
      <TableRow>
        <SortHead k="rank" label="#" sort={sort} desc={desc} onSort={onSort} title="Rank by estimated loss ฿" />
        <SortHead k="name" label="Site" sort={sort} desc={desc} onSort={onSort} />
        <SortHead k="meter" label="Meter MWh" sort={sort} desc={desc} onSort={onSort} className="text-right" />
        <SortHead
          k="contract"
          label={
            <>
              vs contract <Tag kind="mod" />
            </>
          }
          sort={sort}
          desc={desc}
          onSort={onSort}
          className="text-right"
          title={`Meter ÷ contract expected energy. ${MODELLED}`}
        />
        <SortHead
          k="pvsyst"
          label={
            <>
              vs PVsyst <Tag kind="mod" />
            </>
          }
          sort={sort}
          desc={desc}
          onSort={onSort}
          className="text-right"
          title={`Meter ÷ PVsyst P50 on producing days (PI_PVsyst). ${MODELLED}`}
        />
        <SortHead k="yield" label="kWh/kWp" sort={sort} desc={desc} onSort={onSort} className="text-right" title="Meter energy ÷ contract kWp" />
        <SortHead k="avail" label="Availability" sort={sort} desc={desc} onSort={onSort} className="text-right" />
        <SortHead k="outage" label="Outage d" sort={sort} desc={desc} onSort={onSort} className="text-right" />
        <SortHead k="gaps" label="Gap d" sort={sort} desc={desc} onSort={onSort} className="text-right" title="Days with the meter or the inverter reading missing" />
        <TableHead className="text-right" title={`(Curtailment + outage + under-performance) × book price; the MWh split is in each cell's tooltip. ${EST}`}>
          Loss ฿ <Tag kind="est" />
        </TableHead>
        <TableHead>Issues</TableHead>
        <TableHead>Owner</TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      {rows.map((r) => (
        <TableRow key={r.site_id} className="cursor-pointer" onClick={() => onOpen(r.site_id)}>
          <TableCell className="num text-muted-foreground">{r.rank}</TableCell>
          <TableCell>
            <SiteCell name={r.name} siteId={r.site_id} region={r.region} />
          </TableCell>
          <TableCell className="num text-right">{fmt(r.meter_mwh, 1)}</TableCell>
          <TableCell className={cn("num text-right", pctTone(r.vs_contract_pct, 100, 90))}>{r.vs_contract_pct == null ? "—" : `${fmt(r.vs_contract_pct, 1)} %`}</TableCell>
          <TableCell className="num text-right">{r.vs_pvsyst_pct == null ? "—" : `${fmt(r.vs_pvsyst_pct, 1)} %`}</TableCell>
          <TableCell className="num text-right">{fmtInt(r.yield_kwh_kwp)}</TableCell>
          <TableCell className={cn("num text-right", pctTone(r.availability_pct, 99.5, 99))}>{r.availability_pct == null ? "—" : `${fmt(r.availability_pct, 2)} %`}</TableCell>
          <TableCell className={cn("num text-right", r.outage_recent_days > 0 && "text-red-300")} title={r.outage_recent_days ? `${r.outage_recent_days} in the last 14 days of the window` : undefined}>
            {fmtInt(r.outage_days)}
          </TableCell>
          <TableCell className="num text-right">{fmtInt(r.data_gap_days)}</TableCell>
          <TableCell
            className="num text-right"
            title={`${fmt(lossMwh(r), 1)} MWh: curtailment ${fmt(r.curtailment_loss_mwh, 2)} · outage ${fmt(r.outage_loss_mwh, 2)} · under-performance ${fmt(r.under_loss_mwh, 2)}`}
          >
            {fmtInt(r.loss_thb)}
          </TableCell>
          <TableCell className="min-w-[160px] max-w-[220px]">
            <span className="flex flex-wrap gap-1">
              {r.issues.map((i) => (
                <Badge key={i} variant={issueTone(i)}>
                  {i}
                </Badge>
              ))}
              {r.curtailed && !r.issues.includes("หรี่กำลัง") && (
                <Badge variant="neutral" title={`${r.curtailment_note_days} days with a curtailment note`}>
                  Curtailed
                </Badge>
              )}
            </span>
          </TableCell>
          <TableCell className="whitespace-nowrap">{r.owner ?? <span className="text-muted-foreground">—</span>}</TableCell>
        </TableRow>
      ))}
    </TableBody>
  </Table>
);

export const outageSortValue = (r: PwaOutageEvent, k: OutageSort): number | string | null =>
  k === "days" ? r.days : k === "start" ? r.start : k === "lost" ? r.lost_mwh : r.name;

export const OutagesTable: React.FC<{
  rows: PwaOutageEvent[];
  sort: OutageSort;
  desc: boolean;
  onSort: (k: OutageSort) => void;
  onOpen?: (siteId: string) => void;
  longDays: number;
}> = ({ rows, sort, desc, onSort, onOpen, longDays }) => (
  <Table>
    <TableHeader className="sticky top-0 z-10 bg-card">
      <TableRow>
        <SortHead k="name" label="Site" sort={sort} desc={desc} onSort={onSort} />
        <SortHead k="start" label="From" sort={sort} desc={desc} onSort={onSort} />
        <TableHead>To</TableHead>
        <SortHead k="days" label="Days" sort={sort} desc={desc} onSort={onSort} className="text-right" />
        <TableHead>Cause</TableHead>
        <SortHead
          k="lost"
          label={
            <>
              Lost MWh <Tag kind="est" />
            </>
          }
          sort={sort}
          desc={desc}
          onSort={onSort}
          className="text-right"
          title={`PVsyst on the outage days × the phase PI_free. ${EST}`}
        />
        <TableHead className="text-right" title={EST}>
          Lost ฿ <Tag kind="est" />
        </TableHead>
        <TableHead>Note</TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      {rows.map((r) => (
        <TableRow key={`${r.site_id}-${r.start}`}>
          <TableCell>
            <SiteCell name={r.name} siteId={r.site_id} region={r.region} onOpen={onOpen && (() => onOpen(r.site_id))} />
          </TableCell>
          <TableCell className="num whitespace-nowrap">{fmtDay(r.start)}</TableCell>
          <TableCell className="num whitespace-nowrap">{r.end === r.start ? <span className="text-muted-foreground">same day</span> : fmtDay(r.end)}</TableCell>
          <TableCell className={cn("num text-right", r.days >= longDays && "text-red-300")}>{r.days}</TableCell>
          <TableCell className="whitespace-nowrap">{r.cause}</TableCell>
          <TableCell className="num text-right">{fmt(r.lost_mwh, 2)}</TableCell>
          <TableCell className="num text-right">{fmtInt(r.lost_thb)}</TableCell>
          <TableCell className="max-w-[320px]">
            <span className="block truncate text-[11px] text-muted-foreground" title={r.note ?? undefined}>
              {r.note ?? "—"}
            </span>
          </TableCell>
        </TableRow>
      ))}
    </TableBody>
  </Table>
);

export const checkSortValue = (r: PwaMeterCheck, k: CheckSort): number | string | null =>
  k === "gap" ? r.gap_mwh : k === "median" ? r.median_ratio_pct : k === "low" ? r.low_days + r.meter_missing_days : r.name;

export const MeterCheckTable: React.FC<{
  rows: PwaMeterCheck[];
  sort: CheckSort;
  desc: boolean;
  onSort: (k: CheckSort) => void;
  onOpen: (siteId: string) => void;
}> = ({ rows, sort, desc, onSort, onOpen }) => (
  <Table>
    <TableHeader className="sticky top-0 z-10 bg-card">
      <TableRow>
        <SortHead k="name" label="Site" sort={sort} desc={desc} onSort={onSort} />
        <SortHead
          k="median"
          label="Meter ÷ inverter"
          sort={sort}
          desc={desc}
          onSort={onSort}
          className="text-right"
          title="The site's median ratio on days both read > 0 (the AC losses; fleet ≈ 99.4 %)"
        />
        <TableHead className="text-right" title="5th percentile of the daily ratio">
          P05
        </TableHead>
        <SortHead k="low" label="Low / meter missing d" sort={sort} desc={desc} onSort={onSort} className="text-right" title="Days the ratio fell > 3 points under the median, and days the meter read nothing while the inverter produced" />
        <TableHead className="text-right" title="Days the meter read above the inverter (ratio > 1.005)">
          High d
        </TableHead>
        <TableHead className="text-right" title="Days the meter read but the inverter total is missing">
          Inv. missing d
        </TableHead>
        <SortHead
          k="gap"
          label={
            <>
              Gap MWh <Tag kind="est" />
            </>
          }
          sort={sort}
          desc={desc}
          onSort={onSort}
          className="text-right"
          title={`Energy the meter may have missed: inverter × the site median − meter on low / high days, + inverter × median on meter-missing days. ${EST}`}
        />
        <TableHead className="text-right" title={EST}>
          Gap ฿ <Tag kind="est" />
        </TableHead>
        <TableHead>Flags</TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      {rows.map((r) => (
        <TableRow key={r.site_id} className="cursor-pointer" onClick={() => onOpen(r.site_id)}>
          <TableCell>
            <SiteCell name={r.name} siteId={r.site_id} region={r.region} />
          </TableCell>
          <TableCell className={cn("num text-right", r.median_ratio_pct != null && r.median_ratio_pct < 98.5 && "text-amber-300")}>
            {r.median_ratio_pct == null ? "—" : `${fmt(r.median_ratio_pct, 2)} %`}
          </TableCell>
          <TableCell className="num text-right text-muted-foreground">{r.p05_ratio_pct == null ? "—" : `${fmt(r.p05_ratio_pct, 1)} %`}</TableCell>
          <TableCell className="num text-right">
            {r.low_days} / {r.meter_missing_days}
          </TableCell>
          <TableCell className="num text-right">{r.high_days}</TableCell>
          <TableCell className="num text-right">{r.inverter_missing_days}</TableCell>
          <TableCell className="num text-right">{fmt(r.gap_mwh, 2)}</TableCell>
          <TableCell className="num text-right">{fmtInt(r.gap_thb)}</TableCell>
          <TableCell className="max-w-[260px]">
            <span className="flex flex-wrap gap-1">
              {r.flags.map((f) => (
                <Badge key={f} variant="warn">
                  {f}
                </Badge>
              ))}
            </span>
          </TableCell>
        </TableRow>
      ))}
    </TableBody>
  </Table>
);
