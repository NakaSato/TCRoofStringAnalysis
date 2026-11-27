/** Field faults: "Record fault". Plant (the user's plants), kind, severity, how found, symptom,
 * found at, cause, evidence links, next action day, owner, and optionally the device: one of the
 * plant's inverters, a Site Register device, a Growatt meter, or a typed / scanned serial
 * (`ScanField`, kept with `serial_input` / `serial_raw`). Before saving it asks
 * `GET /faults/open-on-device` and offers the open fault instead; a 409 from the create does the same. */
import React, { useEffect, useMemo, useState } from "react";
import { ApiError, api } from "../../api/client";
import type {
  DeviceMeter,
  Fault,
  FaultCause,
  FaultCreateBody,
  FaultDetail,
  FaultDuplicateDetail,
  FaultHowFound,
  FaultKind,
  FaultSeverity,
  FaultSubKind,
  GrowattInverter,
  InputMethod,
  SiteDevice,
} from "../../api/client";
import { ScanField } from "../../components/scan/ScanField";
import { useAppContext } from "../../context/AppContext";
import { plantToday } from "../../context/alarmLogStore";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { DayInput, Field, Footer } from "../tools/dialogs";
import { KIND_LABEL as SITE_KIND_LABEL } from "../siteRegister/kinds";
import { useI18n } from "../../i18n";
import { faultsApi } from "./useFaults";
import { OwnerSelect, PositionFields, readPosition, usePlantPeople } from "./dialogs";
import {
  CAUSE,
  CAUSE_KEYS,
  HOW_FOUND,
  HOW_FOUND_KEYS,
  KIND,
  KIND_KEYS,
  LOCATION_KINDS,
  POSITION_KINDS,
  SEVERITY,
  SEVERITY_KEYS,
  STATUS,
  SUB_KIND,
  SUB_KIND_KEYS,
  defaultSource,
  isEvidenceUrl,
  parseUrls,
  plantNowLocal,
} from "./format";
import type { DeviceSource } from "./format";

const NONE = "__none";
const str = (s: string) => (s.trim() ? s.trim() : null);
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

interface Draft {
  plant_id: string;
  kind: FaultKind;
  sub_kind: FaultSubKind | null;
  severity: FaultSeverity;
  how_found: FaultHowFound;
  symptom: string;
  found_at: string;
  cause: FaultCause | null;
  urls: string;
  next: string | null;
  owner: number | null;
  reference: string;
  source: DeviceSource;
  inverter_sn: string;
  site_device_id: string;
  meter: string;
  serial: string;
  serial_input: InputMethod | null;
  serial_raw: string | null;
  mppt: string;
  string_no: string;
  module_no: string;
  location: string;
}

const blank = (plantId: number | null): Draft => ({
  plant_id: plantId != null ? String(plantId) : "",
  kind: "inverter",
  sub_kind: null,
  severity: "S2",
  how_found: "site_visit",
  symptom: "",
  found_at: plantNowLocal(),
  cause: null,
  urls: "",
  next: null,
  owner: null,
  reference: "",
  source: "inverter",
  inverter_sn: "",
  site_device_id: "",
  meter: "",
  serial: "",
  serial_input: null,
  serial_raw: null,
  mppt: "",
  string_no: "",
  module_no: "",
  location: "",
});

/** the plant's devices for the picker, read when the plant changes (meters only when asked for) */
function usePlantDevices(plantId: number | null, wantMeters: boolean) {
  const [inverters, setInverters] = useState<GrowattInverter[] | null>(null);
  const [site, setSite] = useState<SiteDevice[] | null>(null);
  const [meters, setMeters] = useState<DeviceMeter[] | null>(null);
  useEffect(() => {
    setInverters(null);
    setSite(null);
    if (plantId == null) return;
    let live = true;
    api
      .listGrowattInverters(plantId)
      .then((x) => live && setInverters(x))
      .catch(() => live && setInverters([]));
    api
      .getPlantSiteRegister(plantId)
      .then((x) => live && setSite((x.register?.devices ?? []).filter((d) => d.id != null)))
      .catch(() => live && setSite([]));
    return () => {
      live = false;
    };
  }, [plantId]);
  useEffect(() => {
    if (!wantMeters || meters != null) return;
    let live = true;
    api
      .listDeviceMeters()
      .then((x) => live && setMeters(x.meters))
      .catch(() => live && setMeters([]));
    return () => {
      live = false;
    };
  }, [wantMeters, meters]);
  const plantMeters = useMemo(() => (meters == null ? null : meters.filter((m) => m.plant_id === plantId)), [meters, plantId]);
  return { inverters, site, meters: plantMeters };
}

