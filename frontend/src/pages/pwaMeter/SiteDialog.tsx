/** PWA Meter: one site's days (`?site=`): meter vs inverter vs the modelled contract / PVsyst per
 * day, the meter ÷ inverter ratio, outage and missing-data days shaded, the site's figures for the
 * window, its outage events and the report's notes. DB only. */
import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api/client";
import type { PwaMeterCheck, PwaMeterSiteDays, PwaMeterSiteSummary, PwaMeterWindow, PwaOutageEvent } from "../../api/client";
import { PanelChart } from "../../components/PanelChart";
import type { PanelChartSpec } from "../../components/PanelChart";
import { SERIES } from "../../components/chartTheme";
import { DAY_MS, ratioPanel, statusBands } from "./chart";
import { SkeletonChart, fmt, fmtInt } from "../../components/ui";
import { plantPath } from "../../context/routes";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DAY_STATUS, EST, MODELLED, WEATHER, dayMs, fmtDay, issueTone } from "./format";

const siteSpec = (d: PwaMeterSiteDays, median: number | null): PanelChartSpec | null => {
  if (!d.days.length) return null;
  const x = d.days.map((r) => dayMs(r.day));
  const dayOf = new Map(d.days.map((r, i) => [x[i], r.day]));
  const ratio = d.days.map((r) => (r.meter_kwh != null && r.inverter_kwh != null && r.meter_kwh > 0 && r.inverter_kwh > 0 ? (100 * r.meter_kwh) / r.inverter_kwh : null));
  const bands = statusBands(d.days, x);
  return {
    xKind: "time",
    x,
    xStep: DAY_MS,
    xTipLabel: (v) => fmtDay(dayOf.get(Number(v))),
    bands,
    tipExtra: (i) => {
      const r = d.days[i];
      const out = [{ label: "Day", value: DAY_STATUS[r.status].label }];
      if (r.weather) out.push({ label: "Weather", value: WEATHER[r.weather] ?? r.weather });
      if (r.note) out.push({ label: "Note", value: r.note.length > 80 ? `${r.note.slice(0, 80)}…` : r.note });
      return out;
    },
    panels: [
      {
        key: "energy",
        title: "Energy (kWh/day)",
        weight: 2,
        series: [
          { key: "meter", name: "Meter (billed)", color: SERIES.ac, type: "line", area: true, width: 1.5, y: d.days.map((r) => r.meter_kwh), format: (v) => `${fmt(v, 0)} kWh` },
          { key: "inv", name: "Inverter (report)", color: SERIES.dc, type: "line", width: 1, opacity: 0.8, y: d.days.map((r) => r.inverter_kwh), format: (v) => `${fmt(v, 0)} kWh` },
          { key: "con", name: "Contract (modelled)", color: SERIES.reference, type: "line", dash: "dash", y: d.days.map((r) => r.contract_kwh), format: (v) => `${fmt(v, 0)} kWh` },
          { key: "pv", name: "PVsyst P50 (modelled)", color: SERIES.reference, type: "line", dash: "dot", y: d.days.map((r) => r.pvsyst_kwh), format: (v) => `${fmt(v, 0)} kWh` },
        ],
      },
      ratioPanel("Meter ÷ inverter (%)", "Meter ÷ inverter", ratio, median != null ? { y: median, label: `Site median ${fmt(median, 2)} %` } : null),
    ],
  };
};

const Fact: React.FC<{ label: string; value: React.ReactNode; title?: string }> = ({ label, value, title }) => (
  <div className="flex flex-col gap-0.5" title={title}>
    <span className="eyebrow">{label}</span>
    <span className="num text-sm font-semibold">{value}</span>
  </div>
);

