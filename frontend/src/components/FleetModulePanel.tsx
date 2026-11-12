import React, { useEffect, useState } from "react";
import { Cpu, Save, ExternalLink } from "lucide-react";
import { useAppContext } from "../context/AppContext";
import { isAdmin } from "../auth/access";
import { api, FleetModule, FleetModuleOut } from "../api/client";
import { Panel, LoadingState } from "./ui";

type NumKey = Exclude<keyof FleetModule, "manufacturer" | "model" | "datasheet_url">;

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
];

/**
 * PV module used across the whole fleet (global data). Saved in the backend DB and mirrored
 * to Firestore `config/fleet_module`. Strings with no own rating use its Wp.
 */
export const FleetModulePanel: React.FC<{
  module: FleetModuleOut | null;
  onSaved: (m: FleetModuleOut) => void;
}> = ({ module, onSaved }) => {
  const { user, refreshAll } = useAppContext();
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
    };
    for (const f of NUM_FIELDS) d[f.key] = module[f.key] != null ? String(module[f.key]) : "";
    setDraft(d);
  }, [module]);

  const num = (v: string | undefined) => (v != null && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

  const save = async () => {
    const wp = num(draft.wp);
    if (wp == null || !draft.manufacturer?.trim() || !draft.model?.trim()) {
      setMsg({ tone: "crit", text: "Manufacturer, model and Pmax are required." });
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
      datasheet_url: draft.datasheet_url?.trim() || null,
    };
    setSaving(true);
    setMsg(null);
    try {
      const saved = await api.putFleetModule(body);
      onSaved(saved);
      await refreshAll();
      const p = saved.published;
      setMsg(
        p?.error
          ? { tone: "warn", text: `Saved. Publishing to ${p.sink ?? "the summary sink"} failed (${p.error}); the next publish job retries.` }
          : p?.deferred
          ? { tone: "warn", text: "Saved. Today's Firestore write budget is used up; it publishes on the next quota day." }
          : { tone: "ok", text: `Saved and published to ${p?.sink === "firestore" ? "Firestore" : p?.sink ?? "sink"} (${p?.written ?? 0} write).` }
      );
    } catch (e: any) {
      setMsg({ tone: "crit", text: `Save failed: ${e.message}` });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Panel
      icon={Cpu}
      title="Fleet PV Module (Global)"
      subtitle="Applies to every plant. Saved on the server and mirrored to Firestore config/fleet_module."
      actions={
        module && (
          <span className="text-[11px] text-slate-500">
            {module.source === "default"
              ? "Default (not saved yet)"
              : `Saved by ${module.updated_by ?? "—"}${module.updated_at ? ` · ${new Date(module.updated_at).toLocaleString()}` : ""}`}
          </span>
        )
      }
    >
      {!module ? (
        <LoadingState label="Loading fleet module…" />
      ) : (
        <div className="space-y-4 text-xs">
          {msg && <div className={`callout-${msg.tone}`}>{msg.text}</div>}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <div>
              <label className="label">Manufacturer</label>
              <input
                className="input"
                value={draft.manufacturer ?? ""}
                disabled={!canEdit}
                onChange={(e) => setDraft((d) => ({ ...d, manufacturer: e.target.value }))}
              />
            </div>
            <div>
              <label className="label">Model</label>
              <input
                className="input"
                value={draft.model ?? ""}
                disabled={!canEdit}
                onChange={(e) => setDraft((d) => ({ ...d, model: e.target.value }))}
              />
            </div>
            <div className="col-span-2">
              <label className="label">Datasheet URL</label>
              <div className="flex gap-2">
                <input
                  className="input"
                  value={draft.datasheet_url ?? ""}
                  disabled={!canEdit}
                  onChange={(e) => setDraft((d) => ({ ...d, datasheet_url: e.target.value }))}
                />
                {module.datasheet_url && (
                  <a className="btn btn-sm" href={module.datasheet_url} target="_blank" rel="noreferrer" aria-label="Open datasheet">
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                )}
              </div>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            {NUM_FIELDS.map((f) => (
              <div key={f.key}>
                <label className="label">{f.label}</label>
                <input
                  type="number"
                  step={f.step}
                  className="input num"
                  value={draft[f.key] ?? ""}
                  placeholder="—"
                  disabled={!canEdit}
                  onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                />
              </div>
            ))}
          </div>
          {canEdit && (
            <button type="button" className="btn-primary" onClick={save} disabled={saving}>
              <Save className="h-4 w-4" />
              {saving ? "Saving…" : "Save Fleet Module"}
            </button>
          )}
        </div>
      )}
    </Panel>
  );
};
