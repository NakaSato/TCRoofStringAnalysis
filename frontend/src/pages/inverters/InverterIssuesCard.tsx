/**
 * Inverters page, Issues tab: what the decision rules see for one inverter
 * (docs/plans/decision-rules.md). Its active issues and those of its strings (admins also shadow),
 * with actions, and 30 days of `growatt_inverter_daily`: minutes down by state over daylight and
 * the specific yield vs the plant's other inverters. DB only; lost energy is estimated.
 */
import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api/client";
import type { InverterRuleDay, Issue, IssueActionName, RuleDaily } from "../../api/client";
import { useAppContext, usePlantHref } from "../../context/AppContext";
import { isAdmin } from "../../auth/access";
import { PanelChart } from "../../components/PanelChart";
import type { PanelChartSpec } from "../../components/PanelChart";
import { SERIES, STATUS } from "../../components/chartTheme";
import { LoadingState, fmt } from "../../components/ui";
import { IssueActionDialog, IssueActions, StatusBadgeIssue, TierBadge, evidenceText, issueHref, thb } from "../../components/issues";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const DAYS = 30;

const dayList = (end: string, n: number): string[] => {
  const out: string[] = [];
  const t = new Date(`${end}T00:00:00Z`).getTime();
  for (let k = n - 1; k >= 0; k--) out.push(new Date(t - k * 86_400_000).toISOString().slice(0, 10));
  return out;
};

/** Stacked bars from separate series: each series' bottom is the sum of the ones before it. */
const stack = (rows: Array<Array<number | null>>): Array<{ y: Array<number | null>; y0: Array<number | null> }> => {
  const base = rows[0].map(() => 0);
  return rows.map((r) => {
    const y0 = r.map((v, i) => (v == null ? null : base[i]));
    const y = r.map((v, i) => (v == null ? null : (base[i] += v)));
    return { y, y0 };
  });
};