export const SiteDialog: React.FC<{
  siteId: string | null;
  window: PwaMeterWindow;
  row: PwaMeterSiteSummary | undefined;
  check: PwaMeterCheck | undefined;
  outages: PwaOutageEvent[];
  onClose: () => void;
}> = ({ siteId, window: w, row, check, outages, onClose }) => {
  const [data, setData] = useState<PwaMeterSiteDays | null>(null);
  const [error, setError] = useState<string | null>(null);
  const start = w.start ?? null;
  const end = w.end ?? null;

  useEffect(() => {
    if (!siteId) return;
    let live = true;
    setData(null);
    setError(null);
    api
      .getPwaMeterSiteDays(siteId, { start, end })
      .then((d) => live && setData(d))
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [siteId, start, end]);

  const spec = useMemo(() => (data ? siteSpec(data, check?.median_ratio_pct ?? null) : null), [data, check]);
  const site = data?.site;
  const notes = useMemo(() => (data ? data.days.filter((r) => r.note).slice(-20).reverse() : []), [data]);

  return (
    <Dialog open={siteId != null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>{site?.name ?? row?.name ?? siteId}</DialogTitle>
          <DialogDescription>
            {siteId}
            {site ? ` · Phase ${site.phase}${site.region ? ` · ${site.region}` : ""}` : ""}
            {data?.days.length ? ` · ${fmtDay(data.days[0].day)} – ${fmtDay(data.days.at(-1)!.day)}` : ""}
          </DialogDescription>
        </DialogHeader>

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {site && (
          <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
            <Fact label="Contract kWp" value={fmt(site.kwp, 2)} />
            <Fact
              label="Growatt kWp"
              title={site.kwp_mismatch ? "Differs from the contract kWp by more than 1 %: fix it in the Growatt registry" : undefined}
              value={<span className={site.kwp_mismatch ? "text-amber-300" : ""}>{fmt(site.growatt_kwp, 2)}</span>}
            />
            <Fact label="Meter" value={`${fmt(row?.meter_mwh, 1)} MWh`} />
            <Fact label="vs contract (mod.)" title={MODELLED} value={row?.vs_contract_pct == null ? "—" : `${fmt(row.vs_contract_pct, 1)} %`} />
            <Fact label="vs PVsyst (mod.)" title={MODELLED} value={row?.vs_pvsyst_pct == null ? "—" : `${fmt(row.vs_pvsyst_pct, 1)} %`} />
            <Fact label="Availability" value={row?.availability_pct == null ? "—" : `${fmt(row.availability_pct, 2)} %`} />
            <Fact label="Loss (est.)" title={EST} value={`฿${fmtInt(row?.loss_thb)}`} />
            <Fact label="Meter gap (est.)" title={EST} value={check?.gap_mwh == null ? "—" : `${fmt(check.gap_mwh, 2)} MWh`} />
            {site.growatt_plant_id != null && (
              <Link to={plantPath(site.growatt_plant_id, "generation")} className="ml-auto text-xs text-solar-400 hover:underline">
                Growatt plant {site.growatt_name ?? site.growatt_plant_id} →
              </Link>
            )}
          </div>
        )}

        {row && (row.issues.length > 0 || (check?.flags.length ?? 0) > 0) && (
          <div className="flex flex-wrap gap-1">
            {row.issues.map((i) => (
              <Badge key={i} variant={issueTone(i)}>
                {i}
              </Badge>
            ))}
            {check?.flags.map((f) => (
              <Badge key={f} variant="warn">
                {f}
              </Badge>
            ))}
            {row.owner && <span className="ml-1 text-xs text-muted-foreground">Owner: {row.owner}</span>}
          </div>
        )}

        {!data && !error ? (
          <SkeletonChart />
        ) : (
          <PanelChart spec={spec} height={380} legendToggle legendPosition="bottom" emptyLabel="No report days in this window." />
        )}
        <p className="text-[11px] text-muted-foreground">
          Daily report values; outages of a few hours do not show at this resolution. Shaded: outage days; hatched: a reading missing that day.
        </p>

        {outages.length > 0 && (
          <div className="flex flex-col gap-1">
            <span className="eyebrow">Outage events</span>
            <ul className="flex flex-col gap-1 text-xs">
              {outages.map((o) => (
                <li key={o.start} className="flex flex-wrap gap-x-3">
                  <span className="num">
                    {fmtDay(o.start)}
                    {o.end !== o.start ? ` – ${fmtDay(o.end)}` : ""}
                  </span>
                  <span className="num">{o.days} d</span>
                  <span>{o.cause}</span>
                  <span className="num text-muted-foreground" title={EST}>
                    {fmt(o.lost_mwh, 2)} MWh lost (est.)
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {notes.length > 0 && (
          <div className="flex flex-col gap-1">
            <span className="eyebrow">Report notes (newest {notes.length})</span>
            <ul className="flex flex-col gap-1 text-xs">
              {notes.map((r) => (
                <li key={r.day} className="flex gap-3">
                  <span className="num w-24 shrink-0 text-muted-foreground">{fmtDay(r.day)}</span>
                  <span>{r.note}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};
