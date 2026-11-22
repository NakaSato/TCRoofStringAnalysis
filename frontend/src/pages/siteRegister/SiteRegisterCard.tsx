/** O&M site register card (docs/plans/om-asset-network.md): the plant's station data and the devices on site,
 * as imported from the O&M workbook. Values as written; an empty cell shows "—". */
import React, { useState } from "react";
import { Check, Copy, Network, TriangleAlert } from "lucide-react";
import { api } from "../../api/client";
import type { PlantSiteRegister, SiteDevice, SiteDeviceKind } from "../../api/client";
import { useI18n } from "../../i18n";
import { fmt } from "../../components/ui";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useLoad } from "../kb/useDocs";

const KIND_LABEL: Record<SiteDeviceKind, string> = {
  datalogger: "Data logger",
  weather_station: "Weather station",
  revenue_meter: "Revenue meter",
  router: "Router 4G",
  pqm: "PQM",
  shinemaster: "ShineMaster",
};

const RULE_LABEL: Record<string, string> = {
  logger_sn: "matched by logger SN",
  logger_sn_prefix: "matched by logger SN (sheet SN incomplete)",
  name_code: "matched by the code in the Growatt name",
  kept: "match kept from an earlier import",
};

const dash = (v: string | number | null | undefined) => (v == null || v === "" ? "—" : String(v));

/** A value with a copy button (IPs, serials). */
const Copyable: React.FC<{ value: string | null }> = ({ value }) => {
  const { t } = useI18n();
  const [done, setDone] = useState(false);
  if (!value) return <span className="text-slate-500">—</span>;
  return (
    <span className="inline-flex items-center gap-1">
      <span className="num">{value}</span>
      <button
        type="button"
        aria-label={t("Copy")}
        className="text-slate-500 transition hover:text-slate-200"
        onClick={() =>
          void navigator.clipboard?.writeText(value).then(() => {
            setDone(true);
            setTimeout(() => setDone(false), 1200);
          })
        }
      >
        {done ? <Check className="size-3" /> : <Copy className="size-3" />}
      </button>
    </span>
  );
};

const Fact: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="flex min-w-0 flex-col gap-0.5">
    <dt className="text-[10px] text-muted-foreground">{label}</dt>
    <dd className="truncate text-xs text-slate-200">{children}</dd>
  </div>
);

const extra = (d: SiteDevice, t: (k: string, v?: Record<string, string | number>) => string): string[] => {
  const out: string[] = [];
  if (d.network) out.push(`${t("Network")} ${d.network}`);
  if (d.sim) out.push(`SIM ${d.sim}`);
  if (d.firmware) out.push(`FW ${d.firmware}`);
  if (d.address) out.push(`${t("Address")} ${d.address}`);
  if (d.ct_setting || d.ct_site) out.push(`CT ${dash(d.ct_setting)} / ${t("on site")} ${dash(d.ct_site)}`);
  if (d.link_status) out.push(d.link_status);
  if (d.cod_clear_note) out.push(d.cod_clear_note);
  if (d.note) out.push(d.note);
  return out;
};

