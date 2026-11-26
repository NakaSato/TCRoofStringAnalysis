import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useSearchParams } from "react-router-dom";
import { ArrowLeft, Download, Printer, Tag } from "lucide-react";
import { ApiError, api, type ScanLabel, type ScanLabelKind, type ScanLabelQuery } from "../api/client";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState, LoadingState } from "../components/ui";
import { useI18n } from "../i18n";
import { qrSvg } from "../lib/scan/qr";
import { LAYOUTS, cellAt, defaultLayout, isLocalOrigin, labelsCsv, perSheet, qrUrl, toSheets, type LayoutId, type SheetLayout } from "../lib/scan/labelSheet";

const KIND_TITLE: Record<ScanLabelKind, string> = { tool: "Instrument labels", dev: "Site device labels", rt: "Red tags" };
const BACK: Record<ScanLabelKind, (q: URLSearchParams) => string> = {
  tool: () => "/tools",
  dev: (q) => (q.get("plant_id") ? `/plant/${q.get("plant_id")}/documents` : "/settings?tab=register"),
  rt: () => "/settings?tab=scanning",
};

// on screen the sheet is hidden; in print only the sheet shows, at true size
const PRINT_CSS = `
.label-print { display: none; }
@media print {
  @page { size: A4; margin: 0; }
  html, body { background: #fff !important; }
  body > *:not(.label-print) { display: none !important; }
  .label-print { display: block; }
  .label-page { break-after: page; }
  .label-page:last-child { break-after: auto; }
}`;

const Qr: React.FC<{ text: string; mm: number }> = ({ text, mm }) => {
  const q = useMemo(() => qrSvg(text), [text]);
  return (
    <svg viewBox={`0 0 ${q.size} ${q.size}`} width={`${mm}mm`} height={`${mm}mm`} shapeRendering="crispEdges" aria-label={text} role="img">
      <rect width={q.size} height={q.size} fill="#fff" />
      <path d={q.d} fill="#000" />
    </svg>
  );
};

