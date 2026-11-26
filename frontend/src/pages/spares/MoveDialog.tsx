import React, { useEffect, useMemo, useState } from "react";
import { api, type InputMethod, type StockLocation, type StockMovementRow, type StockPart, type StockUnit } from "../../api/client";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { ScanField } from "../../components/scan/ScanField";
import { useAppContext } from "../../context/AppContext";
import { useI18n } from "../../i18n";
import { notify } from "../../lib/notify";
import { PlantPicker } from "../calendar/fields";
import { KIND_LABEL, MOVE_LABEL, canManageStock, errorText } from "./shared";
import { RegistryReceiveWarning, registryKey, useRegistryWhere } from "./RegistryWhere";

export type MoveKind = Exclude<StockMovementRow["kind"], never>;

const NONE = "__none";

/**
 * One movement of one serialised unit (phase 1, by hand; batch scanning comes in phase 4):
 * receive (store keeper), transfer between store / bins / vans, install at a plant, return from a
 * plant. The serial field takes a keyboard scanner or the camera and keeps how it was entered.
 */
export const MoveDialog: React.FC<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind: MoveKind;
  parts: StockPart[];
  locations: StockLocation[];
  /** a unit picked in the Stock tab: its part and serial are fixed */
  unit?: StockUnit | null;
  onDone: () => void;
}> = ({ open, onOpenChange, kind: initialKind, parts, locations, unit, onDone }) => {
  const { t } = useI18n();
  const { user, growattPlants } = useAppContext();
  const keeper = canManageStock(user);
  const [kind, setKind] = useState<MoveKind>(initialKind);
  const [partId, setPartId] = useState<string>(NONE);
  const [serial, setSerial] = useState("");
  const [method, setMethod] = useState<InputMethod>("manual");
  const [raw, setRaw] = useState(""); // the scan as read (ScanField's 3rd argument), not the normalised serial
  const [toId, setToId] = useState<string>(NONE);
  const [plantId, setPlantId] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setKind(initialKind);
    setPartId(unit ? String(unit.part_id) : NONE);
    setSerial(unit?.serial ?? "");
    setMethod("manual");
    setRaw("");
    setToId(NONE);
    setPlantId(unit?.plant_id ?? null);
    setNote("");
    setError(null);
  }, [open, initialKind, unit]);

  // L-3: receiving a serial the registry has installed on a plant warns (never blocks)
  const receiveHits = useRegistryWhere(open && kind === "receive" ? [serial] : [])[registryKey(serial)];
  const part = parts.find((p) => String(p.id) === partId) ?? null;
  const stockLocs = useMemo(() => locations.filter((l) => l.active && l.kind !== "supplier"), [locations]);
  const needsTo = kind !== "issue";
  const needsPlant = kind === "issue";
  const kinds: MoveKind[] = keeper ? ["receive", "transfer", "issue", "return"] : ["transfer", "issue", "return"];
  const ready = !!part && serial.trim() !== "" && (!needsTo || toId !== NONE) && (!needsPlant || plantId != null);

  const submit = async () => {
    if (!ready || !part) return;
    setBusy(true);
    setError(null);
    try {
      const row: StockMovementRow = {
        kind,
        ...(unit ? { unit_id: unit.id } : { part_id: part.id, serial: serial.trim() }),
        ...(needsTo ? { to_location_id: Number(toId) } : {}),
        ...(kind === "issue" || kind === "return" ? (plantId != null ? { plant_id: plantId } : {}) : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
        input_method: method,
        ...(method !== "manual" && raw ? { raw_scan: raw } : {}),
      };
      await api.postStockBatch([row]);
      notify("ok", t("{what}: {part} {serial}", { what: t(MOVE_LABEL[kind]), part: part.code, serial: serial.trim() }));
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
          <DialogTitle>{t(MOVE_LABEL[kind])}</DialogTitle>
          <DialogDescription>{t("One unit, by its serial. Each move is kept in the movement log and is never edited.")}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3 text-xs">
          {!unit && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="mv-kind" className="text-xs">
                {t("Move")}
              </Label>
              <Select value={kind} onValueChange={(v) => setKind(v as MoveKind)}>
                <SelectTrigger id="mv-kind" size="sm" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {kinds.map((k) => (
                    <SelectItem key={k} value={k}>
                      {t(MOVE_LABEL[k])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="mv-part" className="text-xs">
              {t("Part")}
            </Label>
            <Select value={partId} onValueChange={setPartId} disabled={!!unit}>
              <SelectTrigger id="mv-part" size="sm" className="w-full">
                <SelectValue placeholder={t("Pick a part")} />
              </SelectTrigger>
              <SelectContent>
                {parts
                  .filter((p) => p.active || String(p.id) === partId)
                  .map((p) => (
                    <SelectItem key={p.id} value={String(p.id)}>
                      {p.code} · {p.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="mv-serial" className="text-xs">
              {t("Serial no.")}
            </Label>
            <ScanField
              id="mv-serial"
              maxLength={64}
              upper
              disabled={!!unit}
              scanTitle={t("Serial no.")}
              fieldHint={part ? { category: part.category, model: [part.make, part.model].filter(Boolean).join(" ") || part.code } : undefined}
              value={serial}
              onValueChange={(v, m, raw) => {
                setSerial(v);
                setMethod(m);
                setRaw(m !== "manual" ? (raw ?? "").slice(0, 512) : "");
              }}
            />
          </div>
          {kind === "receive" && <RegistryReceiveWarning hits={receiveHits} />}
          {needsTo && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="mv-to" className="text-xs">
                {t("To")}
              </Label>
              <Select value={toId} onValueChange={setToId}>
                <SelectTrigger id="mv-to" size="sm" className="w-full">
                  <SelectValue placeholder={t("Pick a store, bin or van")} />
                </SelectTrigger>
                <SelectContent>
                  {stockLocs.map((l) => (
                    <SelectItem key={l.id} value={String(l.id)}>
                      {l.code} · {l.name} ({t(KIND_LABEL[l.kind])})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {needsPlant && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="mv-plant" className="text-xs">
                {t("Plant")}
              </Label>
              <PlantPicker id="mv-plant" plants={growattPlants} value={plantId} onChange={setPlantId} />
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="mv-note" className="text-xs">
              {t("Note")}
            </Label>
            <Input id="mv-note" value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} className="h-8" />
          </div>
          {error && (
            <Alert variant="destructive">
              <AlertDescription className="whitespace-pre-line">{error}</AlertDescription>
            </Alert>
          )}
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
