import React, { useEffect, useState } from "react";
import { Save, Settings, Sliders, Cpu, CheckCircle2 } from "lucide-react";
import { useAppContext } from "../context/AppContext";
import { api, FleetModuleOut, StringSpec } from "../api/client";
import { PageHeader, Panel } from "../components/ui";
import { GrowattStringLayoutPanel } from "../components/GrowattStringLayoutPanel";
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
    setSavedMsg("Plant configuration and string electrical specifications saved!");
  };

  const updateSpecField = (idx: number, field: keyof StringSpec, value: any) => {
    const copy = [...specs];
    copy[idx] = { ...copy[idx], [field]: value };
    setSpecs(copy);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Settings}
        eyebrow="System · Plant & String Specifications"
        title="Plant Configuration & String Nameplate Specs"
        description="Configure site coordinates, system loss factors, and per-string STC module ratings."
      />

      {savedMsg && (
        <div className="callout-ok flex items-center gap-2 font-medium">
          <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
          <span>{savedMsg}</span>
        </div>
      )}

      {admin && (
      <form onSubmit={handleSavePlant} className="space-y-6">
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
          Save Plant & String Configuration
        </button>
      </form>
      )}

      <FleetModulePanel module={fleetModule} onSaved={setFleetModule} />
      <GrowattStringLayoutPanel fleetModule={fleetModule} />
    </div>
  );
};