/** One label, in mm, black on white whatever the app theme. */
const LabelCell: React.FC<{ item: ScanLabel; layout: SheetLayout; origin: string }> = ({ item, layout, origin }) => {
  const { t } = useI18n();
  const tag = layout.id === "tag8";
  const pad = tag ? 3 : 1.5;
  return (
    <div
      style={{
        width: `${layout.w}mm`,
        height: `${layout.h}mm`,
        padding: `${pad}mm`,
        boxSizing: "border-box",
        display: "flex",
        gap: tag ? "3mm" : "1.5mm",
        alignItems: "center",
        color: "#000",
        background: "#fff",
        fontFamily: "system-ui, 'Noto Sans Thai', sans-serif",
        overflow: "hidden",
        borderLeft: item.kind === "rt" ? "4mm solid #c81e1e" : undefined,
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", flex: "none" }}>
        <Qr text={qrUrl(origin, item)} mm={layout.qr} />
        <div style={{ fontFamily: "ui-monospace, Menlo, monospace", fontSize: tag ? "3mm" : "2.2mm", marginTop: "0.3mm", whiteSpace: "nowrap" }}>{item.code}</div>
      </div>
      <div style={{ minWidth: 0, flex: 1, display: "flex", flexDirection: "column", gap: tag ? "1.6mm" : "0.6mm" }}>
        <div style={{ fontWeight: 700, fontSize: tag ? "6mm" : "3.4mm", lineHeight: 1.1, wordBreak: "break-word" }}>{item.title}</div>
        {item.kind === "rt" ? (
          <>
            <div style={{ fontSize: "3mm", fontWeight: 600, color: "#c81e1e", textTransform: "uppercase" }}>{t("Failed unit")}</div>
            {[t("Plant"), t("Device / SN"), t("What is wrong"), t("Date · by")].map((f) => (
              <div key={f} style={{ fontSize: "2.6mm", borderBottom: "0.2mm solid #000", paddingTop: "3mm" }}>
                {f}
              </div>
            ))}
          </>
        ) : (
          item.lines.map((l, i) => (
            <div key={i} style={{ fontSize: "2.4mm", lineHeight: 1.15, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {l}
            </div>
          ))
        )}
      </div>
    </div>
  );
};

const Sheet: React.FC<{ cells: Array<ScanLabel | null>; layout: SheetLayout; origin: string; guides?: boolean }> = ({ cells, layout, origin, guides }) => (
  <div className="label-page" style={{ position: "relative", width: "210mm", height: "297mm", background: "#fff", overflow: "hidden" }}>
    {cells.map((c, i) => {
      const { x, y } = cellAt(layout, i);
      return (
        <div
          key={i}
          style={{
            position: "absolute",
            left: `${x}mm`,
            top: `${y}mm`,
            width: `${layout.w}mm`,
            height: `${layout.h}mm`,
            outline: guides ? "0.2mm dashed #bbb" : undefined,
          }}
        >
          {c && <LabelCell item={c} layout={layout} origin={origin} />}
        </div>
      );
    })}
  </div>
);

/**
 * Print labels (docs/plans/barcode-scanning.md §12 step 5): `/labels?kind=tool|dev|rt` with
 * `plant_id` / `site_code` / `ids` / `batch`. Pick the items, the sheet and where to start on it,
 * then print (A4, no margins) or download a CSV. The QR holds this host's `/s/<kind>/<code>` URL.
 */
export const LabelsPage: React.FC = () => {
  const { t } = useI18n();
  const [params] = useSearchParams();
  const kind = (["tool", "dev", "rt"].includes(params.get("kind") ?? "") ? params.get("kind") : "tool") as ScanLabelKind;
  const [items, setItems] = useState<ScanLabel[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [off, setOff] = useState<Set<string>>(new Set());
  const [layoutId, setLayoutId] = useState<LayoutId>(defaultLayout(kind));
  const [startAt, setStartAt] = useState("1");
  const origin = window.location.origin;
  const layout = LAYOUTS[layoutId];

  useEffect(() => {
    const num = (k: string) => (params.get(k) ? Number(params.get(k)) : undefined);
    const q: ScanLabelQuery = { kind, ids: params.get("ids") ?? undefined, plant_id: num("plant_id"), site_code: params.get("site_code") ?? undefined, batch: num("batch") };
    let alive = true;
    setItems(null);
    setError(null);
    setOff(new Set());
    setLayoutId(defaultLayout(kind));
    api
      .getScanLabels(q)
      .then((r) => alive && setItems(r.items))
      .catch((e) => alive && setError(e instanceof ApiError && e.status === 404 ? t("Not found, or not on one of your plants.") : e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [params.toString()]);

  const chosen = useMemo(() => (items ?? []).filter((i) => !off.has(i.key)), [items, off]);
  const start = Math.min(Math.max(1, Number(startAt) || 1), perSheet(layout));
  const sheets = useMemo(() => toSheets(chosen, layout, start), [chosen, layout, start]);

  const toggle = (key: string, on: boolean) =>
    setOff((cur) => {
      const next = new Set(cur);
      if (on) next.delete(key);
      else next.add(key);
      return next;
    });

  const downloadCsv = () => {
    const blob = new Blob(["﻿" + labelsCsv(chosen, origin)], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `labels-${kind}${params.get("batch") ? `-batch${params.get("batch")}` : ""}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  return (
    <div className="flex flex-col gap-4">
      <style>{PRINT_CSS}</style>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Button asChild variant="ghost" size="icon-sm" aria-label={t("Back")}>
            <Link to={BACK[kind](params)}>
              <ArrowLeft />
            </Link>
          </Button>
          <div className="flex min-w-0 flex-col">
            <h1 className="flex items-center gap-2 text-lg font-semibold">
              <Tag className="size-4 text-slate-500" aria-hidden />
              {t(KIND_TITLE[kind])}
            </h1>
            <p className="text-xs text-muted-foreground">{t("QR with the app link, the short code printed under it. Phones open the record from their own camera.")}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={downloadCsv} disabled={!chosen.length}>
            <Download data-icon="inline-start" />
            CSV
          </Button>
          <Button size="sm" onClick={() => window.print()} disabled={!chosen.length}>
            <Printer data-icon="inline-start" />
            {t("Print {n}", { n: chosen.length })}
          </Button>
        </div>
      </div>

      {isLocalOrigin(origin) && (
        <Alert variant="warn">
          <AlertDescription>
            {t("This page is open on {host}: the QR codes would point there, which phones in the field cannot open. Print from the production app.", { host: window.location.host })}
          </AlertDescription>
        </Alert>
      )}

      {error ? (
        <EmptyState title={error} />
      ) : !items ? (
        <LoadingState />
      ) : items.length === 0 ? (
        <EmptyState title={t("Nothing to print here.")} />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[20rem_minmax(0,1fr)]">
          <Card className="self-start">
            <CardContent className="flex flex-col gap-4 text-xs">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="label-layout" className="text-xs">
                  {t("Label sheet")}
                </Label>
                <Select value={layoutId} onValueChange={(v) => setLayoutId(v as LayoutId)}>
                  <SelectTrigger id="label-layout" size="sm" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.values(LAYOUTS).map((l) => (
                      <SelectItem key={l.id} value={l.id}>
                        {t(l.name)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="label-start" className="text-xs">
                  {t("Start at label")}
                </Label>
                <Input id="label-start" inputMode="numeric" value={startAt} onChange={(e) => setStartAt(e.target.value)} className="h-8 w-24" />
                <span className="text-[11px] text-muted-foreground">{t("On a part-used sheet: the labels before it stay empty (1–{n}, left to right).", { n: perSheet(layout) })}</span>
              </div>
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between">
                  <span className="font-medium">
                    {t("{n} of {total} selected", { n: chosen.length, total: items.length })}
                  </span>
                  <Button variant="ghost" size="xs" onClick={() => setOff(off.size ? new Set() : new Set(items.map((i) => i.key)))}>
                    {off.size ? t("Select all") : t("Select none")}
                  </Button>
                </div>
                <ul className="flex max-h-[50vh] flex-col gap-0.5 overflow-y-auto">
                  {items.map((i) => (
                    <li key={i.key}>
                      <label className="flex min-w-0 cursor-pointer items-center gap-2 rounded px-1.5 py-1 hover:bg-white/[0.03]">
                        <Checkbox checked={!off.has(i.key)} onCheckedChange={(v) => toggle(i.key, v === true)} />
                        <span className="min-w-0 flex-1 truncate">{i.title}</span>
                        <span className="shrink-0 truncate text-muted-foreground">{i.kind === "rt" ? t("Failed unit") : i.lines[0]}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              </div>
              <p className="text-[11px] text-muted-foreground">
                {t("Print at 100 % (actual size), no margins. Check one sheet on plain paper against the label sheet first.")}
              </p>
            </CardContent>
          </Card>

          <div className="flex min-w-0 flex-col gap-2">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="neutral">{sheets.length === 1 ? t("1 label sheet") : t("{n} label sheets", { n: sheets.length })}</Badge>
              {t("Preview")}
            </div>
            {/* preview: the sheets scaled to the column; the print copy below is at true size */}
            <div className="flex flex-col gap-3 overflow-x-auto">
              {sheets.slice(0, 3).map((cells, i) => (
                <div key={i} className="origin-top-left rounded shadow-lg" style={{ width: "fit-content", zoom: 0.6 }}>
                  <Sheet cells={cells} layout={layout} origin={origin} guides />
                </div>
              ))}
              {sheets.length > 3 && <p className="text-xs text-muted-foreground">{t("…and {n} more label sheets", { n: sheets.length - 3 })}</p>}
            </div>
          </div>
        </div>
      )}
      {createPortal(
        <div className="label-print">
          {sheets.map((cells, i) => (
            <Sheet key={i} cells={cells} layout={layout} origin={origin} />
          ))}
        </div>,
        document.body
      )}
    </div>
  );
};
