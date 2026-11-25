/** Energy & Billing → Work and response (docs/plans/om-center-dashboard.md §3.5, Phase 2): this
 * week's Calendar tasks, how fast the team answered the issues first seen in the period (days, per
 * tier, against the targets) and the claims still open. Counts and days only, no money. Everything
 * from `/growatt/center` (`work`, `response`, `claims`); missing = "—", never 0. */
import React from "react";
import { Link } from "react-router-dom";
import type { OmCenter, OmCenterResponseTier } from "../../api/client";
import { fmt, fmtInt } from "../../components/ui";
import { useI18n } from "../../i18n";
import type { Vars } from "../../i18n";

type TFn = (en: string, vars?: Vars) => string;
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Meter, StatTile } from "../overview/StatTile";
import { STATUS as CLAIM_STATUS } from "../claims/format";
import { fmtDay } from "./format";

const days = (v: number | null | undefined, t: TFn) => (v == null ? "—" : t("{n} d", { n: fmt(v, v % 1 ? 1 : 0) }));

/** green when the median first response meets the target, amber when not; no colour without a target or a median */
const targetTone = (r: OmCenterResponseTier) =>
  r.target_days == null || r.first_response_median_days == null ? undefined : r.first_response_median_days <= r.target_days ? "text-emerald-300" : "text-amber-300";

const targetText = (d: number | null, t: TFn) =>
  d == null ? "—" : d === 0 ? t("Same day") : t("≤ {n} d", { n: d });

