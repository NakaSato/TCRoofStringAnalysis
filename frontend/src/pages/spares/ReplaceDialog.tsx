/**
 * Replacement on site (docs/plans/spares-failed-units.md §5.3, phase 3): one step at a time, made
 * for a phone camera. Pick the device, scan the old unit's serial, bind a blank red tag and say what
 * is wrong, scan the spare going in, say where the failed unit goes, then confirm. One request does
 * it all: the failed unit is tagged, the spare is installed and the register's serial is updated at
 * once (D-4). When the old label's serial is not the register's, the API answers 409
 * `register_mismatch` and the person confirms the update (or goes back to the old serial).
 */
import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, ArrowRight, Check, CircleAlert, ClipboardList, PackageOpen, TriangleAlert } from "lucide-react";
import {
  ApiError,
  api,
  type InputMethod,
  type RegisterMismatch,
  type ReplacementBody,
  type ReplacementResult,
  type ReplaceTarget,
  type ReplaceTargets,
  type SiteDeviceKind,
  type StockLocation,
  type StockUnit,
} from "../../api/client";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { SkeletonRows } from "../../components/ui";
import { ScanField } from "../../components/scan/ScanField";
import { plantToday } from "../../context/alarmLogStore";
import { useAppContext } from "../../context/AppContext";
import { useI18n } from "../../i18n";
import { newClaimHref } from "@/lib/claimLinks";
import { GLOBAL_FORMATS, SERIAL_FORMATS } from "../../lib/scan/decoder";
import { cn } from "@/lib/utils";
import { PlantPicker } from "../calendar/fields";
import { ErrorAlert, LocationSelect, Row, redTagCode } from "./FailedDialogs";
import { CATEGORY_LABEL, KIND_LABEL, errorText } from "./shared";

/** opened from a Site register tile: its plant and that device */
export interface ReplacePreset {
  plantId: number;
  device?: { id?: number; kind: SiteDeviceKind; seq: number; serial: string | null };
}

const STEPS = ["Device", "Old unit", "Red tag", "New spare", "Goes to", "Confirm"] as const;
type Step = 0 | 1 | 2 | 3 | 4 | 5;

const norm = (s: string | null | undefined) => (s ?? "").trim().toUpperCase();
const keyOf = (d: ReplaceTarget) => (d.kind === "inverter" ? `inv:${d.inverter_sn}` : `sd:${d.site_device_id}`);
const categoryLabel = (c: string) => (c in CATEGORY_LABEL ? CATEGORY_LABEL[c as keyof typeof CATEGORY_LABEL] : c);

/** the tile's device among the plant's targets: by its id; without one (an old API), same serial, else the kind's only one, else its seq-th */
const matchPreset = (devices: ReplaceTarget[], p: NonNullable<ReplacePreset["device"]>): ReplaceTarget | null => {
  if (p.id != null) return devices.find((d) => d.kind === "site_device" && d.site_device_id === p.id) ?? null;
  const same = devices.filter((d) => d.kind === "site_device" && d.category === p.kind);
  if (p.serial) {
    const bySerial = same.find((d) => norm(d.serial) === norm(p.serial));
    if (bySerial) return bySerial;
  }
  if (same.length === 1) return same[0];
  return same[p.seq - 1] ?? null;
};

const isMismatch = (e: unknown): e is ApiError & { detail: RegisterMismatch } =>
  e instanceof ApiError && e.status === 409 && !!e.detail && typeof e.detail === "object" && (e.detail as { code?: string }).code === "register_mismatch";

