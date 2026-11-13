import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Save, Sliders, Cpu, CheckCircle2, Globe2, Layers } from "lucide-react";
import { useAppContext, usePlantHref } from "../context/AppContext";
import { api, FleetModuleOut, StringSpec } from "../api/client";
import { PageHeader, Panel } from "../components/ui";
import { FleetModulePanel } from "../components/FleetModulePanel";
import { isAdmin } from "../auth/access";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const PlantSettingsPage: React.FC = () => {
  const { activePlant, refreshAll, user } = useAppContext();
  const plantHref = usePlantHref();
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
        eyebrow="System · Settings"
        title="Settings"
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
            <Link to={plantHref("string-layout")} className="font-semibold text-sky-300 underline">
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
              <Label className="mb-1 block text-[11px] font-medium text-slate-400">Plant Name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div>
              <Label className="mb-1 block text-[11px] font-medium text-slate-400">Location</Label>
              <Input value={location} onChange={(e) => setLocation(e.target.value)} />
            </div>
            <div>
              <Label className="mb-1 block text-[11px] font-medium text-slate-400">Latitude / Longitude</Label>
              <div className="grid grid-cols-2 gap-2">
                <Input
                  type="number"
                  step="0.0001"
                  value={lat}
                  onChange={(e) => setLat(Number(e.target.value))}
                  className="num"
                />
                <Input
                  type="number"
                  step="0.0001"
                  value={lon}
                  onChange={(e) => setLon(Number(e.target.value))}
                  className="num"
                />
              </div>
            </div>
            <div>
              <Label className="mb-1 block text-[11px] font-medium text-slate-400">System Loss Factor</Label>
              <Input
                type="number"
                step="0.005"
                value={lossFactor}
                onChange={(e) => setLossFactor(Number(e.target.value))}
                className="num"
              />
            </div>
          </div>
        </Panel>

        <Panel
          icon={Cpu}
          title="Per-String Electrical Specifications"
          subtitle="STC nameplate parameters for each PV string and MPPT channel"
        >
          <Table containerClassName="table-wrap">
              <TableHeader>
                <TableRow>
                  <TableHead>String ID</TableHead>
                  <TableHead>Inverter</TableHead>
                  <TableHead>MPPT</TableHead>
                  <TableHead>Modules</TableHead>
                  <TableHead>Module Wp</TableHead>
                  <TableHead>Voc STC (V)</TableHead>
                  <TableHead>Vmp STC (V)</TableHead>
                  <TableHead>Isc STC (A)</TableHead>
                  <TableHead>Imp STC (A)</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {specs.map((s, idx) => (
                  <TableRow key={s.string_id}>
                    <TableCell className="num whitespace-nowrap font-bold text-solar-400">{s.string_id}</TableCell>
                    <TableCell>
                      <Input
                        value={s.inverter_id}
                        onChange={(e) => updateSpecField(idx, "inverter_id", e.target.value)}
                        className="h-7 px-2 text-[11px] num w-28"
                      />
                    </TableCell>
                    <TableCell>
                      <Input
                        value={s.mppt_id}
                        onChange={(e) => updateSpecField(idx, "mppt_id", e.target.value)}
                        className="h-7 px-2 text-[11px] num w-24"
                      />
                    </TableCell>
                    <TableCell>
                      <Input
                        type="number"
                        value={s.modules_per_string}
                        onChange={(e) => updateSpecField(idx, "modules_per_string", Number(e.target.value))}
                        className="h-7 px-2 text-[11px] num w-20"
                      />
                    </TableCell>
                    <TableCell>
                      <Input
                        type="number"
                        value={s.module_wp}
                        onChange={(e) => updateSpecField(idx, "module_wp", Number(e.target.value))}
                        className="h-7 px-2 text-[11px] num w-24"
                      />
                    </TableCell>
                    <TableCell>
                      <Input
                        type="number"
                        step="0.1"
                        value={s.voc_stc}
                        onChange={(e) => updateSpecField(idx, "voc_stc", Number(e.target.value))}
                        className="h-7 px-2 text-[11px] num w-24"
                      />
                    </TableCell>
                    <TableCell>
                      <Input
                        type="number"
                        step="0.1"
                        value={s.vmp_stc}
                        onChange={(e) => updateSpecField(idx, "vmp_stc", Number(e.target.value))}
                        className="h-7 px-2 text-[11px] num w-24"
                      />
                    </TableCell>
                    <TableCell>
                      <Input
                        type="number"
                        step="0.01"
                        value={s.isc_stc}
                        onChange={(e) => updateSpecField(idx, "isc_stc", Number(e.target.value))}
                        className="h-7 px-2 text-[11px] num w-24"
                      />
                    </TableCell>
                    <TableCell>
                      <Input
                        type="number"
                        step="0.01"
                        value={s.imp_stc}
                        onChange={(e) => updateSpecField(idx, "imp_stc", Number(e.target.value))}
                        className="h-7 px-2 text-[11px] num w-24"
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
          </Table>
        </Panel>

        <Button type="submit" variant="default">
          <Save className="size-4" />
          Save legacy plant & strings
        </Button>
      </form>
      </details>
      )}
    </div>
  );
};
