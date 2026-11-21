/**
 * String page: what the decision rules see for this string (docs/plans/decision-rules.md): its open
 * issues (live rules; admins also shadow) with actions, and the last 30 days of the daily table:
 * median current ratio vs the inverter's other strings in gated slots (null = no verdict that
 * day) and the low / open minutes. DB only.
 */
import React, { useEffect, useMemo, useState } from "react";
import { Scale } from "lucide-react";
import { api } from "../../api/client";
import type { Issue, IssueActionName, RuleDaily, StringRuleDay } from "../../api/client";
import { useAppContext } from "../../context/AppContext";
import { isAdmin } from "../../auth/access";
import { PanelChart } from "../PanelChart";
import type { PanelChartSpec } from "../PanelChart";
import { SERIES, STATUS } from "../chartTheme";
import { Panel, fmt } from "../ui";
import { IssueActionDialog, IssueActions, StatusBadgeIssue, TierBadge, evidenceText, thb } from "../issues";
import { Badge } from "@/components/ui/badge";
import { useI18n } from "../../i18n";

const DAYS = 30;

const dayList = (end: string, n: number): string[] => {
  const out: string[] = [];
  const t = new Date(`${end}T00:00:00Z`).getTime();
  for (let k = n - 1; k >= 0; k--) out.push(new Date(t - k * 86_400_000).toISOString().slice(0, 10));
  return out;
};

export const StringRulesPanel: React.FC<{ plantId: number; sn: string; stringNo: number }> = ({ plantId, sn, stringNo }) => {
  const { user } = useAppContext();
  const { t } = useI18n();
  const admin = isAdmin(user);
  const [daily, setDaily] = useState<RuleDaily<StringRuleDay> | null>(null);
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ issue: Issue; action: Exclude<IssueActionName, "note"> } | null>(null);

  useEffect(() => {
    let live = true;
    setDaily(null);
    setIssues(null);
    setError(null);
    api
      .getStringRuleDaily(plantId, sn, stringNo, DAYS)
      .then((d) => live && setDaily(d))
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    Promise.all([
      api.listIssues({ plant_id: plantId }),
      admin ? api.listIssues({ plant_id: plantId, shadow: true }) : Promise.resolve(null),
    ])
      .then(([a, b]) => {
        if (!live) return;
        const all = [...a.issues, ...(b?.issues ?? [])];
        setIssues(all.filter((i) => i.device_sn === sn && (i.string_no === stringNo || i.string_no == null)));
      })
      .catch(() => live && setIssues([]));
    return () => {
      live = false;
    };
  }, [plantId, sn, stringNo, admin]);

  const spec = useMemo<PanelChartSpec | null>(() => {
    if (!daily) return null;
    const days = dayList(daily.end, DAYS);
    const by = new Map(daily.days.map((d) => [d.day, d]));
    const get = <K extends keyof StringRuleDay>(k: K) => days.map((d) => (by.get(d)?.[k] ?? null) as number | null);
    const ratio = get("ratio_median");
    return {
      xKind: "band",
      x: days,
      xTickLabel: (v) => String(v).slice(5),
      panels: [
        {
          key: "r",
          title: t("Median current vs peers (ratio, gated slots)"),
          weight: 1.4,
          yMin: 0,
          yMax: 1.2,
          refLines: [
            { y: 0.95, label: "R5 0.95", color: SERIES.reference },
            { y: 0.85, label: t("Low 0.85"), color: STATUS.warn },
          ],
          series: [
            {
              key: "ratio",
              name: t("Ratio"),
              type: "bar",
              color: STATUS.none,
              y: ratio,
              colors: ratio.map((v) => (v == null ? null : v < 0.85 ? STATUS.crit : v < 0.95 ? STATUS.warn : STATUS.good)),
              format: (v) => fmt(v, 3),
            },
          ],
        },
        {
          key: "m",
          title: t("Minutes (min)"),
          series: [
            { key: "low", name: t("Low (< 85 %)"), type: "bar", color: STATUS.warn, y: get("low_min"), format: (v) => `${fmt(v, 0)} min` },
            { key: "open", name: t("Open (~0 A)"), type: "bar", color: STATUS.crit, y: get("open_min"), format: (v) => `${fmt(v, 0)} min` },
          ],
        },
      ],
      tipExtra: (i) => {
        const d = by.get(days[i]);
        if (!d) return [{ label: t("Data"), value: t("no daily row") }];
        return [
          { label: t("Gated slots"), value: String(d.gated_slots) },
          { label: t("Lost (est.)"), value: d.lost_kwh_est == null ? "—" : `${fmt(d.lost_kwh_est, 2)} kWh` },
        ];
      },
    };
  }, [daily, t]);

  const onDone = (i: Issue) => setIssues((xs) => (xs ? xs.map((x) => (x.id === i.id ? i : x)) : xs));

  return (
    <Panel icon={Scale} title={t("Decision rules")} subtitle={t("Open issues and the last {n} days of the daily rule table · stored history · lost energy estimated", { n: DAYS })}>
      <div className="space-y-4">
        {issues && issues.length > 0 && (
          <div className="space-y-2">
            {issues.map((i) => (
              <div key={i.id} className="flex flex-wrap items-center gap-2 rounded-md border border-white/[0.07] px-3 py-2 text-xs">
                <TierBadge tier={i.tier} />
                {i.shadow && <Badge variant="neutral" title={t("Rule in shadow mode: engineers don't see this")}>{t("Shadow")}</Badge>}
                <span className="font-medium text-white">
                  {i.rule} {i.name}
                  {i.string_no == null && ` (${t("inverter")})`}
                </span>
                <span className="text-slate-400">{evidenceText(i)}</span>
                <span className="text-slate-500">{t("since {day}", { day: i.opened_day })}</span>
                <span className="num">{t("{thb}/day est.", { thb: thb(i.thb_per_day_est) })}</span>
                <StatusBadgeIssue issue={i} />
                <div className="ml-auto">
                  <IssueActions issue={i} onAction={(action) => setDialog({ issue: i, action })} />
                </div>
              </div>
            ))}
          </div>
        )}
        {issues && issues.length === 0 && <div className="text-xs text-slate-500">{t("No open issue for this string.")}</div>}
        {error ? (
          <div className="text-xs text-slate-500">{t("Daily rule data unavailable: {error}", { error })}</div>
        ) : (
          <PanelChart spec={spec} height={260} emptyLabel={t("No daily rule rows yet (the worker's rules jobs compute them).")} />
        )}
      </div>
      <IssueActionDialog issue={dialog?.issue ?? null} action={dialog?.action ?? null} onClose={() => setDialog(null)} onDone={onDone} />
    </Panel>
  );
};
