import React, { useEffect, useMemo, useState } from "react";
import { Plus, Trash2, X } from "lucide-react";
import { useAppContext } from "../../context/AppContext";
import { isAdmin } from "../../auth/access";
import { api, PlantRate, Tariff, TariffOut } from "../../api/client";
import { LoadingState, fmt } from "../../components/ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { useI18n } from "../../i18n";
import { NoticeLine, Notice, NumberField, SaveBar, SavedStamp, SectionHeader, num, publishNotice } from "./shared";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
const HM_END = /^([01]\d|2[0-4]):[0-5]\d$/;

interface RateRow {
  id: string;
  rate: string;
  basis: string;
}

interface Draft {
  on: string;
  off: string;
  ft: string;
  start: string;
  end: string;
  validFrom: string;
  days: number[];
  holidays: string[];
  rates: RateRow[];
}

const toDraft = (t: TariffOut): Draft => ({
  on: String(t.on_peak_thb),
  off: String(t.off_peak_thb),
  ft: String(t.ft_thb),
  start: t.on_peak_start,
  end: t.on_peak_end,
  validFrom: t.valid_from ?? "",
  days: [...t.on_peak_days].sort(),
  holidays: [...t.holidays].sort(),
  rates: Object.entries(t.plant_rates)
    .map(([id, r]) => ({ id, rate: String(r.thb_per_kwh), basis: r.basis ?? "" }))
    .sort((a, b) => Number(a.id) - Number(b.id)),
});

/** One figure in the summary strip. */
const Figure: React.FC<{ label: string; value: string; unit?: string; hint?: string; tone?: "solar" }> = ({ label, value, unit, hint, tone }) => (
  <div className="rounded-lg border border-white/[0.06] bg-ink-900/60 px-3 py-2.5">
    <div className="text-[11px] text-muted-foreground">{label}</div>
    <div className={cn("num text-lg font-semibold leading-tight", tone === "solar" ? "text-solar-300" : "text-white")}>
      {value} {unit && <span className="text-[11px] font-normal text-muted-foreground">{unit}</span>}
    </div>
    {hint && <div className="text-[11px] text-muted-foreground">{hint}</div>}
  </div>
);

/**
 * Every price per kWh the app uses: the TOU tariff (+ Ft) that prices lost energy and revenue,
 * per-plant flat rates (PPA / PWA contract) that override it, and the PWA contract prices from
 * the meter criteria file (read only; billing uses the book price). Admins edit, engineers read
 * (their own plants' rates only).
 */
