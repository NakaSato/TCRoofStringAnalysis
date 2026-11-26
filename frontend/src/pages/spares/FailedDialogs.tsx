import React, { useEffect, useMemo, useState } from "react";
import { ApiError, api, FAILED_OPEN_STATUSES, type Claim, type FailedUnitDetail, type FailedUnitMove, type InputMethod, type StockLocation, type StockMovement, type StockPart } from "../../api/client";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { SkeletonRows } from "../../components/ui";
import { MethodBadge } from "../../components/scan/ScanDialog";
import { ScanField } from "../../components/scan/ScanField";
import { plantToday } from "../../context/alarmLogStore";
import { useAppContext } from "../../context/AppContext";
import { useI18n } from "../../i18n";
import { notify } from "../../lib/notify";
import { GLOBAL_FORMATS, SERIAL_FORMATS } from "../../lib/scan/decoder";
import { parseAppCode } from "../../lib/scan/parse";
import { PlantPicker } from "../calendar/fields";
import { STATUS as CLAIM_STATUS } from "../claims/format";
import { FailedStatusBadges } from "./FailedTab";
import { KIND_LABEL, MOVE_LABEL, canManageStock, errorText } from "./shared";
import { RegistryChip, registryKey, useRegistryWhere } from "./RegistryWhere";

const NONE = "__none";

export const Row: React.FC<{ id?: string; label: string; children: React.ReactNode; hint?: string }> = ({ id, label, children, hint }) => (
  <div className="flex flex-col gap-1.5">
    <Label htmlFor={id} className="text-xs">
      {label}
    </Label>
    {children}
    {hint && <span className="text-[11px] text-muted-foreground">{hint}</span>}
  </div>
);

/** a scanned red tag label (`/s/rt/RT-0103`, `rt:RT-0103`) keeps just its code */
export const redTagCode = (v: string) => {
  const ac = parseAppCode(v);
  return ac?.kind === "rt" ? ac.code.toUpperCase() : v;
};

