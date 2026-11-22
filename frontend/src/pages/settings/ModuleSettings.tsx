import React, { useEffect, useMemo, useState } from "react";
import { ExternalLink } from "lucide-react";
import { useAppContext } from "../../context/AppContext";
import { isAdmin } from "../../auth/access";
import { api, FleetModule, FleetModuleOut } from "../../api/client";
import { LoadingState } from "../../components/ui";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useI18n } from "../../i18n";
import { NoticeLine, Notice, NumberField, SaveBar, SavedStamp, SectionHeader, notifyNotice, num, publishNotice } from "./shared";
import { notify } from "@/lib/notify";

type NumKey = Exclude<keyof FleetModule, "manufacturer" | "model" | "datasheet_url" | "cell_technology">;
type F = { key: NumKey; label: string; unit?: string; step: string };

const CELL_TECH = ["perc", "topcon", "hjt", "ibc"] as const;
const CELL_LABEL: Record<(typeof CELL_TECH)[number], string> = { perc: "PERC", topcon: "TOPCon", hjt: "HJT", ibc: "IBC" };
const UNKNOWN = "unknown";

const GROUPS: Array<{ title: string; description: string; fields: F[] }> = [
  {
    title: "STC rating",
    description: "Datasheet values at 1000 W/m², 25 °C cell.",
    fields: [
      { key: "wp", label: "Pmax", unit: "Wp", step: "1" },
      { key: "vmp_stc", label: "Vmp", unit: "V", step: "0.01" },
      { key: "imp_stc", label: "Imp", unit: "A", step: "0.01" },
      { key: "voc_stc", label: "Voc", unit: "V", step: "0.01" },
      { key: "isc_stc", label: "Isc", unit: "A", step: "0.01" },
      { key: "efficiency_pct", label: "Efficiency", unit: "%", step: "0.01" },
    ],
  },
  {
    title: "Temperature and bifacial",
    description: "Temperature coefficients per °C and the rear-side gain.",
    fields: [
      { key: "temp_coeff_pmax_pct", label: "γ Pmax", unit: "%/°C", step: "0.001" },
      { key: "temp_coeff_voc_pct", label: "β Voc", unit: "%/°C", step: "0.001" },
      { key: "temp_coeff_isc_pct", label: "α Isc", unit: "%/°C", step: "0.001" },
      { key: "bifacial_factor_pct", label: "Bifacial factor", unit: "%", step: "1" },
    ],
  },
  {
    title: "I-V analysis (IEC 60891 Procedure 2)",
    description: "Measured correction factors. Leave empty to use the assumed typical values.",
    fields: [
      { key: "p2_b1", label: "B1 (measured)", step: "0.001" },
      { key: "p2_b2", label: "B2 (measured)", step: "0.001" },
      { key: "kappa_ohm_per_k", label: "κ per module", unit: "Ω/K", step: "0.0001" },
    ],
  },
];
const NUM_KEYS = GROUPS.flatMap((g) => g.fields.map((f) => f.key));
// Not on this form: sent back as loaded, so a save does not reset them.
const KEPT_FIELDS: NumKey[] = ["rs_ohm", "first_year_lid_pct", "annual_degradation_pct"];

const toDraft = (m: FleetModuleOut): Record<string, string> => {
  const d: Record<string, string> = {
    manufacturer: m.manufacturer,
    model: m.model,
    datasheet_url: m.datasheet_url ?? "",
    cell_technology: m.cell_technology ?? "",
  };
  for (const k of NUM_KEYS) d[k] = m[k] != null ? String(m[k]) : "";
  return d;
};

/** Fleet PV module (global): saved in SQL and mirrored to Firestore `config/fleet_module`.
 * Strings with no own rating use its Wp. Admins edit, engineers read. */
