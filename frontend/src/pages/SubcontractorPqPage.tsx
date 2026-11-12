import React, { useEffect, useState } from "react";
import { ClipboardCheck, Users, CheckSquare, Zap } from "lucide-react";
import { useAppContext } from "../context/AppContext";
import { api, PQTestResult, SubcontractorAudit } from "../api/client";
import { PageHeader, Panel, StatusBadge } from "../components/ui";
import { SelectedPlantBanner } from "../components/SelectedPlantBanner";

export const SubcontractorPqPage: React.FC = () => {
  const { activePlant } = useAppContext();
  const [subcontractors, setSubcontractors] = useState<SubcontractorAudit[]>([]);
  const [qaqcList, setQaqcList] = useState<Record<string, any>[]>([]);
  const [pqResult, setPqResult] = useState<PQTestResult | null>(null);

  // Power Quality Analyzer Inputs
  const [thdv, setThdv] = useState<number>(2.1);
  const [thdi, setThdi] = useState<number>(3.4);
  const [pf, setPf] = useState<number>(0.992);
  const [unbal, setUnbal] = useState<number>(0.85);
  const [plt, setPlt] = useState<number>(0.42);
  const [riso, setRiso] = useState<number>(42.5);

  const loadData = async () => {
    const pid = activePlant?.id || 1;
    const [subs, qaqc, pq] = await Promise.all([
      api.listSubcontractors(pid),
      api.getQaqcChecklist(),
      api.getLatestPqTest(pid),
    ]);
    setSubcontractors(subs);
    setQaqcList(qaqc);
    setPqResult(pq);
    if (pq) {
      setThdv(pq.voltage_thd_pct);
      setThdi(pq.current_thd_pct);
      setPf(pq.power_factor);
      setUnbal(pq.voltage_unbalance_pct);
      setPlt(pq.flicker_plt);
      setRiso(pq.min_riso_mohm);
    }
  };

  useEffect(() => {
    loadData();
  }, [activePlant]);

  const handleEvaluatePq = async (
    nextParams?: Partial<{
      thdv: number;
      thdi: number;
      pf: number;
      unbal: number;
      plt: number;
      riso: number;
    }>
  ) => {
    const res = await api.evaluatePqTest({
      plant_id: activePlant?.id || 1,
      voltage_thd_pct: nextParams?.thdv ?? thdv,
      current_thd_pct: nextParams?.thdi ?? thdi,
      power_factor: nextParams?.pf ?? pf,
      voltage_unbalance_pct: nextParams?.unbal ?? unbal,
      flicker_plt: nextParams?.plt ?? plt,
      grid_frequency_hz: 50.02,
      dc_injection_pct: 0.18,
      min_riso_mohm: nextParams?.riso ?? riso,
    });
    setPqResult(res);
  };

  const handleRatingChange = async (sub: SubcontractorAudit, overall_rating: string) => {
    try {
      const updated = await api.updateSubcontractor(sub.id, { ...sub, overall_rating });
      setSubcontractors(subcontractors.map((s) => (s.id === sub.id ? updated : s)));
    } catch (err: any) {
      alert(err.message);
    }
  };

  return (
    <div className="space-y-6">
      <SelectedPlantBanner />

      {/* Subcontractor Scorecard */}
      <Panel
        icon={Users}
        title="Subcontractor Supervision & Work Quality Scorecard"
        subtitle="Evaluate subcontractor workmanship, adherence to IEC engineering standards, tool calibration, and SLA compliance"
      >
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Subcontractor & Scope</th>
                <th className="text-right">Active WOs</th>
                <th className="text-right">Workmanship</th>
                <th className="text-right">Eng. Std</th>
                <th className="text-right">SH&E</th>
                <th className="text-right">SLA</th>
                <th className="text-right">NCRs</th>
                <th>Torque & Calibration</th>
                <th>Overall Rating</th>
              </tr>
            </thead>
            <tbody>
              {subcontractors.map((sub) => (
                <tr key={sub.id}>
                  <td className="num font-bold text-solar-400">{sub.contractor_id}</td>
                  <td>
                    <div className="font-semibold text-slate-100">{sub.subcontractor_name}</div>
                    <div className="text-[11px] text-slate-500">{sub.scope_of_work}</div>
                  </td>
                  <td className="num text-right">{sub.active_work_orders}</td>
                  <td className="num text-right font-semibold text-slate-100">{sub.workmanship_score_pct.toFixed(1)}%</td>
                  <td className="num text-right">{sub.engineering_std_compliance_pct.toFixed(1)}%</td>
                  <td className="num text-right font-semibold text-emerald-400">
                    {sub.safety_she_compliance_pct.toFixed(1)}%
                  </td>
                  <td className="num text-right">{sub.on_time_sla_pct.toFixed(1)}%</td>
                  <td className="num text-right">{sub.open_ncrs}</td>
                  <td className="text-[11px]">
                    <div className="text-slate-200">
                      <strong className="text-slate-400">Torque:</strong> {sub.torque_seal_verified}
                    </div>
                    <div className="text-slate-500">{sub.calibrated_tools_cert}</div>
                  </td>
                  <td>
                    <select
                      value={sub.overall_rating}
                      onChange={(e) => handleRatingChange(sub, e.target.value)}
                      className="select input-sm w-48"
                    >
                      <option>Approved - Grade A</option>
                      <option>Approved - Grade B</option>
                      <option>Conditional - Audit Required</option>
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      {/* QA/QC Engineering Checklist */}
      <Panel
        icon={CheckSquare}
        title="Engineering QA/QC Field Inspection Checklist"
        subtitle="Verification against IEC 62446-1, IEC 60364-7-712, and OEM torque specifications"
      >
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Item Code</th>
                <th>Engineering Standard</th>
                <th>Inspection Parameter</th>
                <th>Acceptance Criteria</th>
                <th>Measured Result</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {qaqcList.map((item, i) => (
                <tr key={i}>
                  <td className="num font-semibold text-solar-400">{item.Item_Code}</td>
                  <td className="font-medium text-energy-300">{item.Engineering_Standard}</td>
                  <td className="font-semibold text-slate-100">{item.Inspection_Parameter}</td>
                  <td className="text-slate-400">{item.Acceptance_Criteria}</td>
                  <td className="num">{item.Measured_Result}</td>
                  <td>
                    <StatusBadge status={item.Status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      {/* Interactive Power Quality & Commissioning Analyzer */}
      <Panel
        icon={Zap}
        title="Power Quality Testing (IEEE 519 / PEA-MEA Grid Code) & IEC 62446-1 Commissioning"
        subtitle="Adjust analyzer measurements at Point of Common Coupling (PCC) to evaluate grid code compliance in real time"
        actions={
          pqResult && (
            <StatusBadge
              status={
                pqResult.overall_compliant
                  ? "All Grid Code Limits Compliant"
                  : "Non-Compliant Parameter Detected"
              }
              level={pqResult.overall_compliant ? "ok" : "crit"}
            />
          )
        }
        bodyClassName="panel-pad space-y-5"
      >
        <div className="callout grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <div>
            <label className="label">Voltage THDv (%)</label>
            <input
              type="number"
              step="0.1"
              value={thdv}
              onChange={(e) => {
                const v = Number(e.target.value);
                setThdv(v);
                handleEvaluatePq({ thdv: v });
              }}
              className="input num"
            />
          </div>
          <div>
            <label className="label">Current THDi (%)</label>
            <input
              type="number"
              step="0.1"
              value={thdi}
              onChange={(e) => {
                const v = Number(e.target.value);
                setThdi(v);
                handleEvaluatePq({ thdi: v });
              }}
              className="input num"
            />
          </div>
          <div>
            <label className="label">Power Factor (PF)</label>
            <input
              type="number"
              step="0.005"
              value={pf}
              onChange={(e) => {
                const v = Number(e.target.value);
                setPf(v);
                handleEvaluatePq({ pf: v });
              }}
              className="input num"
            />
          </div>
          <div>
            <label className="label">Voltage Unbalance (%)</label>
            <input
              type="number"
              step="0.05"
              value={unbal}
              onChange={(e) => {
                const v = Number(e.target.value);
                setUnbal(v);
                handleEvaluatePq({ unbal: v });
              }}
              className="input num"
            />
          </div>
          <div>
            <label className="label">Flicker Plt</label>
            <input
              type="number"
              step="0.05"
              value={plt}
              onChange={(e) => {
                const v = Number(e.target.value);
                setPlt(v);
                handleEvaluatePq({ plt: v });
              }}
              className="input num"
            />
          </div>
          <div>
            <label className="label">Min String Riso (MΩ)</label>
            <input
              type="number"
              step="1"
              value={riso}
              onChange={(e) => {
                const v = Number(e.target.value);
                setRiso(v);
                handleEvaluatePq({ riso: v });
              }}
              className="input num"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <div>
            <h5 className="mb-2 text-xs font-bold text-slate-200">
              Power Quality Analyzer Results at PCC (IEEE 519 / Grid Code)
            </h5>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Parameter</th>
                    <th>Standard</th>
                    <th>Limit</th>
                    <th className="text-right">Measured</th>
                    <th>Compliant</th>
                  </tr>
                </thead>
                <tbody>
                  {(pqResult?.pq_results_json || []).map((row, idx) => (
                    <tr key={idx}>
                      <td className="font-medium text-slate-100">{row.Parameter}</td>
                      <td className="text-[11px] text-slate-500">{row.Standard_Code}</td>
                      <td className="num text-[11px] text-slate-400">{row.Grid_Limit}</td>
                      <td className="num text-right font-bold text-slate-100">{row.Measured_Value}</td>
                      <td>
                        <StatusBadge status={row.Compliant} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div>
            <h5 className="mb-2 text-xs font-bold text-slate-200">
              IEC 62446-1 Commissioning & Protection Verification
            </h5>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Test ID</th>
                    <th>Description</th>
                    <th>Criteria</th>
                    <th>Measured</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {(pqResult?.commissioning_results_json || []).map((row, idx) => (
                    <tr key={idx}>
                      <td className="num font-bold text-solar-400">{row.Test_ID}</td>
                      <td>
                        <div className="font-medium text-slate-100">{row.Test_Description}</div>
                        <div className="text-[10px] text-slate-500">{row.Category}</div>
                      </td>
                      <td className="text-[11px] text-slate-400">{row.Acceptance_Criteria}</td>
                      <td className="num text-[11px] text-slate-200">{row.Measured_Result}</td>
                      <td>
                        <StatusBadge status={row.Status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </Panel>
    </div>
  );
};
