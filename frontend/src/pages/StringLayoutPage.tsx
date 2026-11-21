import React, { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Cpu, Grid3x3, Search } from "lucide-react";
import { useAppContext } from "../context/AppContext";
import { api } from "../api/client";
import type { FleetModuleOut, GrowattStringLayout, GrowattStringLayoutEntry } from "../api/client";
import { SelectedPlantBanner } from "../components/SelectedPlantBanner";
import { EmptyState, LoadingState, Meter, fmt } from "../components/ui";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { pick, useUrlState } from "@/lib/useUrlState";
import { useI18n } from "../i18n";
import { SaveBar } from "./settings/shared";
import { InverterSld, SldLegend, type Draft } from "./stringLayout/TopologyDiagram";

const EMPTY_DRAFT: Draft = { modules: "", wp: "", azimuth: "", tilt: "" };
const FILTERS = ["all", "incomplete", "mismatch"] as const;
const keyOf = (sn: string, no: number) => `${sn}|${no}`;
const toInt = (v: string) => (/^\d+$/.test(v.trim()) ? Number(v) : null);
const toNum = (v: string) => (v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

const draftFrom = (l: GrowattStringLayout) => {
  const d: Record<string, Draft> = {};
  for (const inv of l.inverters)
    for (const s of inv.strings)
      d[keyOf(inv.device_sn, s.string_no)] = {
        modules: s.modules != null ? String(s.modules) : "",
        wp: s.module_wp != null ? String(s.module_wp) : "",
        azimuth: s.azimuth_deg != null ? String(s.azimuth_deg) : "",
        tilt: s.tilt_deg != null ? String(s.tilt_deg) : "",
      };
  return d;
};

/**
 * Plant view tab: as-built modules per string (and module Wp, azimuth, tilt) for the selected
 * Growatt plant. Growatt does not report module counts; once every active string of an inverter has
 * one, the backend compares strings per module / per kWp so a short string is not flagged as a fault.
 * Layout: summary figures, the inverter list (URL `filter`, `q`, `inv`) and the selected inverter's
 * single-line diagram, where each string is edited; Save appears only with unsaved changes.
 */
export const StringLayoutPage: React.FC = () => {
  const { selectedGrowattPlantId, user, refreshAll } = useAppContext();
  const { t } = useI18n();
  // admins: any plant; engineers: the list only holds their assigned plants (the backend checks too)
  const canEdit = user?.role === "admin" || user?.role === "engineer";

  const [fleetModule, setFleetModule] = useState<FleetModuleOut | null>(null);
  const [layout, setLayout] = useState<GrowattStringLayout | null>(null);
  const [baseline, setBaseline] = useState<Record<string, Draft>>({});
  const [draft, setDraft] = useState<Record<string, Draft>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "crit"; text: string } | null>(null);
  // page choices in the URL; switching plant drops them
  const [url, setUrl] = useUrlState();
  const filter = pick(url.get("filter"), FILTERS, "all");
  const q = url.get("q") ?? "";
  const invParam = url.get("inv");

  useEffect(() => {
    api.getFleetModule().then(setFleetModule).catch(() => {});
  }, []);

  useEffect(() => {
    setMsg(null);
    setLayout(null);
    if (selectedGrowattPlantId == null) return;
    setLoading(true);
    api
      .getGrowattStringLayout(selectedGrowattPlantId)
      .then((l) => {
        const d = draftFrom(l);
        setLayout(l);
        setBaseline(d);
        setDraft(d);
      })
      .catch((e) => setMsg({ tone: "crit", text: t("Failed to load string layout: {error}", { error: e.message }) }))
      .finally(() => setLoading(false));
  }, [selectedGrowattPlantId]);

  const fleetWp = fleetModule?.wp ?? layout?.fleet_module_wp ?? null;
  const set = (k: string, field: keyof Draft, value: string) =>
    setDraft((d) => ({ ...d, [k]: { ...(d[k] ?? EMPTY_DRAFT), [field]: value } }));
  const isDirty = (k: string) => {
    const a = draft[k] ?? EMPTY_DRAFT;
    const b = baseline[k] ?? EMPTY_DRAFT;
    return (
      a.modules.trim() !== b.modules.trim() ||
      a.wp.trim() !== b.wp.trim() ||
      a.azimuth.trim() !== b.azimuth.trim() ||
      a.tilt.trim() !== b.tilt.trim()
    );
  };

  // per-inverter view model
  const invs = useMemo(
    () =>
      // in name order, numbers compared as numbers (INVERTER 2 before INVERTER 10)
      [...(layout?.inverters ?? [])]
        .sort((a, b) => (a.alias || a.device_sn).localeCompare(b.alias || b.device_sn, undefined, { numeric: true }))
        .map((inv, idx) => {
        const rows = inv.strings.map((s) => {
          const k = keyOf(inv.device_sn, s.string_no);
          const d = draft[k] ?? EMPTY_DRAFT;
          const m = toInt(d.modules);
          const wp = toNum(d.wp) ?? fleetWp;
          return { s, k, d, m, kwp: m != null && wp != null ? (m * wp) / 1000 : null, invalid: d.modules.trim() !== "" && m == null, dirty: isDirty(k) };
        });
        // strings in parallel on one MPPT share its voltage, so unequal lengths there lose energy
        const mismatch = new Set(
          rows
            .filter((r) => r.m != null && rows.some((o) => o !== r && o.s.mppt_no === r.s.mppt_no && o.m != null && o.m !== r.m))
            .map((r) => r.s.mppt_no)
        );
        const mppts = new Map<number, typeof rows>();
        for (const r of rows) mppts.set(r.s.mppt_no, [...(mppts.get(r.s.mppt_no) ?? []), r]);
        const active = rows.filter((r) => r.s.active);
        return {
          no: idx + 1,
          inv,
          rows,
          mppts: [...mppts.entries()].sort((a, b) => a[0] - b[0]),
          mismatch,
          filled: rows.filter((r) => r.m != null).length,
          complete: active.length > 0 && active.every((r) => r.m != null),
          kwp: rows.reduce((t, r) => t + (r.kwp ?? 0), 0),
          dirty: rows.filter((r) => r.dirty).length,
        };
      }),
    [layout, draft, baseline, fleetWp]
  );

  const totals = useMemo(() => {
    const allComplete = invs.length > 0 && invs.every((i) => i.complete);
    const acKnown = invs.length > 0 && invs.every((i) => i.inv.rated_power_w != null);
    const ac = invs.reduce((t, i) => t + (i.inv.rated_power_w ?? 0) / 1000, 0);
    const kwp = invs.reduce((t, i) => t + i.kwp, 0);
    return {
      strings: invs.reduce((t, i) => t + i.rows.length, 0),
      filled: invs.reduce((t, i) => t + i.filled, 0),
      complete: invs.filter((i) => i.complete).length,
      kwp,
      ac: acKnown ? ac : null,
      // a plant DC/AC only when every inverter is complete and every rating is known
      ratio: allComplete && acKnown && ac > 0 ? kwp / ac : null,
      mismatchInv: invs.filter((i) => i.mismatch.size > 0).length,
      dirty: invs.reduce((t, i) => t + i.dirty, 0),
      invalid: invs.reduce((t, i) => t + i.rows.filter((r) => r.invalid).length, 0),
    };
  }, [invs]);

  const qn = q.trim().toLowerCase();
  const shown = invs.filter(
    (i) =>
      (filter === "incomplete" ? !i.complete : filter === "mismatch" ? i.mismatch.size > 0 : true) &&
      (!qn ||
        i.inv.device_sn.toLowerCase().includes(qn) ||
        (i.inv.alias ?? "").toLowerCase().includes(qn) ||
        (i.inv.device_model ?? i.inv.model).toLowerCase().includes(qn))
  );
  // the URL's inverter, else the first one listed
  const selected = invs.find((i) => i.inv.device_sn === invParam) ?? shown[0] ?? invs[0] ?? null;

  // warn before leaving the page with unsaved edits
  useEffect(() => {
    if (!totals.dirty) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [totals.dirty]);

  const save = async () => {
    if (!layout || selectedGrowattPlantId == null) return;
    const entries: GrowattStringLayoutEntry[] = [];
    for (const inv of layout.inverters)
      for (const s of inv.strings) {
        const d = draft[keyOf(inv.device_sn, s.string_no)];
        const m = toInt(d?.modules ?? "");
        if (m == null) continue;
        entries.push({
          device_sn: inv.device_sn,
          string_no: s.string_no,
          modules: m,
          module_wp: toNum(d?.wp ?? ""),
          azimuth_deg: toNum(d?.azimuth ?? ""),
          tilt_deg: toNum(d?.tilt ?? ""),
        });
      }
    setSaving(true);
    setMsg(null);
    try {
      const saved = await api.putGrowattStringLayout(selectedGrowattPlantId, entries);
      const d = draftFrom(saved);
      setLayout(saved);
      setBaseline(d);
      setDraft(d);
      await refreshAll();
      const p = saved.published;
      const where = p?.sink === "firestore" ? "Firestore" : p?.sink ?? t("the summary sink");
      setMsg(
        p?.error
          ? { tone: "crit", text: t("Saved {n} string module counts. Publishing to {where} failed ({error}); the next publish job retries.", { n: entries.length, where, error: p.error }) }
          : p?.deferred
          ? { tone: "ok", text: t("Saved {n} string module counts. Today's write budget is used up; inverters publish on the next quota day.", { n: entries.length }) }
          : { tone: "ok", text: t("Saved {n} string module counts and published {written} inverter doc(s) to {where}. Diagnostics recalculated.", { n: entries.length, written: p?.written ?? 0, where }) }
      );
    } catch (e: any) {
      setMsg({ tone: "crit", text: t("Save failed: {error}", { error: e.message }) });
    } finally {
      setSaving(false);
    }
  };

  if (selectedGrowattPlantId == null) {
    return (
      <div className="space-y-6">
        <SelectedPlantBanner />
        <EmptyState icon={Grid3x3} title={t("Select a Growatt plant")} description={t("Pick a plant in the fleet view first.")} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <SelectedPlantBanner />

      {loading || (!layout && !msg) ? (
        <LoadingState label={t("Loading string layout…")} shape="chart" />
      ) : !layout ? (
        msg && <div className="callout-crit">{msg.text}</div>
      ) : (
        <>
          {msg && (
            <div className={`${msg.tone === "ok" ? "callout-ok" : "callout-crit"} flex items-center gap-2`}>
              {msg.tone === "ok" ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : <AlertTriangle className="h-4 w-4 shrink-0" />}
              <span>{msg.text}</span>
            </div>
          )}

          {invs.length === 0 ? (
            <EmptyState icon={Cpu} title={t("This plant has no inverters in the registry")} />
          ) : (
            <>
              {/* summary */}
              <Card className="gap-0 py-0">
                <div className="grid grid-cols-2 divide-white/[0.06] lg:grid-cols-4 lg:divide-x">
                  <Figure
                    label={t("Strings with modules")}
                    value={`${totals.filled} / ${totals.strings}`}
                    meter={{ value: totals.filled, max: totals.strings, tone: totals.filled === totals.strings ? "ok" : "warn" }}
                  />
                  <Figure
                    label={t("Inverters complete")}
                    value={`${totals.complete} / ${invs.length}`}
                    meter={{ value: totals.complete, max: invs.length, tone: totals.complete === invs.length ? "ok" : "warn" }}
                    hint={t("Compared per module once every active string has a count")}
                  />
                  <Figure
                    label={t("DC entered")}
                    value={totals.kwp > 0 ? `${fmt(totals.kwp, 1)} kWp` : "—"}
                    sub={`AC ${totals.ac != null ? `${fmt(totals.ac, 0)} kW` : "—"} · DC/AC ${totals.ratio != null ? fmt(totals.ratio, 2) : "—"}`}
                    hint={t("DC/AC ratio: entered DC kWp ÷ rated AC power; shown once every active string has a module count")}
                  />
                  <Figure
                    label={t("MPPT mismatch")}
                    value={String(totals.mismatchInv)}
                    tone={totals.mismatchInv > 0 ? "warn" : undefined}
                    sub={t("inverters with unequal strings on one MPPT")}
                  />
                </div>
              </Card>

              <div className="grid items-start gap-4 lg:grid-cols-[17rem_minmax(0,1fr)]">
                {/* inverter list */}
                <Card className="gap-0 py-0 lg:sticky lg:top-2">
                  <Tabs value={filter} onValueChange={(v) => setUrl({ filter: v === "all" ? null : v })}>
                    <TabsList variant="line" className="w-full border-0 border-b border-white/[0.06] p-0 px-2">
                      <TabsTrigger value="all" className="px-2 py-2.5 text-xs">
                        {t("All ({n})", { n: invs.length })}
                      </TabsTrigger>
                      <TabsTrigger value="incomplete" className="px-2 py-2.5 text-xs">
                        {t("Incomplete ({n})", { n: invs.length - totals.complete })}
                      </TabsTrigger>
                      <TabsTrigger value="mismatch" className="px-2 py-2.5 text-xs">
                        {t("Mismatch ({n})", { n: totals.mismatchInv })}
                      </TabsTrigger>
                    </TabsList>
                  </Tabs>
                  {invs.length > 4 && (
                    <div className="relative border-b border-white/[0.06] p-2">
                      <Search className="pointer-events-none absolute left-4 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
                      <Input
                        value={q}
                        onChange={(e) => setUrl({ q: e.target.value })}
                        placeholder={t("Search name, SN, model")}
                        aria-label={t("Search name, SN, model")}
                        className="h-7 pl-7 text-[11px]"
                      />
                    </div>
                  )}
                  <div className="max-h-[70vh] overflow-y-auto p-1.5">
                    {shown.length === 0 ? (
                      <p className="px-2 py-6 text-center text-[11px] text-slate-500">{t("No inverter matches this filter.")}</p>
                    ) : (
                      shown.map((i) => {
                        const active = selected?.inv.device_sn === i.inv.device_sn;
                        return (
                          <button
                            key={i.inv.device_sn}
                            type="button"
                            onClick={() => setUrl({ inv: i.inv.device_sn })}
                            aria-current={active}
                            className={cn(
                              "flex w-full flex-col gap-1 rounded-md px-2.5 py-2 text-left text-[11px] transition",
                              active ? "bg-sky-500/10 ring-1 ring-sky-400/40" : "hover:bg-white/[0.04]"
                            )}
                          >
                            <span className="flex items-center gap-2">
                              <span className={cn("h-2 w-2 shrink-0 rounded-full", i.complete ? "bg-emerald-400" : "bg-amber-400")} />
                              <span className="min-w-0 flex-1 truncate font-semibold text-white">
                                {i.inv.alias || t("Inverter No.{no}", { no: String(i.no).padStart(2, "0") })}
                              </span>
                              {i.mismatch.size > 0 && <AlertTriangle className="h-3 w-3 shrink-0 text-amber-300" />}
                              {i.dirty > 0 && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-sky-400" title={t("{n} unsaved", { n: i.dirty })} />}
                            </span>
                            <span className="num flex justify-between gap-2 pl-4 text-slate-400">
                              <span className="truncate">{i.inv.device_sn}</span>
                              <span>{t("{n}/{total} set", { n: i.filled, total: i.rows.length })}</span>
                              <span className="text-solar-300">{i.kwp > 0 ? `${fmt(i.kwp, 1)} kWp` : "— kWp"}</span>
                            </span>
                            <span className="block pl-4">
                              <Meter value={i.filled} max={i.rows.length || 1} tone={i.complete ? "ok" : "warn"} className="h-1" />
                            </span>
                          </button>
                        );
                      })
                    )}
                  </div>
                </Card>

                {/* selected inverter */}
                {selected && (
                  <Card className="gap-0 py-0">
                    <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-white/[0.06] px-4 py-3">
                      <span className="text-sm font-bold text-white">{t("Single-line diagram")}</span>
                      <span className="num text-xs text-slate-400">
                        {t("{n} strings on {m} MPPT", { n: selected.rows.length, m: selected.mppts.length })}
                      </span>
                      {!canEdit && <Badge variant="neutral">{t("Read only")}</Badge>}
                      <div className="ml-auto">
                        <SldLegend canEdit={canEdit} />
                      </div>
                    </header>
                    <div className="p-4">
                      <InverterSld
                        ti={selected}
                        no={selected.no}
                        canEdit={canEdit}
                        fleetWp={fleetWp}
                        onChange={set}
                      />
                    </div>
                  </Card>
                )}
              </div>

              {canEdit && (
                <SaveBar
                  dirty={totals.dirty > 0}
                  saving={saving}
                  onSave={save}
                  onReset={() => setDraft(baseline)}
                  label={t("Save layout")}
                  canSave={totals.invalid === 0}
                  note={
                    totals.invalid > 0
                      ? t(totals.invalid > 1 ? "{n} invalid values" : "{n} invalid value", { n: totals.invalid })
                      : t(totals.dirty > 1 ? "{n} strings changed" : "{n} string changed", { n: totals.dirty })
                  }
                />
              )}
            </>
          )}
        </>
      )}
    </div>
  );
};

/** One summary figure: label, value, an optional meter and one secondary line. */
const Figure: React.FC<{
  label: string;
  value: string;
  sub?: string;
  hint?: string;
  tone?: "warn";
  meter?: { value: number; max: number; tone: "ok" | "warn" };
}> = ({ label, value, sub, hint, tone, meter }) => (
  <div className="space-y-1 px-4 py-3" title={hint}>
    <div className="text-[11px] font-medium text-slate-400">{label}</div>
    <div className={cn("num text-lg font-bold", tone === "warn" ? "text-amber-300" : "text-white")}>{value}</div>
    {meter && <Meter value={meter.value} max={meter.max || 1} tone={meter.tone} className="h-1" />}
    {sub && <div className="num text-[11px] text-slate-500">{sub}</div>}
  </div>
);
