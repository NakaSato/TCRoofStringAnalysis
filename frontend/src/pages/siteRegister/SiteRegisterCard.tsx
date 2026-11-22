/** O&M site register card (docs/plans/om-asset-network.md): the plant's station data and the devices on site,
 * as imported from the O&M workbook. Values as written; an empty cell shows "—". */
import React, { useState } from "react";
import { Check, Copy, Network, Pencil, Plus, TriangleAlert, Users, Zap, Building2 } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { api } from "../../api/client";
import type { PlantSiteRegister, SiteDevice, SiteDeviceKind } from "../../api/client";
import { useI18n } from "../../i18n";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { cn } from "@/lib/utils";
import { useLoad } from "../kb/useDocs";
import { useAppContext } from "../../context/AppContext";
import { Button } from "@/components/ui/button";
import { DeviceEditDialog } from "./DeviceEditDialog";
import type { DeviceTarget } from "./DeviceEditDialog";
import { KIND_ICON, KIND_LABEL } from "./kinds";

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

/** One label / value pair inside a fact group. */
const Fact: React.FC<{ label: string; children: React.ReactNode; wide?: boolean }> = ({ label, children, wide }) => (
  <div className={cn("flex min-w-0 flex-col gap-0.5", wide && "col-span-2")}>
    <dt className="text-[10px] text-muted-foreground">{label}</dt>
    <dd className="truncate text-xs text-slate-200" title={typeof children === "string" ? children : undefined}>
      {children}
    </dd>
  </div>
);

/** A titled group of facts (PEA, PWA site, project & team). */
const FactGroup: React.FC<{ icon: LucideIcon; title: string; children: React.ReactNode }> = ({ icon: Icon, title, children }) => (
  <section className="flex flex-col gap-2.5 rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
    <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
      <Icon className="size-3.5 text-slate-500" aria-hidden />
      {title}
    </h3>
    <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5">{children}</dl>
  </section>
);

/** The device's own fields beyond brand / SN / IP / status, as label → value. */
const deviceRows = (d: SiteDevice, t: (k: string, v?: Record<string, string | number>) => string): [string, React.ReactNode][] => {
  const out: [string, React.ReactNode][] = [];
  if (d.network) out.push([t("Network"), <span className="num">{d.network}</span>]);
  if (d.sim) out.push(["SIM", <Copyable value={d.sim} />]);
  if (d.firmware) out.push(["FW", <span className="num">{d.firmware}</span>]);
  if (d.address) out.push([t("Address"), <span className="num">{d.address}</span>]);
  if (d.ct_setting || d.ct_site) {
    const differs = d.ct_setting != null && d.ct_site != null && d.ct_setting !== d.ct_site;
    out.push([
      "CT",
      <span className={cn("num", differs && "text-amber-300")}>
        {dash(d.ct_setting)} · {t("on site")} {dash(d.ct_site)}
      </span>,
    ]);
  }
  if (d.billing_cut_days) out.push([t("Billing cut-off day"), d.billing_cut_days]);
  if (d.sales_start) out.push([t("Sales start"), d.sales_start]);
  if (d.warranty_start || d.warranty_end) out.push([t("Warranty"), `${dash(d.warranty_start)} → ${dash(d.warranty_end)}`]);
  return out;
};