export const ModuleSettings: React.FC = () => {
  const { user, refreshAll } = useAppContext();
  const { t } = useI18n();
  const canEdit = isAdmin(user);
  const [module, setModule] = useState<FleetModuleOut | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  useEffect(() => {
    api
      .getFleetModule()
      .then((m) => {
        setModule(m);
        setDraft(toDraft(m));
      })
      .catch((e) => setLoadError(e.message));
  }, []);

  const dirty = useMemo(() => module != null && JSON.stringify(toDraft(module)) !== JSON.stringify(draft), [module, draft]);
  const set = (k: string, v: string) => setDraft((d) => ({ ...d, [k]: v }));

  const save = async () => {
    const wp = num(draft.wp);
    if (wp == null || !draft.manufacturer?.trim() || !draft.model?.trim()) {
      setNotice({ tone: "crit", text: t("Manufacturer, model and Pmax are required.") });
      return;
    }
    const body = {
      manufacturer: draft.manufacturer.trim(),
      model: draft.model.trim(),
      cell_technology: CELL_TECH.find((c) => c === draft.cell_technology) ?? null,
      datasheet_url: draft.datasheet_url?.trim() || null,
    } as FleetModule;
    for (const k of NUM_KEYS) (body as any)[k] = num(draft[k]);
    for (const k of KEPT_FIELDS) if (module?.[k] != null) body[k] = module[k];
    setSaving(true);
    setNotice(null);
    try {
      const saved = await api.putFleetModule(body);
      setModule(saved);
      setDraft(toDraft(saved));
      await refreshAll();
      notifyNotice(publishNotice(saved.published));
    } catch (e: any) {
      notify("crit", t("Save failed: {error}", { error: e.message }));
    } finally {
      setSaving(false);
    }
  };

  const header = (
    <SectionHeader
      title={t("PV module")}
      description={t("The module used across the fleet. Strings without their own module Wp (String Layout) use this one; I-V analysis uses its ratings.")}
      aside={module && <SavedStamp source={module.source} by={module.updated_by} at={module.updated_at} />}
    />
  );

  if (loadError) return <div className="space-y-4">{header}<NoticeLine notice={{ tone: "crit", text: t("Could not load the fleet module: {error}", { error: loadError }) }} /></div>;
  if (!module) return <div className="space-y-4">{header}<LoadingState label={t("Loading fleet module…")} shape="lines" /></div>;

  return (
    <div className="space-y-4">
      {header}
      <NoticeLine notice={notice} />

      <Card className="gap-4 py-4">
        <CardHeader className="px-4">
          <CardTitle className="text-sm">{t("Module")}</CardTitle>
          <CardDescription className="text-xs">{t("Who makes it and which model.")}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 px-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field className="gap-1.5">
            <FieldLabel htmlFor="m-manufacturer" className="text-[11px] font-medium text-muted-foreground">{t("Manufacturer")}</FieldLabel>
            <Input id="m-manufacturer" value={draft.manufacturer ?? ""} disabled={!canEdit} onChange={(e) => set("manufacturer", e.target.value)} />
          </Field>
          <Field className="gap-1.5">
            <FieldLabel htmlFor="m-model" className="text-[11px] font-medium text-muted-foreground">{t("Model")}</FieldLabel>
            <Input id="m-model" value={draft.model ?? ""} disabled={!canEdit} onChange={(e) => set("model", e.target.value)} />
          </Field>
          <Field className="gap-1.5">
            <FieldLabel htmlFor="m-cell" className="text-[11px] font-medium text-muted-foreground">{t("Cell technology")}</FieldLabel>
            <Select value={draft.cell_technology || UNKNOWN} disabled={!canEdit} onValueChange={(v) => set("cell_technology", v === UNKNOWN ? "" : v)}>
              <SelectTrigger id="m-cell" size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={UNKNOWN}>{t("Unknown")}</SelectItem>
                {CELL_TECH.map((c) => (
                  <SelectItem key={c} value={c}>
                    {CELL_LABEL[c]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field className="gap-1.5">
            <FieldLabel htmlFor="m-sheet" className="text-[11px] font-medium text-muted-foreground">{t("Datasheet URL")}</FieldLabel>
            <div className="flex gap-2">
              <Input id="m-sheet" value={draft.datasheet_url ?? ""} disabled={!canEdit} onChange={(e) => set("datasheet_url", e.target.value)} />
              {/^https?:\/\//i.test(module.datasheet_url ?? "") && (
                <Button asChild size="icon-sm" variant="outline">
                  <a href={module.datasheet_url!} target="_blank" rel="noreferrer" aria-label={t("Open datasheet")}>
                    <ExternalLink />
                  </a>
                </Button>
              )}
            </div>
          </Field>
        </CardContent>
      </Card>

      {GROUPS.map((g) => (
        <Card key={g.title} className="gap-4 py-4">
          <CardHeader className="px-4">
            <CardTitle className="text-sm">{t(g.title)}</CardTitle>
            <CardDescription className="text-xs">{t(g.description)}</CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-3 px-4 sm:grid-cols-3 lg:grid-cols-6">
            {g.fields.map((f) => (
              <NumberField
                key={f.key}
                id={`m-${f.key}`}
                label={t(f.label)}
                unit={f.unit}
                step={f.step}
                value={draft[f.key] ?? ""}
                disabled={!canEdit}
                invalid={f.key === "wp" && num(draft.wp) == null}
                onChange={(v) => set(f.key, v)}
              />
            ))}
          </CardContent>
        </Card>
      ))}

      {canEdit && (
        <SaveBar
          dirty={dirty}
          saving={saving}
          onSave={save}
          onReset={() => setDraft(toDraft(module))}
          note={t("Applies to every plant and publishes config/fleet_module.")}
        />
      )}
    </div>
  );
};