export const SiteRegisterCard: React.FC<{ plantId: number }> = ({ plantId }) => {
  const { t } = useI18n();
  const data = useLoad<PlantSiteRegister>(`sr:${plantId}`, () => api.getPlantSiteRegister(plantId), { keepOnKeyChange: false });
  const reg = data.data?.register;

  if (data.error && !data.data) {
    return (
      <Alert variant="destructive">
        <AlertTitle>{t("Could not load the site register")}</AlertTitle>
        <AlertDescription>{data.error.text}</AlertDescription>
      </Alert>
    );
  }
  if (!data.data) return null;

  return (
    <Card className="gap-3 py-4">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Network className="size-4 text-slate-500" aria-hidden />
            {t("Site register")}
            {reg && <Badge variant="info">{reg.site.site_code}</Badge>}
          </CardTitle>
          <p className="text-[11px] text-muted-foreground">
            {reg
              ? t("From the O&M asset & network workbook · imported {at} · {rule}", {
                  at: reg.site.imported_at.slice(0, 10),
                  rule: t(RULE_LABEL[reg.site.match_rule ?? ""] ?? "not matched"),
                })
              : t("This plant has no station in the O&M asset & network workbook.")}
          </p>
        </div>
      </CardHeader>
      {reg && (
        <CardContent className="flex flex-col gap-4">
          {reg.checks.length > 0 && (
            <Alert variant="warn">
              <TriangleAlert />
              <AlertTitle>{t("Worth a look")}</AlertTitle>
              <AlertDescription>
                <ul className="list-disc pl-4 text-xs">
                  {reg.checks.map((c, i) => (
                    <li key={i}>{c.text}</li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          )}

          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3 lg:grid-cols-6">
            <Fact label={t("Station")}>{reg.site.name}</Fact>
            <Fact label={t("Project phase")}>{dash(reg.site.project_phase)}</Fact>
            <Fact label={t("Province")}>{dash(reg.site.province)}</Fact>
            <Fact label="kWp">
              {reg.site.kwp != null ? fmt(reg.site.kwp, 2) : "—"}
              {reg.growatt?.kwp != null && reg.site.kwp != null && Math.abs(reg.growatt.kwp - reg.site.kwp) / reg.site.kwp > 0.01 && (
                <span className="text-amber-300"> ({t("Growatt")} {fmt(reg.growatt.kwp, 2)})</span>
              )}
            </Fact>
            <Fact label={t("Inverter total (kW)")}>{reg.site.inverter_ac_kw != null ? fmt(reg.site.inverter_ac_kw, 0) : "—"}</Fact>
            <Fact label={t("Export limit")}>{dash(reg.site.export_limit)}</Fact>
            <Fact label={t("PEA meter no.")}>
              <Copyable value={reg.site.pea_meter_no} />
            </Fact>
            <Fact label={t("PEA account no.")}>
              <Copyable value={reg.site.pea_account_no} />
            </Fact>
            <Fact label={t("Billing cut-off day")}>{dash(reg.site.billing_cut_days)}</Fact>
            <Fact label={t("PEA connection status")}>{dash(reg.site.pea_connection_status)}</Fact>
            <Fact label={t("PWA branch")}>{dash(reg.site.pwa_branch)}</Fact>
            <Fact label={t("PWA / PEA zone")}>
              {dash(reg.site.pwa_zone)} · {dash(reg.site.pea_zone)}
            </Fact>
            <Fact label={t("PEA contract start")}>{dash(reg.site.pea_contract_start)}</Fact>
            <Fact label={t("COD baseline")}>{dash(reg.site.cod_baseline)}</Fact>
            <Fact label={t("COD actual")}>{dash(reg.site.cod_actual)}</Fact>
            <Fact label={t("DLP contractor")}>{dash(reg.site.dlp_contractor)}</Fact>
            <Fact label={t("Engineers")}>{dash(reg.site.engineers_text)}</Fact>
            <Fact label={t("O&M technicians")}>{dash(reg.site.technicians_text)}</Fact>
          </dl>

          <Table containerClassName="table-wrap" className="min-w-[640px] text-xs">
            <TableHeader>
              <TableRow>
                <TableHead>{t("Device")}</TableHead>
                <TableHead>{t("Brand / model")}</TableHead>
                <TableHead>SN</TableHead>
                <TableHead>IP</TableHead>
                <TableHead>{t("Details")}</TableHead>
                <TableHead>{t("Status")}</TableHead>
                <TableHead>{t("Warranty")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {reg.devices.map((d) => (
                <TableRow key={`${d.kind}-${d.seq}`} className="align-top">
                  <TableCell className="whitespace-nowrap text-slate-300">
                    {t(KIND_LABEL[d.kind])}
                    {d.kind === "revenue_meter" && ` ${d.seq}`}
                  </TableCell>
                  <TableCell className="text-slate-300">{dash(d.brand_model)}</TableCell>
                  <TableCell className="whitespace-nowrap">
                    <Copyable value={d.serial} />
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    <Copyable value={d.ip} />
                  </TableCell>
                  <TableCell className="whitespace-normal text-slate-400">{extra(d, t).join(" · ") || "—"}</TableCell>
                  <TableCell className="whitespace-nowrap text-slate-300">{dash(d.status)}</TableCell>
                  <TableCell className="whitespace-nowrap text-slate-400">
                    {d.warranty_start || d.warranty_end ? `${dash(d.warranty_start)} → ${dash(d.warranty_end)}` : "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {reg.growatt && reg.growatt.logger_sns.length > 0 && (
            <p className="text-[11px] text-muted-foreground">
              {t("Growatt reports logger {sn}", { sn: reg.growatt.logger_sns.join(", ") })}
            </p>
          )}
        </CardContent>
      )}
    </Card>
  );
};
