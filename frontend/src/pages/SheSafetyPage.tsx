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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

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
          <Button onClick={() => setShowAddForm(!showAddForm)} variant="default" size="sm">
            <Plus className="h-3.5 w-3.5" />
            Issue New PTW
          </Button>
        }
        bodyClassName="panel-pad space-y-4"
      >
        {showAddForm && (
          <form onSubmit={handleCreatePtw} className="callout space-y-3 text-xs">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              <Input
                value={ptwNum}
                onChange={(e) => setPtwNum(e.target.value)}
                placeholder="PTW Number"
                required
              />
              <Input
                value={highRisk}
                onChange={(e) => setHighRisk(e.target.value)}
                placeholder="High Risk Permit Type"
                required
              />
              <Input
                value={padlockId}
                onChange={(e) => setPadlockId(e.target.value)}
                placeholder="LOTO Padlock ID"
                required
              />
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              <Input
                value={activity}
                onChange={(e) => setActivity(e.target.value)}
                placeholder="Work Activity"
                required
              />
              <Input
                value={ppe}
                onChange={(e) => setPpe(e.target.value)}
                placeholder="Arc Flash / Fall Protection PPE"
                required
              />
              <Input
                value={supervisor}
                onChange={(e) => setSupervisor(e.target.value)}
                placeholder="Safety Supervisor"
                required
              />
            </div>
            <Button type="submit" variant="default" size="sm">
              Approve & Register PTW
            </Button>
          </form>
        )}

        <Table containerClassName="table-wrap">
          <TableHeader>
            <TableRow>
              <TableHead>PTW #</TableHead>
              <TableHead>Issue Date</TableHead>
              <TableHead>Work Activity & High-Risk Permits</TableHead>
              <TableHead>LOTO Padlock ID</TableHead>
              <TableHead>Mandatory PPE & Heat Check</TableHead>
              <TableHead>Supervisor</TableHead>
              <TableHead>Status</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {permits.map((p) => (
              <TableRow key={p.id}>
                <TableCell className="num whitespace-nowrap font-bold text-solar-400">{p.ptw_number}</TableCell>
                <TableCell className="num whitespace-nowrap text-[11px]">{p.issue_date}</TableCell>
                <TableCell>
                  <div className="font-semibold text-slate-100">{p.work_activity}</div>
                  <div className="text-[11px] font-medium text-amber-300">{p.high_risk_permits}</div>
                </TableCell>
                <TableCell className="num whitespace-nowrap font-semibold text-energy-300">{p.loto_padlock_id}</TableCell>
                <TableCell className="max-w-xs text-[11px]">
                  <div className="text-slate-200">{p.arc_flash_ppe}</div>
                  <div className="text-slate-500">{p.gas_heat_index_check}</div>
                </TableCell>
                <TableCell>{p.safety_supervisor}</TableCell>
                <TableCell>
                  <Select value={p.status} onValueChange={(v) => handleStatusChange(p, v)}>
                    <SelectTrigger size="sm" className="w-48 text-[11px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Active - Approved">Active - Approved</SelectItem>
                      <SelectItem value="Pending Night Outage Window">Pending Night Outage Window</SelectItem>
                      <SelectItem value="Closed - Safe Completion">Closed - Safe Completion</SelectItem>
                    </SelectContent>
                  </Select>
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => handleDeletePtw(p.id)}
                    className="text-slate-500 hover:text-red-400"
                    aria-label="Delete permit"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Panel>

      {/* Site SH&E Mandatory Compliance Matrix */}
      <Panel
        icon={ShieldCheck}
        title="Site SH&E Mandatory Compliance Matrix (ISO 45001 / ISO 14001 / NFPA 70E)"
        subtitle="Audit verification across electrical isolation, rooftop fall protection, and environmental controls"
      >
        <Table containerClassName="table-wrap">
          <TableHeader>
            <TableRow>
              <TableHead>Code</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>Mandatory Safety Requirement</TableHead>
              <TableHead>Field Verification</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {checklist.map((c, idx) => (
              <TableRow key={idx}>
                <TableCell className="num whitespace-nowrap font-bold text-solar-400">{c["SH&E_Code"]}</TableCell>
                <TableCell className="font-semibold text-slate-100">{c.Category}</TableCell>
                <TableCell className="text-slate-300">{c.Requirement}</TableCell>
                <TableCell className="text-slate-400">{c.Verification}</TableCell>
                <TableCell>
                  <StatusBadge status={c.Status} level="ok" />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Panel>
    </div>
  );
};