const StepDots: React.FC<{ step: Step; done: boolean }> = ({ step, done }) => {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-1.5">
      <ol className="flex items-center gap-1" aria-label={t("Steps")}>
        {STEPS.map((s, i) => (
          <li
            key={s}
            aria-current={i === step && !done ? "step" : undefined}
            className={cn("h-1.5 flex-1 rounded-full", done || i < step ? "bg-solar-400/70" : i === step ? "bg-solar-400" : "bg-white/10")}
            title={t(s)}
          />
        ))}
      </ol>
      <span className="text-[11px] text-muted-foreground">
        {done ? t("Done") : t("Step {n} of {total}: {name}", { n: step + 1, total: STEPS.length, name: t(STEPS[step]) })}
      </span>
    </div>
  );
};

/** one line of the summary / result: what changes */
const Change: React.FC<{ icon: React.ReactNode; children: React.ReactNode }> = ({ icon, children }) => (
  <li className="flex items-start gap-2 rounded-lg border border-white/[0.07] px-3 py-2.5 text-sm text-slate-100">
    <span className="mt-0.5 shrink-0 text-slate-400">{icon}</span>
    <span className="min-w-0 break-words">{children}</span>
  </li>
);

export const ReplaceDialog: React.FC<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  preset?: ReplacePreset | null;
  /** the page's stock locations; read here when not given */
  locations?: StockLocation[];
  /** after a replacement went through (reload what shows the serial) */
  onDone?: (r: ReplacementResult) => void;
}> = ({ open, onOpenChange, preset, locations: locationsProp, onDone }) => {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { growattPlants, user } = useAppContext();
  const [step, setStep] = useState<Step>(0);
  // 1 device
  const [plantId, setPlantId] = useState<number | null>(null);
  const [targets, setTargets] = useState<ReplaceTargets | null>(null);
  const [targetsError, setTargetsError] = useState<string | null>(null);
  const [targetKey, setTargetKey] = useState<string | null>(null);
  const [presetDone, setPresetDone] = useState(false);
  // 2 old unit
  const [oldSerial, setOldSerial] = useState("");
  const [oldMethod, setOldMethod] = useState<InputMethod>("manual");
  const [oldRaw, setOldRaw] = useState("");
  // 3 red tag + fault
  const [tag, setTag] = useState("");
  const [tagMethod, setTagMethod] = useState<InputMethod>("manual");
  const [tagRaw, setTagRaw] = useState("");
  const [fault, setFault] = useState("");
  // 4 new spare
  const [newSerial, setNewSerial] = useState("");
  const [newMethod, setNewMethod] = useState<InputMethod>("manual");
  const [newRaw, setNewRaw] = useState("");
  const [matches, setMatches] = useState<StockUnit[] | null>(null);
  const [lookupBusy, setLookupBusy] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [newUnitId, setNewUnitId] = useState<number | null>(null);
  // 5 where the failed unit goes
  const [loadedLocations, setLoadedLocations] = useState<StockLocation[] | null>(null);
  const [toId, setToId] = useState<string | null>(null);
  const [day, setDay] = useState(plantToday());
  const [note, setNote] = useState("");
  // 6 confirm / result
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mismatch, setMismatch] = useState<RegisterMismatch | null>(null);
  const [result, setResult] = useState<ReplacementResult | null>(null);

  // a fresh form on every open
  useEffect(() => {
    if (!open) return;
    setStep(0);
    setPlantId(preset?.plantId ?? null);
    setTargets(null);
    setTargetsError(null);
    setTargetKey(null);
    setPresetDone(false);
    setOldSerial("");
    setOldMethod("manual");
    setOldRaw("");
    setTag("");
    setTagMethod("manual");
    setTagRaw("");
    setFault("");
    setNewSerial("");
    setNewMethod("manual");
    setNewRaw("");
    setMatches(null);
    setLookupError(null);
    setNewUnitId(null);
    setToId(null);
    setDay(plantToday());
    setNote("");
    setBusy(false);
    setError(null);
    setMismatch(null);
    setResult(null);
  }, [open]);

  // the plant's devices
  useEffect(() => {
    if (!open || plantId == null) return;
    let alive = true;
    setTargets(null);
    setTargetsError(null);
    setTargetKey(null);
    api
      .getReplaceTargets(plantId)
      .then((r) => alive && setTargets(r))
      .catch((e) => alive && setTargetsError(e instanceof ApiError && e.status === 404 ? t("This plant was not found, or you do not see it.") : errorText(e, t)));
    return () => {
      alive = false;
    };
  }, [open, plantId]);

  // preset from a Site register tile: select its device once and go on to the old unit
  useEffect(() => {
    if (!open || presetDone || !targets || !preset?.device || targets.plant_id !== preset.plantId) return;
    setPresetDone(true);
    const m = matchPreset(targets.devices, preset.device);
    if (m) {
      setTargetKey(keyOf(m));
      setStep(1);
    }
  }, [open, presetDone, targets, preset]);

  // stock locations, when the page did not pass them
  useEffect(() => {
    if (!open || locationsProp || loadedLocations) return;
    api
      .listStockLocations()
      .then(setLoadedLocations)
      .catch((e) => setError(errorText(e, t)));
  }, [open, locationsProp, loadedLocations]);

  // the new spare by its serial: in stock, exact serial
  useEffect(() => {
    const s = norm(newSerial);
    setNewUnitId(null);
    setLookupError(null);
    if (s.length < 3) {
      setMatches(null);
      setLookupBusy(false);
      return;
    }
    let alive = true;
    setLookupBusy(true);
    const h = setTimeout(() => {
      api
        .listStockUnits({ q: s, state: "in_stock" })
        .then((list) => {
          if (!alive) return;
          const exact = list.filter((u) => u.state === "in_stock" && norm(u.serial) === s);
          setMatches(exact);
          if (exact.length === 1) setNewUnitId(exact[0].id);
        })
        .catch((e) => alive && setLookupError(errorText(e, t)))
        .finally(() => alive && setLookupBusy(false));
    }, 350);
    return () => {
      alive = false;
      clearTimeout(h);
    };
  }, [newSerial]);

  const locations = locationsProp ?? loadedLocations ?? [];
  const stockLocs = useMemo(() => locations.filter((l) => l.active && l.kind !== "supplier"), [locations]);
  const locById = useMemo(() => new Map(locations.map((l) => [l.id, l])), [locations]);
  const target = targets?.devices.find((d) => keyOf(d) === targetKey) ?? null;
  const newUnit = matches?.find((u) => u.id === newUnitId) ?? null;
  const hint = target ? { category: target.category, model: target.model } : undefined;
  const plantName = targets?.plant_name ?? (plantId != null ? (growattPlants.find((p) => p.plant_id === plantId)?.name ?? t("Plant {id}", { id: plantId })) : "—");

  // default for the failed unit: the spare's van, else the user's own van
  const defaultTo = useMemo(() => {
    const from = newUnit?.location_id != null ? locById.get(newUnit.location_id) : undefined;
    if (from && from.kind === "van" && from.active) return String(from.id);
    const mine = stockLocs.find((l) => l.kind === "van" && user != null && l.holder_user_id === user.id);
    return mine ? String(mine.id) : "";
  }, [newUnit, locById, stockLocs, user]);
  const to = toId ?? defaultTo;
  const toLoc = to ? locById.get(Number(to)) : undefined;

  const today = plantToday();
  const dayOk = /^\d{4}-\d{2}-\d{2}$/.test(day) && day <= today;
  const regSerial = target?.serial ?? null;
  const oldMatches = regSerial != null && norm(oldSerial) !== "" && norm(oldSerial) === norm(regSerial);
  const sameAsOld = norm(newSerial) !== "" && norm(newSerial) === norm(oldSerial);

  const ok: Record<Step, boolean> = {
    0: plantId != null && !!target,
    1: norm(oldSerial) !== "",
    2: tag.trim() !== "" && fault.trim() !== "",
    3: !!newUnit && !sameAsOld,
    4: to !== "" && dayOk,
    5: true,
  };

  const submit = async (confirm: boolean) => {
    if (!target || plantId == null || !newUnit || !to) return;
    setBusy(true);
    setError(null);
    setMismatch(null);
    const body: ReplacementBody = {
      plant_id: plantId,
      ...(target.kind === "inverter" ? { inverter_sn: target.inverter_sn ?? "" } : { site_device_id: target.site_device_id ?? undefined }),
      old_serial: oldSerial.trim(),
      old_input_method: oldMethod,
      ...(oldMethod !== "manual" && oldRaw ? { old_raw_scan: oldRaw } : {}),
      ...(confirm ? { confirm_register_update: true } : {}),
      red_tag: tag.trim(),
      red_tag_input_method: tagMethod,
      ...(tagMethod !== "manual" && tagRaw ? { red_tag_raw_scan: tagRaw } : {}),
      fault: fault.trim(),
      new_unit_id: newUnit.id,
      new_input_method: newMethod,
      ...(newMethod !== "manual" && newRaw ? { new_raw_scan: newRaw } : {}),
      failed_to_location_id: Number(to),
      removed_day: day,
      ...(note.trim() ? { note: note.trim() } : {}),
    };
    try {
      const r = await api.postReplacement(body);
      setResult(r);
      onDone?.(r);
    } catch (e) {
      if (isMismatch(e)) setMismatch(e.detail);
      else setError(errorText(e, t));
    } finally {
      setBusy(false);
    }
  };

  const openClaim = () => {
    if (!result) return;
    const p = result.claim_prefill;
    onOpenChange(false);
    navigate(
      newClaimHref("replacement", {
        plantId: p.plant_id,
        sn: p.device_sn,
        ref: p.failed_unit_id,
        claimType: p.type,
        newSn: p.new_sn,
        label: p.device_label,
        redTag: p.red_tag,
      })
    );
  };

  const openFailed = () => {
    if (!result) return;
    onOpenChange(false);
    navigate(`/inventory?tab=failed&fu=${result.failed_unit.id}`);
  };

  const registerLine = (r: { kind: "site_device" | "inverter"; old: string | null; new: string; device: string }) =>
    r.kind === "inverter"
      ? t("Growatt brings the new SN on the next fleet sync; mark the old SN not installed.")
      : t("Register {device}: {old} → {new}", { device: r.device, old: r.old ?? "—", new: r.new });

  const body = (() => {
    if (result) {
      const reg = result.register;
      const loc = result.failed_unit.location_code ?? toLoc?.code ?? "—";
      return (
        <div className="flex flex-col gap-3">
          <Alert>
            <Check />
            <AlertTitle>{t("Replacement saved")}</AlertTitle>
          </Alert>
          {result.warnings.length > 0 && (
            <Alert variant="warn">
              <TriangleAlert />
              <AlertDescription>
                <ul className="list-disc pl-4 text-xs">
                  {result.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          )}
          <ul className="flex flex-col gap-2">
            <Change icon={<CircleAlert className="size-4 text-red-300" />}>
              {t("{tag} on {serial} → {location}", { tag: result.failed_unit.red_tag, serial: result.failed_unit.serial ?? "—", location: loc })}
            </Change>
            <Change icon={<PackageOpen className="size-4 text-emerald-300" />}>
              {t("{serial} installed at {plant}", { serial: result.installed_unit.serial, plant: result.installed_unit.plant_name ?? plantName })}
            </Change>
            <Change icon={<ClipboardList className="size-4" />}>
              {reg.kind === "inverter"
                ? registerLine({ kind: "inverter", old: reg.old_serial, new: reg.new_serial, device: target?.label ?? "" })
                : reg.updated
                  ? registerLine({ kind: "site_device", old: reg.old_serial, new: reg.new_serial, device: target?.label ?? "" })
                  : t("The register was not changed.")}
            </Change>
          </ul>
        </div>
      );
    }

    switch (step) {
      case 0:
        return (
          <div className="flex flex-col gap-3">
            <Row id="rp-plant" label={t("Plant")}>
              <PlantPicker id="rp-plant" plants={growattPlants} value={plantId} onChange={setPlantId} className="h-10 w-full justify-between" />
            </Row>
            {plantId == null ? null : targetsError ? (
              <ErrorAlert error={targetsError} />
            ) : !targets ? (
              <SkeletonRows rows={3} />
            ) : !targets.devices.length ? (
              <p className="text-xs text-muted-foreground">{t("No devices to replace on this plant.")}</p>
            ) : (
              <div className="flex flex-col gap-1.5" role="radiogroup" aria-label={t("Device")}>
                <span className="text-xs">{t("Which device is replaced?")}</span>
                {targets.devices.map((d) => {
                  const k = keyOf(d);
                  const on = k === targetKey;
                  return (
                    <button
                      key={k}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      onClick={() => setTargetKey(k)}
                      className={cn(
                        "flex min-h-12 w-full min-w-0 items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors",
                        on ? "border-solar-400/60 bg-solar-400/10" : "border-white/[0.07] hover:bg-white/[0.03]"
                      )}
                    >
                      <span className={cn("grid size-5 shrink-0 place-items-center rounded-full border", on ? "border-solar-400 bg-solar-400 text-ink-950" : "border-white/20")}>
                        {on && <Check className="size-3" />}
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm text-slate-100">
                          <span className="truncate">{d.label}</span>
                          <Badge variant={d.kind === "inverter" ? "info" : "neutral"}>{t(categoryLabel(d.category))}</Badge>
                        </span>
                        <span className="truncate text-[11px] text-muted-foreground">
                          {d.model ?? "—"} · <span className="font-mono">{d.serial ?? t("no serial")}</span>
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      case 1:
        return (
          <div className="flex flex-col gap-3">
            <p className="text-xs text-muted-foreground">{t("Scan the serial on the label of the unit you take off.")}</p>
            <Row id="rp-old" label={t("Old unit serial no.")}>
              <ScanField
                id="rp-old"
                maxLength={64}
                upper
                formats={SERIAL_FORMATS}
                scanTitle={t("Old unit serial no.")}
                fieldHint={hint}
                value={oldSerial}
                onValueChange={(v, m) => {
                  setOldSerial(v);
                  setOldMethod(m);
                  setOldRaw(m !== "manual" ? v : "");
                }}
                className="h-10 text-sm"
              />
            </Row>
            <div className="flex flex-col gap-1 rounded-lg border border-white/[0.07] px-3 py-2 text-xs">
              <span className="text-muted-foreground">
                {regSerial ? (
                  <>
                    {t("Register says")} <span className="font-mono text-slate-100">{regSerial}</span>
                  </>
                ) : (
                  t("The register has no serial for this device.")
                )}
              </span>
              {regSerial && norm(oldSerial) !== "" && (
                <span className={cn("flex items-center gap-1.5", oldMatches ? "text-emerald-300" : "text-amber-300")}>
                  {oldMatches ? <Check className="size-3.5" /> : <TriangleAlert className="size-3.5" />}
                  {oldMatches ? t("Matches the register") : t("Differs from the register: you will be asked to update it")}
                </span>
              )}
            </div>
          </div>
        );
      case 2:
        return (
          <div className="flex flex-col gap-3">
            <Row id="rp-tag" label={t("Red tag")} hint={t("Tie a blank red tag to the old unit and scan it.")}>
              <ScanField
                id="rp-tag"
                maxLength={64}
                upper
                formats={GLOBAL_FORMATS}
                scanTitle={t("Red tag")}
                placeholder="RT-0001"
                value={tag}
                onValueChange={(v, m) => {
                  setTag(redTagCode(v));
                  setTagMethod(m);
                  setTagRaw(m !== "manual" ? v : "");
                }}
                className="h-10 text-sm"
              />
            </Row>
            <Row id="rp-fault" label={t("Fault found")}>
              <Textarea id="rp-fault" value={fault} maxLength={2000} rows={4} onChange={(e) => setFault(e.target.value)} placeholder={t("What is wrong with it")} className="text-sm" />
            </Row>
          </div>
        );
      case 3:
        return (
          <div className="flex flex-col gap-3">
            <Row id="rp-new" label={t("New spare serial no.")} hint={t("Scan the spare going in. It must be in stock.")}>
              <ScanField
                id="rp-new"
                maxLength={64}
                upper
                formats={SERIAL_FORMATS}
                scanTitle={t("New spare serial no.")}
                fieldHint={hint}
                value={newSerial}
                onValueChange={(v, m) => {
                  setNewSerial(v);
                  setNewMethod(m);
                  setNewRaw(m !== "manual" ? v : "");
                }}
                className="h-10 text-sm"
              />
            </Row>
            {sameAsOld ? (
              <ErrorAlert error={t("The new serial is the same as the old one.")} />
            ) : lookupError ? (
              <ErrorAlert error={lookupError} />
            ) : lookupBusy ? (
              <span className="flex items-center gap-2 text-xs text-muted-foreground">
                <Spinner className="size-3" />
                {t("Looking it up…")}
              </span>
            ) : matches == null ? null : !matches.length ? (
              <Alert variant="warn">
                <TriangleAlert />
                <AlertTitle>{t("Not in stock")}</AlertTitle>
                <AlertDescription>{t("No unit with this serial is in stock. Receive it first, or check the serial.")}</AlertDescription>
              </Alert>
            ) : (
              <div className="flex flex-col gap-1.5" role="radiogroup" aria-label={t("Spare")}>
                {matches.length > 1 && <span className="text-xs text-amber-300">{t("Several parts have this serial: pick the one in your hand.")}</span>}
                {matches.map((u) => {
                  const on = u.id === newUnitId;
                  const loc = u.location_id != null ? locById.get(u.location_id) : undefined;
                  return (
                    <button
                      key={u.id}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      onClick={() => setNewUnitId(u.id)}
                      className={cn(
                        "flex min-h-12 w-full min-w-0 items-center gap-3 rounded-lg border px-3 py-2 text-left",
                        on ? "border-emerald-400/50 bg-emerald-500/10" : "border-white/[0.07] hover:bg-white/[0.03]"
                      )}
                    >
                      <span className={cn("grid size-5 shrink-0 place-items-center rounded-full border", on ? "border-emerald-400 bg-emerald-400 text-ink-950" : "border-white/20")}>
                        {on && <Check className="size-3" />}
                      </span>
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate text-sm text-slate-100">
                          {u.part_code} · {u.part_name}
                        </span>
                        <span className="truncate text-[11px] text-muted-foreground">
                          {t("Where")}: <span className="font-mono">{u.location_code ?? "—"}</span>
                          {loc ? ` (${t(KIND_LABEL[loc.kind])})` : ""}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      case 4:
        return (
          <div className="flex flex-col gap-3">
            <Row id="rp-to" label={t("Failed unit goes to")}>
              <LocationSelect id="rp-to" value={to} onChange={setToId} locations={stockLocs} placeholder={t("Pick a store, bin or van")} className="h-10" />
            </Row>
            <Row id="rp-day" label={t("Removed on")}>
              <Input id="rp-day" type="date" value={day} max={today} onChange={(e) => setDay(e.target.value)} className="h-10" />
            </Row>
            <Row id="rp-note" label={t("Note")} hint={t("Optional")}>
              <Input id="rp-note" value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} className="h-10" />
            </Row>
          </div>
        );
      case 5:
        return (
          <div className="flex flex-col gap-3">
            <span className="text-xs text-muted-foreground">{t("These three changes are saved together:")}</span>
            <ul className="flex flex-col gap-2">
              <Change icon={<CircleAlert className="size-4 text-red-300" />}>
                {t("{tag} on {serial} → {location}", { tag: tag.trim(), serial: oldSerial.trim(), location: toLoc?.code ?? "—" })}
              </Change>
              <Change icon={<PackageOpen className="size-4 text-emerald-300" />}>{t("{serial} installed at {plant}", { serial: newUnit?.serial ?? newSerial.trim(), plant: plantName })}</Change>
              <Change icon={<ClipboardList className="size-4" />}>
                {registerLine({ kind: target?.kind ?? "site_device", old: regSerial, new: newUnit?.serial ?? newSerial.trim(), device: target?.label ?? "" })}
              </Change>
            </ul>
            {mismatch && (
              <Alert variant="warn">
                <TriangleAlert />
                <AlertTitle>{t("Register says {register}, label says {label}: update the register?", { register: mismatch.register_serial ?? "—", label: mismatch.label_serial })}</AlertTitle>
                <AlertDescription>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button size="lg" disabled={busy} onClick={() => void submit(true)}>
                      {busy && <Spinner data-icon="inline-start" />}
                      {t("Yes, update the register")}
                    </Button>
                    <Button
                      size="lg"
                      variant="outline"
                      disabled={busy}
                      onClick={() => {
                        setMismatch(null);
                        setStep(1);
                      }}
                    >
                      {t("No, check the old serial")}
                    </Button>
                  </div>
                </AlertDescription>
              </Alert>
            )}
            <ErrorAlert error={error} />
          </div>
        );
    }
  })();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92dvh] overflow-x-hidden overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("Replace a device")}</DialogTitle>
          <DialogDescription>{t("Take the failed unit off, put a spare in. The register is updated at once.")}</DialogDescription>
        </DialogHeader>
        <div className="flex min-w-0 flex-col gap-4 text-xs">
          <StepDots step={step} done={!!result} />
          {!result && step > 0 && target && (
            <span className="truncate text-[11px] text-muted-foreground">
              {plantName} · {target.label}
            </span>
          )}
          {body}
          {!result && step < 5 && error && <ErrorAlert error={error} />}
        </div>
        <DialogFooter className="flex-row flex-wrap gap-2 sm:justify-between">
          {result ? (
            <>
              <Button size="lg" variant="outline" className="flex-1 sm:flex-none" onClick={openClaim}>
                {t("Open a claim")}
              </Button>
              <Button size="lg" variant="outline" className="flex-1 sm:flex-none" onClick={openFailed}>
                {t("Open the failed unit")}
              </Button>
              <Button size="lg" className="w-full sm:w-auto" onClick={() => onOpenChange(false)}>
                {t("Done")}
              </Button>
            </>
          ) : (
            <>
              <Button size="lg" variant="ghost" className="flex-1 sm:flex-none" disabled={busy} onClick={() => {
                  if (step === 0) return onOpenChange(false);
                  setMismatch(null);
                  setError(null);
                  setStep((s) => (s - 1) as Step);
                }}>
                {step === 0 ? (
                  t("Cancel")
                ) : (
                  <>
                    <ArrowLeft data-icon="inline-start" />
                    {t("Back")}
                  </>
                )}
              </Button>
              {step < 5 ? (
                <Button size="lg" className="flex-1 sm:flex-none" disabled={!ok[step]} onClick={() => setStep((s) => (s + 1) as Step)}>
                  {t("Next")}
                  <ArrowRight data-icon="inline-end" />
                </Button>
              ) : (
                <Button size="lg" className="flex-1 sm:flex-none" disabled={busy || !!mismatch || !(ok[0] && ok[1] && ok[2] && ok[3] && ok[4])} onClick={() => void submit(false)}>
                  {busy && <Spinner data-icon="inline-start" />}
                  {t("Submit")}
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
