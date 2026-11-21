/**
 * Inverters page: download one inverter's day as CSV with every field Growatt reports in its
 * `max_data` records (Growatt's own field names, values as reported; stored history, kept 30 days).
 */
import React, { useState } from "react";
import { Download } from "lucide-react";
import { api } from "../../api/client";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useI18n } from "@/i18n";

const cell = (v: unknown): string => {
  if (v == null) return "";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const RawExportButton: React.FC<{ plantId: number | null; deviceSn: string; day: string | null }> = ({ plantId, deviceSn, day }) => {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const run = async () => {
    if (plantId == null) return;
    setBusy(true);
    setNote(null);
    try {
      const r = await api.getGrowattInverterRaw(plantId, deviceSn, day ?? undefined);
      if (!r.records.length) {
        setNote(t("No full records stored for this day"));
        return;
      }
      const head = ["time", ...r.fields];
      const body = r.records.map((rec) => head.map((k) => cell(rec[k])).join(","));
      // BOM: the debug fields carry full-width commas, which Excel misreads without it
      const blob = new Blob(["﻿" + [head.join(","), ...body].join("\n")], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${deviceSn}_${r.meta.day ?? "day"}_growatt_raw.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => void run()}
      disabled={busy || plantId == null}
      title={note ?? t("Download every Growatt field of this inverter's stored records for the day (as reported; kept 30 days)")}
    >
      {busy ? <Spinner data-icon="inline-start" className="size-3" /> : <Download data-icon="inline-start" className="h-3.5 w-3.5" />}
      {note ? t("No data") : t("All fields CSV")}
    </Button>
  );
};
