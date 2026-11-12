import React, { useEffect, useState } from "react";
import {
  Plus,
  Trash2,
  ShieldAlert,
  Clock,
  Award,
  FileCheck,
  Lock,
  Users,
  CheckCircle2,
  ShieldCheck,
} from "lucide-react";
import { useAppContext } from "../context/AppContext";
import { api, PTWPermit } from "../api/client";
import { PageHeader, Panel, KpiTile, StatusBadge } from "../components/ui";

export const SheSafetyPage: React.FC = () => {
  const { activePlant } = useAppContext();
  const [kpis, setKpis] = useState<Record<string, number>>({});
  const [permits, setPermits] = useState<PTWPermit[]>([]);
  const [checklist, setChecklist] = useState<Record<string, any>[]>([]);
  const [showAddForm, setShowAddForm] = useState<boolean>(false);

  // New PTW form fields
  const [ptwNum, setPtwNum] = useState("PTW-2026-084");
  const [activity, setActivity] = useState("Inverter DC Fuse & Surge Arrester Inspection");
  const [highRisk, setHighRisk] = useState("Electrical Work + LOTO (Lock-Out Tag-Out)");
  const [padlockId, setPadlockId] = useState("LOTO-DC-INV01-01");
  const [ppe, setPpe] = useState("Cat 2 (8 cal/cm² Shield, Class 0 Insulated Gloves 1000V)");
  const [supervisor, setSupervisor] = useState("Somchai K. (Safety Officer)");

  const loadShe = async () => {
    const pid = activePlant?.id || 1;
    const data = await api.getSheDashboard(pid);
    setKpis(data.kpis);
    setPermits(data.ptw_permits);
    setChecklist(data.checklist);
  };

  useEffect(() => {
    loadShe();
  }, [activePlant]);

  const handleStatusChange = async (ptw: PTWPermit, status: string) => {
    try {
      const updated = await api.updatePtwPermit(ptw.id, { ...ptw, status });
      setPermits(permits.map((p) => (p.id === ptw.id ? updated : p)));
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleCreatePtw = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api.createPtwPermit({
        plant_id: activePlant?.id || 1,
        ptw_number: ptwNum,
        issue_date: new Date().toISOString().slice(0, 10),
        work_activity: activity,
        high_risk_permits: highRisk,
        loto_padlock_id: padlockId,
        arc_flash_ppe: ppe,
        gas_heat_index_check: "WBGT 28.5°C (Hydration Break Every 45m)",
        safety_supervisor: supervisor,
        status: "Active - Approved",
      });
      setShowAddForm(false);
      await loadShe();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleDeletePtw = async (id: number) => {
    try {
      await api.deletePtwPermit(id);
      await loadShe();
    } catch (err: any) {
      alert(err.message);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        icon={ShieldAlert}
        eyebrow="Operations · ISO 45001 · NFPA 70E"
        title="Safety, Health & Environment (SH&E)"
        description="ISO 45001, ISO 14001, and NFPA 70E Electrical LOTO / Rooftop Work-at-Height Safety Governance."
      />

      {/* 6 SH&E KPI Cards */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        <KpiTile
          label="Safe Man-Hours"
          icon={Clock}
          tone="solar"
          value={(kpis.safe_man_hours || 0).toLocaleString()}
          unit="hrs"
          hint="Cumulative Site Total"
          hintTone="ok"
        />
        <KpiTile
          label="Zero-LTI Streak"
          icon={Award}
          tone="ok"
          value={kpis.days_without_lti || 0}
          unit="Days"
          hint="0 Lost Time Injuries"
          hintTone="ok"
        />
        <KpiTile
          label="Permit-to-Work"
          icon={FileCheck}
          tone="energy"
          value={(kpis.ptw_audit_compliance_pct || 100).toFixed(0)}
          unit="%"
          hint="100% Audited"
          hintTone="info"
        />
        <KpiTile
          label="LOTO Isolation"
          icon={Lock}
          tone="ok"
          value={(kpis.loto_compliance_pct || 100).toFixed(0)}
          unit="%"
          hint="Zero Violations"
          hintTone="ok"
        />
        <KpiTile
          label="Toolbox Talks"
          icon={Users}
          tone="neutral"
          value={kpis.toolbox_talks_completed || 0}
          unit="Sessions"
          hint="100% Attendance"
        />
        <KpiTile
          label="Near-Miss Closure"
          icon={CheckCircle2}
          tone="ok"
          value={`${kpis.near_miss_closed || 0} / ${kpis.near_miss_reported || 0}`}
          hint="All Resolved"
          hintTone="ok"
        />
      </div>

      {/* Active PTW & LOTO Register */}
      <Panel
        icon={Lock}
        title="Active Permit-to-Work (PTW), LOTO & High-Risk Activity Register"
        subtitle="Track electrical isolation padlocks, Arc-Flash PPE categories, and WBGT heat stress checks"
        actions={
          <button onClick={() => setShowAddForm(!showAddForm)} className="btn-primary btn-sm">
            <Plus className="h-3.5 w-3.5" />
            Issue New PTW
          </button>
        }
        bodyClassName="panel-pad space-y-4"
      >
        {showAddForm && (
          <form onSubmit={handleCreatePtw} className="callout space-y-3 text-xs">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              <input
                value={ptwNum}
                onChange={(e) => setPtwNum(e.target.value)}
                placeholder="PTW Number"
                className="input"
                required
              />
              <input
                value={highRisk}
                onChange={(e) => setHighRisk(e.target.value)}
                placeholder="High Risk Permit Type"
                className="input"
                required
              />
              <input
                value={padlockId}
                onChange={(e) => setPadlockId(e.target.value)}
                placeholder="LOTO Padlock ID"
                className="input"
                required
              />
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              <input
                value={activity}
                onChange={(e) => setActivity(e.target.value)}
                placeholder="Work Activity"
                className="input"
                required
              />
              <input
                value={ppe}
                onChange={(e) => setPpe(e.target.value)}
                placeholder="Arc Flash / Fall Protection PPE"
                className="input"
                required
              />
              <input
                value={supervisor}
                onChange={(e) => setSupervisor(e.target.value)}
                placeholder="Safety Supervisor"
                className="input"
                required
              />
            </div>
            <button type="submit" className="btn-primary btn-sm">
              Approve & Register PTW
            </button>
          </form>
        )}

        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>PTW #</th>
                <th>Issue Date</th>
                <th>Work Activity & High-Risk Permits</th>
                <th>LOTO Padlock ID</th>
                <th>Mandatory PPE & Heat Check</th>
                <th>Supervisor</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {permits.map((p) => (
                <tr key={p.id}>
                  <td className="num font-bold text-solar-400">{p.ptw_number}</td>
                  <td className="num text-[11px]">{p.issue_date}</td>
                  <td>
                    <div className="font-semibold text-slate-100">{p.work_activity}</div>
                    <div className="text-[11px] font-medium text-amber-300">{p.high_risk_permits}</div>
                  </td>
                  <td className="num font-semibold text-energy-300">{p.loto_padlock_id}</td>
                  <td className="max-w-xs text-[11px]">
                    <div className="text-slate-200">{p.arc_flash_ppe}</div>
                    <div className="text-slate-500">{p.gas_heat_index_check}</div>
                  </td>
                  <td>{p.safety_supervisor}</td>
                  <td>
                    <select
                      value={p.status}
                      onChange={(e) => handleStatusChange(p, e.target.value)}
                      className="select input-sm w-48"
                    >
                      <option>Active - Approved</option>
                      <option>Pending Night Outage Window</option>
                      <option>Closed - Safe Completion</option>
                    </select>
                  </td>
                  <td className="text-right">
                    <button
                      onClick={() => handleDeletePtw(p.id)}
                      className="btn-ghost p-1 text-slate-500 hover:text-red-400"
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

      {/* Site SH&E Mandatory Compliance Matrix */}
      <Panel
        icon={ShieldCheck}
        title="Site SH&E Mandatory Compliance Matrix (ISO 45001 / ISO 14001 / NFPA 70E)"
        subtitle="Audit verification across electrical isolation, rooftop fall protection, and environmental controls"
      >
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Code</th>
                <th>Category</th>
                <th>Mandatory Safety Requirement</th>
                <th>Field Verification</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {checklist.map((c, idx) => (
                <tr key={idx}>
                  <td className="num font-bold text-solar-400">{c["SH&E_Code"]}</td>
                  <td className="font-semibold text-slate-100">{c.Category}</td>
                  <td className="text-slate-300">{c.Requirement}</td>
                  <td className="text-slate-400">{c.Verification}</td>
                  <td>
                    <StatusBadge status={c.Status} level="ok" />
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