export const LocationSelect: React.FC<{ id: string; value: string; onChange: (v: string) => void; locations: StockLocation[]; placeholder: string; className?: string }> = ({
  id,
  value,
  onChange,
  locations,
  placeholder,
  className,
}) => {
  const { t } = useI18n();
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger id={id} size="sm" className={className ? `w-full ${className}` : "w-full"}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {locations.map((l) => (
          <SelectItem key={l.id} value={String(l.id)}>
            {l.code} · {l.name} ({t(KIND_LABEL[l.kind])})
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
};

export const ErrorAlert: React.FC<{ error: string | null }> = ({ error }) =>
  error ? (
    <Alert variant="destructive">
      <AlertDescription className="whitespace-pre-line">{error}</AlertDescription>
    </Alert>
  ) : null;

/**
 * Bind a red tag to a failed unit taken off site (§5.3 step 2, §5.4): anyone signed in. The tag is
 * a pre-printed blank `rt` label; a tag already used is refused by the API (409).
 */
export const TagFailedDialog: React.FC<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  parts: StockPart[];
  locations: StockLocation[];
  onDone: () => void;
}> = ({ open, onOpenChange, parts, locations, onDone }) => {
  const { t } = useI18n();
  const { growattPlants } = useAppContext();
  const [tag, setTag] = useState("");
  const [partId, setPartId] = useState(NONE);
  const [serial, setSerial] = useState("");
  const [method, setMethod] = useState<InputMethod>("manual");
  const [plantId, setPlantId] = useState<number | null>(null);
  const [fault, setFault] = useState("");
  const [toId, setToId] = useState(NONE);
  const [day, setDay] = useState(plantToday());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setTag("");
    setPartId(NONE);
    setSerial("");
    setMethod("manual");
    setPlantId(null);
    setFault("");
    setToId(NONE);
    setDay(plantToday());
    setError(null);
  }, [open]);

  const activeParts = useMemo(() => parts.filter((p) => p.active), [parts]);
  const stockLocs = useMemo(() => locations.filter((l) => l.active && l.kind !== "supplier"), [locations]);
  const part = activeParts.find((p) => String(p.id) === partId) ?? null;
  const today = plantToday();
  const dayOk = /^\d{4}-\d{2}-\d{2}$/.test(day) && day <= today;
  const ready = tag.trim() !== "" && fault.trim() !== "" && toId !== NONE && dayOk;

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const s = serial.trim();
      const u = await api.createFailedUnit({
        red_tag: tag.trim(),
        fault: fault.trim(),
        to_location_id: Number(toId),
        removed_day: day,
        ...(part ? { part_id: part.id } : {}),
        ...(plantId != null ? { plant_id: plantId } : {}),
        ...(s ? { serial: s, input_method: method, ...(method !== "manual" ? { raw_scan: serial } : {}) } : {}),
      });
      notify("ok", t("Red tag {tag} bound to the failed unit.", { tag: u.red_tag }));
      onDone();
      onOpenChange(false);
    } catch (e) {
      setError(errorText(e, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("Tag a failed unit")}</DialogTitle>
          <DialogDescription>{t("Scan a blank red tag and tie it to the unit taken off site. The tag then opens this unit.")}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3 text-xs">
          <Row id="fu-tag" label={t("Red tag")}>
            <ScanField
              id="fu-tag"
              maxLength={64}
              upper
              formats={GLOBAL_FORMATS}
              scanTitle={t("Red tag")}
              placeholder="RT-0001"
              value={tag}
              onValueChange={(v) => setTag(redTagCode(v))}
            />
          </Row>
          <Row id="fu-part" label={t("Part")}>
            <Select value={partId} onValueChange={setPartId}>
              <SelectTrigger id="fu-part" size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>{t("Not in the catalogue")}</SelectItem>
                {activeParts.map((p) => (
                  <SelectItem key={p.id} value={String(p.id)}>
                    {p.code} · {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Row>
          <Row id="fu-serial" label={t("Serial no.")} hint={t("Optional")}>
            <ScanField
              id="fu-serial"
              maxLength={64}
              upper
              formats={SERIAL_FORMATS}
              scanTitle={t("Serial no.")}
              fieldHint={part ? { category: part.category, model: [part.make, part.model].filter(Boolean).join(" ") || part.code } : undefined}
              value={serial}
              onValueChange={(v, m) => {
                setSerial(v);
                setMethod(m);
              }}
            />
          </Row>
          <Row id="fu-plant" label={t("Plant")} hint={t("Optional")}>
            <div className="flex items-center gap-1.5">
              <PlantPicker id="fu-plant" plants={growattPlants} value={plantId} onChange={setPlantId} className="min-w-0 flex-1 justify-between" />
              {plantId != null && (
                <Button size="sm" variant="ghost" onClick={() => setPlantId(null)}>
                  {t("Clear")}
                </Button>
              )}
            </div>
          </Row>
          <Row id="fu-fault" label={t("Fault found")}>
            <Textarea id="fu-fault" value={fault} maxLength={2000} rows={3} onChange={(e) => setFault(e.target.value)} placeholder={t("What is wrong with it")} />
          </Row>
          <div className="grid gap-3 sm:grid-cols-2">
            <Row id="fu-to" label={t("Where it is now")}>
              <LocationSelect id="fu-to" value={toId} onChange={setToId} locations={stockLocs} placeholder={t("Pick a store, bin or van")} />
            </Row>
            <Row id="fu-day" label={t("Removed on")}>
              <Input id="fu-day" type="date" value={day} max={today} onChange={(e) => setDay(e.target.value)} className="h-8" />
            </Row>
          </div>
          <ErrorAlert error={error} />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("Cancel")}
          </Button>
          <Button disabled={!ready || busy} onClick={() => void submit()}>
            {busy && <Spinner data-icon="inline-start" />}
            {t("Save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

type Mode = null | "transfer" | "ship" | "back" | "scrap" | "claim" | "edit";

const Fact: React.FC<{ label: string; children: React.ReactNode; mono?: boolean }> = ({ label, children, mono }) => (
  <div className="flex min-w-0 flex-col">
    <span className="text-[11px] text-muted-foreground">{label}</span>
    <span className={mono ? "truncate font-mono text-xs text-slate-100" : "truncate text-xs text-slate-100"}>{children}</span>
  </div>
);

const placeOf = (m: StockMovement, side: "from" | "to") => {
  const code = side === "from" ? m.from_location_code : m.to_location_code;
  if (code) return code;
  if (side === "from" && m.kind === "failed_in") return m.plant_name ?? "—";
  return "—";
};

/**
 * One failed unit: where it is, its trail (newest first) and what can be done next. Move: anyone,
 * while it is with us; ship to / back from the supplier and scrap: admin or store keeper.
 */
export const FailedUnitDialog: React.FC<{
  id: number | null;
  onOpenChange: (open: boolean) => void;
  parts: StockPart[];
  locations: StockLocation[];
  onChanged: () => void;
}> = ({ id, onOpenChange, parts, locations, onChanged }) => {
  const { t } = useI18n();
  const { user } = useAppContext();
  const keeper = canManageStock(user);
  const [unit, setUnit] = useState<FailedUnitDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // action fields
  const [toId, setToId] = useState(NONE);
  const [carrier, setCarrier] = useState("");
  const [tracking, setTracking] = useState("");
  const [outcome, setOutcome] = useState<"repaired" | "replaced">("repaired");
  const [newSerial, setNewSerial] = useState("");
  const [note, setNote] = useState("");
  const [claimId, setClaimId] = useState(NONE);
  const [claims, setClaims] = useState<Claim[] | null>(null);
  const [fault, setFault] = useState("");
  const [partId, setPartId] = useState(NONE);
  // L-3: the registry device with this serial
  const registryHits = useRegistryWhere([unit?.serial])[registryKey(unit?.serial)];

  const load = (fid: number) =>
    api
      .getFailedUnit(fid)
      .then((u) => {
        setUnit(u);
        setLoadError(null);
      })
      .catch((e) => setLoadError(e instanceof ApiError && e.status === 404 ? t("This failed unit was not found, or it is on a plant you do not see.") : errorText(e, t)));

  useEffect(() => {
    setUnit(null);
    setLoadError(null);
    setMode(null);
    if (id != null) void load(id);
  }, [id]);

  const startMode = (m: Mode) => {
    setMode(m);
    setError(null);
    setToId(NONE);
    setCarrier("");
    setTracking("");
    setOutcome("repaired");
    setNewSerial("");
    setNote("");
    setClaimId(unit?.claim_id != null ? String(unit.claim_id) : NONE);
    setFault(unit?.fault ?? "");
    setPartId(unit?.part_id != null ? String(unit.part_id) : NONE);
    if (m === "claim" && !claims)
      api
        .listClaims()
        .then((l) => setClaims(l.claims))
        .catch((e) => {
          setClaims([]);
          setError(errorText(e, t));
        });
  };

  const stockLocs = useMemo(() => locations.filter((l) => l.active && l.kind !== "supplier"), [locations]);
  const supplierLocs = useMemo(() => locations.filter((l) => l.active && l.kind === "supplier"), [locations]);
  const plantClaims = useMemo(
    () => (claims ?? []).filter((c) => unit?.plant_id == null || c.plant_id === unit.plant_id || c.id === unit.claim_id),
    [claims, unit]
  );

  const isOpen = !!unit && FAILED_OPEN_STATUSES.includes(unit.status);
  const withUs = !!unit && (unit.status === "tagged" || unit.status === "in_store");

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    if (!unit) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
      notify("ok", ok);
      setMode(null);
      await load(unit.id);
      onChanged();
    } catch (e) {
      setError(errorText(e, t));
    } finally {
      setBusy(false);
    }
  };

  const move = (body: FailedUnitMove, ok: string) =>
    run(() => api.moveFailedUnit(unit!.id, { ...body, ...(note.trim() ? { note: note.trim() } : {}) }), ok);

  const ready =
    mode === "transfer" || mode === "ship"
      ? toId !== NONE
      : mode === "back"
        ? toId !== NONE && (outcome === "repaired" || newSerial.trim() !== "") && unit?.part_id != null
        : mode === "edit"
          ? fault.trim() !== ""
          : true;

  const submit = () => {
    if (!unit || !ready) return;
    const tag = unit.red_tag;
    if (mode === "transfer") void move({ kind: "transfer", to_location_id: Number(toId) }, t("{tag} moved.", { tag }));
    else if (mode === "ship")
      void move(
        {
          kind: "ship_out",
          to_location_id: Number(toId),
          ...(carrier.trim() ? { carrier: carrier.trim() } : {}),
          ...(tracking.trim() ? { tracking_no: tracking.trim() } : {}),
        },
        t("{tag} sent to the supplier.", { tag })
      );
    else if (mode === "back")
      void move(
        { kind: "supplier_return", to_location_id: Number(toId), outcome, ...(outcome === "replaced" ? { new_serial: newSerial.trim() } : {}) },
        t("{tag} back from the supplier.", { tag })
      );
    else if (mode === "scrap") void move({ kind: "scrap" }, t("{tag} scrapped.", { tag }));
    else if (mode === "claim")
      void run(() => api.updateFailedUnit(unit.id, { claim_id: claimId === NONE ? null : Number(claimId) }), t("Saved {code}.", { code: tag }));
    else if (mode === "edit")
      void run(
        () => api.updateFailedUnit(unit.id, { fault: fault.trim(), part_id: partId === NONE ? null : Number(partId) }),
        t("Saved {code}.", { code: tag })
      );
  };

  const MODE_TITLE: Record<Exclude<Mode, null>, string> = {
    transfer: "Move it",
    ship: "Ship to supplier",
    back: "Back from supplier",
    scrap: "Scrap",
    claim: "Link a claim",
    edit: "Edit details",
  };

  return (
    <Dialog open={id != null} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xl">{unit?.red_tag ?? t("Failed unit")}</span>
            {unit && <FailedStatusBadges unit={unit} />}
          </DialogTitle>
          <DialogDescription>{t("A failed unit taken off site, with every move from the plant to the supplier and back.")}</DialogDescription>
        </DialogHeader>
        {loadError ? (
          <ErrorAlert error={loadError} />
        ) : !unit ? (
          <SkeletonRows rows={4} />
        ) : (
          <div className="flex min-w-0 flex-col gap-4 text-xs">
            <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
              <Fact label={t("Part")}>{unit.part_code ? `${unit.part_code} · ${unit.part_name ?? ""}` : t("Not in the catalogue")}</Fact>
              <Fact label={t("Serial no.")} mono>
                {unit.serial ?? "—"}
              </Fact>
              <Fact label={t("Plant")}>{unit.plant_name ?? (unit.plant_id != null ? t("Plant {id}", { id: unit.plant_id }) : "—")}</Fact>
              <Fact label={t("Device")}>{unit.site_device_label ?? unit.inverter_sn ?? "—"}</Fact>
              {registryHits && (
                <div className="col-span-2 flex min-w-0 flex-col gap-0.5 sm:col-span-3">
                  <span className="text-[11px] text-muted-foreground">{t("In the registry")}</span>
                  <RegistryChip hits={registryHits} />
                </div>
              )}
              <Fact label={t("Removed on")}>
                <span className="num">{unit.removed_day}</span> · {t("{n} days", { n: unit.age_days })}
              </Fact>
              <Fact label={t("Where")} mono>
                {unit.location_code ?? "—"}
              </Fact>
              <Fact label={t("Claim")} mono>
                {unit.claim_number ?? "—"}
              </Fact>
              <Fact label={t("Tagged by")}>{unit.created_by ?? "—"}</Fact>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-[11px] text-muted-foreground">{t("Fault found")}</span>
              <p className="text-xs whitespace-pre-line text-slate-100">{unit.fault}</p>
            </div>

            {mode == null ? (
              <div className="flex flex-wrap gap-2">
                {withUs && (
                  <Button size="sm" variant="outline" onClick={() => startMode("transfer")} disabled={!stockLocs.length}>
                    {t("Move it")}
                  </Button>
                )}
                {keeper && withUs && (
                  <Button size="sm" variant="outline" onClick={() => startMode("ship")} disabled={!supplierLocs.length} title={supplierLocs.length ? undefined : t("Add a supplier location first")}>
                    {t("Ship to supplier")}
                  </Button>
                )}
                {keeper && unit.status === "sent" && (
                  <Button size="sm" variant="outline" onClick={() => startMode("back")} disabled={!stockLocs.length}>
                    {t("Back from supplier")}
                  </Button>
                )}
                <Button size="sm" variant="outline" onClick={() => startMode("claim")}>
                  {t("Link a claim")}
                </Button>
                <Button size="sm" variant="outline" onClick={() => startMode("edit")}>
                  {t("Edit details")}
                </Button>
                {keeper && isOpen && (
                  <Button size="sm" variant="outline" className="text-red-300" onClick={() => startMode("scrap")}>
                    {t("Scrap")}
                  </Button>
                )}
              </div>
            ) : (
              <div className="flex flex-col gap-3 rounded-lg border border-white/[0.07] p-3">
                <span className="text-sm font-medium">{t(MODE_TITLE[mode])}</span>
                {(mode === "transfer" || mode === "back") && (
                  <Row id="fa-to" label={t("To")}>
                    <LocationSelect id="fa-to" value={toId} onChange={setToId} locations={stockLocs} placeholder={t("Pick a store, bin or van")} />
                  </Row>
                )}
                {mode === "ship" && (
                  <>
                    <Row id="fa-to" label={t("Supplier")}>
                      <LocationSelect id="fa-to" value={toId} onChange={setToId} locations={supplierLocs} placeholder={t("Pick a supplier")} />
                    </Row>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Row id="fa-carrier" label={t("Carrier")} hint={t("Optional")}>
                        <Input id="fa-carrier" value={carrier} maxLength={120} onChange={(e) => setCarrier(e.target.value)} className="h-8" />
                      </Row>
                      <Row id="fa-track" label={t("Tracking no.")} hint={t("Optional")}>
                        <Input id="fa-track" value={tracking} maxLength={120} onChange={(e) => setTracking(e.target.value)} className="h-8 font-mono" />
                      </Row>
                    </div>
                  </>
                )}
                {mode === "back" && (
                  <>
                    {unit.part_id == null && (
                      <Alert variant="warn">
                        <AlertDescription>{t("Set its part first (Edit details): a unit back from the supplier goes into stock as that part.")}</AlertDescription>
                      </Alert>
                    )}
                    <Row id="fa-outcome" label={t("Outcome")}>
                      <Select value={outcome} onValueChange={(v) => setOutcome(v as "repaired" | "replaced")}>
                        <SelectTrigger id="fa-outcome" size="sm" className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="repaired">{t("Repaired (same serial)")}</SelectItem>
                          <SelectItem value="replaced">{t("Replaced by a new unit")}</SelectItem>
                        </SelectContent>
                      </Select>
                    </Row>
                    {outcome === "replaced" && (
                      <Row id="fa-new" label={t("New serial no.")}>
                        <ScanField id="fa-new" maxLength={64} upper formats={SERIAL_FORMATS} scanTitle={t("New serial no.")} value={newSerial} onValueChange={(v) => setNewSerial(v)} />
                      </Row>
                    )}
                  </>
                )}
                {mode === "scrap" && <p className="text-xs text-amber-300">{t("Scrap {tag}? It leaves the register for good; the trail stays.", { tag: unit.red_tag })}</p>}
                {mode === "claim" &&
                  (!claims ? (
                    <SkeletonRows rows={1} />
                  ) : (
                    <Row id="fa-claim" label={t("Claim")} hint={unit.plant_id != null ? t("Claims on the same plant") : undefined}>
                      <Select value={claimId} onValueChange={setClaimId}>
                        <SelectTrigger id="fa-claim" size="sm" className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={NONE}>{t("None")}</SelectItem>
                          {plantClaims.map((c) => (
                            <SelectItem key={c.id} value={String(c.id)}>
                              {c.number} · {t(CLAIM_STATUS[c.status].label)}
                              {c.device_sn ? ` · ${c.device_sn}` : ""}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Row>
                  ))}
                {mode === "edit" && (
                  <>
                    <Row id="fa-part" label={t("Part")}>
                      <Select value={partId} onValueChange={setPartId}>
                        <SelectTrigger id="fa-part" size="sm" className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={NONE}>{t("Not in the catalogue")}</SelectItem>
                          {parts
                            .filter((p) => p.active || String(p.id) === partId)
                            .map((p) => (
                              <SelectItem key={p.id} value={String(p.id)}>
                                {p.code} · {p.name}
                              </SelectItem>
                            ))}
                        </SelectContent>
                      </Select>
                    </Row>
                    <Row id="fa-fault" label={t("Fault found")}>
                      <Textarea id="fa-fault" value={fault} maxLength={2000} rows={3} onChange={(e) => setFault(e.target.value)} />
                    </Row>
                  </>
                )}
                {(mode === "transfer" || mode === "ship" || mode === "back" || mode === "scrap") && (
                  <Row id="fa-note" label={t("Note")}>
                    <Input id="fa-note" value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} className="h-8" />
                  </Row>
                )}
                <ErrorAlert error={error} />
                <div className="flex justify-end gap-2">
                  <Button size="sm" variant="ghost" onClick={() => setMode(null)}>
                    {t("Cancel")}
                  </Button>
                  <Button size="sm" variant={mode === "scrap" ? "destructive" : "default"} disabled={!ready || busy} onClick={submit}>
                    {busy && <Spinner data-icon="inline-start" />}
                    {mode === "scrap" ? t("Yes, scrap it") : t("Save")}
                  </Button>
                </div>
              </div>
            )}

            <div className="flex flex-col gap-1.5">
              <span className="text-[11px] text-muted-foreground">{t("Trail")}</span>
              {!unit.trail.length ? (
                <p className="text-xs text-muted-foreground">{t("No movements yet.")}</p>
              ) : (
                <ol className="flex flex-col divide-y divide-white/[0.05] rounded-lg border border-white/[0.07]">
                  {unit.trail.map((m) => (
                    <li key={m.id} className="flex flex-col gap-0.5 px-3 py-2">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="num text-muted-foreground">{m.day}</span>
                        <span className="font-medium text-slate-100">{t(MOVE_LABEL[m.kind])}</span>
                        {/* a return or scrap also moves a spare unit: its serial tells the two rows apart */}
                        {m.serial && <span className="font-mono text-slate-300">{m.serial}</span>}
                        {(placeOf(m, "from") !== "—" || placeOf(m, "to") !== "—") && (
                          <span className="font-mono text-muted-foreground">
                            {placeOf(m, "from")} → {placeOf(m, "to")}
                          </span>
                        )}
                        <span className="flex-1" />
                        <span className="flex items-center gap-1.5 text-muted-foreground">
                          {m.by ?? "—"}
                          {m.input_method && <MethodBadge method={m.input_method} />}
                        </span>
                      </span>
                      {m.note && <span className="text-[11px] break-words whitespace-pre-line text-muted-foreground">{m.note}</span>}
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("Close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