export const InverterIssuesCard: React.FC<{ plantId: number; sn: string; label: string }> = ({ plantId, sn, label }) => {
  const { user } = useAppContext();
  const plantHref = usePlantHref();
  const admin = isAdmin(user);
  const [daily, setDaily] = useState<RuleDaily<InverterRuleDay> | null>(null);
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ issue: Issue; action: Exclude<IssueActionName, "note"> } | null>(null);

  useEffect(() => {
    let live = true;
    setDaily(null);
    setIssues(null);
    setError(null);
    api
      .getInverterRuleDaily(plantId, sn, DAYS)
      .then((d) => live && setDaily(d))
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    Promise.all([
      api.listIssues({ plant_id: plantId }),
      admin ? api.listIssues({ plant_id: plantId, shadow: true }) : Promise.resolve(null),
    ])
      .then(([a, b]) => {
        if (!live) return;
        const all = [...a.issues, ...(b?.issues ?? [])].filter((i) => i.device_sn === sn);
        // the inverter's own issues first, then its strings by number
        all.sort((x, y) => (x.string_no ?? 0) - (y.string_no ?? 0));
        setIssues(all);
      })
      .catch(() => live && setIssues([]));
    return () => {
      live = false;
    };
  }, [plantId, sn, admin]);

  const spec = useMemo<PanelChartSpec | null>(() => {
    if (!daily || !daily.days.length) return null;
    const days = dayList(daily.end, DAYS);
    const by = new Map(daily.days.map((d) => [d.day, d]));
    const get = (k: keyof InverterRuleDay) => days.map((d) => (by.get(d)?.[k] ?? null) as number | null);
    const parts = [
      { key: "fault", name: "Fault", color: STATUS.crit, v: get("fault_min") },
      { key: "off", name: "Off", color: SERIES.temp, v: get("off_min") },
      { key: "standby", name: "Standby", color: STATUS.warn, v: get("standby_min") },
      { key: "nodata", name: "No data", color: STATUS.none, v: get("no_data_min") },
    ];
    const stacked = stack(parts.map((p) => p.v));
    const yf = get("yf_vs_median_pct");
    return {
      xKind: "band",
      x: days,
      xTickLabel: (v) => String(v).slice(5),
      panels: [
        {
          key: "down",
          title: "Minutes not producing in daylight (min)",
          weight: 1.2,
          series: parts.map((p, i) => ({
            key: p.key,
            name: p.name,
            type: "bar" as const,
            color: p.color,
            y: stacked[i].y,
            y0: stacked[i].y0,
            noTip: true, // stacked heights are running totals: the tooltip lists each state below
          })),
        },
        {
          key: "yf",
          title: "Specific yield vs the plant's other inverters (%)",
          refLines: [{ y: 0, label: "Median", color: SERIES.reference }],
          series: [
            {
              key: "yf",
              name: "vs median",
              type: "bar",
              color: STATUS.none,
              y: yf,
              colors: yf.map((v) => (v == null ? null : v < -10 ? STATUS.crit : v < -3 ? STATUS.warn : STATUS.good)),
              format: (v) => `${v > 0 ? "+" : ""}${fmt(v, 1)} %`,
            },
          ],
        },
      ],
      tipExtra: (i) => {
        const d = by.get(days[i]);
        if (!d) return [{ label: "Data", value: "no daily row" }];
        const lost = [d.lost_fault_kwh_est, d.lost_off_kwh_est, d.lost_standby_kwh_est, d.lost_no_data_kwh_est].filter(
          (x): x is number => x != null
        );
        return [
          { label: "Fault", value: `${fmt(d.fault_min, 0)} min` },
          { label: "Off", value: `${fmt(d.off_min, 0)} min` },
          { label: "Standby", value: `${fmt(d.standby_min, 0)} min` },
          { label: "No data", value: `${fmt(d.no_data_min, 0)} min` },
          { label: "Daylight", value: d.daylight_min == null ? "—" : `${fmt(d.daylight_min, 0)} min` },
          { label: "Energy", value: d.energy_kwh == null ? "—" : `${fmt(d.energy_kwh, 1)} kWh` },
          { label: "Lost (est.)", value: lost.length ? `${fmt(lost.reduce((a, x) => a + x, 0), 1)} kWh` : "—" },
          { label: "Power-limited", value: `${fmt(d.limited_min, 0)} min` },
        ];
      },
    };
  }, [daily]);

  const onDone = (i: Issue) => setIssues((xs) => (xs ? xs.map((x) => (x.id === i.id ? i : x)) : xs));

  return (
    <Card className="gap-0">
      <CardHeader className="pb-4">
        <CardTitle>Decision rules</CardTitle>
        <CardDescription>
          {label}: active issues of the inverter and its strings, and the last {DAYS} days of the daily rule table · stored history · lost
          energy estimated
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {issues == null ? (
          <LoadingState label="Loading issues" shape="lines" />
        ) : issues.length > 0 ? (
          <div className="space-y-2">
            {issues.map((i) => (
              <div key={i.id} className="flex flex-wrap items-center gap-2 rounded-md border border-white/[0.07] px-3 py-2 text-xs">
                <TierBadge tier={i.tier} />
                {i.shadow && (
                  <Badge variant="neutral" title="Rule in shadow mode: engineers don't see this">
                    Shadow
                  </Badge>
                )}
                <span className="font-medium text-white">
                  {i.rule} {i.name}
                </span>
                {i.string_no != null && (
                  <Link className="text-sky-300 hover:underline" to={issueHref(i)}>
                    String {i.string_no}
                  </Link>
                )}
                <span className="text-slate-400">{evidenceText(i)}</span>
                <span className="text-slate-500">since {i.opened_day}</span>
                <span className="num">{thb(i.thb_per_day_est)}/day est.</span>
                <StatusBadgeIssue issue={i} />
                <div className="ml-auto">
                  <IssueActions issue={i} onAction={(action) => setDialog({ issue: i, action })} />
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-xs text-slate-500">
            No active issue for this inverter or its strings.{" "}
            <Link className="text-sky-300 hover:underline" to={`/issues?plant=${plantId}`}>
              All issues of the plant
            </Link>
          </div>
        )}
        {error ? (
          <div className="text-xs text-slate-500">Daily rule data unavailable: {error}</div>
        ) : (
          <PanelChart spec={spec} height={300} emptyLabel="No daily rule rows yet (the worker's rules jobs compute them)." />
        )}
        <div className="text-[11px] text-slate-500">
          Strings in depth:{" "}
          <Link className="text-sky-300 hover:underline" to={`${plantHref("strings")}?inv=${encodeURIComponent(sn)}`}>
            String Diagnostics
          </Link>
        </div>
      </CardContent>
      <IssueActionDialog issue={dialog?.issue ?? null} action={dialog?.action ?? null} onClose={() => setDialog(null)} onDone={onDone} />
    </Card>
  );
};
