import React, { useEffect, useState } from "react";
import { Cpu, Save, ExternalLink } from "lucide-react";
import { useAppContext } from "../context/AppContext";
import { isAdmin } from "../auth/access";
import { api, FleetModule, FleetModuleOut } from "../api/client";
import { Panel, LoadingState } from "./ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useI18n } from "../i18n";

type NumKey = Exclude<keyof FleetModule, "manufacturer" | "model" | "datasheet_url" | "cell_technology">;

const CELL_TECH = ["perc", "topcon", "hjt", "ibc"] as const;

const NUM_FIELDS: Array<{ key: NumKey; label: string; step: string }> = [
  { key: "wp", label: "Pmax (Wp)", step: "1" },
  { key: "vmp_stc", label: "Vmp (V)", step: "0.01" },
  { key: "imp_stc", label: "Imp (A)", step: "0.01" },
  { key: "voc_stc", label: "Voc (V)", step: "0.01" },
  { key: "isc_stc", label: "Isc (A)", step: "0.01" },
  { key: "efficiency_pct", label: "Efficiency (%)", step: "0.01" },
  { key: "temp_coeff_pmax_pct", label: "γ Pmax (%/°C)", step: "0.001" },
  { key: "temp_coeff_voc_pct", label: "β Voc (%/°C)", step: "0.001" },
  { key: "temp_coeff_isc_pct", label: "α Isc (%/°C)", step: "0.001" },
  { key: "bifacial_factor_pct", label: "Bifacial factor (%)", step: "1" },
  // I-V analysis (IEC 60891 Procedure 2); empty = the assumed typical values are used
  { key: "p2_b1", label: "I-V: B1 (measured)", step: "0.001" },
  { key: "p2_b2", label: "I-V: B2 (measured)", step: "0.001" },
  { key: "kappa_ohm_per_k", label: "I-V: κ (Ω/K per module)", step: "0.0001" },
];

// Not on this form: sent back as loaded, so a save does not reset them.
const KEPT_FIELDS: NumKey[] = ["rs_ohm", "first_year_lid_pct", "annual_degradation_pct"];

/**
 * PV module used across the whole fleet (global data). Saved in the backend DB and mirrored
 * to Firestore `config/fleet_module`. Strings with no own rating use its Wp.
 */
