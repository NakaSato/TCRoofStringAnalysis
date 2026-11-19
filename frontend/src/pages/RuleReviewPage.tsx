/**
 * System → Rule review (admin, docs/plans/decision-rules.md §4.3–4.4): per rule, the issues it
 * opened, how they ended (auto-closed / resolved / dismissed, confirmed vs false alarm) and the
 * estimated baht found, with its enabled / shadow switches; the thresholds; and the tariff that
 * prices lost energy. Every rule starts in shadow mode: turn it live when it keeps about one false
 * alarm or fewer per ten confirmed. Changes are logged (System → Logs) and apply from the next
 * `rules_*` run.
 */
import React, { useCallback, useEffect, useState } from "react";
import { RefreshCw, Scale } from "lucide-react";
import { api } from "../api/client";
import type { RuleSettings, RulesOut, Tariff, TariffOut } from "../api/client";
import { LoadingState, PageHeader, fmt, fmtInt } from "../components/ui";
import { thb } from "../components/issues";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";

/** Threshold keys shown in the form, grouped by rule, with labels. */
const THRESHOLDS: { rule: string; fields: [key: string, label: string][] }[] = [
  { rule: "R1", fields: [["r1_low_min", "Low minutes / day"], ["r1_days", "Window (days)"], ["r1_days_hit", "Days that must hit"]] },
  { rule: "R2", fields: [["r2_open_min", "Open minutes / day"]] },
  { rule: "R4", fields: [["r4_v_drop_pct", "Voltage drop below peers (%)"], ["r4_days", "Days in a row"]] },
  { rule: "R5", fields: [["r5_window_days", "Window (days)"], ["r5_min_days", "Min. days with a verdict"], ["r5_ratio", "Median ratio below"]] },
  { rule: "R6", fields: [["r6_window_days", "Window (days)"], ["r6_min_days", "Min. days with a verdict"], ["r6_drop_pct_per_month", "Slope drop above (%/month)"]] },
  { rule: "R7", fields: [["r7_pct", "Yield vs peers below (%)"], ["r7_days", "Days in a row"], ["r7_max_gap_pct", "Skip days with downtime above (%)"]] },
  { rule: "R8", fields: [["r8_min_down_min", "Down at least (min)"], ["r8_p1_share_pct", "P1 above share of plant kWp (%)"]] },
  { rule: "R9", fields: [["r9_events", "Trips"], ["r9_window_days", "Within (days)"]] },
  { rule: "R10", fields: [["r10_window_days", "Baseline window (days)"], ["r10_min_days", "Min. baseline days"], ["r10_two_sigma_days", "2σ persistence (days)"]] },
  { rule: "R11", fields: [["r11_window_days", "Baseline window (days)"], ["r11_min_days", "Min. baseline days"], ["r11_days", "Days in a row"], ["r11_gap_increase_h", "Ya − Yf increase (h)"]] },
  {
    rule: "R16",
    fields: [
      ["r16_stale_slots", "Frozen-reading slots / day"],
      ["r16_high_slots", "Slots above 1.5 × clear sky"],
      ["r16_neighbour_ratio", "Below share of nearby sensors"],
      ["r16_clear_cloud_pct", "Clear day: Google cloud at most (%)"],
    ],
  },
  { rule: "R17", fields: [["r17_pct", "No data above (% of daylight)"]] },
  { rule: "Tiers", fields: [["p1_thb_per_day", "THB/day line (R2 → P1, R7 → P2)"]] },
];
const KEYWORDS: [key: string, label: string][] = [
  ["r3_keywords", "R3 safety alarm words"],
  ["r9_keywords", "R9 grid-trip alarm words"],
];
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const RuleReviewPage: React.FC = () => {
  const [data, setData] = useState<RulesOut | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyRule, setBusyRule] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.getRules());
      setError(null);
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = async (rule: string, key: "enabled" | "shadow", value: boolean) => {
    setBusyRule(rule);
    try {
      const out = await api.putRules({ rules: { [rule]: { [key]: value } } });
      setData((d) =>
        d ? { ...d, settings: out.settings, review: d.review.map((r) => (r.rule === rule ? { ...r, ...out.settings.rules[rule] } : r)) } : d
      );
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusyRule(null);
    }
  };

  const refresh = (
    <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
      {loading ? <Spinner data-icon="inline-start" className="size-3" /> : <RefreshCw data-icon="inline-start" className="size-3" />}
      Refresh
    </Button>
  );

  return (
    <div className="space-y-4">
      <PageHeader
        icon={Scale}
        eyebrow="System"
        title="Rule review"
        description="Calibrate the decision rules before engineers see them. A rule in shadow mode records issues for this review only; turn it live when it keeps about 1 false alarm or fewer per 10 confirmed."
        actions={
refresh
        }
      />
      {error && <div className="callout-crit">{error}</div>}
      {!data ? (
        <LoadingState label="Loading rules…" shape="table" />
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Rules</CardTitle>
              <CardDescription>Issues opened since {data.since}. Baht are estimates (lost kWh × tariff).</CardDescription>
            </CardHeader>
            <CardContent>
              <Table containerClassName="table-wrap">
                <TableHeader>
                  <TableRow>
                    <TableHead>Rule</TableHead>
                    <TableHead className="text-right">Issues</TableHead>
                    <TableHead className="text-right">Open</TableHead>
                    <TableHead className="text-right" title="Closed by the rule itself: quiet for 2 days with data">Auto-closed</TableHead>
                    <TableHead className="text-right">Confirmed</TableHead>
                    <TableHead className="text-right">False alarm</TableHead>
                    <TableHead className="text-right" title="confirmed ÷ (confirmed + false alarm)">Precision</TableHead>
                    <TableHead className="text-right">Plants</TableHead>
                    <TableHead className="text-right">฿ found (est.)</TableHead>
                    <TableHead>Mode</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.review.map((r) => (
                    <TableRow key={r.rule} className={r.enabled ? undefined : "opacity-50"}>
                      <TableCell className="whitespace-nowrap">
                        <span className="num text-slate-400">{r.rule}</span> {r.name}
                      </TableCell>
                      <TableCell className="num text-right">
                        {fmtInt(r.issues)}
                      </TableCell>
                      <TableCell className="num text-right">{fmtInt(r.active)}</TableCell>
                      <TableCell className="num text-right">{fmtInt(r.auto_closed)}</TableCell>
                      <TableCell className="num text-right">{fmtInt(r.confirmed)}</TableCell>
                      <TableCell className="num text-right">{fmtInt(r.false_alarm)}</TableCell>
                      <TableCell className="num text-right">{r.precision_pct == null ? "—" : `${fmt(r.precision_pct, 0)} %`}</TableCell>
                      <TableCell className="num text-right">{fmtInt(r.plants)}</TableCell>
                      <TableCell className="num text-right">{thb(r.thb_total_est)}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1">
                          {busyRule === r.rule && <Spinner className="size-3" />}
                          <Button
                            size="xs"
                            variant={r.enabled ? (r.shadow ? "outline" : "accent") : "ghost"}
                            disabled={busyRule === r.rule || !r.enabled}
                            onClick={() => void toggle(r.rule, "shadow", !r.shadow)}
                            title={r.shadow ? "Shadow: recorded for this review only. Click to show it to engineers." : "Live: engineers see its issues. Click to return to shadow."}
                          >
                            {r.shadow ? "Shadow" : "Live"}
                          </Button>
                          <Button size="xs" variant="ghost" disabled={busyRule === r.rule} onClick={() => void toggle(r.rule, "enabled", !r.enabled)}>
                            {r.enabled ? "Disable" : "Enable"}
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
          <div className="grid gap-4 xl:grid-cols-2">
            <ThresholdsCard data={data} onSaved={(settings) => setData((d) => (d ? { ...d, settings } : d))} />
            <TariffCard />
          </div>
        </>
      )}
    </div>
  );
};

const ThresholdsCard: React.FC<{ data: RulesOut; onSaved: (s: RuleSettings) => void }> = ({ data, onSaved }) => {
  const initial = useCallback(() => {
    const f: Record<string, string> = {};
    for (const g of THRESHOLDS) for (const [k] of g.fields) f[k] = String(data.settings[k] ?? "");
    for (const [k] of KEYWORDS) f[k] = ((data.settings[k] as string[]) ?? []).join(", ");
    return f;
  }, [data.settings]);
  const [form, setForm] = useState<Record<string, string>>(initial);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => setForm(initial()), [initial]);

  const save = async () => {
    const patch: Record<string, number | string[]> = {};
    for (const g of THRESHOLDS)
      for (const [k] of g.fields) {
        const v = Number(form[k]);
        if (form[k].trim() === "" || !Number.isFinite(v)) {
          setMsg({ ok: false, text: `${k}: enter a number` });
          return;
        }
        if (v !== data.settings[k]) patch[k] = v;
      }
    for (const [k] of KEYWORDS) {
      const words = form[k].split(",").map((w) => w.trim()).filter(Boolean);
      if (words.join(",") !== ((data.settings[k] as string[]) ?? []).join(",")) patch[k] = words;
    }
    if (Object.keys(patch).length === 0) {
      setMsg({ ok: true, text: "No changes." });
      return;
    }
    setBusy(true);
    try {
      const out = await api.putRules(patch);
      onSaved(out.settings);
      setMsg({ ok: true, text: `Saved ${Object.keys(patch).length} change(s); they apply from the next rules run.` });
    } catch (e) {
      setMsg({ ok: false, text: errText(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Thresholds</CardTitle>
        <CardDescription>Defaults from the research report. The THB/day line is not confirmed yet.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {THRESHOLDS.map((g) => (
          <div key={g.rule}>
            <div className="eyebrow mb-1.5">
              {g.rule} {data.names[g.rule] ?? ""}
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {g.fields.map(([k, label]) => (
                <div key={k} className="space-y-1">
                  <Label htmlFor={k} className="text-[11px] text-slate-400" title={`default ${String(data.defaults[k])}`}>
                    {label}
                  </Label>
                  <Input id={k} inputMode="decimal" value={form[k] ?? ""} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
                </div>
              ))}
            </div>
          </div>
        ))}
        {KEYWORDS.map(([k, label]) => (
          <div key={k} className="space-y-1">
            <Label htmlFor={k} className="text-[11px] text-slate-400">
              {label} (comma separated; matched in the alarm message)
            </Label>
            <Textarea id={k} rows={2} value={form[k] ?? ""} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
          </div>
        ))}
        <div className="flex items-center gap-3">
          <Button onClick={() => void save()} disabled={busy}>
            {busy && <Spinner data-icon="inline-start" className="size-3" />}
            Save thresholds
          </Button>
          {msg && <span className={`text-xs ${msg.ok ? "text-slate-400" : "text-red-300"}`}>{msg.text}</span>}
        </div>
      </CardContent>
    </Card>
  );
};

const TariffCard: React.FC = () => {
  const [t, setT] = useState<TariffOut | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [days, setDays] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const fill = (x: TariffOut) => {
    setT(x);
    setDays(x.on_peak_days);
    setForm({
      on_peak_thb: String(x.on_peak_thb),
      off_peak_thb: String(x.off_peak_thb),
      ft_thb: String(x.ft_thb),
      on_peak_start: x.on_peak_start,
      on_peak_end: x.on_peak_end,
      valid_from: x.valid_from ?? "",
      holidays: x.holidays.join(", "),
      plant_rates: Object.entries(x.plant_rates)
        .map(([id, r]) => `${id}: ${r.thb_per_kwh}${r.basis ? ` ${r.basis}` : ""}`)
        .join("\n"),
    });
  };

  useEffect(() => {
    api.getTariff().then(fill).catch((e) => setMsg({ ok: false, text: errText(e) }));
  }, []);

  const save = async () => {
    const rates: Tariff["plant_rates"] = {};
    for (const line of form.plant_rates.split("\n").map((l) => l.trim()).filter(Boolean)) {
      const m = /^(\d+)\s*:\s*([\d.]+)\s*(.*)$/.exec(line);
      if (!m) {
        setMsg({ ok: false, text: `Plant rate "${line}": write it as <plant id>: <THB/kWh> [basis]` });
        return;
      }
      rates[m[1]] = { thb_per_kwh: Number(m[2]), basis: m[3].trim() || null };
    }
    const body: Tariff = {
      on_peak_thb: Number(form.on_peak_thb),
      off_peak_thb: Number(form.off_peak_thb),
      ft_thb: Number(form.ft_thb),
      on_peak_days: days,
      on_peak_start: form.on_peak_start.trim(),
      on_peak_end: form.on_peak_end.trim(),
      valid_from: form.valid_from.trim() || null,
      holidays: form.holidays.split(/[,\s]+/).map((d) => d.trim()).filter(Boolean),
      plant_rates: rates,
    };
    setBusy(true);
    try {
      const out = await api.putTariff(body);
      fill(out);
      setMsg({ ok: true, text: out.published?.error ? `Saved; publish to Firestore failed (${out.published.error}), the next publish retries.` : "Saved." });
    } catch (e) {
      setMsg({ ok: false, text: errText(e) });
    } finally {
      setBusy(false);
    }
  };

  const field = (k: string, label: string, hint?: string) => (
    <div className="space-y-1">
      <Label htmlFor={`t-${k}`} className="text-[11px] text-slate-400" title={hint}>
        {label}
      </Label>
      <Input id={`t-${k}`} value={form[k] ?? ""} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
    </div>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Tariff {t && <Badge variant={t.source === "saved" ? "ok" : "neutral"}>{t.source === "saved" ? `saved by ${t.updated_by ?? "?"}` : "default"}</Badge>}
        </CardTitle>
        <CardDescription>
          Prices estimated lost energy by the time it was lost, and the plant revenue figures. Holidays are off-peak all day; the default list
          has only fixed-date holidays, so add the lunar ones and substitution days.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {!t ? (
          <LoadingState label="Loading tariff…" shape="lines" />
        ) : (
          <>
            <div className="grid grid-cols-3 gap-2">
              {field("on_peak_thb", "On-peak THB/kWh")}
              {field("off_peak_thb", "Off-peak THB/kWh")}
              {field("ft_thb", "Ft THB/kWh", "Added to both rates; changes every four months")}
            </div>
            <div className="grid grid-cols-3 gap-2">
              {field("on_peak_start", "On-peak from (HH:MM)")}
              {field("on_peak_end", "On-peak until (HH:MM)")}
              {field("valid_from", "Valid from (YYYY-MM-DD)")}
            </div>
            <div className="space-y-1">
              <Label className="text-[11px] text-slate-400">On-peak days</Label>
              <div className="flex flex-wrap gap-1">
                {DAYS.map((d, n) => (
                  <Button
                    key={d}
                    size="xs"
                    variant={days.includes(n) ? "accent" : "outline"}
                    onClick={() => setDays(days.includes(n) ? days.filter((x) => x !== n) : [...days, n].sort())}
                  >
                    {d}
                  </Button>
                ))}
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="t-holidays" className="text-[11px] text-slate-400">
                Holidays (YYYY-MM-DD, comma separated)
              </Label>
              <Textarea id="t-holidays" rows={3} value={form.holidays ?? ""} onChange={(e) => setForm({ ...form, holidays: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="t-rates" className="text-[11px] text-slate-400">
                Plant rates, one per line: plant id: THB/kWh [basis], e.g. 10025413: 3.5 PPA (used instead of TOU + Ft)
              </Label>
              <Textarea id="t-rates" rows={3} value={form.plant_rates ?? ""} onChange={(e) => setForm({ ...form, plant_rates: e.target.value })} />
            </div>
            <div className="flex items-center gap-3">
              <Button onClick={() => void save()} disabled={busy}>
                {busy && <Spinner data-icon="inline-start" className="size-3" />}
                Save tariff
              </Button>
              {msg && <span className={`text-xs ${msg.ok ? "text-slate-400" : "text-red-300"}`}>{msg.text}</span>}
            </div>
            <p className="text-[11px] text-slate-500">
              New rates apply from the next rules run. A changed on-peak window applies to past days only after a <span className="num">rules_backfill</span>.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
};