export const PriceSettings: React.FC = () => {
  const { user, growattPlants } = useAppContext();
  const { t } = useI18n();
  const canEdit = isAdmin(user);
  const [tariff, setTariff] = useState<TariffOut | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [applying, setApplying] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [q, setQ] = useState("");
  const [addId, setAddId] = useState("");
  const [newHoliday, setNewHoliday] = useState("");

  const load = (tt: TariffOut) => {
    setTariff(tt);
    setDraft(toDraft(tt));
  };
  useEffect(() => {
    api.getTariff().then(load).catch((e) => setLoadError(e.message));
  }, []);

  const names = useMemo(() => new Map(growattPlants.map((p) => [String(p.plant_id), p.name])), [growattPlants]);
  const pwaIds = useMemo(() => new Set((tariff?.pwa_contract?.plant_ids ?? []).map(String)), [tariff]);
  const dirty = useMemo(() => tariff != null && draft != null && JSON.stringify(toDraft(tariff)) !== JSON.stringify(draft), [tariff, draft]);

  const header = (
    <SectionHeader
      title={t("Price per kWh")}
      description={t("Prices lost energy (decision rules), revenue and the plant tariff. Saved on the server and mirrored to Firestore config/tariff.")}
      aside={tariff && <SavedStamp source={tariff.source} by={tariff.updated_by} at={tariff.updated_at} />}
    />
  );
  if (loadError) return <div className="space-y-4">{header}<NoticeLine notice={{ tone: "crit", text: t("Could not load the tariff: {error}", { error: loadError }) }} /></div>;
  if (!tariff || !draft) return <div className="space-y-4">{header}<LoadingState label={t("Loading tariff…")} shape="lines" /></div>;

  const patch = (p: Partial<Draft>) => setDraft({ ...draft, ...p });

  const save = async () => {
    const on = num(draft.on);
    const off = num(draft.off);
    const ft = num(draft.ft);
    if (on == null || off == null || on <= 0 || off <= 0 || on > 50 || off > 50) {
      setNotice({ tone: "crit", text: t("On-peak and off-peak prices must be between 0 and 50 THB/kWh.") });
      return;
    }
    if (ft == null || ft < -5 || ft > 5) {
      setNotice({ tone: "crit", text: t("Ft must be between −5 and 5 THB/kWh.") });
      return;
    }
    if (!HM.test(draft.start) || !HM_END.test(draft.end)) {
      setNotice({ tone: "crit", text: t("On-peak hours must be HH:MM.") });
      return;
    }
    const plant_rates: Record<string, PlantRate> = {};
    for (const r of draft.rates) {
      const v = num(r.rate);
      if (v == null || v <= 0 || v > 50) {
        setNotice({ tone: "crit", text: t("Plant {id}: the rate must be between 0 and 50 THB/kWh.", { id: r.id }) });
        return;
      }
      plant_rates[r.id] = { thb_per_kwh: v, basis: r.basis.trim() || null };
    }
    const body: Tariff = {
      on_peak_thb: on,
      off_peak_thb: off,
      ft_thb: ft,
      on_peak_days: [...draft.days].sort(),
      on_peak_start: draft.start,
      on_peak_end: draft.end,
      holidays: draft.holidays,
      valid_from: draft.validFrom || null,
      plant_rates,
    };
    setSaving(true);
    setNotice(null);
    try {
      const saved = await api.putTariff(body);
      load(saved);
      setNotice(publishNotice(saved.published));
    } catch (e: any) {
      setNotice({ tone: "crit", text: t("Save failed: {error}", { error: e.message }) });
    } finally {
      setSaving(false);
    }
  };

  const applyPwa = async () => {
    setApplying(true);
    setNotice(null);
    try {
      const r = await api.applyPwaRates();
      load(r.tariff);
      setNotice({
        tone: "ok",
        text: r.applied
          ? t("{n} PWA plants now use the contract book price; {kept} rates already entered were kept.", { n: r.added, kept: r.kept })
          : t("Every PWA plant already has a rate; nothing changed."),
      });
    } catch (e: any) {
      setNotice({ tone: "crit", text: t("Save failed: {error}", { error: e.message }) });
    } finally {
      setApplying(false);
    }
  };

  const setRow = (id: string, p: Partial<RateRow>) => patch({ rates: draft.rates.map((r) => (r.id === id ? { ...r, ...p } : r)) });
  const addRow = () => {
    if (!addId) return;
    const book = tariff.pwa_contract?.book_price_thb_per_kwh;
    const isPwa = pwaIds.has(addId) && book != null;
    patch({ rates: [...draft.rates, { id: addId, rate: isPwa ? String(book) : "", basis: isPwa ? "PWA contract" : "PPA" }].sort((a, b) => Number(a.id) - Number(b.id)) });
    setAddId("");
  };
  const addHoliday = () => {
    if (!newHoliday || draft.holidays.includes(newHoliday)) return;
    patch({ holidays: [...draft.holidays, newHoliday].sort() });
    setNewHoliday("");
  };

  const ft = num(draft.ft) ?? 0;
  const onEff = (num(draft.on) ?? NaN) + ft;
  const offEff = (num(draft.off) ?? NaN) + ft;
  const pwa = tariff.pwa_contract;
  const rateIds = new Set(draft.rates.map((r) => r.id));
  const pwaMissing = [...pwaIds].filter((id) => !rateIds.has(id)).length;
  const needle = q.trim().toLowerCase();
  const rows = draft.rates.filter(
    (r) => !needle || r.id.includes(needle) || (names.get(r.id) ?? "").toLowerCase().includes(needle) || r.basis.toLowerCase().includes(needle)
  );
  const addable = growattPlants.filter((p) => !rateIds.has(String(p.plant_id))).sort((a, b) => a.name.localeCompare(b.name));
  const label = "text-[11px] font-medium text-muted-foreground";

  return (
    <div className="space-y-4">
      {header}
      <NoticeLine notice={notice} />

      {/* ---- what applies, at a glance */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Figure label={t("On-peak (with Ft)")} value={fmt(onEff, 4)} unit="THB/kWh" hint={`${draft.start}–${draft.end}`} tone="solar" />
        <Figure label={t("Off-peak (with Ft)")} value={fmt(offEff, 4)} unit="THB/kWh" hint={t("Nights, weekends, holidays")} />
        <Figure label={t("Flat-rate plants")} value={String(draft.rates.length)} hint={t("Use their own rate every hour")} />
        <Figure
          label={t("PWA book price")}
          value={fmt(pwa?.book_price_thb_per_kwh, 4)}
          unit="THB/kWh"
          hint={pwa ? t("{priced} of {total} PWA plants priced", { priced: pwaIds.size - pwaMissing, total: pwaIds.size }) : undefined}
        />
      </div>

      {/* ---- TOU tariff */}
      <Card className="gap-4 py-4">
        <CardHeader className="px-4">
          <CardTitle className="text-sm">{t("TOU tariff")}</CardTitle>
          <CardDescription className="text-xs">{t("For every plant without a flat rate. Ft is added to both prices.")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 px-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <NumberField id="t-on" label={t("On-peak")} unit="THB/kWh" step="0.0001" value={draft.on} disabled={!canEdit} onChange={(v) => patch({ on: v })} />
            <NumberField id="t-off" label={t("Off-peak")} unit="THB/kWh" step="0.0001" value={draft.off} disabled={!canEdit} onChange={(v) => patch({ off: v })} />
            <NumberField id="t-ft" label="Ft" unit="THB/kWh" step="0.0001" value={draft.ft} disabled={!canEdit} onChange={(v) => patch({ ft: v })} />
            <Field className="gap-1.5">
              <FieldLabel htmlFor="t-valid" className={label}>{t("Valid from")}</FieldLabel>
              <Input id="t-valid" type="date" className="num" value={draft.validFrom} disabled={!canEdit} onChange={(e) => patch({ validFrom: e.target.value })} />
            </Field>
          </div>
          <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Field className="gap-1.5">
                <FieldLabel htmlFor="t-start" className={label}>{t("On-peak from")}</FieldLabel>
                <Input id="t-start" type="time" className="num w-28" value={draft.start} disabled={!canEdit} onChange={(e) => patch({ start: e.target.value })} />
              </Field>
              <Field className="gap-1.5">
                <FieldLabel htmlFor="t-end" className={label}>{t("On-peak to")}</FieldLabel>
                <Input id="t-end" className="num w-28" placeholder="22:00" value={draft.end} disabled={!canEdit} onChange={(e) => patch({ end: e.target.value })} />
              </Field>
            </div>
            <div className="space-y-1.5">
              <div className={label}>{t("On-peak days")}</div>
              <div className="flex flex-wrap gap-1" role="group" aria-label={t("On-peak days")}>
                {DAYS.map((d, i) => {
                  const on = draft.days.includes(i);
                  return (
                    <Button
                      key={d}
                      type="button"
                      size="xs"
                      variant={on ? "accent" : "outline"}
                      className="w-10"
                      disabled={!canEdit}
                      aria-pressed={on}
                      onClick={() => patch({ days: on ? draft.days.filter((x) => x !== i) : [...draft.days, i].sort() })}
                    >
                      {t(d)}
                    </Button>
                  );
                })}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ---- holidays */}
      <Card className="gap-4 py-4">
        <CardHeader className="px-4">
          <CardTitle className="text-sm">{t("Holidays ({n})", { n: draft.holidays.length })}</CardTitle>
          <CardDescription className="text-xs">{t("Off-peak all day. The O&M calendar also skips them for rounds and plans.")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 px-4">
          {draft.holidays.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("No holidays.")}</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {draft.holidays.map((d) => (
                <Badge key={d} variant="neutral" className="num gap-1 pr-1">
                  {d}
                  {canEdit && (
                    <button
                      type="button"
                      className="rounded-sm p-0.5 text-muted-foreground hover:bg-white/10 hover:text-white"
                      aria-label={t("Remove {day}", { day: d })}
                      onClick={() => patch({ holidays: draft.holidays.filter((x) => x !== d) })}
                    >
                      <X className="size-3" />
                    </button>
                  )}
                </Badge>
              ))}
            </div>
          )}
          {canEdit && (
            <div className="flex items-center gap-2">
              <Input type="date" className="num w-40" value={newHoliday} aria-label={t("Holiday to add")} onChange={(e) => setNewHoliday(e.target.value)} />
              <Button type="button" size="sm" variant="outline" disabled={!newHoliday || draft.holidays.includes(newHoliday)} onClick={addHoliday}>
                <Plus data-icon="inline-start" />
                {t("Add holiday")}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ---- PWA contract (read only) */}
      {pwa && (
        <Card className="gap-4 py-4">
          <CardHeader className="px-4">
            <CardTitle className="text-sm">{t("PWA contract")}</CardTitle>
            <CardDescription className="text-xs">
              {t("Read only, from the PWA meter criteria file{version}. Billing in Engineering O&M uses the book price.", {
                version: pwa.criteria_version ? ` (${pwa.criteria_version})` : "",
              })}
            </CardDescription>
            {canEdit && pwaMissing > 0 && (
              <CardAction>
                <Button type="button" size="sm" variant="secondary" onClick={applyPwa} disabled={applying || saving || dirty}>
                  {applying && <Spinner className="size-3" data-icon="inline-start" />}
                  {t("Price {n} PWA plants at the book price", { n: pwaMissing })}
                </Button>
              </CardAction>
            )}
          </CardHeader>
          <CardContent className="px-4">
            <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs sm:grid-cols-5">
              {(
                [
                  [t("Book price"), pwa.book_price_thb_per_kwh],
                  [t("TOU net"), pwa.tou_net_thb_per_kwh],
                  [t("TOU P90"), pwa.tou_p90_thb_per_kwh],
                  [t("PWA grid price"), pwa.pwa_grid_price_thb_per_kwh],
                  [t("PWA saving"), pwa.pwa_grid_price_thb_per_kwh != null ? pwa.pwa_grid_price_thb_per_kwh - pwa.book_price_thb_per_kwh : null],
                ] as Array<[string, number | null | undefined]>
              ).map(([k, v]) => (
                <div key={k}>
                  <dt className="text-[11px] text-muted-foreground">{k}</dt>
                  <dd className="num font-semibold text-white">
                    {fmt(v, 4)} <span className="text-[11px] font-normal text-muted-foreground">THB/kWh</span>
                  </dd>
                </div>
              ))}
            </dl>
            {canEdit && pwaMissing > 0 && dirty && <p className="mt-3 text-[11px] text-muted-foreground">{t("Save or discard your changes first.")}</p>}
          </CardContent>
        </Card>
      )}

      {/* ---- per-plant flat rates */}
      <Card className="gap-4 py-4">
        <CardHeader className="px-4">
          <CardTitle className="text-sm">{t("Per-plant flat rates ({n})", { n: draft.rates.length })}</CardTitle>
          <CardDescription className="text-xs">{t("A plant with a flat rate uses it instead of the TOU tariff for every hour.")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 px-4">
          {draft.rates.length > 0 && (
            <Input className="h-8 w-full sm:w-64" placeholder={t("Search plant, id or basis")} value={q} onChange={(e) => setQ(e.target.value)} />
          )}
          {draft.rates.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("No plant has a flat rate.")}</p>
          ) : (
            <div className="max-h-[26rem] overflow-auto">
              <Table containerClassName="table-wrap">
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("Plant")}</TableHead>
                    <TableHead>ID</TableHead>
                    <TableHead>THB/kWh</TableHead>
                    <TableHead>{t("Basis")}</TableHead>
                    {canEdit && <TableHead className="w-10" />}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="max-w-72 truncate">
                        {names.get(r.id) ?? "—"}
                        {pwaIds.has(r.id) && (
                          <Badge variant="info" className="ml-2">
                            PWA
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="num text-muted-foreground">{r.id}</TableCell>
                      <TableCell>
                        <Input
                          type="number"
                          step="0.0001"
                          className="num h-7 w-24 px-2 text-[11px]"
                          aria-label={t("Rate of plant {id}", { id: r.id })}
                          value={r.rate}
                          disabled={!canEdit}
                          onChange={(e) => setRow(r.id, { rate: e.target.value })}
                        />
                      </TableCell>
                      <TableCell>
                        <Input
                          className="h-7 w-32 px-2 text-[11px]"
                          maxLength={32}
                          aria-label={t("Basis of plant {id}", { id: r.id })}
                          value={r.basis}
                          disabled={!canEdit}
                          onChange={(e) => setRow(r.id, { basis: e.target.value })}
                        />
                      </TableCell>
                      {canEdit && (
                        <TableCell>
                          <Button type="button" size="icon-sm" variant="ghost" aria-label={t("Remove rate")} onClick={() => patch({ rates: draft.rates.filter((x) => x.id !== r.id) })}>
                            <Trash2 />
                          </Button>
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                  {rows.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={canEdit ? 5 : 4} className="text-center text-muted-foreground">
                        {t("No plant matches “{q}”.", { q })}
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          )}
          {canEdit && addable.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <Select value={addId} onValueChange={setAddId}>
                <SelectTrigger size="sm" className="w-72" aria-label={t("Plant to add")}>
                  <SelectValue placeholder={t("Add a plant…")} />
                </SelectTrigger>
                <SelectContent className="max-h-80">
                  {addable.map((p) => (
                    <SelectItem key={p.plant_id} value={String(p.plant_id)}>
                      {p.name} · {p.plant_id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button type="button" size="sm" variant="outline" disabled={!addId} onClick={addRow}>
                <Plus data-icon="inline-start" />
                {t("Add rate")}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {canEdit && (
        <SaveBar
          dirty={dirty}
          saving={saving}
          onSave={save}
          onReset={() => setDraft(toDraft(tariff))}
          label={t("Save prices")}
          note={t("Lost-energy ฿ use the new prices from the next rules run; ฿ already stored on issues keep their price.")}
        />
      )}
    </div>
  );
};