export const FleetModulePanel: React.FC<{
  module: FleetModuleOut | null;
  onSaved: (m: FleetModuleOut) => void;
}> = ({ module, onSaved }) => {
  const { user, refreshAll } = useAppContext();
  const { t, locale } = useI18n();
  const canEdit = isAdmin(user); // fleet-wide setting: admin only
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "warn" | "crit"; text: string } | null>(null);

  useEffect(() => {
    if (!module) return;
    const d: Record<string, string> = {
      manufacturer: module.manufacturer,
      model: module.model,
      datasheet_url: module.datasheet_url ?? "",
      cell_technology: module.cell_technology ?? "",
    };
    for (const f of NUM_FIELDS) d[f.key] = module[f.key] != null ? String(module[f.key]) : "";
    setDraft(d);
  }, [module]);

  const num = (v: string | undefined) => (v != null && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

  const save = async () => {
    const wp = num(draft.wp);
    if (wp == null || !draft.manufacturer?.trim() || !draft.model?.trim()) {
      setMsg({ tone: "crit", text: t("Manufacturer, model and Pmax are required.") });
      return;
    }
    const body: FleetModule = {
      manufacturer: draft.manufacturer.trim(),
      model: draft.model.trim(),
      wp,
      vmp_stc: num(draft.vmp_stc),
      imp_stc: num(draft.imp_stc),
      voc_stc: num(draft.voc_stc),
      isc_stc: num(draft.isc_stc),
      efficiency_pct: num(draft.efficiency_pct),
      temp_coeff_pmax_pct: num(draft.temp_coeff_pmax_pct),
      temp_coeff_voc_pct: num(draft.temp_coeff_voc_pct),
      temp_coeff_isc_pct: num(draft.temp_coeff_isc_pct),
      bifacial_factor_pct: num(draft.bifacial_factor_pct),
      p2_b1: num(draft.p2_b1),
      p2_b2: num(draft.p2_b2),
      kappa_ohm_per_k: num(draft.kappa_ohm_per_k),
      cell_technology: CELL_TECH.find((t) => t === draft.cell_technology) ?? null,
      datasheet_url: draft.datasheet_url?.trim() || null,
    };
    for (const k of KEPT_FIELDS) if (module?.[k] != null) body[k] = module[k];
    setSaving(true);
    setMsg(null);
    try {
      const saved = await api.putFleetModule(body);
      onSaved(saved);
      await refreshAll();
      const p = saved.published;
      setMsg(
        p?.error
          ? { tone: "warn", text: t("Saved. Publishing to {sink} failed ({error}); the next publish job retries.", { sink: p.sink ?? t("the summary sink"), error: p.error }) }
          : p?.deferred
          ? { tone: "warn", text: t("Saved. Today's Firestore write budget is used up; it publishes on the next quota day.") }
          : { tone: "ok", text: t("Saved and published to {sink} ({n} write).", { sink: p?.sink === "firestore" ? "Firestore" : p?.sink ?? "sink", n: p?.written ?? 0 }) }
      );
    } catch (e: any) {
      setMsg({ tone: "crit", text: t("Save failed: {error}", { error: e.message }) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Panel
      icon={Cpu}
      title={t("Fleet PV Module (Global)")}
      subtitle={t("Applies to every plant. Saved on the server and mirrored to Firestore config/fleet_module.")}
      actions={
        module && (
          <span className="text-[11px] text-slate-500">
            {module.source === "default"
              ? t("Default (not saved yet)")
              : `${t("Saved by {user}", { user: module.updated_by ?? "—" })}${module.updated_at ? ` · ${new Date(module.updated_at).toLocaleString(locale)}` : ""}`}
          </span>
        )
      }
    >
      {!module ? (
        <LoadingState label={t("Loading fleet module…")} shape="lines" />
      ) : (
        <div className="space-y-4 text-xs">
          {msg && <div className={`callout-${msg.tone}`}>{msg.text}</div>}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <div>
              <Label className="mb-1 block text-[11px] font-medium text-slate-400">{t("Manufacturer")}</Label>
              <Input
                value={draft.manufacturer ?? ""}
                disabled={!canEdit}
                onChange={(e) => setDraft((d) => ({ ...d, manufacturer: e.target.value }))}
              />
            </div>
            <div>
              <Label className="mb-1 block text-[11px] font-medium text-slate-400">{t("Model")}</Label>
              <Input
                value={draft.model ?? ""}
                disabled={!canEdit}
                onChange={(e) => setDraft((d) => ({ ...d, model: e.target.value }))}
              />
            </div>
            <div className="col-span-2">
              <Label className="mb-1 block text-[11px] font-medium text-slate-400">{t("Datasheet URL")}</Label>
              <div className="flex gap-2">
                <Input
                  value={draft.datasheet_url ?? ""}
                  disabled={!canEdit}
                  onChange={(e) => setDraft((d) => ({ ...d, datasheet_url: e.target.value }))}
                />
                {module.datasheet_url && (
                  <Button asChild size="sm">
                    <a href={module.datasheet_url} target="_blank" rel="noreferrer" aria-label={t("Open datasheet")}>
                      <ExternalLink className="size-3.5" />
                    </a>
                  </Button>
                )}
              </div>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            {NUM_FIELDS.map((f) => (
              <div key={f.key}>
                <Label className="mb-1 block text-[11px] font-medium text-slate-400">{t(f.label)}</Label>
                <Input
                  type="number"
                  step={f.step}
                  className="num"
                  value={draft[f.key] ?? ""}
                  placeholder="—"
                  disabled={!canEdit}
                  onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                />
              </div>
            ))}
            <div>
              <Label className="mb-1 block text-[11px] font-medium text-slate-400">{t("I-V: cell technology")}</Label>
              <select
                value={draft.cell_technology ?? ""}
                disabled={!canEdit}
                onChange={(e) => setDraft((d) => ({ ...d, cell_technology: e.target.value }))}
                className="h-8 w-full rounded-md border border-white/10 bg-ink-900 px-2 text-xs text-white focus:outline-none disabled:opacity-50"
              >
                <option value="">{t("Unknown")}</option>
                <option value="perc">PERC</option>
                <option value="topcon">TOPCon</option>
                <option value="hjt">HJT</option>
                <option value="ibc">IBC</option>
              </select>
            </div>
          </div>
          {canEdit && (
            <Button type="button" variant="default" onClick={save} disabled={saving}>
              <Save className="size-4" />
              {saving ? t("Saving…") : t("Save Fleet Module")}
            </Button>
          )}
        </div>
      )}
    </Panel>
  );
};