const siteLabel = (d: SiteDevice) => [SITE_KIND_LABEL[d.kind] + (d.seq > 1 ? ` ${d.seq}` : ""), d.brand_model, d.serial].filter(Boolean).join(" · ");

export const RecordDialog: React.FC<{
  open: boolean;
  /** plant to start with (URL `p`) */
  plantId: number | null;
  onClose: () => void;
  onSaved: (f: FaultDetail) => void;
  /** "add to this one": open the existing fault instead */
  onOpenExisting: (id: number) => void;
}> = ({ open, plantId: initialPlant, onClose, onSaved, onOpenExisting }) => {
  const { growattPlants } = useAppContext();
  const { t } = useI18n();
  const [d, setD] = useState<Draft>(() => blank(initialPlant));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** active faults on the picked device (from the check or a 409); null = not checked */
  const [dups, setDups] = useState<Array<Pick<Fault, "id" | "no"> & Partial<Fault>> | null>(null);

  useEffect(() => {
    if (!open) return;
    setD(blank(initialPlant));
    setError(null);
    setDups(null);
  }, [open, initialPlant]);

  const plantId = /^\d+$/.test(d.plant_id) ? Number(d.plant_id) : null;
  const { inverters, site, meters } = usePlantDevices(open ? plantId : null, open && d.source === "meter");
  const people = usePlantPeople(open ? plantId : null);
  const plants = useMemo(() => [...growattPlants].sort((a, b) => a.name.localeCompare(b.name)), [growattPlants]);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => {
    setD((x) => ({ ...x, [k]: v }));
    setDups(null); // a changed device or kind needs a new check
  };
  const setPlant = (v: string) => setD((x) => ({ ...x, plant_id: v, inverter_sn: "", site_device_id: "", meter: "", owner: null }));
  const setKind = (k: FaultKind) =>
    setD((x) => ({
      ...x,
      kind: k,
      sub_kind: k === "service" ? (x.sub_kind ?? "vpn") : null,
      // follow the kind's usual device until the person picks one
      source: x.inverter_sn || x.site_device_id || x.meter || x.serial ? x.source : defaultSource(k),
      cause: x.cause,
    }));

  const numbers = POSITION_KINDS.includes(d.kind);
  const withLocation = LOCATION_KINDS.includes(d.kind);
  const position = readPosition(d, numbers);
  const urls = parseUrls(d.urls);
  const now = plantNowLocal();

  const device = (): Partial<FaultCreateBody> => {
    switch (d.source) {
      case "inverter":
        return d.inverter_sn ? { inverter_sn: d.inverter_sn } : {};
      case "site":
        return d.site_device_id ? { site_device_id: Number(d.site_device_id) } : {};
      case "meter": {
        const [dl, addr] = d.meter.split("|");
        return dl && addr ? { meter: { datalogger_sn: dl, address: Number(addr) } } : {};
      }
      case "serial":
        return d.serial.trim() ? { serial: d.serial.trim(), serial_input: d.serial_input ?? "manual", serial_raw: d.serial_input && d.serial_input !== "manual" ? d.serial_raw : null } : {};
      default:
        return {};
    }
  };
  const deviceQuery = (): { inverter_sn?: string; site_device_id?: number; serial?: string } | null => {
    const dev = device();
    if (dev.inverter_sn) return { inverter_sn: dev.inverter_sn };
    if (dev.site_device_id != null) return { site_device_id: dev.site_device_id };
    if (dev.serial) return { serial: dev.serial };
    // a Growatt meter has no duplicate lookup (the create's 409 still catches one)
    return null;
  };

  const problems = [
    !plantId && t("Pick the plant"),
    !d.symptom.trim() && t("Say what is wrong"),
    d.kind === "service" && !d.sub_kind && t("Pick what failed"),
    !d.found_at && t("Enter when it was found"),
    d.found_at > now && t("Found time is in the future"),
    urls.some((u) => !isEvidenceUrl(u)) && t("Evidence links start with https://"),
    urls.length > 20 && t("At most 20 evidence links"),
    position === undefined && t("MPPT, string and module numbers are whole numbers 1–999"),
  ].filter(Boolean) as string[];

  const save = async (allowDuplicate: boolean) => {
    if (!plantId) return;
    setBusy(true);
    setError(null);
    try {
      if (!allowDuplicate) {
        const q = deviceQuery();
        if (q) {
          const open = (await faultsApi.faultsOpenOnDevice(q)).faults;
          if (open.length) {
            setDups(open);
            return;
          }
        }
      }
      const body: FaultCreateBody = {
        plant_id: plantId,
        kind: d.kind,
        sub_kind: d.kind === "service" ? d.sub_kind : null,
        severity: d.severity,
        how_found: d.how_found,
        symptom: d.symptom.trim(),
        cause: d.cause,
        found_at: d.found_at || null,
        ...device(),
        position: numbers || withLocation ? (position ?? null) : null,
        owner_user_id: d.owner,
        next_action_day: d.next,
        evidence_urls: urls,
        reference: str(d.reference),
        allow_duplicate: allowDuplicate,
      };
      const f = await faultsApi.createFault(body);
      onSaved(f); // the page closes the dialog and opens the new fault (one URL change)
    } catch (e) {
      const det = e instanceof ApiError && e.status === 409 ? (e.detail as Partial<FaultDuplicateDetail> | undefined) : undefined;
      if (det && typeof det === "object" && det.fault_id != null) setDups([{ id: det.fault_id, no: det.no ?? `#${det.fault_id}` }]);
      else setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const today = plantToday();
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("Record fault")}</DialogTitle>
          <DialogDescription>{t("One problem on one plant, as found. It starts Open; decide and move it on from its page.")}</DialogDescription>
        </DialogHeader>

        {d.severity === "S1" && (
          <Alert variant="destructive">
            <AlertTitle>{t("S1 safety: make it safe first")}</AlertTitle>
            <AlertDescription>
              {t("Work only under a permit to work (PTW). Isolate and lock out the AC and DC sides, prove dead, and keep people away from exposed live parts and damaged modules. PV strings stay live in daylight.")}
            </AlertDescription>
          </Alert>
        )}

        {dups && dups.length > 0 && (
          <Alert variant="warn">
            <AlertTitle>{t("Already open on this device")}</AlertTitle>
            <AlertDescription className="flex flex-col gap-2">
              <div className="flex flex-col gap-1">
                {dups.map((f) => (
                  <div key={f.id} className="flex flex-wrap items-center gap-2">
                    <span className="num">{f.no}</span>
                    {f.kind && <span className="text-muted-foreground">{t(KIND[f.kind])}</span>}
                    {f.status && <span className="text-muted-foreground">· {t(STATUS[f.status].label)}</span>}
                    {f.symptom && <span className="max-w-[260px] truncate text-muted-foreground">· {f.symptom}</span>}
                    <Button size="xs" variant="outline" onClick={() => onOpenExisting(f.id)}>
                      {t("Add to this one")}
                    </Button>
                  </div>
                ))}
              </div>
              <div>
                <Button size="xs" variant="ghost" disabled={busy} onClick={() => void save(true)}>
                  {t("Record anyway (a different fault)")}
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field id="r-plant" label={t("Plant")} wide>
            <Select value={d.plant_id} onValueChange={setPlant}>
              <SelectTrigger id="r-plant" size="sm" className="w-full">
                <SelectValue placeholder={t("Pick a plant")} />
              </SelectTrigger>
              <SelectContent>
                {plants.map((p) => (
                  <SelectItem key={p.plant_id} value={String(p.plant_id)}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field id="r-kind" label={t("Kind")}>
            <Select value={d.kind} onValueChange={(v) => setKind(v as FaultKind)}>
              <SelectTrigger id="r-kind" size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {KIND_KEYS.map((k) => (
                  <SelectItem key={k} value={k}>
                    {t(KIND[k])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {d.kind === "service" ? (
            <Field id="r-sub" label={t("What failed")}>
              <Select value={d.sub_kind ?? ""} onValueChange={(v) => set("sub_kind", v as FaultSubKind)}>
                <SelectTrigger id="r-sub" size="sm" className="w-full">
                  <SelectValue placeholder={t("Pick")} />
                </SelectTrigger>
                <SelectContent>
                  {SUB_KIND_KEYS.map((k) => (
                    <SelectItem key={k} value={k}>
                      {t(SUB_KIND[k])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          ) : (
            <div className="hidden sm:block" />
          )}
          <Field id="r-sev" label={t("Severity")} hint={t(SEVERITY[d.severity].hint)}>
            <Select value={d.severity} onValueChange={(v) => set("severity", v as FaultSeverity)}>
              <SelectTrigger id="r-sev" size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SEVERITY_KEYS.map((k) => (
                  <SelectItem key={k} value={k}>
                    {t(SEVERITY[k].label)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field id="r-how" label={t("How found")}>
            <Select value={d.how_found} onValueChange={(v) => set("how_found", v as FaultHowFound)}>
              <SelectTrigger id="r-how" size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {HOW_FOUND_KEYS.map((k) => (
                  <SelectItem key={k} value={k}>
                    {t(HOW_FOUND[k])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field id="r-symptom" label={t("Symptom")} hint={t("What you saw: fault code, no data, burnt smell, cracked glass, …")} wide>
            <Textarea id="r-symptom" className="min-h-16" value={d.symptom} onChange={(e) => set("symptom", e.target.value)} maxLength={4000} />
          </Field>

          {/* the device: at most one; a picked device's register serial is the one recorded */}
          <div className="space-y-1.5 sm:col-span-2">
            <span className="text-xs font-medium">{t("Device (optional)")}</span>
            <Tabs value={d.source} onValueChange={(v) => set("source", v as DeviceSource)}>
              <TabsList variant="line" className="flex-wrap border-0 p-0">
                <TabsTrigger value="none">{t("None")}</TabsTrigger>
                <TabsTrigger value="inverter">{t("Inverter")}</TabsTrigger>
                <TabsTrigger value="site">{t("Site Register")}</TabsTrigger>
                <TabsTrigger value="meter">{t("Growatt meter")}</TabsTrigger>
                <TabsTrigger value="serial">{t("Serial (type / scan)")}</TabsTrigger>
              </TabsList>
            </Tabs>
            {!plantId && d.source !== "none" && d.source !== "serial" && <p className="text-[11px] text-muted-foreground">{t("Pick the plant first.")}</p>}
            {plantId && d.source === "inverter" && (
              <DevicePick
                id="r-inv"
                loading={inverters == null}
                empty={t("No inverters registered for this plant")}
                value={d.inverter_sn}
                onChange={(v) => set("inverter_sn", v)}
                options={(inverters ?? []).map((i) => ({ value: i.device_sn, label: i.alias && i.alias !== i.device_sn ? `${i.alias} · ${i.device_sn}` : i.device_sn }))}
              />
            )}
            {plantId && d.source === "site" && (
              <DevicePick
                id="r-site"
                loading={site == null}
                empty={t("No Site Register devices for this plant")}
                value={d.site_device_id}
                onChange={(v) => set("site_device_id", v)}
                options={(site ?? []).map((s) => ({ value: String(s.id), label: siteLabel(s) }))}
              />
            )}
            {plantId && d.source === "meter" && (
              <DevicePick
                id="r-meter"
                loading={meters == null}
                empty={t("No Growatt meter registered for this plant")}
                value={d.meter}
                onChange={(v) => set("meter", v)}
                options={(meters ?? []).map((m) => ({ value: `${m.datalogger_sn}|${m.address}`, label: `${m.device_name ?? t("Meter")} · ${m.datalogger_sn}:${m.address}` }))}
              />
            )}
            {d.source === "serial" && (
              <ScanField
                id="r-serial"
                className="h-8"
                maxLength={64}
                upper
                scanTitle={t("Device serial")}
                value={d.serial}
                onValueChange={(v, m, raw) => {
                  setD((x) => ({ ...x, serial: v, serial_input: m, serial_raw: m === "manual" ? null : (raw ?? "").slice(0, 512) || null }));
                  setDups(null);
                }}
              />
            )}
            {d.source !== "none" && d.source !== "serial" && (
              <p className="text-[11px] text-muted-foreground">{t("The serial is taken from the register for a picked device.")}</p>
            )}
          </div>

          {(numbers || withLocation) && (
            <PositionFields
              idPrefix="r"
              value={d}
              onChange={(k, v) => {
                set(k, v);
              }}
              numbers={numbers}
            />
          )}

          <Field id="r-found" label={t("Found at")} hint={t("Plant time; not in the future")}>
            <Input id="r-found" type="datetime-local" className="num h-8" value={d.found_at} max={now} onChange={(e) => set("found_at", e.target.value)} />
          </Field>
          <Field id="r-cause" label={t("Cause")}>
            <Select value={d.cause ?? NONE} onValueChange={(v) => set("cause", v === NONE ? null : (v as FaultCause))}>
              <SelectTrigger id="r-cause" size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>{t("Not known yet")}</SelectItem>
                <SelectSeparator />
                {CAUSE_KEYS.map((k) => (
                  <SelectItem key={k} value={k}>
                    {t(CAUSE[k])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field id="r-owner" label={t("Owner")}>
            <OwnerSelect id="r-owner" people={plantId ? people : []} value={d.owner} onChange={(v) => set("owner", v)} />
          </Field>
          <Field id="r-next" label={t("Next action by")} hint={t("Past this day the fault shows Follow up. Empty = nothing is flagged.")}>
            <DayInput id="r-next" value={d.next} onChange={(v) => set("next", v)} min={today} clearable placeholder={t("No date")} />
          </Field>
          {d.kind === "service" && (
            <Field id="r-ref" label={t("Reference")} hint={t("Carrier ticket no., config version, …")}>
              <Input id="r-ref" className="num h-8" maxLength={120} value={d.reference} onChange={(e) => set("reference", e.target.value)} />
            </Field>
          )}
          <Field id="r-urls" label={t("Evidence links")} hint={t("One https:// link per line (Drive folder, photo, KB page)")} wide>
            <Textarea id="r-urls" className="min-h-14 font-mono text-xs" value={d.urls} onChange={(e) => set("urls", e.target.value)} />
          </Field>
        </div>

        {problems.length > 0 && <p className="text-[11px] text-muted-foreground">{problems.join(" · ")}</p>}
        <Footer busy={busy} error={error} onClose={onClose} label={t("Record fault")} disabled={problems.length > 0 || (dups != null && dups.length > 0)} onSubmit={() => void save(false)} />
      </DialogContent>
    </Dialog>
  );
};

const DevicePick: React.FC<{ id: string; loading: boolean; empty: string; value: string; onChange: (v: string) => void; options: Array<{ value: string; label: string }> }> = ({
  id,
  loading,
  empty,
  value,
  onChange,
  options,
}) => {
  const { t } = useI18n();
  if (loading)
    return (
      <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Spinner className="size-3" /> {t("Reading devices…")}
      </p>
    );
  if (!options.length) return <p className="text-[11px] text-muted-foreground">{empty}</p>;
  return (
    <Select value={value || NONE} onValueChange={(v) => onChange(v === NONE ? "" : v)}>
      <SelectTrigger id={id} size="sm" className="w-full">
        <SelectValue placeholder={t("Pick a device")} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>{t("Not picked")}</SelectItem>
        <SelectSeparator />
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
};
