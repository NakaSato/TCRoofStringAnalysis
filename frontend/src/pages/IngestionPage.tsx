import React, { useState } from "react";
import {
  Globe,
  Upload,
  FlaskConical,
  Download,
  CheckCircle2,
  AlertCircle,
  UploadCloud,
  Database,
  Table2,
  Code2,
  Play,
} from "lucide-react";
import { useAppContext } from "../context/AppContext";
import { api, downloadApiFile } from "../api/client";
import { PageHeader, Panel, StatusBadge, fmt } from "../components/ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";

type IngestMode = "api" | "upload" | "simulate";

export const IngestionPage: React.FC = () => {
  const { activePlant, activeDataset, datasets, selectDataset, refreshAll } = useAppContext();
  const [mode, setMode] = useState<IngestMode>("api");
  const [busy, setBusy] = useState<boolean>(false);
  const [statusMsg, setStatusMsg] = useState<{ type: "success" | "error"; text: string } | null>(null);

  // API Connector state
  const [provider, setProvider] = useState<"huawei" | "sungrow" | "generic_rest">("huawei");
  const [baseUrl, setBaseUrl] = useState<string>("https://intl.fusionsolar.huawei.com");
  const [xsrfToken, setXsrfToken] = useState<string>("demo-token-xxxx");
  const [devId, setDevId] = useState<string>("INV-HUAWEI-SUN2000-01");
  const [appKey, setAppKey] = useState<string>("sungrow-app-key");
  const [psKey, setPsKey] = useState<string>("1029384_1_1_1");
  const [httpMethod, setHttpMethod] = useState<string>("GET");
  const [recordsKey, setRecordsKey] = useState<string>("data");
  const [headersJson, setHeadersJson] = useState<string>('{"Authorization": "Bearer YOUR_API_TOKEN"}');
  const [useSandbox, setUseSandbox] = useState<boolean>(true);

  // Simulator state
  const [simDays, setSimDays] = useState<number>(7);
  const [simStrings, setSimStrings] = useState<number>(8);
  const [simInterval, setSimInterval] = useState<number>(15);

  const handleApiFetch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activePlant) return;
    setBusy(true);
    setStatusMsg(null);
    try {
      let parsedHeaders = {};
      if (provider === "generic_rest" && headersJson.trim()) {
        parsedHeaders = JSON.parse(headersJson);
      }
      const ds = await api.fetchDatasetFromApi(activePlant.id, {
        provider,
        base_url: baseUrl,
        xsrf_token: xsrfToken,
        dev_id: devId,
        appkey: appKey,
        token: xsrfToken,
        ps_key: psKey,
        http_method: httpMethod,
        records_key: recordsKey,
        headers: parsedHeaders,
        simulate_if_unreachable: useSandbox,
      });
      await refreshAll();
      setStatusMsg({
        type: "success",
        text: `Loaded ${ds.row_count.toLocaleString()} records across ${ds.string_count} strings from ${ds.source_label}`,
      });
    } catch (err: any) {
      setStatusMsg({ type: "error", text: err.message || "API ingestion failed" });
    } finally {
      setBusy(false);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !activePlant) return;
    setBusy(true);
    setStatusMsg(null);
    try {
      const ds = await api.uploadDataset(activePlant.id, file);
      await refreshAll();
      setStatusMsg({
        type: "success",
        text: `Parsed '${file.name}' — ${ds.row_count.toLocaleString()} records across ${ds.string_count} strings!`,
      });
    } catch (err: any) {
      setStatusMsg({ type: "error", text: err.message || "File upload failed" });
    } finally {
      setBusy(false);
    }
  };

  const handleSimulate = async () => {
    if (!activePlant) return;
    setBusy(true);
    setStatusMsg(null);
    try {
      const ds = await api.simulateDataset(activePlant.id, {
        days: simDays,
        num_strings: simStrings,
        interval_minutes: simInterval,
      });
      await refreshAll();
      setStatusMsg({
        type: "success",
        text: `Generated simulated dataset (#${ds.id}): ${ds.row_count.toLocaleString()} records across ${ds.string_count} strings`,
      });
    } catch (err: any) {
      setStatusMsg({ type: "error", text: err.message || "Simulation failed" });
    } finally {
      setBusy(false);
    }
  };

  const previewRows = activeDataset?.preview_rows || [];

  return (
    <div className="space-y-6">
      <PageHeader
        icon={UploadCloud}
        eyebrow="Data & Reports · SCADA / Inverter Cloud"
        title="Data Ingestion & Telemetry Simulator"
        description="Normalize both Long/Tidy and Wide SCADA formats (PV1_U, PV1_I ... PV24_U, PV24_I) into canonical IEC 61724 telemetry."
        actions={
          <Tabs value={mode} onValueChange={(v) => setMode(v as IngestMode)}>
            <TabsList>
              <TabsTrigger value="api">
                <Globe className="h-3.5 w-3.5" />
                Inverter Cloud / REST API
              </TabsTrigger>
              <TabsTrigger value="upload">
                <Upload className="h-3.5 w-3.5" />
                Upload CSV / Excel
              </TabsTrigger>
              <TabsTrigger value="simulate">
                <FlaskConical className="h-3.5 w-3.5" />
                PV String Simulator
              </TabsTrigger>
            </TabsList>
          </Tabs>
        }
      />

      {statusMsg && (
        <div className={`flex items-center gap-2 ${statusMsg.type === "success" ? "callout-ok" : "callout-crit"}`}>
          {statusMsg.type === "success" ? (
            <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
          ) : (
            <AlertCircle className="h-4 w-4 shrink-0 text-red-400" />
          )}
          <span>{statusMsg.text}</span>
        </div>
      )}

      {/* Mode 1: API Connector */}
      {mode === "api" && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
          <Panel
            className="lg:col-span-7"
            icon={Globe}
            title="Inverter Cloud / REST API Connector"
            subtitle="Connect directly to Huawei FusionSolar, Sungrow iSolarCloud, or custom SCADA REST endpoints"
          >
            <form onSubmit={handleApiFetch} className="space-y-4">
              <div>
                <Label className="mb-1 block text-[11px] font-medium text-slate-400">Select API Provider / Protocol</Label>
                <Select
                  value={provider}
                  onValueChange={(v) => {
                    const val = v as any;
                    setProvider(val);
                    if (val === "huawei") setBaseUrl("https://intl.fusionsolar.huawei.com");
                    if (val === "sungrow") setBaseUrl("https://gateway.isolarcloud.com.hk");
                    if (val === "generic_rest") setBaseUrl("https://api.example-solar.com/v1/strings/telemetry");
                  }}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="huawei">Huawei FusionSolar Northbound API (getDevHistoryKpi)</SelectItem>
                    <SelectItem value="sungrow">Sungrow iSolarCloud OpenAPI (getDevicePointMinuteDataList)</SelectItem>
                    <SelectItem value="generic_rest">Generic REST API (JSON Records / Custom Endpoint)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label className="mb-1 block text-[11px] font-medium text-slate-400">Endpoint / Gateway Base URL</Label>
                <Input
                  type="text"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  className="font-mono"
                />
              </div>

              {provider === "huawei" && (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <Label className="mb-1 block text-[11px] font-medium text-slate-400">XSRF-TOKEN Header</Label>
                    <Input
                      type="password"
                      value={xsrfToken}
                      onChange={(e) => setXsrfToken(e.target.value)}
                      className="font-mono"
                    />
                  </div>
                  <div>
                    <Label className="mb-1 block text-[11px] font-medium text-slate-400">Inverter Device ID (devIds)</Label>
                    <Input
                      type="text"
                      value={devId}
                      onChange={(e) => setDevId(e.target.value)}
                      className="font-mono"
                    />
                  </div>
                </div>
              )}

              {provider === "sungrow" && (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <div>
                    <Label className="mb-1 block text-[11px] font-medium text-slate-400">AppKey</Label>
                    <Input
                      type="text"
                      value={appKey}
                      onChange={(e) => setAppKey(e.target.value)}
                      className="font-mono"
                    />
                  </div>
                  <div>
                    <Label className="mb-1 block text-[11px] font-medium text-slate-400">Access Token</Label>
                    <Input
                      type="password"
                      value={xsrfToken}
                      onChange={(e) => setXsrfToken(e.target.value)}
                      className="font-mono"
                    />
                  </div>
                  <div>
                    <Label className="mb-1 block text-[11px] font-medium text-slate-400">Device ps_key</Label>
                    <Input
                      type="text"
                      value={psKey}
                      onChange={(e) => setPsKey(e.target.value)}
                      className="font-mono"
                    />
                  </div>
                </div>
              )}

              {provider === "generic_rest" && (
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label className="mb-1 block text-[11px] font-medium text-slate-400">HTTP Method</Label>
                      <Select value={httpMethod} onValueChange={(v) => setHttpMethod(v)}>
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="GET">GET</SelectItem>
                          <SelectItem value="POST">POST</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <Label className="mb-1 block text-[11px] font-medium text-slate-400">JSON Array Key</Label>
                      <Input
                        type="text"
                        value={recordsKey}
                        onChange={(e) => setRecordsKey(e.target.value)}
                        className="font-mono"
                      />
                    </div>
                  </div>
                  <div>
                    <Label className="mb-1 block text-[11px] font-medium text-slate-400">Request Headers (JSON)</Label>
                    <Textarea
                      rows={2}
                      value={headersJson}
                      onChange={(e) => setHeadersJson(e.target.value)}
                      className="font-mono"
                    />
                  </div>
                </div>
              )}

              {provider !== "generic_rest" && (
                <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-300">
                  <input
                    type="checkbox"
                    checked={useSandbox}
                    onChange={(e) => setUseSandbox(e.target.checked)}
                    className="rounded"
                  />
                  <span>Use API Sandbox Simulator if endpoint is unreachable / offline</span>
                </label>
              )}

              <Button type="submit" disabled={busy} variant="default">
                <Play className="h-3.5 w-3.5" />
                {busy ? "Fetching String Telemetry…" : "Fetch String Telemetry from API"}
              </Button>
            </form>
          </Panel>

          <Panel
            className="lg:col-span-5"
            icon={Code2}
            title="Expected API Payload Structure"
            subtitle="Auto-normalized into canonical string records"
          >
            <div className="space-y-3 text-xs">
              <p className="leading-relaxed text-slate-400">
                The ingestion engine automatically normalizes both{" "}
                <strong className="text-solar-400">Wide Inverter KPI Maps</strong> (<code className="text-slate-200">pv1_u</code>,{" "}
                <code className="text-slate-200">pv1_i</code>, <code className="text-slate-200">pv2_u</code>,{" "}
                <code className="text-slate-200">pv2_i</code>) and{" "}
                <strong className="text-emerald-400">Tidy JSON Arrays</strong> (<code className="text-slate-200">timestamp</code>,{" "}
                <code className="text-slate-200">string_id</code>, <code className="text-slate-200">voltage_v</code>,{" "}
                <code className="text-slate-200">current_a</code>, <code className="text-slate-200">irradiance_wm2</code>).
              </p>
              <pre className="overflow-x-auto rounded-lg border border-white/[0.06] bg-ink-950 p-3 font-mono text-[11px] text-energy-300">
{`{
  "success": true,
  "data": [
    {
      "devId": "INV-HUAWEI-01",
      "collectTime": 1762840800000,
      "dataItemMap": {
        "irradiance": 845.2,
        "temperature": 46.8,
        "pv1_u": 718.4,
        "pv1_i": 11.12,
        "pv2_u": 716.9,
        "pv2_i": 11.08
      }
    }
  ]
}`}
              </pre>
            </div>
          </Panel>
        </div>
      )}

      {/* Mode 2: CSV / Excel Upload */}
      {mode === "upload" && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
          <Panel
            className="lg:col-span-7"
            icon={Upload}
            title="Upload SCADA CSV or Excel (.csv, .xlsx)"
            subtitle="Automatically executes IEC 61724 string analysis upon ingestion"
          >
            <label className="flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-white/15 bg-ink-950/50 p-10 transition hover:border-solar-400/60 hover:bg-solar-500/[0.04]">
              <Upload className="mb-2.5 h-8 w-8 text-solar-400" />
              <span className="text-xs font-semibold text-slate-200">
                Click to choose a CSV or Excel file (.csv, .xlsx, .xls)
              </span>
              <span className="mt-1 text-[11px] text-slate-500">
                Supports both Tidy/Long and Wide SCADA column layouts
              </span>
              <input type="file" accept=".csv,.xlsx,.xls" onChange={handleFileUpload} className="hidden" />
            </label>
          </Panel>

          <Panel
            className="lg:col-span-5"
            icon={Download}
            title="Sample CSV Template"
            subtitle="Reference format for external SCADA exports"
          >
            <div className="space-y-4 text-xs text-slate-400">
              <p className="leading-relaxed">
                You can upload either <strong className="text-slate-200">Long Format</strong> (
                <code className="text-energy-300">timestamp, string_id, voltage_v, current_a, irradiance_wm2</code>) or{" "}
                <strong className="text-slate-200">Wide SCADA Export Format</strong> (
                <code className="text-solar-300">timestamp, irradiance_wm2, PV1_U, PV1_I, PV2_U, PV2_I, ...</code>).
              </p>
              {activeDataset && (
                <Button
                  type="button"
                  onClick={() =>
                    downloadApiFile(api.sampleCsvPath(activeDataset.id), `dataset_${activeDataset.id}_sample.csv`).catch((e) =>
                      alert(`Could not download the template: ${e instanceof Error ? e.message : e}`)
                    )
                  }
                  variant="accent"
                >
                  <Download className="h-4 w-4" />
                  Download Sample Template (.csv)
                </Button>
              )}
            </div>
          </Panel>
        </div>
      )}

      {/* Mode 3: PV String Simulator */}
      {mode === "simulate" && (
        <Panel
          icon={FlaskConical}
          title="Built-in Rooftop PV String Simulator"
          subtitle="Synthesizes multi-day irradiance curves with realistic fault scenarios"
        >
          <div className="space-y-4">
            <div className="callout">
              Injects realistic field anomalies: <strong className="text-amber-300">STR-03</strong> (afternoon partial
              shading), <strong className="text-amber-300">STR-05</strong> (bypassed sub-string diode voltage drop), and{" "}
              <strong className="text-red-300">STR-06</strong> (open-circuit blown fuse on final 2 days).
            </div>
            <div className="grid grid-cols-1 gap-4 text-xs md:grid-cols-3">
              <div>
                <Label className="mb-1 block text-[11px] font-medium text-slate-400">
                  Simulation Duration: <strong className="num text-solar-400">{simDays} Days</strong>
                </Label>
                <input
                  type="range"
                  min={2}
                  max={30}
                  value={simDays}
                  onChange={(e) => setSimDays(Number(e.target.value))}
                  className="w-full"
                />
              </div>
              <div>
                <Label className="mb-1 block text-[11px] font-medium text-slate-400">
                  Number of PV Strings: <strong className="num text-energy-400">{simStrings} Strings</strong>
                </Label>
                <input
                  type="range"
                  min={4}
                  max={16}
                  value={simStrings}
                  onChange={(e) => setSimStrings(Number(e.target.value))}
                  className="w-full"
                />
              </div>
              <div>
                <Label className="mb-1 block text-[11px] font-medium text-slate-400">Sampling Interval (Minutes)</Label>
                <Select value={String(simInterval)} onValueChange={(v) => setSimInterval(Number(v))}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[5, 10, 15, 30, 60].map((m) => (
                      <SelectItem key={m} value={String(m)}>
                        {m} minutes
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <Button onClick={handleSimulate} disabled={busy} variant="default">
              <FlaskConical className="h-3.5 w-3.5" />
              {busy ? "Generating Simulated Telemetry…" : "Generate Simulated Rooftop PV Dataset"}
            </Button>
          </div>
        </Panel>
      )}

      {/* Dataset History Table */}
      <Panel
        icon={Database}
        title="Ingested Dataset History"
        subtitle="Switch active telemetry source to re-evaluate plant KPIs and string diagnostics"
      >
        <Table containerClassName="table-wrap">
            <TableHeader>
              <TableRow>
                <TableHead>ID</TableHead>
                <TableHead>Source Label</TableHead>
                <TableHead>Type</TableHead>
                <TableHead className="text-right">Strings</TableHead>
                <TableHead className="text-right">Records</TableHead>
                <TableHead>Time Range</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {datasets.map((d) => {
                const isCurrent = d.id === activeDataset?.id;
                return (
                  <TableRow key={d.id} className={isCurrent ? "bg-solar-500/[0.06]" : ""}>
                    <TableCell className="num whitespace-nowrap font-semibold text-solar-400">#{d.id}</TableCell>
                    <TableCell className="font-medium text-slate-100">{d.name}</TableCell>
                    <TableCell>
                      <Badge variant="neutral" className="uppercase">{d.source_type}</Badge>
                    </TableCell>
                    <TableCell className="num whitespace-nowrap text-right">{d.string_count}</TableCell>
                    <TableCell className="num whitespace-nowrap text-right">{d.row_count.toLocaleString()}</TableCell>
                    <TableCell className="num whitespace-nowrap text-[11px] text-slate-400">
                      {d.start_timestamp?.slice(0, 16)} → {d.end_timestamp?.slice(0, 16)}
                    </TableCell>
                    <TableCell className="text-right">
                      {isCurrent ? (
                        <StatusBadge status="Active" level="ok" />
                      ) : (
                        <Button onClick={() => selectDataset(d.id)} size="sm">
                          Activate
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
        </Table>
      </Panel>

      {/* Preview Normalized String Telemetry */}
      <Panel
        icon={Table2}
        title="Preview Normalized String Telemetry (First 100 Rows)"
        subtitle={activeDataset?.source_label}
      >
        <Table containerClassName="table-wrap max-h-80 overflow-y-auto">
            <TableHeader className="sticky top-0 z-10">
              <TableRow>
                <TableHead>Timestamp</TableHead>
                <TableHead>Inverter</TableHead>
                <TableHead>MPPT</TableHead>
                <TableHead>String</TableHead>
                <TableHead className="text-right">Voltage (V)</TableHead>
                <TableHead className="text-right">Current (A)</TableHead>
                <TableHead className="text-right">Power (W)</TableHead>
                <TableHead className="text-right">Irradiance (W/m²)</TableHead>
                <TableHead className="text-right">Mod Temp (°C)</TableHead>
                <TableHead className="text-right">Amb Temp (°C)</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className="num text-[11px]">
              {previewRows.map((r, idx) => (
                <TableRow key={idx}>
                  <TableCell className="text-slate-300">{r.timestamp}</TableCell>
                  <TableCell>{r.inverter_id}</TableCell>
                  <TableCell>{r.mppt_id}</TableCell>
                  <TableCell className="font-semibold text-solar-400">{r.string_id}</TableCell>
                  <TableCell className="text-right">{fmt(r.voltage_v, 1)}</TableCell>
                  <TableCell className="text-right">{fmt(r.current_a, 2)}</TableCell>
                  <TableCell className="text-right">{fmt(r.power_w, 1)}</TableCell>
                  <TableCell className="text-right">{fmt(r.irradiance_wm2, 1)}</TableCell>
                  <TableCell className="text-right">{fmt(r.module_temp_c, 1)}</TableCell>
                  <TableCell className="text-right">{fmt(r.ambient_temp_c, 1)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
        </Table>
      </Panel>
    </div>
  );
};
