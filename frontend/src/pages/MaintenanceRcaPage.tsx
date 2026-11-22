import React, { useEffect, useState } from "react";
import { Plus, RefreshCw, Trash2, Wrench, CalendarCheck2, GitFork, CheckCircle2 } from "lucide-react";
import { useAppContext } from "../context/AppContext";
import { api, CMWorkOrder, PMTask, RCARecord } from "../api/client";
import { PageHeader, Panel, StatusBadge, Led, fmt } from "../components/ui";
import { SelectedPlantBanner } from "../components/SelectedPlantBanner";
import { useI18n } from "@/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/** Legacy O&M modules (admin only, local `plants` table); `top` = the site log, shown first. */
export const MaintenanceRcaPage: React.FC<{ top?: React.ReactNode }> = ({ top }) => {
  const { activePlant, analysisRun, selectedPlantOverview, setInspectedStringId } = useAppContext();
  const { t } = useI18n();
  const [pmTasks, setPmTasks] = useState<PMTask[]>([]);
  const [cmOrders, setCmOrders] = useState<CMWorkOrder[]>([]);
  const [rcaRecords, setRcaRecords] = useState<RCARecord[]>([]);
  const [showRcaForm, setShowRcaForm] = useState<boolean>(false);
  const [showPmForm, setShowPmForm] = useState<boolean>(false);
  const [cmSyncing, setCmSyncing] = useState(false);

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
      setPmTasks(pmTasks.map((x) => (x.id === task.id ? updated : x)));
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
    if (!analysisRun?.id) {
      alert(t("No legacy analysis run to build CM work orders from."));
      return;
    }
    setCmSyncing(true);
    try {
      const orders = await api.regenerateCmWorkOrders(analysisRun.id);
      setCmOrders(orders);
    } catch (err: any) {
      alert(err.message);
    } finally {
      setCmSyncing(false);
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
      {top}

      {/* Live Plant String & Inverter Fault Alarms */}
      {plantAnomalies.length > 0 && (
        <Panel
          icon={Wrench}
          title={t("Detected Plant String & Inverter Fault Alarms ({n})", { n: plantAnomalies.length })}
          subtitle={t("Real-time string mismatch & underperformance alarms on {name}", { name: selectedPlantOverview?.plant.name || "" })}
          bodyClassName="p-0"
        >
          <Table containerClassName="scroll-x-hint max-h-72 overflow-auto">
              <TableHeader>
                <TableRow>
                  <TableHead>{t("Severity")}</TableHead>
                  <TableHead>{t("String ID")}</TableHead>
                  <TableHead>{t("Inverter SN")}</TableHead>
                  <TableHead>{t("Category")}</TableHead>
                  <TableHead className="text-right">{t("PR (%)")}</TableHead>
                  <TableHead className="text-right">{t("Est. Loss (kWh)")}</TableHead>
                  <TableHead>{t("Diagnosis & Recommended Action")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {plantAnomalies.slice(0, 20).map((a, idx) => (
                  <TableRow
                    key={idx}
                    onClick={() => setInspectedStringId(a.string_id)}
                    className="cursor-pointer hover:bg-white/[0.03]"
                  >
                    <TableCell>
                      <StatusBadge
                        status={a.severity}
                        level={a.severity === "Critical" ? "crit" : "warn"}
                        dot
                      />
                    </TableCell>
                    <TableCell className="num whitespace-nowrap font-bold text-white hover:text-sky-300">{a.string_id}</TableCell>
                    <TableCell className="num whitespace-nowrap text-xs text-slate-300">{a.device_sn}</TableCell>
                    <TableCell className="text-xs text-slate-300">{a.category}</TableCell>
                    <TableCell className="num whitespace-nowrap text-right font-semibold text-solar-300">
                      {fmt(a.pr_pct, 1)}%
                    </TableCell>
                    <TableCell className="num whitespace-nowrap text-right text-red-300">{fmt(a.energy_loss_kwh, 2)}</TableCell>
                    <TableCell className="text-xs text-slate-400">
                      <span className="text-slate-200">{a.description}</span> —{" "}
                      <span>{a.recommended_action}</span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
          </Table>
        </Panel>
      )}

      {/* PM & CM Side-by-Side */}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        {/* PM Schedule */}
        <Panel
          icon={CalendarCheck2}
          title={t("Preventive Maintenance (PM) Optimization Schedule")}
          subtitle={t("Across PV Modules, Combiners, Inverters, Transformers & Switchgear")}
          actions={
            <Button onClick={() => setShowPmForm(!showPmForm)} variant="default" size="sm">
              <Plus className="h-3.5 w-3.5" />
              {t("Add PM Task")}
            </Button>
          }
          bodyClassName="panel-pad space-y-3"
        >
          {showPmForm && (
            <form onSubmit={handleAddPmTask} className="callout space-y-3 text-xs">
              <div className="grid grid-cols-3 gap-2">
                <Input
                  value={newPmId}
                  onChange={(e) => setNewPmId(e.target.value)}
                  placeholder={t("PM ID")}
                  className="h-7 px-2 text-[11px]"
                  required
                />
                <Input
                  value={newPmCat}
                  onChange={(e) => setNewPmCat(e.target.value)}
                  placeholder={t("Asset Category")}
                  className="h-7 px-2 text-[11px]"
                  required
                />
                <Select value={newPmFreq} onValueChange={(v) => setNewPmFreq(v)}>
                  <SelectTrigger size="sm" className="w-full text-[11px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Monthly">{t("Monthly")}</SelectItem>
                    <SelectItem value="Quarterly">{t("Quarterly")}</SelectItem>
                    <SelectItem value="Semi-Annual">{t("Semi-Annual")}</SelectItem>
                    <SelectItem value="Annual">{t("Annual")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Input
                  value={newPmDesc}
                  onChange={(e) => setNewPmDesc(e.target.value)}
                  placeholder={t("Task Description")}
                  className="h-7 px-2 text-[11px]"
                  required
                />
                <Input
                  value={newPmSub}
                  onChange={(e) => setNewPmSub(e.target.value)}
                  placeholder={t("Subcontractor")}
                  className="h-7 px-2 text-[11px]"
                  required
                />
              </div>
              <Button type="submit" variant="default" size="sm">
                {t("Save PM Task")}
              </Button>
            </form>
          )}

          <Table containerClassName="table-wrap">
              <TableHeader>
                <TableRow>
                  <TableHead>{t("PM ID")}</TableHead>
                  <TableHead>{t("Asset & Task")}</TableHead>
                  <TableHead>{t("Freq")}</TableHead>
                  <TableHead>{t("Next Due")}</TableHead>
                  <TableHead>{t("Subcontractor")}</TableHead>
                  <TableHead>{t("Status")}</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {pmTasks.map((x) => (
                  <TableRow key={x.id}>
                    <TableCell className="num whitespace-nowrap font-semibold text-solar-400">{x.pm_id}</TableCell>
                    <TableCell>
                      <div className="font-semibold text-slate-100">{x.asset_category}</div>
                      <div className="text-[11px] text-slate-500">{x.task_description}</div>
                    </TableCell>
                    <TableCell>{x.frequency}</TableCell>
                    <TableCell className="num whitespace-nowrap text-[11px]">{x.next_due}</TableCell>
                    <TableCell className="text-[11px] text-slate-400">{x.assigned_subcontractor}</TableCell>
                    <TableCell>
                      <Select value={x.compliance_status} onValueChange={(v) => handlePmStatusChange(x, v)}>
                        <SelectTrigger size="sm" className="w-32 text-[11px]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="Due Soon">{t("Due Soon")}</SelectItem>
                          <SelectItem value="Scheduled">{t("Scheduled")}</SelectItem>
                          <SelectItem value="Completed">{t("Completed")}</SelectItem>
                          <SelectItem value="Overdue">{t("Overdue")}</SelectItem>
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell className="text-right">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => handleDeletePm(x.id)}
                            className="text-slate-500 hover:text-red-400"
                            aria-label={t("Delete PM Task")}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{t("Delete PM Task")}</TooltipContent>
                      </Tooltip>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
          </Table>
        </Panel>

        {/* CM Work Orders */}
        <Panel
          icon={Wrench}
          title={t("Corrective Maintenance (CM) & Troubleshooting Work Orders")}
          subtitle={t("Auto-generated from string fault diagnostics + active Inverter / Switchgear alarms")}
          actions={
            <Button onClick={handleRegenerateCm} size="sm" disabled={cmSyncing}>
              {cmSyncing ? <Spinner data-icon="inline-start" className="size-3" /> : <RefreshCw data-icon="inline-start" className="size-3.5" />}
              {t("Sync from Analysis")}
            </Button>
          }
        >
          <Table containerClassName="table-wrap">
              <TableHeader>
                <TableRow>
                  <TableHead>{t("WO #")}</TableHead>
                  <TableHead>{t("Asset & Symptom")}</TableHead>
                  <TableHead>{t("Priority")}</TableHead>
                  <TableHead>{t("Troubleshooting Steps")}</TableHead>
                  <TableHead>{t("Status")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {cmOrders.map((wo) => (
                  <TableRow key={wo.id}>
                    <TableCell className="num whitespace-nowrap font-semibold text-solar-400">{wo.wo_number}</TableCell>
                    <TableCell>
                      <div className="font-semibold text-slate-100">{wo.asset_id}</div>
                      <div className="text-[11px] text-red-300">{wo.fault_symptom}</div>
                    </TableCell>
                    <TableCell>
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
                    </TableCell>
                    <TableCell className="max-w-xs text-[11px] text-slate-400">
                      {wo.troubleshooting_checklist}
                    </TableCell>
                    <TableCell>
                      <Select value={wo.status} onValueChange={(v) => handleCmStatusChange(wo, v)}>
                        <SelectTrigger size="sm" className="w-40 text-[11px]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="Open - Dispatched">{t("Open - Dispatched")}</SelectItem>
                          <SelectItem value="In Progress">{t("In Progress")}</SelectItem>
                          <SelectItem value="Scheduled">{t("Scheduled")}</SelectItem>
                          <SelectItem value="Closed - Verified">{t("Closed - Verified")}</SelectItem>
                        </SelectContent>
                      </Select>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
          </Table>
        </Panel>
      </div>

      {/* Root Cause Analysis (RCA) Register */}
      <Panel
        icon={GitFork}
        title={t("Root Cause Analysis (RCA) — Inverters, Transformers, Switchgear & PV Strings")}
        subtitle={t("Structured 5-Why & Fishbone (Ishikawa) Root Cause Analysis with Corrective & Preventive Actions (CAPA)")}
        actions={
          <Button onClick={() => setShowRcaForm(!showRcaForm)} variant="default" size="sm">
            <Plus className="h-3.5 w-3.5" />
            {showRcaForm ? t("Close RCA Form") : t("Log New Equipment Failure RCA")}
          </Button>
        }
        bodyClassName="panel-pad space-y-4"
      >
        {showRcaForm && (
          <form onSubmit={handleCreateRca} className="callout space-y-3 text-xs">
            <h5 className="font-bold text-slate-100">{t("Log New 5-Why & Fishbone RCA Record")}</h5>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
              <div>
                <Label className="mb-1 block text-[11px] font-medium text-slate-400">{t("Equipment Category")}</Label>
                <Select value={eqCat} onValueChange={(v) => setEqCat(v)}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Inverter">{t("Inverter")}</SelectItem>
                    <SelectItem value="Transformer">{t("Transformer")}</SelectItem>
                    <SelectItem value="Switchgear">{t("Switchgear")}</SelectItem>
                    <SelectItem value="PV String / DC Combiner">{t("PV String / DC Combiner")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="mb-1 block text-[11px] font-medium text-slate-400">{t("Asset ID")}</Label>
                <Input
                  value={assetId}
                  onChange={(e) => setAssetId(e.target.value)}
                  required
                />
              </div>
              <div>
                <Label className="mb-1 block text-[11px] font-medium text-slate-400">{t("Downtime (Hours)")}</Label>
                <Input
                  type="number"
                  step="0.5"
                  value={downtime}
                  onChange={(e) => setDowntime(Number(e.target.value))}
                  className="num"
                />
              </div>
              <div>
                <Label className="mb-1 block text-[11px] font-medium text-slate-400">{t("Energy Loss (kWh)")}</Label>
                <Input
                  type="number"
                  step="10"
                  value={lossKwh}
                  onChange={(e) => setLossKwh(Number(e.target.value))}
                  className="num"
                />
              </div>
            </div>

            <div>
              <Label className="mb-1 block text-[11px] font-medium text-slate-400">{t("Failure Mode / Alarm Description")}</Label>
              <Input
                value={failureMode}
                onChange={(e) => setFailureMode(e.target.value)}
                required
              />
            </div>

            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div>
                <Label className="mb-1 block text-[11px] font-medium text-slate-400">{t("Why 1 (Immediate Symptom)")}</Label>
                <Input value={why1} onChange={(e) => setWhy1(e.target.value)} />
              </div>
              <div>
                <Label className="mb-1 block text-[11px] font-medium text-slate-400">{t("Why 2 (Direct Cause)")}</Label>
                <Input value={why2} onChange={(e) => setWhy2(e.target.value)} />
              </div>
              <div>
                <Label className="mb-1 block text-[11px] font-medium text-slate-400">{t("Why 3 (Contributing Factor)")}</Label>
                <Input value={why3} onChange={(e) => setWhy3(e.target.value)} />
              </div>
              <div>
                <Label className="mb-1 block text-[11px] font-medium text-slate-400">{t("Why 4 (Process Gap)")}</Label>
                <Input value={why4} onChange={(e) => setWhy4(e.target.value)} />
              </div>
              <div>
                <Label className="mb-1 block text-[11px] font-medium text-slate-400">{t("Why 5 (Root Cause)")}</Label>
                <Input value={why5} onChange={(e) => setWhy5(e.target.value)} />
              </div>
              <div>
                <Label className="mb-1 block text-[11px] font-medium text-slate-400">{t("Fishbone Category")}</Label>
                <Select value={fishbone} onValueChange={(v) => setFishbone(v)}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Machine / Maintenance PM">{t("Machine / Maintenance PM")}</SelectItem>
                    <SelectItem value="Material / Workmanship">{t("Material / Workmanship")}</SelectItem>
                    <SelectItem value="Method / Subcontractor QA">{t("Method / Subcontractor QA")}</SelectItem>
                    <SelectItem value="Engineering / Protection Coordination">{t("Engineering / Protection Coordination")}</SelectItem>
                    <SelectItem value="Environment">{t("Environment")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div>
                <Label className="mb-1 block text-[11px] font-medium text-slate-400">{t("Corrective Action (Immediate Fix)")}</Label>
                <Input value={capaC} onChange={(e) => setCapaC(e.target.value)} />
              </div>
              <div>
                <Label className="mb-1 block text-[11px] font-medium text-slate-400">{t("Preventive Action (Long-Term Recurrence Prevention)")}</Label>
                <Input value={capaP} onChange={(e) => setCapaP(e.target.value)} />
              </div>
            </div>

            <Button type="submit" variant="default">
              <CheckCircle2 className="h-3.5 w-3.5" />
              {t("Save RCA Record to Register")}
            </Button>
          </form>
        )}

        <Table containerClassName="table-wrap">
            <TableHeader>
              <TableRow>
                <TableHead>{t("RCA ID")}</TableHead>
                <TableHead>{t("Category & Asset")}</TableHead>
                <TableHead>{t("Failure Mode")}</TableHead>
                <TableHead>{t("Loss")}</TableHead>
                <TableHead>{t("Why 5 Root Cause & Fishbone")}</TableHead>
                <TableHead>{t("CAPA (Corrective & Preventive)")}</TableHead>
                <TableHead>{t("Status")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rcaRecords.map((rec) => (
                <TableRow key={rec.id}>
                  <TableCell className="num whitespace-nowrap">
                    <div className="font-bold text-solar-400">{rec.rca_id}</div>
                    <div className="text-[11px] text-slate-500">{rec.incident_date}</div>
                  </TableCell>
                  <TableCell>
                    <div className="font-semibold text-slate-100">{rec.equipment_category}</div>
                    <div className="num text-[11px] text-slate-500">{rec.asset_id}</div>
                  </TableCell>
                  <TableCell className="max-w-xs text-slate-200">{rec.failure_mode}</TableCell>
                  <TableCell className="num whitespace-nowrap text-[11px]">
                    <div className="text-slate-400">{t("{n} h", { n: rec.downtime_hours })}</div>
                    <div className="font-semibold text-red-400">{rec.energy_loss_kwh} kWh</div>
                  </TableCell>
                  <TableCell className="max-w-xs">
                    <div className="font-semibold text-slate-100">{rec.why_5_root_cause}</div>
                    <Badge variant="info" className="mt-1">{rec.fishbone_category}</Badge>
                  </TableCell>
                  <TableCell className="max-w-xs text-[11px]">
                    <div>
                      <strong className="text-solar-400">C:</strong> {rec.capa_corrective_action}
                    </div>
                    <div className="mt-0.5">
                      <strong className="text-energy-400">P:</strong> {rec.capa_preventive_action}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Select value={rec.rca_status} onValueChange={(v) => handleRcaStatusChange(rec, v)}>
                      <SelectTrigger size="sm" className="w-44 text-[11px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="Open - CAPA Assigned">{t("Open - CAPA Assigned")}</SelectItem>
                        <SelectItem value="CAPA In Implementation">{t("CAPA In Implementation")}</SelectItem>
                        <SelectItem value="Closed - Verified">{t("Closed - Verified")}</SelectItem>
                      </SelectContent>
                    </Select>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
        </Table>
      </Panel>
    </div>
  );
};
