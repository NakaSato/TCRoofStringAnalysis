import React, { useEffect, useState } from "react";
import { Plus, RefreshCw, Trash2, Wrench, CalendarCheck2, GitFork, CheckCircle2 } from "lucide-react";
import { useAppContext } from "../context/AppContext";
import { api, CMWorkOrder, PMTask, RCARecord } from "../api/client";
import { PageHeader, Panel, StatusBadge, Led, fmt } from "../components/ui";
import { SelectedPlantBanner } from "../components/SelectedPlantBanner";

export const MaintenanceRcaPage: React.FC = () => {
  const { activePlant, analysisRun, selectedPlantOverview, setInspectedStringId } = useAppContext();
  const [pmTasks, setPmTasks] = useState<PMTask[]>([]);
  const [cmOrders, setCmOrders] = useState<CMWorkOrder[]>([]);
  const [rcaRecords, setRcaRecords] = useState<RCARecord[]>([]);
  const [showRcaForm, setShowRcaForm] = useState<boolean>(false);
  const [showPmForm, setShowPmForm] = useState<boolean>(false);

  // New PM Task state
  const [newPmId, setNewPmId] = useState("PM-PV-006");
  const [newPmCat, setNewPmCat] = useState("PV Array & Modules");
  const [newPmDesc, setNewPmDesc] = useState("Soiling Sensor Calibration & Clamp Torque Check");
  const [newPmFreq, setNewPmFreq] = useState("Monthly");
  const [newPmSub, setNewPmSub] = useState("SolarClean Asia Co., Ltd.");

  // New RCA Form state
  const [eqCat, setEqCat] = useState("Inverter");
  const [assetId, setAssetId] = useState("INV-01 / TX-01 / SWG-01");
  const [downtime, setDowntime] = useState(2.5);
  const [lossKwh, setLossKwh] = useState(120.0);
  const [failureMode, setFailureMode] = useState("Unexpected breaker trip during peak load");
  const [why1, setWhy1] = useState("Equipment tripped offline");
  const [why2, setWhy2] = useState("Overtemperature / Overcurrent relay activated");
  const [why3, setWhy3] = useState("Loose termination / cooling fan failure");
  const [why4, setWhy4] = useState("PM inspection interval missed thermal anomaly");
  const [why5, setWhy5] = useState("PM checklist lacked full-load IR scan & torque verification");
  const [fishbone, setFishbone] = useState("Machine / Maintenance PM");
  const [capaC, setCapaC] = useState("Clean & re-torque termination; replace damaged component and test.");
  const [capaP, setCapaP] = useState(
    "Update PM checklist to require quarterly IR thermography and torque-seal witness marks."
  );

  const loadData = async () => {
    const pid = activePlant?.id || 1;
    const [pms, cms, rcas] = await Promise.all([
      api.listPmTasks(pid),
      api.listCmWorkOrders(pid),
      api.listRcaRecords(pid),
    ]);
    setPmTasks(pms);
    setCmOrders(cms);
    setRcaRecords(rcas);
  };

  useEffect(() => {
    loadData();
  }, [activePlant, analysisRun]);

  const handlePmStatusChange = async (task: PMTask, newStatus: string) => {
    try {
      const updated = await api.updatePmTask(task.id, { ...task, compliance_status: newStatus });
      setPmTasks(pmTasks.map((t) => (t.id === task.id ? updated : t)));
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleAddPmTask = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const today = new Date().toISOString().slice(0, 10);
      await api.createPmTask({
        plant_id: activePlant?.id || 1,
        pm_id: newPmId,
        asset_category: newPmCat,
        task_description: newPmDesc,
        frequency: newPmFreq,
        standard_ref: "IEC 62446-2",
        last_completed: today,
        next_due: today,
        assigned_subcontractor: newPmSub,
        compliance_status: "Scheduled",
        estimated_pr_recovery_pct: 0.8,
      });
      setShowPmForm(false);
      await loadData();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleDeletePm = async (id: number) => {
    try {
      await api.deletePmTask(id);
      await loadData();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleCmStatusChange = async (wo: CMWorkOrder, status: string) => {
    try {
      const updated = await api.updateCmWorkOrder(wo.id, { ...wo, status });
      setCmOrders(cmOrders.map((w) => (w.id === wo.id ? updated : w)));
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleRegenerateCm = async () => {
    if (!analysisRun) return;
    try {
      const orders = await api.regenerateCmWorkOrders(analysisRun.id);
      setCmOrders(orders);
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleCreateRca = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api.createRcaRecord({
        plant_id: activePlant?.id || 1,
        equipment_category: eqCat,
        asset_id: assetId,
        failure_mode: failureMode,
        downtime_hours: downtime,
        energy_loss_kwh: lossKwh,
        why_1: why1,
        why_2: why2,
        why_3: why3,
        why_4: why4,
        why_5_root_cause: why5,
        fishbone_category: fishbone,
        capa_corrective_action: capaC,
        capa_preventive_action: capaP,
        rca_status: "Open - CAPA Assigned",
      });
      setShowRcaForm(false);
      await loadData();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleRcaStatusChange = async (rec: RCARecord, status: string) => {
    try {
      const updated = await api.updateRcaRecord(rec.id, { ...rec, rca_status: status });
      setRcaRecords(rcaRecords.map((r) => (r.id === rec.id ? updated : r)));
    } catch (err: any) {
      alert(err.message);
    }
  };

  const plantAnomalies = selectedPlantOverview?.anomalies || [];

  return (
    <div className="space-y-6">
      <SelectedPlantBanner />

      {/* Live Plant String & Inverter Fault Alarms */}
      {plantAnomalies.length > 0 && (
        <Panel
          icon={Wrench}
          title={`Detected Plant String & Inverter Fault Alarms (${plantAnomalies.length})`}
          subtitle={`Real-time string mismatch & underperformance alarms on ${selectedPlantOverview?.plant.name || ""}`}
          bodyClassName="p-0"
        >
          <div className="scroll-x-hint max-h-72 overflow-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Severity</th>
                  <th>String ID</th>
                  <th>Inverter SN</th>
                  <th>Category</th>
                  <th className="text-right">PR (%)</th>
                  <th className="text-right">Est. Loss (kWh)</th>
                  <th>Diagnosis & Recommended Action</th>
                </tr>
              </thead>
              <tbody>
                {plantAnomalies.slice(0, 20).map((a, idx) => (
                  <tr
                    key={idx}
                    onClick={() => setInspectedStringId(a.string_id)}
                    className="cursor-pointer hover:bg-white/[0.03]"
                  >
                    <td>
                      <StatusBadge
                        status={a.severity}
                        level={a.severity === "Critical" ? "crit" : "warn"}
                        dot
                      />
                    </td>
                    <td className="num font-bold text-white hover:text-sky-300">{a.string_id}</td>
                    <td className="num text-xs text-slate-300">{a.device_sn}</td>
                    <td className="text-xs text-slate-300">{a.category}</td>
                    <td className="num text-right font-semibold text-solar-300">
                      {fmt(a.pr_pct, 1)}%
                    </td>
                    <td className="num text-right text-red-300">{fmt(a.energy_loss_kwh, 2)}</td>
                    <td className="text-xs text-slate-400">
                      <span className="text-slate-200">{a.description}</span> —{" "}
                      <span>{a.recommended_action}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      {/* PM & CM Side-by-Side */}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        {/* PM Schedule */}
        <Panel
          icon={CalendarCheck2}
          title="Preventive Maintenance (PM) Optimization Schedule"
          subtitle="Across PV Modules, Combiners, Inverters, Transformers & Switchgear"
          actions={
            <button onClick={() => setShowPmForm(!showPmForm)} className="btn-primary btn-sm">
              <Plus className="h-3.5 w-3.5" />
              Add PM Task
            </button>
          }
          bodyClassName="panel-pad space-y-3"
        >
          {showPmForm && (
            <form onSubmit={handleAddPmTask} className="callout space-y-3 text-xs">
              <div className="grid grid-cols-3 gap-2">
                <input
                  value={newPmId}
                  onChange={(e) => setNewPmId(e.target.value)}
                  placeholder="PM ID"
                  className="input input-sm"
                  required
                />
                <input
                  value={newPmCat}
                  onChange={(e) => setNewPmCat(e.target.value)}
                  placeholder="Asset Category"
                  className="input input-sm"
                  required
                />
                <select
                  value={newPmFreq}
                  onChange={(e) => setNewPmFreq(e.target.value)}
                  className="select input-sm"
                >
                  <option>Monthly</option>
                  <option>Quarterly</option>
                  <option>Semi-Annual</option>
                  <option>Annual</option>
                </select>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <input
                  value={newPmDesc}
                  onChange={(e) => setNewPmDesc(e.target.value)}
                  placeholder="Task Description"
                  className="input input-sm"
                  required
                />
                <input
                  value={newPmSub}
                  onChange={(e) => setNewPmSub(e.target.value)}
                  placeholder="Subcontractor"
                  className="input input-sm"
                  required
                />
              </div>
              <button type="submit" className="btn-primary btn-sm">
                Save PM Task
              </button>
            </form>
          )}

          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>PM ID</th>
                  <th>Asset & Task</th>
                  <th>Freq</th>
                  <th>Next Due</th>
                  <th>Subcontractor</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {pmTasks.map((t) => (
                  <tr key={t.id}>
                    <td className="num font-semibold text-solar-400">{t.pm_id}</td>
                    <td>
                      <div className="font-semibold text-slate-100">{t.asset_category}</div>
                      <div className="text-[11px] text-slate-500">{t.task_description}</div>
                    </td>
                    <td>{t.frequency}</td>
                    <td className="num text-[11px]">{t.next_due}</td>
                    <td className="text-[11px] text-slate-400">{t.assigned_subcontractor}</td>
                    <td>
                      <select
                        value={t.compliance_status}
                        onChange={(e) => handlePmStatusChange(t, e.target.value)}
                        className="select input-sm w-32"
                      >
                        <option>Due Soon</option>
                        <option>Scheduled</option>
                        <option>Completed</option>
                        <option>Overdue</option>
                      </select>
                    </td>
                    <td className="text-right">
                      <button
                        onClick={() => handleDeletePm(t.id)}
                        className="btn-ghost p-1 text-slate-500 hover:text-red-400"
                        title="Delete PM Task"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>

        {/* CM Work Orders */}
        <Panel
          icon={Wrench}
          title="Corrective Maintenance (CM) & Troubleshooting Work Orders"
          subtitle="Auto-generated from string fault diagnostics + active Inverter / Switchgear alarms"
          actions={
            <button onClick={handleRegenerateCm} className="btn btn-sm">
              <RefreshCw className="h-3.5 w-3.5" />
              Sync from Analysis
            </button>
          }
        >
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>WO #</th>
                  <th>Asset & Symptom</th>
                  <th>Priority</th>
                  <th>Troubleshooting Steps</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {cmOrders.map((wo) => (
                  <tr key={wo.id}>
                    <td className="num font-semibold text-solar-400">{wo.wo_number}</td>
                    <td>
                      <div className="font-semibold text-slate-100">{wo.asset_id}</div>
                      <div className="text-[11px] text-red-300">{wo.fault_symptom}</div>
                    </td>
                    <td>
                      <StatusBadge
                        status={wo.priority}
                        level={
                          wo.priority.includes("P1")
                            ? "crit"
                            : wo.priority.includes("P2")
                            ? "warn"
                            : "info"
                        }
                      />
                    </td>
                    <td className="max-w-xs text-[11px] text-slate-400">
                      {wo.troubleshooting_checklist}
                    </td>
                    <td>
                      <select
                        value={wo.status}
                        onChange={(e) => handleCmStatusChange(wo, e.target.value)}
                        className="select input-sm w-40"
                      >
                        <option>Open - Dispatched</option>
                        <option>In Progress</option>
                        <option>Scheduled</option>
                        <option>Closed - Verified</option>
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      </div>

      {/* Root Cause Analysis (RCA) Register */}
      <Panel
        icon={GitFork}
        title="Root Cause Analysis (RCA) — Inverters, Transformers, Switchgear & PV Strings"
        subtitle="Structured 5-Why & Fishbone (Ishikawa) Root Cause Analysis with Corrective & Preventive Actions (CAPA)"
        actions={
          <button onClick={() => setShowRcaForm(!showRcaForm)} className="btn-primary btn-sm">
            <Plus className="h-3.5 w-3.5" />
            {showRcaForm ? "Close RCA Form" : "Log New Equipment Failure RCA"}
          </button>
        }
        bodyClassName="panel-pad space-y-4"
      >
        {showRcaForm && (
          <form onSubmit={handleCreateRca} className="callout space-y-3 text-xs">
            <h5 className="font-bold text-slate-100">Log New 5-Why & Fishbone RCA Record</h5>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
              <div>
                <label className="label">Equipment Category</label>
                <select value={eqCat} onChange={(e) => setEqCat(e.target.value)} className="select">
                  <option>Inverter</option>
                  <option>Transformer</option>
                  <option>Switchgear</option>
                  <option>PV String / DC Combiner</option>
                </select>
              </div>
              <div>
                <label className="label">Asset ID</label>
                <input
                  value={assetId}
                  onChange={(e) => setAssetId(e.target.value)}
                  className="input"
                  required
                />
              </div>
              <div>
                <label className="label">Downtime (Hours)</label>
                <input
                  type="number"
                  step="0.5"
                  value={downtime}
                  onChange={(e) => setDowntime(Number(e.target.value))}
                  className="input num"
                />
              </div>
              <div>
                <label className="label">Energy Loss (kWh)</label>
                <input
                  type="number"
                  step="10"
                  value={lossKwh}
                  onChange={(e) => setLossKwh(Number(e.target.value))}
                  className="input num"
                />
              </div>
            </div>

            <div>
              <label className="label">Failure Mode / Alarm Description</label>
              <input
                value={failureMode}
                onChange={(e) => setFailureMode(e.target.value)}
                className="input"
                required
              />
            </div>

            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div>
                <label className="label">Why 1 (Immediate Symptom)</label>
                <input value={why1} onChange={(e) => setWhy1(e.target.value)} className="input" />
              </div>
              <div>
                <label className="label">Why 2 (Direct Cause)</label>
                <input value={why2} onChange={(e) => setWhy2(e.target.value)} className="input" />
              </div>
              <div>
                <label className="label">Why 3 (Contributing Factor)</label>
                <input value={why3} onChange={(e) => setWhy3(e.target.value)} className="input" />
              </div>
              <div>
                <label className="label">Why 4 (Process Gap)</label>
                <input value={why4} onChange={(e) => setWhy4(e.target.value)} className="input" />
              </div>
              <div>
                <label className="label">Why 5 (Root Cause)</label>
                <input value={why5} onChange={(e) => setWhy5(e.target.value)} className="input" />
              </div>
              <div>
                <label className="label">Fishbone Category</label>
                <select value={fishbone} onChange={(e) => setFishbone(e.target.value)} className="select">
                  <option>Machine / Maintenance PM</option>
                  <option>Material / Workmanship</option>
                  <option>Method / Subcontractor QA</option>
                  <option>Engineering / Protection Coordination</option>
                  <option>Environment</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div>
                <label className="label">Corrective Action (Immediate Fix)</label>
                <input value={capaC} onChange={(e) => setCapaC(e.target.value)} className="input" />
              </div>
              <div>
                <label className="label">Preventive Action (Long-Term Recurrence Prevention)</label>
                <input value={capaP} onChange={(e) => setCapaP(e.target.value)} className="input" />
              </div>
            </div>

            <button type="submit" className="btn-primary">
              <CheckCircle2 className="h-3.5 w-3.5" />
              Save RCA Record to Register
            </button>
          </form>
        )}

        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>RCA ID</th>
                <th>Category & Asset</th>
                <th>Failure Mode</th>
                <th>Loss</th>
                <th>Why 5 Root Cause & Fishbone</th>
                <th>CAPA (Corrective & Preventive)</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rcaRecords.map((rec) => (
                <tr key={rec.id}>
                  <td className="num">
                    <div className="font-bold text-solar-400">{rec.rca_id}</div>
                    <div className="text-[10px] text-slate-500">{rec.incident_date}</div>
                  </td>
                  <td>
                    <div className="font-semibold text-slate-100">{rec.equipment_category}</div>
                    <div className="num text-[11px] text-slate-500">{rec.asset_id}</div>
                  </td>
                  <td className="max-w-xs text-slate-200">{rec.failure_mode}</td>
                  <td className="num text-[11px]">
                    <div className="text-slate-400">{rec.downtime_hours}h</div>
                    <div className="font-semibold text-red-400">{rec.energy_loss_kwh} kWh</div>
                  </td>
                  <td className="max-w-xs">
                    <div className="font-semibold text-slate-100">{rec.why_5_root_cause}</div>
                    <span className="badge badge-info mt-1">{rec.fishbone_category}</span>
                  </td>
                  <td className="max-w-xs text-[11px]">
                    <div>
                      <strong className="text-solar-400">C:</strong> {rec.capa_corrective_action}
                    </div>
                    <div className="mt-0.5">
                      <strong className="text-energy-400">P:</strong> {rec.capa_preventive_action}
                    </div>
                  </td>
                  <td>
                    <select
                      value={rec.rca_status}
                      onChange={(e) => handleRcaStatusChange(rec, e.target.value)}
                      className="select input-sm w-44"
                    >
                      <option>Open - CAPA Assigned</option>
                      <option>CAPA In Implementation</option>
                      <option>Closed - Verified</option>
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
};