/** One device on site: kind, brand / model, status, SN and IP to copy, then its other fields and notes. */
const DeviceTile: React.FC<{ d: SiteDevice; numbered: boolean; onEdit?: () => void }> = ({ d, numbered, onEdit }) => {
  const { t } = useI18n();
  const Icon = KIND_ICON[d.kind];
  const notes = [d.link_status, d.cod_clear_note, d.note].filter((x): x is string => !!x);
  const rows = deviceRows(d, t);
  return (
    <div className="flex min-w-0 flex-col gap-2.5 rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-2">
          <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md bg-white/5 text-slate-300">
            <Icon className="size-4" aria-hidden />
          </span>
          <div className="flex min-w-0 flex-col">
            <span className="text-xs font-medium text-slate-100">
              {t(KIND_LABEL[d.kind])}
              {numbered && ` ${d.seq}`}
            </span>
            <span className="truncate text-[11px] text-slate-400">{dash(d.brand_model)}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {d.status && <Badge variant={d.status === "ใช้งาน" ? "ok" : "neutral"}>{d.status}</Badge>}
          {onEdit && (
            <Button variant="ghost" size="icon-xs" onClick={onEdit} aria-label={t("Edit device")} title={t("Edit device")}>
              <Pencil />
            </Button>
          )}
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5">
        <Fact label="SN">
          <Copyable value={d.serial} />
        </Fact>
        <Fact label="IP">
          <Copyable value={d.ip} />
        </Fact>
        {rows.map(([k, v]) => (
          <Fact key={k} label={k}>
            {v}
          </Fact>
        ))}
      </dl>
      {notes.length > 0 && (
        <ul className="flex flex-col gap-1 border-t border-white/[0.06] pt-2 text-[11px] text-amber-200/90">
          {notes.map((n, i) => (
            <li key={i} className="whitespace-normal">
              {n}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

export const SiteRegisterCard: React.FC<{ plantId: number }> = ({ plantId }) => {
  const { t } = useI18n();
  const { user } = useAppContext();
  const canEdit = user?.role === "admin" || user?.role === "engineer";
  const [editing, setEditing] = useState<DeviceTarget | null>(null);
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

  if (!reg) {
    return (
      <Card className="gap-1 py-4">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <Network className="size-4 text-slate-500" aria-hidden />
            {t("Site register")}
          </CardTitle>
          <p className="text-[11px] text-muted-foreground">{t("This plant has no station in the O&M asset & network workbook.")}</p>
        </CardHeader>
      </Card>
    );
  }

  const s = reg.site;
  // a kind's number only when the site has more than one of it (revenue meters 1, 2, …)
  const perKind = reg.devices.reduce<Partial<Record<SiteDeviceKind, number>>>((m, d) => ({ ...m, [d.kind]: (m[d.kind] ?? 0) + 1 }), {});

  return (
    <Card className="gap-4 py-4">
      <CardHeader>
        <div className="flex min-w-0 flex-col gap-1">
          <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
            <Network className="size-4 text-slate-500" aria-hidden />
            {t("Site register")}
            <Badge variant="info" className="num">
              {s.site_code}
            </Badge>
            {s.project_phase != null && <Badge variant="neutral">{t("Phase {n}", { n: s.project_phase })}</Badge>}
          </CardTitle>
        </div>
      </CardHeader>

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

        <div className="grid gap-3 lg:grid-cols-3">
          <FactGroup icon={Zap} title={t("PEA connection")}>
            <Fact label={t("PEA meter no.")}>
              <Copyable value={s.pea_meter_no} />
            </Fact>
            <Fact label={t("PEA account no.")}>
              <Copyable value={s.pea_account_no} />
            </Fact>
            <Fact label={t("Billing cut-off day")}>{dash(s.billing_cut_days)}</Fact>
            <Fact label={t("PEA zone")}>{dash(s.pea_zone)}</Fact>
          </FactGroup>
          <FactGroup icon={Building2} title={t("PWA site")}>
            <Fact label={t("PWA branch")} wide>
              {dash(s.pwa_branch)}
            </Fact>
            <Fact label={t("PWA zone")}>{dash(s.pwa_zone)}</Fact>
            <Fact label={t("Province")}>{dash(s.province)}</Fact>
          </FactGroup>
          <FactGroup icon={Users} title={t("Project & team")}>
            <Fact label={t("COD baseline")}>{dash(s.cod_baseline)}</Fact>
            <Fact label={t("DLP contractor")}>{dash(s.dlp_contractor)}</Fact>
            <Fact label={t("Engineers")}>{dash(s.engineers_text)}</Fact>
            <Fact label={t("O&M technicians")}>{dash(s.technicians_text)}</Fact>
          </FactGroup>
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="flex items-center gap-2 text-xs font-semibold text-slate-200">
              {t("Devices on site")}
              <Badge variant="neutral" className="num">
                {reg.devices.length}
              </Badge>
            </h3>
            <div className="flex flex-wrap items-center gap-2">
              {reg.growatt && reg.growatt.logger_sns.length > 0 && (
                <p className="text-[11px] text-muted-foreground">{t("Growatt reports logger {sn}", { sn: reg.growatt.logger_sns.join(", ") })}</p>
              )}
              {canEdit && (
                <Button variant="outline" size="xs" onClick={() => setEditing({ kind: "revenue_meter" })}>
                  <Plus data-icon="inline-start" />
                  {t("Add device")}
                </Button>
              )}
            </div>
          </div>
          {reg.devices.length > 0 ? (
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {reg.devices.map((d, i) => (
                <DeviceTile
                  key={`${d.kind}-${d.seq}`}
                  d={d}
                  numbered={(perKind[d.kind] ?? 0) > 1 || d.kind === "revenue_meter"}
                  onEdit={canEdit ? () => setEditing({ index: i }) : undefined}
                />
              ))}
            </div>
          ) : (
            <p className="text-[11px] text-muted-foreground">{t("No devices listed for this station.")}</p>
          )}
          {canEdit && (
            <DeviceEditDialog
              plantId={plantId}
              station={`${s.site_code} · ${s.name}`}
              devices={reg.devices}
              target={editing}
              onClose={() => setEditing(null)}
              onSaved={(next) => data.setData(next)}
            />
          )}
        </div>
      </CardContent>
    </Card>
  );
};
