/**
 * Inverters page, selected inverter's tab contents that come from the plant overview and the live
 * record: MPPT inputs (Performance), strings (Strings) and grid / fault / safety values (Grid &
 * faults). Each card says whether its numbers are live or from the stored day.
 */
import React from "react";
import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { Meter, StatusBadge, fmt } from "../../components/ui";
import { cn } from "@/lib/utils";
import { dayLabel } from "@/lib/day";
import { useI18n } from "@/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Code, Row, hhmm } from "./shared";
import type { InactiveString, LiveCheck, LiveState, OverviewInverter, PlantString } from "./shared";

const NoLive: React.FC<{ state: LiveState; what: string }> = ({ state, what }) => {
  const { t } = useI18n();
  return (
    <Empty className="border border-dashed border-white/[0.08] py-8">
      <EmptyHeader>
        <EmptyTitle>{state.kind === "waiting" ? t("Asking Growatt…") : t("Offline: no live record for this inverter today")}</EmptyTitle>
        <EmptyDescription>{t("{what} come only from the newest live record; nothing is stored.", { what: t(what) })}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
};

/* -------------------------------------------------------------------------- */
/* MPPT                                                                       */
/* -------------------------------------------------------------------------- */

export const MpptCard: React.FC<{ inv: OverviewInverter; state: LiveState }> = ({ inv, state }) => {
  const { t } = useI18n();
  const rec = state.kind === "live" ? state.rec : null;
  // live record first; without one, the overview's newest stored MPPT values (labelled as such)
  const rows = rec?.mppt.length ? rec.mppt : inv.mppt_latest;
  const fromLive = Boolean(rec?.mppt.length);
  const energy = new Map((rec?.mppt_energy ?? []).map((e) => [e.mppt, e]));
  const nos = [...new Set([...rows.map((m) => m.mppt), ...energy.keys()])].sort((a, b) => a - b);
  const power = new Map(rows.map((m) => [m.mppt, m]));
  const totalToday = [...energy.values()].reduce((a, e) => a + (e.today_kwh ?? 0), 0);
  const totalP = rows.reduce((a, m) => a + (m.p ?? 0), 0);
  // energy per input comes only with a live record: no empty columns without one
  const hasEnergy = energy.size > 0;

  return (
    <Card className="gap-0 pb-0">
      <CardHeader className="pb-4">
        <CardTitle>{t("MPPT inputs")}</CardTitle>
        <CardDescription>
          {fromLive
            ? t("Live record {t} · V, A and kW now; energy today and lifetime per input", { t: hhmm(rec!.timestamp) })
            : rows.length
              ? t("No live record for this inverter: newest stored V / A / kW (energy per input comes only with a live record)")
              : t("No MPPT record yet")}
        </CardDescription>
      </CardHeader>
      {nos.length === 0 ? (
        <CardContent className="pb-(--card-spacing)">
          <NoLive state={state} what="MPPT values" />
        </CardContent>
      ) : (
        <Table containerClassName="border-t border-white/[0.06]">
          <TableHeader>
            <TableRow>
              <TableHead>{t("Input")}</TableHead>
              <TableHead className="text-right">V</TableHead>
              <TableHead className="text-right">A</TableHead>
              <TableHead className="text-right">kW</TableHead>
              <TableHead className="min-w-32">{t("Share of power")}</TableHead>
              {hasEnergy && <TableHead className="text-right">{t("Today kWh")}</TableHead>}
              {hasEnergy && <TableHead className="text-right">{t("Lifetime MWh")}</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {nos.map((n) => {
              const m = power.get(n);
              const e = energy.get(n);
              return (
                <TableRow key={n}>
                  <TableCell className="num whitespace-nowrap text-slate-300">MPPT-{n}</TableCell>
                  <TableCell className="num text-right whitespace-nowrap">{fmt(m?.v, 1)}</TableCell>
                  <TableCell className="num text-right whitespace-nowrap">{fmt(m?.i, 2)}</TableCell>
                  <TableCell className="num text-right whitespace-nowrap">{fmt(m == null ? null : m.p / 1000, 2)}</TableCell>
                  <TableCell>{m && totalP > 0 ? <Meter value={m.p} max={totalP} tone="energy" /> : <span className="text-muted-foreground">—</span>}</TableCell>
                  {hasEnergy && <TableCell className="num text-right whitespace-nowrap text-slate-300" title={totalToday > 0 && e?.today_kwh != null ? t("{v} % of today's DC energy", { v: fmt((e.today_kwh / totalToday) * 100, 0) }) : undefined}>
                    {fmt(e?.today_kwh, 1)}
                  </TableCell>}
                  {hasEnergy && <TableCell className="num text-right whitespace-nowrap text-slate-300">{fmt(e?.total_kwh == null ? null : e.total_kwh / 1000, 1)}</TableCell>}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </Card>
  );
};

/* -------------------------------------------------------------------------- */
/* Strings                                                                    */
/* -------------------------------------------------------------------------- */

const LIVE_VERDICT_VARIANT = { Healthy: "ok", Warning: "warn", Critical: "crit" } as const;

export const StringsCard: React.FC<{
  inv: OverviewInverter;
  state: LiveState;
  check: LiveCheck | null;
  strings: PlantString[];
  inactive: InactiveString[];
  day: string | null;
  stringsHref: string;
}> = ({ inv, state, check, strings, inactive, day, stringsHref }) => {
  const { t } = useI18n();
  const rec = state.kind === "live" ? state.rec : null;
  const liveByNo = new Map((rec?.strings ?? []).map((s) => [s.string_no, s]));
  const rows = [
    ...strings.map((s) => ({ no: s.string_no, s, x: null as InactiveString | null })),
    ...inactive.map((x) => ({ no: x.string_no, s: null as PlantString | null, x })),
  ].sort((a, b) => a.no - b.no);
  const counts = { Critical: 0, Warning: 0, Healthy: 0 };
  for (const s of strings) counts[s.status] += 1;
  const checkNote =
    check?.status === "low_light"
      ? t("too little light to compare now")
      : check?.status === "too_few_strings"
        ? t("too few strings to compare")
        : null;

  return (
    <Card className="gap-0 pb-0">
      <CardHeader className="pb-4">
        <CardTitle className="flex flex-wrap items-center gap-2">
          {t("Strings")}
          {counts.Critical > 0 && <Badge variant="crit">{t("{n} critical", { n: counts.Critical })}</Badge>}
          {counts.Warning > 0 && <Badge variant="warn">{t("{n} warning", { n: counts.Warning })}</Badge>}
          {inactive.length > 0 && <Badge variant="neutral">{t("{n} inactive", { n: inactive.length })}</Badge>}
        </CardTitle>
        <CardDescription>
          {t("Day result from stored history of {day} · V / A now and the live check from the record of {t}", {
            day: day ? dayLabel(day) : "—",
            t: rec ? hhmm(rec.timestamp) : "—",
          })}
          {checkNote ? ` (${checkNote})` : ""}
        </CardDescription>
        <CardAction>
          <Button asChild variant="ghost" size="sm">
            <Link to={stringsHref}>
              {t("String diagnostics")}
              <ArrowRight data-icon="inline-end" />
            </Link>
          </Button>
        </CardAction>
      </CardHeader>
      {rows.length === 0 ? (
        <CardContent className="pb-(--card-spacing)">
          <Empty className="border border-dashed border-white/[0.08] py-8">
            <EmptyHeader>
              <EmptyTitle>{t("No string results")}</EmptyTitle>
              <EmptyDescription>
                {t("No string of {name} has stored records for this day.", { name: inv.alias || inv.device_sn })}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </CardContent>
      ) : (
        <Table containerClassName="border-t border-white/[0.06]">
          <TableHeader>
            <TableRow>
              <TableHead rowSpan={2} className="align-bottom">
                {t("String")}
              </TableHead>
              <TableHead colSpan={6} className="border-l border-white/[0.06] text-slate-300">
                {t("Stored day")}
              </TableHead>
              <TableHead colSpan={3} className="border-l border-white/[0.06] text-slate-300">
                {t("Now · live")}
              </TableHead>
            </TableRow>
            <TableRow>
              <TableHead className="border-l border-white/[0.06]">{t("Result")}</TableHead>
              <TableHead className="text-right">kWh</TableHead>
              <TableHead className="text-right" title={t("Expected minus actual energy")}>
                {t("Loss kWh")}
              </TableHead>
              <TableHead className="text-right" title={t("Peer-relative index, not IEC 61724 PR")}>
                {t("PR idx %")}
              </TableHead>
              <TableHead className="text-right">{t("I avg / max A")}</TableHead>
              <TableHead className="text-right">{t("Health")}</TableHead>
              <TableHead className="border-l border-white/[0.06] text-right">V</TableHead>
              <TableHead className="text-right">A</TableHead>
              <TableHead>{t("Check")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map(({ no, s, x }) => {
              const l = liveByNo.get(no);
              const v = check?.strings[String(no)];
              return (
                <TableRow key={no} className={cn(x && "text-muted-foreground")}>
                  <TableCell className="whitespace-nowrap">
                    <div className="num font-semibold text-slate-100">{s?.short_label ?? x?.short_label}</div>
                    <div className="num text-[11px] text-muted-foreground">
                      {s?.mppt_id ?? x?.mppt_id}
                      {s?.modules != null ? ` · ${t("{n} modules", { n: s.modules })}` : ""}
                    </div>
                  </TableCell>
                  <TableCell className="max-w-72 border-l border-white/[0.06]">
                    {s ? (
                      <div className="flex flex-col items-start gap-1">
                        <StatusBadge status={s.status} />
                        {s.status !== "Healthy" && (
                          <span className="truncate text-[11px] text-muted-foreground" title={s.diagnosis}>
                            {s.diagnosis}
                          </span>
                        )}
                      </div>
                    ) : (
                      <div className="flex flex-col items-start gap-1">
                        <Badge variant="neutral">{t("Not active")}</Badge>
                        <span className="text-[11px]">
                          {x?.reason === "no_current" ? `${t("no current all day")}${x.v_max != null ? ` · V max ${fmt(x.v_max, 0)} V` : ""}` : t("input not reported")}
                        </span>
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="num text-right whitespace-nowrap">{s ? fmt(s.actual_energy_kwh, 2) : "—"}</TableCell>
                  <TableCell className={cn("num text-right whitespace-nowrap", s?.energy_loss_kwh != null && s.energy_loss_kwh > 0 && s.status !== "Healthy" && "text-amber-300")}>
                    {fmt(s?.energy_loss_kwh, 2)}
                  </TableCell>
                  <TableCell className="num text-right whitespace-nowrap">{fmt(s?.pr_pct, 1)}</TableCell>
                  <TableCell className="num text-right whitespace-nowrap">
                    {s ? `${fmt(s.i_avg, 2)} / ${fmt(s.i_max, 2)}` : "—"}
                  </TableCell>
                  <TableCell className="num text-right whitespace-nowrap">{fmt(s?.health_score, 0)}</TableCell>
                  <TableCell className="num border-l border-white/[0.06] text-right whitespace-nowrap">{fmt(l?.voltage_v, 1)}</TableCell>
                  <TableCell className="num text-right whitespace-nowrap">{fmt(l?.current_a, 2)}</TableCell>
                  <TableCell>
                    {v?.status ? (
                      <Badge variant={LIVE_VERDICT_VARIANT[v.status]} title={v.reason}>
                        {t(v.status)}
                      </Badge>
                    ) : (
                      <span className="text-[11px] text-muted-foreground" title={v?.reason}>
                        {v ? "—" : rec ? t("not checked") : "—"}
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </Card>
  );
};

/* -------------------------------------------------------------------------- */
/* Grid & faults                                                              */
/* -------------------------------------------------------------------------- */

export const GridFaultCards: React.FC<{ state: LiveState }> = ({ state }) => {
  const rec = state.kind === "live" ? state.rec : null;
  const g = rec?.grid;
  const d = rec?.diagnostics;
  const { t } = useI18n();
  const at = rec ? t("Live record {t}", { t: hhmm(rec.timestamp) }) : "";
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card className="gap-0">
        <CardHeader className="pb-4">
          <CardTitle>{t("Grid (AC)")}</CardTitle>
          <CardDescription>{at ? `${at} · ${t("per-phase voltage and current")}` : t("Per-phase voltage and current")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {!g ? (
            <NoLive state={state} what="Grid values" />
          ) : (
            <>
              <Table containerClassName="table-wrap">
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("Grid phase")}</TableHead>
                    <TableHead className="text-right">V L-N</TableHead>
                    <TableHead className="text-right">V L-L</TableHead>
                    <TableHead className="text-right">A</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(
                    [
                      ["R", g.v_r, "R-S", g.v_rs, g.i_r],
                      ["S", g.v_s, "S-T", g.v_st, g.i_s],
                      ["T", g.v_t, "T-R", g.v_tr, g.i_t],
                    ] as const
                  ).map(([ph, vln, ll, vll, a]) => (
                    <TableRow key={ph}>
                      <TableCell className="num text-slate-300">{ph}</TableCell>
                      <TableCell className="num text-right">{fmt(vln, 1)}</TableCell>
                      <TableCell className="num text-right" title={ll}>
                        {fmt(vll, 1)}
                      </TableCell>
                      <TableCell className="num text-right">{fmt(a, 2)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <div className="px-1">
                <Row label="Power factor">{fmt(g.pf, 3)}</Row>
                <Row label="Reactive power">{fmt(g.reactive_var == null ? null : g.reactive_var / 1000, 2)} kvar</Row>
                <Row label="Frequency">{fmt(g.fac_hz, 2)} Hz</Row>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card className="gap-0">
        <CardHeader className="pb-4">
          <CardTitle>{t("Faults and safety")}</CardTitle>
          <CardDescription>{at ? `${at} · ` : ""}{t("codes are Growatt's own: 0 = none, — = not reported")}</CardDescription>
        </CardHeader>
        <CardContent>
          {!d ? (
            <NoLive state={state} what="Fault codes" />
          ) : (
            <div className="grid gap-x-8 md:grid-cols-2">
              <div>
                <Row label="Fault type">
                  <Code v={d.fault_type} />
                </Row>
                <Row label="Fault codes">
                  <Code v={d.fault_code1} /> / <Code v={d.fault_code2} />
                </Row>
                <Row label="Warning code">
                  <Code v={d.warn_code} tone="warn" />
                </Row>
                <Row label="Warning values">
                  {d.warning_values.length
                    ? d.warning_values.map((w, k) => (
                        <React.Fragment key={k}>
                          {k > 0 && " / "}
                          <Code v={w} tone="warn" />
                        </React.Fragment>
                      ))
                    : "—"}
                </Row>
                <Row label="PID fault">
                  <Code v={d.pid_fault_code} />
                </Row>
                <Row label="String break">
                  <Code v={d.str_break} />
                </Row>
              </div>
              <div>
                <Row label="PV insulation">{d.pv_iso_kohm == null ? "—" : `${fmt(d.pv_iso_kohm, 0)} kΩ`}</Row>
                <Row label="AFCI status">{d.afci_status ?? "—"}</Row>
                <Row label="AFCI level PV1 / PV2">{(d.afci_pv ?? []).map((v) => v ?? "—").join(" / ") || "—"}</Row>
                <Row label="GFCI (leakage)">{fmt(d.gfci, 1)}</Row>
                <Row label="DCI R / S / T">{(d.dci ?? []).map((v) => fmt(v, 1)).join(" / ") || "—"}</Row>
                <Row label="AMTemp1 / INVTemp / BTTemp" title="Growatt temperature / temperature2 / temperature3, named as in Growatt's history export">
                  {fmt(d.temperature_c, 1)} / {fmt(d.ipm_temperature_c, 1)} / {fmt(d.boost_temperature_c, 1)} °C
                </Row>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
};