export const WorkResponse: React.FC<{ c: OmCenter | null; issuesHref: string }> = ({ c, issuesHref }) => {
  const { t } = useI18n();
  const w = c?.work;
  const cl = c?.claims;
  const tiers = c?.response.tiers ?? [];
  const p1 = tiers.find((r) => r.tier === "P1");
  const p2 = tiers.find((r) => r.tier === "P2");
  const weekDone = w?.tasks.by_status.done ?? 0;
  const tile = (r: OmCenterResponseTier | undefined, tier: "P1" | "P2") => (
    <StatTile
      label={t("{tier} first response", { tier })}
      tag={t("median")}
      value={r?.first_response_median_days == null ? "—" : fmt(r.first_response_median_days, 1)}
      unit={t("days")}
      tone={r ? targetTone(r) : undefined}
      meter={r && r.within_target != null && r.opened ? <Meter segments={[{ pct: (100 * r.within_target) / r.opened, className: "bg-emerald-400" }]} title={t("{n} of {total} answered within the target", { n: r.within_target, total: r.opened })} /> : undefined}
      footer={
        <span title={t("Issues first seen in the period. First response = acknowledged or closed by a person, whichever came first; days from the day the issue was first seen.")}>
          {t("Target {target}", { target: targetText(tier === "P1" ? 0 : 2, t) })} · {r ? t("{n} of {total} in time", { n: fmtInt(r.within_target ?? 0), total: fmtInt(r.opened) }) : t("None opened")}
        </span>
      }
    />
  );
  return (
    <section className="flex flex-col gap-2">
      <div className="flex h-7 items-center gap-2">
        <h2 className="shrink-0 text-sm font-semibold">{t("Work and response")}</h2>
        <span className="min-w-0 truncate text-[11px] text-muted-foreground">{t("Calendar · decision-rule issues · Claims; counts and days, no money")}</span>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
        <StatTile
          label={t("This week")}
          tag={w ? `${fmtDay(w.week.start)} – ${fmtDay(w.week.end)}` : undefined}
          value={w ? `${fmtInt(weekDone)} / ${fmtInt(w.tasks.total)}` : "—"}
          unit={t("done")}
          href={w ? `/calendar?view=week&d=${w.week.start}` : undefined}
          linkLabel={t("Open the week in the Calendar")}
          meter={w && w.tasks.total ? <Meter segments={[{ pct: (100 * weekDone) / w.tasks.total, className: "bg-emerald-400" }, { pct: (100 * w.tasks.overdue) / w.tasks.total, className: "bg-red-400" }]} /> : undefined}
          footer={
            w ? (
              <>
                <span>{t("{n} not done yet", { n: fmtInt(w.tasks.open) })}</span>
                {w.tasks.overdue > 0 && <span className="text-red-300">{t("{n} overdue", { n: fmtInt(w.tasks.overdue) })}</span>}
                <span title={t("Tasks a recurring plan generated this week; {n} active plans on these plants", { n: w.active_plans })}>
                  {t("Plans {done}/{total}", { done: fmtInt(w.from_plans.done), total: fmtInt(w.from_plans.total) })}
                </span>
              </>
            ) : (
              <span>—</span>
            )
          }
        />
        <StatTile
          label={t("Overdue tasks")}
          value={w ? fmtInt(w.overdue_all) : "—"}
          tone={w?.overdue_all ? "text-red-300" : undefined}
          href="/calendar?view=list&status=overdue&user=all"
          linkLabel={t("Open the overdue tasks")}
          footer={<span>{w?.overdue_oldest_days != null ? t("Oldest {n} d past its end", { n: fmtInt(w.overdue_oldest_days) }) : t("Planned / started, end day passed")}</span>}
        />
        {tile(p1, "P1")}
        {tile(p2, "P2")}
        <StatTile
          label={t("Claims waiting")}
          value={cl ? fmtInt(cl.open) : "—"}
          href="/claims"
          linkLabel={t("Open the Claims")}
          footer={
            cl ? (
              <>
                <span>{t("Us {us} · them {them}", { us: fmtInt(cl.waiting_us), them: fmtInt(cl.waiting_them) })}</span>
                {cl.followup_overdue > 0 && <span className="text-amber-300">{t("{n} follow-up due", { n: fmtInt(cl.followup_overdue) })}</span>}
                {cl.oldest && <span title={`${cl.oldest.number} · ${t(CLAIM_STATUS[cl.oldest.status]?.label ?? cl.oldest.status)}`}>{t("Oldest {n} d", { n: fmtInt(cl.oldest.age_days) })}</span>}
              </>
            ) : (
              <span>—</span>
            )
          }
        />
      </div>
      <Card className="gap-0 py-0">
        <CardHeader className="py-3">
          <CardTitle className="flex flex-wrap items-center gap-2">
            {t("Response to issues")}
            <span className="text-[11px] font-normal text-muted-foreground">
              {c ? t("Issues first seen {from} – {to}, live rules only", { from: fmtDay(c.response.start), to: fmtDay(c.response.end) }) : ""}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="px-0">
          {tiers.length === 0 ? (
            <p className="px-4 pb-3 text-xs text-muted-foreground sm:px-5">{c ? t("No issue was first seen in this period.") : "—"}</p>
          ) : (
            <Table containerClassName="table-wrap">
              <TableHeader>
                <TableRow>
                  <TableHead>{t("Tier")}</TableHead>
                  <TableHead>{t("Target")}</TableHead>
                  <TableHead className="text-right">{t("Opened")}</TableHead>
                  <TableHead className="text-right" title={t("Median days from the day first seen to the day acknowledged, over the issues acknowledged")}>
                    {t("To acknowledged")}
                  </TableHead>
                  <TableHead className="text-right" title={t("Median days to resolved or dismissed by a person, over those closed by the team")}>
                    {t("To closed")}
                  </TableHead>
                  <TableHead className="text-right" title={t("Median days to the first of acknowledged / closed by a person")}>
                    {t("First response")}
                  </TableHead>
                  <TableHead className="text-right">{t("In time")}</TableHead>
                  <TableHead className="text-right" title={t("Still open and nobody has acknowledged it")}>
                    {t("Not acted on")}
                  </TableHead>
                  <TableHead className="text-right" title={t("Closed by the rule itself (quiet for 2 days): not a response")}>
                    {t("Auto-closed")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tiers.map((r) => (
                  <TableRow key={r.tier}>
                    <TableCell className="font-medium">{r.tier}</TableCell>
                    <TableCell className="text-muted-foreground">{targetText(r.target_days, t)}</TableCell>
                    <TableCell className="num text-right">{fmtInt(r.opened)}</TableCell>
                    <TableCell className="num text-right">
                      {days(r.ack_median_days, t)}
                      <span className="ml-1 text-[11px] text-muted-foreground">({fmtInt(r.acknowledged)})</span>
                    </TableCell>
                    <TableCell className="num text-right">
                      {days(r.close_median_days, t)}
                      <span className="ml-1 text-[11px] text-muted-foreground">({fmtInt(r.closed_by_team)})</span>
                    </TableCell>
                    <TableCell className={`num text-right ${targetTone(r) ?? ""}`}>{days(r.first_response_median_days, t)}</TableCell>
                    <TableCell className="num text-right">{r.within_target == null ? "—" : `${fmtInt(r.within_target)} / ${fmtInt(r.opened)}`}</TableCell>
                    <TableCell className={`num text-right ${r.waiting ? "text-amber-300" : ""}`}>
                      {fmtInt(r.waiting)}
                      {r.waiting_oldest_days != null && <span className="ml-1 text-[11px] text-muted-foreground">{t("oldest {n} d", { n: r.waiting_oldest_days })}</span>}
                    </TableCell>
                    <TableCell className="num text-right text-muted-foreground">{fmtInt(r.auto_closed)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
        <CardContent className="border-t py-2.5 text-[11px] text-muted-foreground">
          {t("Issues are dated by day, so response is in whole days. Medians count only the issues that had the step (number in brackets). Open the list Fix first to act on an issue.")}{" "}
          <Link to={issuesHref} className="underline-offset-2 hover:text-solar-400 hover:underline">
            {t("Fix first")}
          </Link>
        </CardContent>
      </Card>
    </section>
  );
};
