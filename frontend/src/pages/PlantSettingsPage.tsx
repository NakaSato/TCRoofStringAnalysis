import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Save, Sliders, Cpu, CheckCircle2, Globe2, Layers } from "lucide-react";
import { useAppContext } from "../context/AppContext";
import { api, FleetModuleOut, StringSpec } from "../api/client";
import { PageHeader, Panel } from "../components/ui";
import { FleetModulePanel } from "../components/FleetModulePanel";
import { isAdmin } from "../auth/access";

export const PlantSettingsPage: React.FC = () => {
  const { activePlant, refreshAll, user } = useAppContext();
  const admin = isAdmin(user); // the legacy plant / string-spec form is admin only
  const [name, setName] = useState("");
  const [location, setLocation] = useState("");
  const [lat, setLat] = useState(13.7563);
  const [lon, setLon] = useState(100.5018);
  const [lossFactor, setLossFactor] = useState(0.04);
  const [specs, setSpecs] = useState<StringSpec[]>([]);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [fleetModule, setFleetModule] = useState<FleetModuleOut | null>(null);

  useEffect(() => {
    api.getFleetModule().then(setFleetModule).catch(() => {});
  }, []);

  useEffect(() => {
    if (activePlant) {
      setName(activePlant.name);
      setLocation(activePlant.location);
      setLat(activePlant.latitude);
      setLon(activePlant.longitude);
      setLossFactor(activePlant.system_loss_factor);
      setSpecs(activePlant.string_specs || []);
    }
  }, [activePlant]);

  const handleSavePlant = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activePlant) return;
    setSavedMsg(null);
    await api.updatePlant(activePlant.id, {
      ...activePlant,
      name,
      location,
      latitude: lat,
      longitude: lon,
      system_loss_factor: lossFactor,
    });
    await api.updatePlantStrings(activePlant.id, specs);
    await refreshAll();
    setSavedMsg("Legacy plant and string specifications saved.");
  };

  const updateSpecField = (idx: number, field: keyof StringSpec, value: any) => {
    const copy = [...specs];
    copy[idx] = { ...copy[idx], [field]: value };
    setSpecs(copy);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Globe2}
        eyebrow="System · Global Settings"
        title="Global Settings"
        description="Fleet-wide settings that apply to every Growatt plant. Settings that belong to one plant live on that plant's tabs."
      />

      {savedMsg && (
        <div className="callout-ok flex items-center gap-2 font-medium">
          <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
          <span>{savedMsg}</span>
        </div>
      )}

      <FleetModulePanel module={fleetModule} onSaved={setFleetModule} />

      <Panel icon={Layers} title="Per-plant settings" subtitle="Not global: set these on the selected plant">
        <ul className="space-y-2 text-xs text-slate-300">
          <li>
            <Link to="/string-layout" className="font-semibold text-sky-300 underline">
              String Layout
            </Link>{" "}
            — modules per string and module Wp for one plant (blank Wp uses the fleet module above).
          </li>
          {admin && (
            <li>
              <Link to="/users" className="font-semibold text-sky-300 underline">
                Users &amp; Access
              </Link>{" "}
              — which plants each engineer can see.
            </li>
          )}
        </ul>
      </Panel>

      {admin && (
      <details className="group">
        <summary className="cursor-pointer select-none text-xs font-semibold text-slate-400 hover:text-slate-200">
          Legacy analysis plant (uploaded / simulated datasets, not Growatt plants)
        </summary>
      <form onSubmit={handleSavePlant} className="mt-4 space-y-6">
        <Panel icon={Sliders} title="General Plant Metadata" subtitle="Geolocation and baseline system loss parameters">
          <div className="grid grid-cols-1 gap-4 text-xs md:grid-cols-5">
            <div className="md:col-span-2">
              <label className="label">Plant Name</label>
              <input value={name} onChange={(e) => setName(e.target.value)} className="input" />
            </div>
            <div>
              <label className="label">Location</label>
              <input value={location} onChange={(e) => setLocation(e.target.value)} className="input" />
            </div>
            <div>
              <label className="label">Latitude / Longitude</label>
              <div className="grid grid-cols-2 gap-2">
                <input
                  type="number"
                  step="0.0001"
                  value={lat}
                  onChange={(e) => setLat(Number(e.target.value))}
                  className="input num"
                />
                <input
                  type="number"
                  step="0.0001"
                  value={lon}
                  onChange={(e) => setLon(Number(e.target.value))}
                  className="input num"
                />
              </div>
            </div>
            <div>
              <label className="label">System Loss Factor</label>
              <input
                type="number"
                step="0.005"
                value={lossFactor}
                onChange={(e) => setLossFactor(Number(e.target.value))}
                className="input num"
              />
            </div>
          </div>
        </Panel>

        <Panel
          icon={Cpu}
          title="Per-String Electrical Specifications"
          subtitle="STC nameplate parameters for each PV string and MPPT channel"
        >
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>String ID</th>
                  <th>Inverter</th>
                  <th>MPPT</th>
                  <th>Modules</th>
                  <th>Module Wp</th>
                  <th>Voc STC (V)</th>
                  <th>Vmp STC (V)</th>
                  <th>Isc STC (A)</th>
                  <th>Imp STC (A)</th>
                </tr>
              </thead>
              <tbody>
                {specs.map((s, idx) => (
                  <tr key={s.string_id}>
                    <td className="num font-bold text-solar-400">{s.string_id}</td>
                    <td>
                      <input
                        value={s.inverter_id}
                        onChange={(e) => updateSpecField(idx, "inverter_id", e.target.value)}
                        className="input input-sm num w-28"
                      />
                    </td>
                    <td>
                      <input
                        value={s.mppt_id}
                        onChange={(e) => updateSpecField(idx, "mppt_id", e.target.value)}
                        className="input input-sm num w-24"
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        value={s.modules_per_string}
                        onChange={(e) => updateSpecField(idx, "modules_per_string", Number(e.target.value))}
                        className="input input-sm num w-20"
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        value={s.module_wp}
                        onChange={(e) => updateSpecField(idx, "module_wp", Number(e.target.value))}
                        className="input input-sm num w-24"
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        step="0.1"
                        value={s.voc_stc}
                        onChange={(e) => updateSpecField(idx, "voc_stc", Number(e.target.value))}
                        className="input input-sm num w-24"
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        step="0.1"
                        value={s.vmp_stc}
                        onChange={(e) => updateSpecField(idx, "vmp_stc", Number(e.target.value))}
                        className="input input-sm num w-24"
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        step="0.01"
                        value={s.isc_stc}
                        onChange={(e) => updateSpecField(idx, "isc_stc", Number(e.target.value))}
                        className="input input-sm num w-24"
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        step="0.01"
                        value={s.imp_stc}
                        onChange={(e) => updateSpecField(idx, "imp_stc", Number(e.target.value))}
                        className="input input-sm num w-24"
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>

        <button type="submit" className="btn-primary">
          <Save className="h-4 w-4" />
          Save legacy plant & strings
        </button>
      </form>
      </details>
      )}
    </div>
  );
};
