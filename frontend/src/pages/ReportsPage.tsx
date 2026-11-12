import React, { useEffect, useState } from "react";
import { FileText, FileSpreadsheet, Globe, Table, Eye, ExternalLink, Loader2 } from "lucide-react";
import { useAppContext } from "../context/AppContext";
import { api, downloadApiFile, fetchFileBlob, openApiFileInTab } from "../api/client";
import { PageHeader, Panel, LoadingState } from "../components/ui";

type Format = "pdf" | "xlsx" | "html" | "csv";

export const ReportsPage: React.FC = () => {
  const { analysisRun } = useAppContext();
  const [busy, setBusy] = useState<Format | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  // Reports need the session token, so the preview is fetched as a blob (an iframe src cannot send it).
  const runId = analysisRun?.id;
  useEffect(() => {
    if (runId == null) return;
    let url: string | null = null;
    let cancelled = false;
    setPreviewUrl(null);
    fetchFileBlob(api.reportPath(runId, "html"))
      .then(({ blob }) => {
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setPreviewUrl(url);
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [runId]);

  if (!analysisRun) {
    return <LoadingState label="Loading report compilation context…" />;
  }

  const run = analysisRun.id;
  const handle = async (format: Format) => {
    setBusy(format);
    setError(null);
    try {
      if (format === "html") await openApiFileInTab(api.reportPath(run, "html"));
      else await downloadApiFile(api.reportPath(run, format), `analysis_${run}_report.${format}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const exports: Array<{ format: Format; icon: typeof FileText; title: string; sub: string; tone: string; iconCls: string }> = [
    {
      format: "pdf",
      icon: FileText,
      title: "Download Management PDF (.pdf)",
      sub: "Landscape A4 Multi-Page Executive Report",
      tone: "border-solar-400/30 bg-solar-500/10 hover:bg-solar-500/15 text-solar-300",
      iconCls: "bg-solar-500/20 text-solar-400",
    },
    {
      format: "xlsx",
      icon: FileSpreadsheet,
      title: "Download 11-Sheet Excel (.xlsx)",
      sub: "Full Engineering & O&M Workbook",
      tone: "border-emerald-400/25 bg-emerald-500/[0.07] hover:bg-emerald-500/15 text-emerald-300",
      iconCls: "bg-emerald-500/15 text-emerald-400",
    },
    {
      format: "html",
      icon: Globe,
      title: "Open Printable HTML (.html)",
      sub: "Browser-Ready Executive Summary Brief",
      tone: "border-energy-400/25 bg-energy-500/[0.07] hover:bg-energy-500/15 text-energy-300",
      iconCls: "bg-energy-500/15 text-energy-400",
    },
    {
      format: "csv",
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

      {error && <p className="callout-crit">Could not load the report: {error}</p>}

      {/* 4 One-Click Export Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {exports.map((item) => {
          const Icon = busy === item.format ? Loader2 : item.icon;
          return (
            <button
              key={item.title}
              type="button"
              onClick={() => handle(item.format)}
              disabled={busy !== null}
              className={`panel flex items-center gap-3.5 border p-4 text-left transition disabled:cursor-wait ${item.tone}`}
            >
              <div className={`rounded-xl p-2.5 ${item.iconCls}`}>
                <Icon className={`h-5 w-5 shrink-0 ${busy === item.format ? "animate-spin" : ""}`} />
              </div>
              <div className="min-w-0">
                <div className="truncate text-xs font-bold text-slate-100">{item.title}</div>
                <div className="mt-0.5 truncate text-[11px] text-slate-400">{item.sub}</div>
              </div>
            </button>
          );
        })}
      </div>

      {/* Embedded Live HTML Report Preview */}
      <Panel
        icon={Eye}
        title="Live Preview: Printable Management & Engineering O&M Summary"
        subtitle={`Analysis Run #${analysisRun.id}`}
        actions={
          <button type="button" onClick={() => handle("html")} className="btn btn-sm" disabled={busy !== null}>
            <ExternalLink className="h-3.5 w-3.5" />
            Open in New Tab
          </button>
        }
      >
        {previewUrl ? (
          <iframe
            src={previewUrl}
            title="Solar O&M Management Report Preview"
            className="h-[760px] w-full rounded-lg border border-white/10 bg-white"
          />
        ) : (
          !error && <LoadingState label="Loading report preview…" />
        )}
      </Panel>
    </div>
  );
};
