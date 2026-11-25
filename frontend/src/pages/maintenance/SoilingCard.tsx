/** Plant Maintenance: what each recorded cleaning recovered, and whether the last heavy rain left the
 * array dirty (R13). DB only (`/growatt/plants/{id}/soiling`, services/soiling.py). EPI = measured ÷
 * modelled, compared on good clear days only; rain is Google Weather (modelled, daytime only); steps
 * and soiling rates are estimates. A cleaning shows up here once it is in the Site log. */
import React, { useEffect, useMemo, useState } from "react";
import { api } from "../../api/client";
import type { CleaningStep, PlantSoiling, SoilingWallet } from "../../api/client";
import { useAppContext } from "../../context/AppContext";
import { isAdmin } from "../../auth/access";
import { PanelChart } from "../../components/PanelChart";
import type { PanelChartSpec } from "../../components/PanelChart";
import { SERIES, STATUS } from "../../components/chartTheme";
import { fmt, fmtInt, LoadingState, Meter } from "../../components/ui";
import { useI18n } from "@/i18n";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const DAYS = 60;

const signed = (v: number | null, d = 1) => (v == null ? "—" : `${v > 0 ? "+" : ""}${fmt(v, d)}`);

const StatusCell: React.FC<{ s: CleaningStep }> = ({ s }) => {
  const { t } = useI18n();
  if (s.status === "measured") {
    return (
      <div className="space-y-1">
        <Badge variant={s.step_pct != null && s.step_pct > 0 ? "ok" : "neutral"}>{t("Measured")}</Badge>
        {s.rain_between.length > 0 && (
          <div className="text-amber-300" title={s.rain_between.map((r) => `${r.day}: ${fmt(r.rain_mm, 1)} mm`).join(", ")}>
            {t("Heavy rain in between (modelled): the step is not the cleaning alone")}
          </div>
        )}
        {s.scope === "inverter" && <div className="text-slate-400">{t("Part of the plant cleaned: the plant step is diluted")}</div>}
      </div>
    );
  }
  const label =
    s.status === "waiting" ? t("Waiting for clear days after") : s.status === "no_epi" ? t("No EPI for this plant") : t("Too few clear days");
  return (
    <div className="space-y-1">
      <Badge variant={s.status === "waiting" ? "info" : "neutral"}>{label}</Badge>
      {s.reason && <div className="text-slate-500">{s.reason}</div>}
    </div>
  );
};

const WALLET_STATUS: Record<Exclude<SoilingWallet["status"], "ok">, string> = {
  no_rate: "No soiling rate measured yet (this plant or the fleet)",
  no_reset: "No plant-wide cleaning recorded and no heavy rain stored",
  rain_unknown: "Rain record incomplete since the array was last clean: a heavy rain may have washed it",
};

