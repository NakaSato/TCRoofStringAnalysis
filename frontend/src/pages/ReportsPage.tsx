import React from "react";
import { FileText, FileSpreadsheet, Globe, Table, Eye, ExternalLink } from "lucide-react";
import { useAppContext } from "../context/AppContext";
import { api } from "../api/client";
import { PageHeader, Panel, LoadingState } from "../components/ui";

export const ReportsPage: React.FC = () => {
  const { analysisRun } = useAppContext();

  if (!analysisRun) {
    return <LoadingState label="Loading report compilation context…" />;
  }

  const pdfUrl = api.getReportUrl(analysisRun.id, "pdf");
  const xlsxUrl = api.getReportUrl(analysisRun.id, "xlsx");
  const htmlUrl = api.getReportUrl(analysisRun.id, "html");
  const csvUrl = api.getReportUrl(analysisRun.id, "csv");

  const exports = [
    {
      href: pdfUrl,
      download: true,
      icon: FileText,
      title: "Download Management PDF (.pdf)",
      sub: "Landscape A4 Multi-Page Executive Report",
      tone: "border-solar-400/30 bg-solar-500/10 hover:bg-solar-500/15 text-solar-300",
      iconCls: "bg-solar-500/20 text-solar-400",
    },
    {
      href: xlsxUrl,
      download: true,
      icon: FileSpreadsheet,
      title: "Download 11-Sheet Excel (.xlsx)",
      sub: "Full Engineering & O&M Workbook",
      tone: "border-emerald-400/25 bg-emerald-500/[0.07] hover:bg-emerald-500/15 text-emerald-300",
      iconCls: "bg-emerald-500/15 text-emerald-400",
    },
    {
      href: htmlUrl,
      download: false,
      icon: Globe,
      title: "Open Printable HTML (.html)",
      sub: "Browser-Ready Executive Summary Brief",
      tone: "border-energy-400/25 bg-energy-500/[0.07] hover:bg-energy-500/15 text-energy-300",
      iconCls: "bg-energy-500/15 text-energy-400",
    },
    {
      href: csvUrl,
      download: true,
      icon: Table,
      title: "Download String Summary (.csv)",
      sub: "String KPIs, PR & Fault Classifications",
      tone: "border-sky-400/25 bg-sky-500/[0.07] hover:bg-sky-500/15 text-sky-300",
      iconCls: "bg-sky-500/15 text-sky-400",
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        icon={FileSpreadsheet}
        eyebrow="Data & Reports · Management Exports"
        title="Engineering & O&M Performance Reports"
        description="Compile and export executive and technical O&M packages covering Daily/Monthly PR trends, String Diagnostics, PM/CM Work Orders, Equipment Failure RCAs, Subcontractor QA/QC, Commissioning/PQ, and SH&E compliance."
      />

      {/* 4 One-Click Export Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {exports.map((item) => {
          const Icon = item.icon;
          return (
            <a
              key={item.title}
              href={item.href}
              {...(item.download ? { download: true } : { target: "_blank", rel: "noreferrer" })}
              className={`panel flex items-center gap-3.5 border p-4 transition ${item.tone}`}
            >
              <div className={`rounded-xl p-2.5 ${item.iconCls}`}>
                <Icon className="h-5 w-5 shrink-0" />
              </div>
              <div className="min-w-0">
                <div className="truncate text-xs font-bold text-slate-100">{item.title}</div>
                <div className="mt-0.5 truncate text-[11px] text-slate-400">{item.sub}</div>
              </div>
            </a>
          );
        })}
      </div>

      {/* Embedded Live HTML Report Preview */}
      <Panel
        icon={Eye}
        title="Live Preview: Printable Management & Engineering O&M Summary"
        subtitle={`Analysis Run #${analysisRun.id}`}
        actions={
          <a href={htmlUrl} target="_blank" rel="noreferrer" className="btn btn-sm">
            <ExternalLink className="h-3.5 w-3.5" />
            Open in New Tab
          </a>
        }
      >
        <iframe
          src={htmlUrl}
          title="Solar O&M Management Report Preview"
          className="h-[760px] w-full rounded-lg border border-white/10 bg-white"
        />
      </Panel>
    </div>
  );
};
