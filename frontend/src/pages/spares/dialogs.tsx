import React, { useEffect, useState } from "react";
import {
  api,
  LOCATION_KINDS,
  PART_CATEGORIES,
  type LocationKind,
  type PartCategory,
  type StockLocation,
  type StockMovement,
  type StockPart,
} from "../../api/client";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { useI18n } from "../../i18n";
import { notify } from "../../lib/notify";
import { CATEGORY_LABEL, KIND_LABEL, MOVE_LABEL, errorText } from "./shared";

const NONE = "__none";

const Row: React.FC<{ id: string; label: string; children: React.ReactNode; hint?: string }> = ({ id, label, children, hint }) => (
  <div className="flex flex-col gap-1.5">
    <Label htmlFor={id} className="text-xs">
      {label}
    </Label>
    {children}
    {hint && <span className="text-[11px] text-muted-foreground">{hint}</span>}
  </div>
);

const useSave = (onDone: () => void, close: () => void) => {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      notify("ok", ok);
      onDone();
      close();
    } catch (e) {
      setError(errorText(e, t));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, setError, run };
};

/** Add or edit a catalogue part (admin or store keeper). Serialised units only in v1 (D-2). */
export const PartDialog: React.FC<{ part: StockPart | null; open: boolean; onOpenChange: (o: boolean) => void; onDone: () => void }> = ({
  part,
  open,
  onOpenChange,
  onDone,
}) => {
  const { t } = useI18n();
  const [d, setD] = useState({ code: "", name: "", category: "router" as PartCategory, make: "", model: "", min_qty: "", active: true, note: "" });
  const { busy, error, setError, run } = useSave(onDone, () => onOpenChange(false));
  useEffect(() => {
    if (!open) return;
    setError(null);
    setD({
      code: part?.code ?? "",
      name: part?.name ?? "",
      category: part?.category ?? "router",
      make: part?.make ?? "",
      model: part?.model ?? "",
      min_qty: part?.min_qty != null ? String(part.min_qty) : "",
      active: part?.active ?? true,
      note: part?.note ?? "",
    });
  }, [open, part]);
  const minOk = d.min_qty.trim() === "" || /^\d+$/.test(d.min_qty.trim());
  const save = () => {
    const body = {
      code: d.code.trim(),
      name: d.name.trim(),
      category: d.category,
      make: d.make.trim() || null,
      model: d.model.trim() || null,
      min_qty: d.min_qty.trim() === "" ? null : Number(d.min_qty),
      active: d.active,
      note: d.note.trim() || null,
    };
    void run(() => (part ? api.updateStockPart(part.id, body) : api.createStockPart(body)), t("Saved {code}.", { code: body.code.toUpperCase() }));
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{part ? t("Edit part") : t("Add part")}</DialogTitle>
          <DialogDescription>{t("Each unit of a part has its own serial. Counted parts (fuses, connectors) come later.")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 text-xs sm:grid-cols-2">
          <Row id="pt-code" label={t("Part code")} hint={t("e.g. P-ROUTER-RUT241")}>
            <Input id="pt-code" value={d.code} maxLength={40} onChange={(e) => setD({ ...d, code: e.target.value.toUpperCase() })} className="h-8 font-mono" />
          </Row>
          <Row id="pt-cat" label={t("Category")}>
            <Select value={d.category} onValueChange={(v) => setD({ ...d, category: v as PartCategory })}>
              <SelectTrigger id="pt-cat" size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PART_CATEGORIES.map((c) => (
                  <SelectItem key={c} value={c}>
                    {t(CATEGORY_LABEL[c])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Row>
          <div className="sm:col-span-2">
            <Row id="pt-name" label={t("Name")}>
              <Input id="pt-name" value={d.name} maxLength={120} onChange={(e) => setD({ ...d, name: e.target.value })} className="h-8" />
            </Row>
          </div>
          <Row id="pt-make" label={t("Make")}>
            <Input id="pt-make" value={d.make} maxLength={64} onChange={(e) => setD({ ...d, make: e.target.value })} className="h-8" />
          </Row>
          <Row id="pt-model" label={t("Model")}>
            <Input id="pt-model" value={d.model} maxLength={64} onChange={(e) => setD({ ...d, model: e.target.value })} className="h-8" />
          </Row>
          <Row id="pt-min" label={t("Minimum in stock")} hint={t("Below it, the part is flagged (nothing is ordered). Empty = no minimum.")}>
            <Input id="pt-min" inputMode="numeric" value={d.min_qty} onChange={(e) => setD({ ...d, min_qty: e.target.value })} className="h-8 w-24" aria-invalid={!minOk} />
          </Row>
          <label className="flex items-center gap-2 self-end pb-2">
            <Checkbox checked={d.active} onCheckedChange={(v) => setD({ ...d, active: v === true })} />
            {t("Active")}
          </label>
          <div className="sm:col-span-2">
            <Row id="pt-note" label={t("Note")}>
              <Textarea id="pt-note" value={d.note} maxLength={2000} rows={2} onChange={(e) => setD({ ...d, note: e.target.value })} />
            </Row>
          </div>
          {error && (
            <Alert variant="destructive" className="sm:col-span-2">
              <AlertDescription className="whitespace-pre-line">{error}</AlertDescription>
            </Alert>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("Cancel")}
          </Button>
          <Button disabled={busy || !d.code.trim() || !d.name.trim() || !minOk} onClick={save}>
            {busy && <Spinner data-icon="inline-start" />}
            {t("Save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

/** Add or edit a stock location (admin or store keeper): a store, a bin in a store, a crew's van, a supplier. */
export const LocationDialog: React.FC<{
  location: StockLocation | null;
  locations: StockLocation[];
  people: { id: number; name: string }[];
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onDone: () => void;
}> = ({ location, locations, people, open, onOpenChange, onDone }) => {
  const { t } = useI18n();
  const [d, setD] = useState({ code: "", name: "", kind: "bin" as LocationKind, parent: NONE, holder: NONE, active: true, note: "" });
  const { busy, error, setError, run } = useSave(onDone, () => onOpenChange(false));
  useEffect(() => {
    if (!open) return;
    setError(null);
    setD({
      code: location?.code ?? "",
      name: location?.name ?? "",
      kind: location?.kind ?? (locations.some((l) => l.kind === "store") ? "bin" : "store"),
      parent: location?.parent_id != null ? String(location.parent_id) : locations.find((l) => l.kind === "store")?.id.toString() ?? NONE,
      holder: location?.holder_user_id != null ? String(location.holder_user_id) : NONE,
      active: location?.active ?? true,
      note: location?.note ?? "",
    });
  }, [open, location, locations]);
  const stores = locations.filter((l) => l.kind === "store" && l.id !== location?.id);
  const ok = d.code.trim() && d.name.trim() && (d.kind !== "bin" || d.parent !== NONE);
  const save = () => {
    const body = {
      code: d.code.trim(),
      name: d.name.trim(),
      kind: d.kind,
      parent_id: d.kind === "bin" && d.parent !== NONE ? Number(d.parent) : null,
      holder_user_id: d.kind === "van" && d.holder !== NONE ? Number(d.holder) : null,
      active: d.active,
      note: d.note.trim() || null,
    };
    void run(() => (location ? api.updateStockLocation(location.id, body) : api.createStockLocation(body)), t("Saved {code}.", { code: body.code.toUpperCase() }));
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{location ? t("Edit location") : t("Add location")}</DialogTitle>
          <DialogDescription>{t("Where spares sit: the store and its bins, and one location per crew van.")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 text-xs sm:grid-cols-2">
          <Row id="loc-code" label={t("Code")} hint={t("e.g. STORE-A-03, VAN-CREW2")}>
            <Input id="loc-code" value={d.code} maxLength={32} onChange={(e) => setD({ ...d, code: e.target.value.toUpperCase() })} className="h-8 font-mono" />
          </Row>
          <Row id="loc-kind" label={t("Kind")}>
            <Select value={d.kind} onValueChange={(v) => setD({ ...d, kind: v as LocationKind })}>
              <SelectTrigger id="loc-kind" size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LOCATION_KINDS.map((k) => (
                  <SelectItem key={k} value={k}>
                    {t(KIND_LABEL[k])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Row>
          <div className="sm:col-span-2">
            <Row id="loc-name" label={t("Name")}>
              <Input id="loc-name" value={d.name} maxLength={120} onChange={(e) => setD({ ...d, name: e.target.value })} className="h-8" />
            </Row>
          </div>
          {d.kind === "bin" && (
            <Row id="loc-parent" label={t("In store")}>
              <Select value={d.parent} onValueChange={(v) => setD({ ...d, parent: v })}>
                <SelectTrigger id="loc-parent" size="sm" className="w-full">
                  <SelectValue placeholder={t("Add a store first")} />
                </SelectTrigger>
                <SelectContent>
                  {stores.map((s) => (
                    <SelectItem key={s.id} value={String(s.id)}>
                      {s.code} · {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Row>
          )}
          {d.kind === "van" && (
            <Row id="loc-holder" label={t("Crew lead")}>
              <Select value={d.holder} onValueChange={(v) => setD({ ...d, holder: v })}>
                <SelectTrigger id="loc-holder" size="sm" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>{t("Nobody")}</SelectItem>
                  {people.map((p) => (
                    <SelectItem key={p.id} value={String(p.id)}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Row>
          )}
          <label className="flex items-center gap-2 self-end pb-2">
            <Checkbox checked={d.active} onCheckedChange={(v) => setD({ ...d, active: v === true })} />
            {t("Active")}
          </label>
          <div className="sm:col-span-2">
            <Row id="loc-note" label={t("Note")}>
              <Textarea id="loc-note" value={d.note} maxLength={2000} rows={2} onChange={(e) => setD({ ...d, note: e.target.value })} />
            </Row>
          </div>
          {error && (
            <Alert variant="destructive" className="sm:col-span-2">
              <AlertDescription className="whitespace-pre-line">{error}</AlertDescription>
            </Alert>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("Cancel")}
          </Button>
          <Button disabled={busy || !ok} onClick={save}>
            {busy && <Spinner data-icon="inline-start" />}
            {t("Save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

/** Undo a unit's latest movement with a correction row (admin or store keeper); the reason is required. */
export const CorrectDialog: React.FC<{ movement: StockMovement | null; onOpenChange: (o: boolean) => void; onDone: () => void }> = ({
  movement,
  onOpenChange,
  onDone,
}) => {
  const { t } = useI18n();
  const [note, setNote] = useState("");
  const { busy, error, setError, run } = useSave(onDone, () => onOpenChange(false));
  useEffect(() => {
    setNote("");
    setError(null);
  }, [movement]);
  return (
    <Dialog open={!!movement} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("Correct a movement")}</DialogTitle>
          <DialogDescription>
            {movement &&
              t("Undo “{what}” of {part} {serial} on {day}. The original stays in the log; a correction is added.", {
                what: t(MOVE_LABEL[movement.kind]),
                part: movement.part_code ?? "",
                serial: movement.serial ?? "",
                day: movement.day,
              })}
          </DialogDescription>
        </DialogHeader>
        <Row id="corr-note" label={t("Reason")}>
          <Textarea id="corr-note" value={note} maxLength={2000} rows={2} onChange={(e) => setNote(e.target.value)} />
        </Row>
        {error && (
          <Alert variant="destructive">
            <AlertDescription className="whitespace-pre-line">{error}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("Cancel")}
          </Button>
          <Button
            variant="destructive"
            disabled={busy || !note.trim() || !movement}
            onClick={() => movement && void run(() => api.correctStockMovement(movement.id, note.trim()), t("Corrected."))}
          >
            {busy && <Spinner data-icon="inline-start" />}
            {t("Add correction")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