/** R12: THB lost to dirt since the array was last clean (estimated) against the entered cleaning cost. */
const WalletCallout: React.FC<{ w: SoilingWallet; shadow: boolean }> = ({ w, shadow }) => {
  const { t } = useI18n();
  const ok = w.status === "ok";
  const pct = ok && w.wallet_thb != null && w.cost_thb ? Math.min(100, (w.wallet_thb / w.cost_thb) * 100) : null;
  const badge = !ok
    ? { variant: "neutral" as const, text: t("No verdict") }
    : w.fires
      ? { variant: "warn" as const, text: t("Cleaning pays off") }
      : w.monsoon
        ? { variant: "info" as const, text: t("Monsoon: rain cleans") }
        : w.cost_thb == null
          ? { variant: "neutral" as const, text: t("Cost not entered") }
          : { variant: "ok" as const, text: t("Not yet") };
  return (
    <div className={w.fires ? "callout-warn" : "callout-ok"}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-white">R12 {t("Soiling wallet")}</span>
        {shadow && <Badge variant="neutral">{t("Shadow")}</Badge>}
        <Badge variant={badge.variant}>{badge.text}</Badge>
      </div>
      {w.status !== "ok" ? (
        <div className="mt-1 text-slate-400">{t(WALLET_STATUS[w.status])}</div>
      ) : (
        <div className="mt-2 space-y-2">
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-slate-400">
            <span title={t("estimated")}>
              {t("Lost to dirt (est.)")}: <span className="num text-white">฿{fmtInt(w.wallet_thb)}</span>{" "}
              <span className="text-slate-500">({fmtInt(w.wallet_kwh)} kWh)</span>
            </span>
            <span title={w.cost_basis === "site_log" ? t("Median cost entered on this plant's cleanings") : t("Entered in Calendar → Due")}>
              {t("Cleaning cost (entered)")}: <span className="num text-white">{w.cost_thb == null ? "—" : `฿${fmtInt(w.cost_thb)}`}</span>
            </span>
            <span>
              {t("Since")} {w.reset_by === "rain" ? t("heavy rain") : t("cleaning")} {w.reset_day} ·{" "}
              <span className="num text-white">{fmtInt(w.days_since_reset)}</span> {t("days")}
            </span>
            <span title={w.rate_basis === "fleet" ? t("Fleet median: this plant has no measured cleaning step yet") : t("This plant's measured cleaning steps")}>
              {t("Soiling rate (est.)")}: <span className="num text-white">{fmt(w.rate_pct_per_day, 2)} %/{t("day")}</span>{" "}
              <span className="text-slate-500">({w.rate_basis === "fleet" ? t("fleet") : t("this plant")})</span>
            </span>
            <span title={t("estimated")}>
              {t("Soiling now (est.)")}: <span className="num text-white">{fmt(w.soiling_pct, 1)} %</span>
            </span>
            {w.optimal_interval_days != null && (
              <span title={t("√(2 × cost ÷ (rate × daily value)), estimated")}>
                {t("Best interval (est.)")}: <span className="num text-white">{fmtInt(w.optimal_interval_days)}</span> {t("days")}
              </span>
            )}
          </div>
          {pct != null && <Meter value={pct} tone={w.fires ? "warn" : "ok"} />}
          {w.days_without_energy > 0 && (
            <div className="text-slate-500">{t("{n} days without stored energy add nothing", { n: w.days_without_energy })}</div>
          )}
          {w.monsoon && <div className="text-slate-500">{t("Monsoon window: no cleaning is suggested.")}</div>}
          {w.cost_thb == null && <div className="text-slate-500">{t("Enter the cleaning cost in Calendar → Due, or a cost on a cleaning in the Site log.")}</div>}
        </div>
      )}
    </div>
  );
};

export const SoilingCard: React.FC<{ plantId: number }> = ({ plantId }) => {
  const { t } = useI18n();
  const { user } = useAppContext();
  const admin = isAdmin(user);
  const [data, setData] = useState<PlantSoiling | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setData(null);
    setError(null);
    api
      .getPlantSoiling(plantId, DAYS)
      .then((d) => live && setData(d))
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [plantId]);

  const spec = useMemo<PanelChartSpec | null>(() => {
    if (!data || !data.days.some((d) => d.epi != null || d.rain_mm != null)) return null;
    const x = data.days.map((d) => d.day);
    const epi = data.days.map((d) => d.epi);
    return {
      xKind: "band",
      x,
      xTickLabel: (v) => String(v).slice(5),
      xTickEvery: 7,
      markers: data.cleanings
        .filter((c) => x.includes(c.day))
        .map((c) => ({ x: c.day, label: t("Cleaned {day}", { day: c.day.slice(5) }), color: STATUS.good })),
      panels: [
        {
          key: "epi",
          title: t("EPI (measured / modelled)"),
          weight: 1.6,
          zero: false,
          series: [
            {
              key: "epi",
              name: t("EPI"),
              type: "bar",
              color: SERIES.ac,
              y: epi,
              colors: data.days.map((d) => (d.epi == null ? null : d.good ? SERIES.ac : STATUS.none)),
              format: (v) => fmt(v, 3),
            },
          ],
        },
        {
          key: "rain",
          title: t("Daytime rain (Google, modelled, mm)"),
          series: [
            { key: "rain", name: t("Rain"), type: "bar", color: SERIES.irradiance, y: data.days.map((d) => d.rain_mm), format: (v) => `${fmt(v, 1)} mm` },
          ],
          refLines: [{ y: data.settings.soil_rain_mm ?? 10, label: t("Washes the array ≥ {mm} mm", { mm: fmt(data.settings.soil_rain_mm ?? 10, 0) }) }],
        },
      ],
      tipExtra: (i) => [{ label: t("Compared"), value: data.days[i]?.good ? t("Good clear day") : t("Not compared (cloudy, down or sensor suspect)") }],
    };
  }, [data, t]);

  const r13 = data?.r13 ?? null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("Cleaning effect")}</CardTitle>
        <CardDescription>
          {t(
            "EPI (measured / modelled) on good clear days before and after each cleaning in the Site log. Rain is Google Weather (modelled, daytime only). Steps and soiling rates are estimates."
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-xs">
        {error && <div className="text-slate-500">{t("Soiling data unavailable: {error}", { error })}</div>}
        {!data && !error && <LoadingState label={t("Loading…")} shape="chart" />}
        {data && (
          <>
            {r13 && (
              <div className={r13.fires ? "callout-warn" : "callout-ok"}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-white">R13 {t("Incomplete recovery after rain")}</span>
                  {admin && data.r13_rule.shadow && <Badge variant="neutral">{t("Shadow")}</Badge>}
                  <Badge variant={r13.fires ? "warn" : "ok"}>{r13.fires ? t("Suggest a manual cleaning") : t("Rain washed it")}</Badge>
                </div>
                <div className="mt-1 text-slate-300">
                  {t("Rain {mm} mm on {day} (modelled) recovered {pct} % of the EPI lost since the array was clean: EPI {b} before → {a} after, clean {c}", {
                    mm: fmt(r13.rain_mm, 1),
                    day: r13.rain_day,
                    pct: fmt(r13.recovery_pct, 0),
                    b: fmt(r13.epi_before, 3),
                    a: fmt(r13.epi_after, 3),
                    c: fmt(r13.epi_clean, 3),
                  })}
                  {" · "}
                  {r13.clean_basis === "cleaning"
                    ? t("clean = after the cleaning on {day}", { day: r13.clean_day ?? "—" })
                    : t("clean = the plant's best clear days (fitted EPI factor)")}
                </div>
              </div>
            )}
            {data.wallet && <WalletCallout w={data.wallet} shadow={admin && data.r12_rule.shadow} />}
            {!data.has_epi && <div className="text-slate-500">{t("No EPI stored for this plant: it needs a weather sensor and the daily rule rows.")}</div>}
            <PanelChart spec={spec} height={240} emptyLabel={t("No daily EPI or rain stored in the last {n} days.", { n: DAYS })} />
            <div className="flex flex-wrap gap-4 text-slate-400">
              <span>
                {t("Cleanings recorded")}: <span className="num text-white">{fmtInt(data.summary.cleanings)}</span>
              </span>
              <span>
                {t("Measured")}: <span className="num text-white">{fmtInt(data.summary.measured)}</span>
              </span>
              <span>
                {t("Median step")}: <span className="num text-white">{signed(data.summary.median_step_pct)} %</span>
              </span>
              <span title={t("estimated")}>
                {t("Soiling rate (est.)")}: <span className="num text-white">{fmt(data.summary.median_soiling_rate_pct_per_day, 2)} %/{t("day")}</span>
              </span>
            </div>
            {data.cleanings.length === 0 ? (
              <div className="text-slate-500">{t("No cleaning in the Site log yet. Record each cleaning with its real date so its effect can be measured.")}</div>
            ) : (
              <Table containerClassName="table-wrap">
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("Cleaned")}</TableHead>
                    <TableHead className="text-right">{t("EPI before")}</TableHead>
                    <TableHead className="text-right">{t("EPI after")}</TableHead>
                    <TableHead className="text-right">{t("Step")}</TableHead>
                    <TableHead className="text-right">{t("Soiling rate (est.)")}</TableHead>
                    <TableHead>{t("Status")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.cleanings.map((s) => (
                    <TableRow key={s.event_id}>
                      <TableCell className="num whitespace-nowrap">
                        {s.day}
                        {s.end_day && s.end_day !== s.day ? ` → ${s.end_day}` : ""}
                      </TableCell>
                      <TableCell className="num text-right" title={s.before_days.join(", ")}>
                        {fmt(s.epi_before, 3)} <span className="text-slate-500">({s.before_days.length})</span>
                      </TableCell>
                      <TableCell className="num text-right" title={s.after_days.join(", ")}>
                        {fmt(s.epi_after, 3)} <span className="text-slate-500">({s.after_days.length})</span>
                      </TableCell>
                      <TableCell className="num text-right">{s.step_pct == null ? "—" : `${signed(s.step_pct)} %`}</TableCell>
                      <TableCell
                        className="num text-right"
                        title={s.rate_reason ?? (s.rate_since ? t("over {n} days since {day}", { n: s.rate_days ?? 0, day: s.rate_since }) : "")}
                      >
                        {s.soiling_rate_pct_per_day == null ? "—" : `${fmt(s.soiling_rate_pct_per_day, 2)} %/${t("day")}`}
                      </TableCell>
                      <TableCell>
                        <StatusCell s={s} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
};
