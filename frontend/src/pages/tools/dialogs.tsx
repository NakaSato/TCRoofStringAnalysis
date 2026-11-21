/** Measuring Tools dialogs: add / edit instrument (admin), check out, check in, record a
 * calibration or document renewal (admin), confirm delete / retire. */
import React, { useEffect, useMemo, useState } from "react";
import { api } from "../../api/client";
import type { CheckoutCondition, DueKind, Instrument, InstrumentBody, InstrumentCategory, UserProfile } from "../../api/client";
import { useAppContext } from "../../context/AppContext";
import { isAdmin } from "../../auth/access";
import { plantToday } from "../../context/alarmLogStore";
import { fromDate, toDate } from "@/lib/day";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { toolsApi } from "./useInstruments";
import { CATEGORIES, DUE_KIND, addDays, addMonths, categoryOf, fmtDay } from "./format";
import { isWebUrl } from "@/lib/safeUrl";
import { translate, useI18n } from "../../i18n";

const NONE = "__none";
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** "" → null, else a finite number, else undefined (= invalid) */
const numOrNull = (s: string): number | null | undefined => {
  const t = s.trim().replace(/,/g, "");
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
};

export const Field: React.FC<{ id: string; label: string; wide?: boolean; hint?: string; children: React.ReactNode }> = ({ id, label, wide, hint, children }) => (
  <div className={wide ? "space-y-1.5 sm:col-span-2" : "space-y-1.5"}>
    <Label htmlFor={id}>{label}</Label>
    {children}
    {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
  </div>
);

/** a day from a Popover + Calendar; `min` / `max` limit the choice */
export const DayInput: React.FC<{
  id: string;
  value: string | null;
  onChange: (d: string | null) => void;
  min?: string;
  max?: string;
  placeholder?: string;
  clearable?: boolean;
}> = ({ id, value, onChange, min, max, placeholder, clearable }) => {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const disabled = [...(min ? [{ before: toDate(min) }] : []), ...(max ? [{ after: toDate(max) }] : [])];
  return (
    <div className="flex gap-1">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button id={id} variant="outline" size="sm" className="num w-full justify-start">
            {value ? fmtDay(value) : <span className="text-slate-500">{placeholder ?? t("Pick a day")}</span>}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            mode="single"
            captionLayout="dropdown"
            selected={value ? toDate(value) : undefined}
            defaultMonth={toDate(value ?? min ?? plantToday())}
            disabled={disabled}
            onSelect={(d) => {
              if (!d) return;
              onChange(fromDate(d));
              setOpen(false);
            }}
          />
        </PopoverContent>
      </Popover>
      {clearable && value && (
        <Button variant="ghost" size="sm" onClick={() => onChange(null)}>
          {t("Clear")}
        </Button>
      )}
    </div>
  );
};

export const Footer: React.FC<{ busy: boolean; error: string | null; onClose: () => void; onSubmit: () => void; label: string; disabled?: boolean; destructive?: boolean }> = ({
  busy,
  error,
  onClose,
  onSubmit,
  label,
  disabled,
  destructive,
}) => {
  const { t } = useI18n();
  return (
    <>
      {error && <div className="callout-crit text-xs">{error}</div>}
      <DialogFooter>
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          {t("Cancel")}
        </Button>
        <Button variant={destructive ? "destructive" : "default"} onClick={onSubmit} disabled={busy || disabled}>
          {busy && <Spinner data-icon="inline-start" className="size-3" />}
          {label}
        </Button>
      </DialogFooter>
    </>
  );
};

/** run an async action with busy / error state; closes and calls `onDone` on success */
export function useSubmit(onDone: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onDone();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, setError, run };
}

/* ------------------------------------------------------------------ add / edit (admin) */

interface Draft {
  asset_tag: string;
  name: string;
  category: InstrumentCategory;
  make: string;
  model: string;
  serial_no: string;
  specs: Record<string, string>;
  interval: string;
  purchase_day: string | null;
  cost: string;
  note: string;
}

const toDraft = (i: Instrument | null): Draft => ({
  asset_tag: i?.asset_tag ?? "",
  name: i?.name ?? "",
  category: i?.category ?? "clamp_meter",
  make: i?.make ?? "",
  model: i?.model ?? "",
  serial_no: i?.serial_no ?? "",
  specs: Object.fromEntries(Object.entries(i?.specs ?? {}).map(([k, v]) => [k, v == null ? "" : String(v)])),
  interval: i?.calibration_interval_months != null ? String(i.calibration_interval_months) : "",
  purchase_day: i?.purchase_day ?? null,
  cost: i?.cost_thb != null ? String(i.cost_thb) : "",
  note: i?.note ?? "",
});

export const InstrumentDialog: React.FC<{ open: boolean; editing: Instrument | null; onClose: () => void; onSaved: () => void }> = ({
  open,
  editing,
  onClose,
  onSaved,
}) => {
  const { t } = useI18n();
  const [d, setD] = useState<Draft>(() => toDraft(editing));
  const { busy, error, setError, run } = useSubmit(() => {
    onSaved();
    onClose();
  });
  useEffect(() => {
    if (open) {
      setD(toDraft(editing));
      setError(null);
    }
  }, [open, editing, setError]);
  const set = (p: Partial<Draft>) => setD((x) => ({ ...x, ...p }));
  const def = categoryOf(d.category);
  const usesCalibration = def.dueKinds.includes("calibration");

  const submit = () => {
    const specs: InstrumentBody["specs"] = {};
    for (const f of def.specs) {
      const raw = (d.specs[f.key] ?? "").trim();
      if (f.kind === "number") {
        const n = numOrNull(raw);
        if (n === undefined) return setError(t("{label} must be a number", { label: t(f.label) }));
        specs[f.key] = n;
      } else specs[f.key] = raw || null;
    }
    const interval = numOrNull(d.interval);
    const cost = numOrNull(d.cost);
    if (interval === undefined || (interval != null && (interval <= 0 || !Number.isInteger(interval)))) return setError(t("Interval must be whole months"));
    if (cost === undefined) return setError(t("Cost must be a number"));
    const body: InstrumentBody = {
      asset_tag: d.asset_tag.trim(),
      name: d.name.trim(),
      category: d.category,
      make: d.make.trim() || null,
      model: d.model.trim() || null,
      serial_no: d.serial_no.trim() || null,
      specs,
      calibration_interval_months: usesCalibration ? interval : null,
      purchase_day: d.purchase_day,
      cost_thb: cost,
      note: d.note.trim() || null,
    };
    void run(() => (editing ? toolsApi.patchInstrument(editing.id, body) : toolsApi.createInstrument(body)));
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{editing ? t("Edit {name}", { name: editing.asset_tag }) : t("Add instrument")}</DialogTitle>
          <DialogDescription>{t('Leave a field empty when you don\'t know it: it shows as "—", never as a typical value.')}</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field id="in-cat" label={t("Category")} wide>
            <Select value={d.category} onValueChange={(v) => set({ category: v as InstrumentCategory })}>
              <SelectTrigger id="in-cat" size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CATEGORIES.map((c) => (
                  <SelectItem key={c.value} value={c.value}>
                    <c.icon />
                    {t(c.label)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field id="in-tag" label={t("Asset tag")}>
            <Input id="in-tag" value={d.asset_tag} onChange={(e) => set({ asset_tag: e.target.value })} placeholder={t("e.g. MT-012")} />
          </Field>
          <Field id="in-name" label={t("Name")}>
            <Input id="in-name" value={d.name} onChange={(e) => set({ name: e.target.value })} placeholder={t("e.g. DC clamp meter")} />
          </Field>
          <Field id="in-make" label={t("Make")}>
            <Input id="in-make" value={d.make} onChange={(e) => set({ make: e.target.value })} />
          </Field>
          <Field id="in-model" label={t("Model")}>
            <Input id="in-model" value={d.model} onChange={(e) => set({ model: e.target.value })} />
          </Field>
          <Field id="in-sn" label={t("Serial no.")} wide>
            <Input id="in-sn" value={d.serial_no} onChange={(e) => set({ serial_no: e.target.value })} />
          </Field>

          <div className="eyebrow pt-1 sm:col-span-2">{t("Specs · {name}", { name: t(def.label) })}</div>
          {def.specs.map((f) => (
            <Field key={f.key} id={`in-spec-${f.key}`} label={f.unit ? `${t(f.label)} (${t(f.unit)})` : t(f.label)}>
              <Input
                id={`in-spec-${f.key}`}
                inputMode={f.kind === "number" ? "decimal" : undefined}
                value={d.specs[f.key] ?? ""}
                placeholder={f.placeholder && t(f.placeholder)}
                onChange={(e) => set({ specs: { ...d.specs, [f.key]: e.target.value } })}
              />
            </Field>
          ))}

          <div className="eyebrow pt-1 sm:col-span-2">{t("Ownership")}</div>
          {usesCalibration && (
            <Field
              id="in-int"
              label={t("Calibration interval (months)")}
              hint={t("Used to set the next due date from a calibration day. Empty = enter each due date by hand.")}
            >
              <Input id="in-int" inputMode="numeric" value={d.interval} onChange={(e) => set({ interval: e.target.value })} />
            </Field>
          )}
          <Field id="in-buy" label={t("Purchased")}>
            <DayInput id="in-buy" value={d.purchase_day} onChange={(v) => set({ purchase_day: v })} max={plantToday()} clearable placeholder={t("Not entered")} />
          </Field>
          <Field id="in-cost" label={t("Cost (THB)")}>
            <Input id="in-cost" inputMode="decimal" value={d.cost} onChange={(e) => set({ cost: e.target.value })} />
          </Field>
          <Field id="in-note" label={t("Note")} wide>
            <Textarea id="in-note" rows={2} value={d.note} onChange={(e) => set({ note: e.target.value })} />
          </Field>
        </div>
        <Footer busy={busy} error={error} onClose={onClose} onSubmit={submit} label={editing ? t("Save") : t("Add")} disabled={!d.asset_tag.trim() || !d.name.trim()} />
      </DialogContent>
    </Dialog>
  );
};

/* ------------------------------------------------------------------ check out */

/** warnings shown before a check-out; the keys are recorded as acknowledged (title / text translated) */
export function checkoutWarnings(i: Instrument): Array<{ key: string; title: string; text: string; crit: boolean }> {
  const out: Array<{ key: string; title: string; text: string; crit: boolean }> = [];
  const cal = i.due.find((x) => x.kind === "calibration");
  if (cal?.state === "overdue")
    out.push({
      key: "calibration_overdue",
      title: translate("Calibration overdue"),
      text: translate("Overdue since {day}: readings may not be valid.", { day: fmtDay(cal.next_due) }),
      crit: false,
    });
  if (i.category === "drone") {
    const expired = i.due.filter((x) => x.state === "overdue").map((x) => translate(DUE_KIND[x.kind]));
    if (expired.length)
      out.push({ key: "drone_documents_expired", title: translate("{list} expired", { list: expired.join(", ") }), text: translate("Do not fly until it is renewed."), crit: true });
  }
  return out;
}

export const CheckoutDialog: React.FC<{ instrument: Instrument | null; onClose: () => void; onDone: () => void }> = ({ instrument, onClose, onDone }) => {
  const { user, growattPlants } = useAppContext();
  const admin = isAdmin(user);
  const { t } = useI18n();
  const today = plantToday();
  const [plant, setPlant] = useState(NONE);
  const [holder, setHolder] = useState(NONE);
  const [dueBack, setDueBack] = useState<string | null>(addDays(today, 1));
  const [note, setNote] = useState("");
  const [ack, setAck] = useState(false);
  const [users, setUsers] = useState<UserProfile[]>([]);
  const { busy, error, setError, run } = useSubmit(() => {
    onDone();
    onClose();
  });
  const warnings = useMemo(() => (instrument ? checkoutWarnings(instrument) : []), [instrument]);

  useEffect(() => {
    if (!instrument) return;
    setPlant(NONE);
    setHolder(NONE);
    setDueBack(addDays(plantToday(), 1));
    setNote("");
    setAck(false);
    setError(null);
  }, [instrument, setError]);
  // admins may check out to someone else
  useEffect(() => {
    if (!instrument || !admin || users.length) return;
    api.listUsers().then((u) => setUsers(u.filter((x) => x.is_active)), () => undefined);
  }, [instrument, admin, users.length]);

  const plants = useMemo(() => [...growattPlants].sort((a, b) => a.name.localeCompare(b.name)), [growattPlants]);
  const submit = () =>
    void run(() =>
      toolsApi.checkoutInstrument(instrument!.id, {
        holder_user_id: holder === NONE ? null : Number(holder),
        plant_id: plant === NONE ? null : Number(plant),
        due_back: dueBack!,
        note: note.trim() || null,
        ack_warnings: warnings.map((w) => w.key),
      })
    );

  return (
    <Dialog open={instrument != null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("Check out {name}", { name: instrument?.asset_tag ?? "" })}</DialogTitle>
          <DialogDescription>{instrument?.name}</DialogDescription>
        </DialogHeader>
        {warnings.map((w) => (
          <Alert key={w.key} variant={w.crit ? "destructive" : "warn"}>
            <AlertTitle>{w.title}</AlertTitle>
            <AlertDescription>{w.text}</AlertDescription>
          </Alert>
        ))}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field id="co-holder" label={t("Holder")} wide={!admin}>
            {admin ? (
              <Select value={holder} onValueChange={setHolder}>
                <SelectTrigger id="co-holder" size="sm" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>{t("Me")}</SelectItem>
                  {users.filter((u) => u.id !== user?.id).length > 0 && <SelectSeparator />}
                  {users
                    .filter((u) => u.id !== user?.id)
                    .map((u) => (
                      <SelectItem key={u.id} value={String(u.id)}>
                        {u.full_name || u.username || u.email}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            ) : (
              <Input id="co-holder" value={user?.full_name || user?.username || ""} disabled />
            )}
          </Field>
          <Field id="co-back" label={t("Due back")}>
            <DayInput id="co-back" value={dueBack} onChange={setDueBack} min={today} />
          </Field>
          <Field id="co-plant" label={t("Plant")} wide>
            <Select value={plant} onValueChange={setPlant}>
              <SelectTrigger id="co-plant" size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>{t("Not to a plant")}</SelectItem>
                <SelectSeparator />
                {plants.map((p) => (
                  <SelectItem key={p.plant_id} value={String(p.plant_id)}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field id="co-note" label={t("Note")} wide>
            <Textarea id="co-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t("What it is for (IR flight, I-V test, …)")} />
          </Field>
        </div>
        {warnings.length > 0 && (
          <label className="flex items-center gap-2 text-xs text-slate-300">
            <Checkbox checked={ack} onCheckedChange={(v) => setAck(v === true)} />
            {warnings.length > 1 ? t("I have read the warnings above") : t("I have read the warning above")}
          </label>
        )}
        <Footer busy={busy} error={error} onClose={onClose} onSubmit={submit} label={t("Check out")} disabled={!dueBack || (warnings.length > 0 && !ack)} />
      </DialogContent>
    </Dialog>
  );
};

/* ------------------------------------------------------------------ check in */

const CONDITIONS: Array<{ value: CheckoutCondition; label: string; hint: string }> = [
  { value: "ok", label: "OK", hint: "Back to Available" },
  { value: "damaged", label: "Damaged", hint: "Goes to Repair" },
  { value: "lost", label: "Lost", hint: "Retired" },
];

export const ReturnDialog: React.FC<{ instrument: Instrument | null; onClose: () => void; onDone: () => void }> = ({ instrument, onClose, onDone }) => {
  const { t } = useI18n();
  const [condition, setCondition] = useState<CheckoutCondition>("ok");
  const [note, setNote] = useState("");
  const { busy, error, setError, run } = useSubmit(() => {
    onDone();
    onClose();
  });
  useEffect(() => {
    if (!instrument) return;
    setCondition("ok");
    setNote("");
    setError(null);
  }, [instrument, setError]);
  const needsNote = condition !== "ok";
  return (
    <Dialog open={instrument != null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("Check in {name}", { name: instrument?.asset_tag ?? "" })}</DialogTitle>
          <DialogDescription>
            {instrument?.name}
            {instrument?.open_checkout?.holder ? ` · ${t("held by {name}", { name: instrument.open_checkout.holder.name })}` : ""}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <Field id="rt-cond" label={t("Condition")}>
            <Select value={condition} onValueChange={(v) => setCondition(v as CheckoutCondition)}>
              <SelectTrigger id="rt-cond" size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CONDITIONS.map((c) => (
                  <SelectItem key={c.value} value={c.value}>
                    {t(c.label)} <span className="text-muted-foreground">· {t(c.hint)}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field id="rt-note" label={needsNote ? t("What happened") : t("Note")}>
            <Textarea id="rt-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
        </div>
        <Footer
          busy={busy}
          error={error}
          onClose={onClose}
          onSubmit={() => void run(() => toolsApi.returnInstrument(instrument!.id, { condition, note: note.trim() || null }))}
          label={t("Check in")}
          disabled={needsNote && !note.trim()}
        />
      </DialogContent>
    </Dialog>
  );
};

/* ------------------------------------------------------------------ calibration / renewal (admin) */

export const DueDialog: React.FC<{ target: { instrument: Instrument; kind?: DueKind } | null; onClose: () => void; onDone: () => void }> = ({
  target,
  onClose,
  onDone,
}) => {
  const { t } = useI18n();
  const instrument = target?.instrument ?? null;
  const kinds = instrument ? categoryOf(instrument.category).dueKinds : [];
  const [kind, setKind] = useState<DueKind>("calibration");
  const [day, setDay] = useState<string | null>(plantToday());
  const [next, setNext] = useState<string | null>(null);
  const [number, setNumber] = useState("");
  const [issuer, setIssuer] = useState("");
  const [cost, setCost] = useState("");
  const [url, setUrl] = useState("");
  const [note, setNote] = useState("");
  const { busy, error, setError, run } = useSubmit(() => {
    onDone();
    onClose();
  });
  useEffect(() => {
    if (!target) return;
    const k = target.kind ?? categoryOf(target.instrument.category).dueKinds[0];
    const prev = target.instrument.due.find((x) => x.kind === k);
    setKind(k);
    setDay(plantToday());
    setNext(null);
    setNumber(prev?.number ?? "");
    setIssuer(prev?.issuer ?? "");
    setCost("");
    setUrl("");
    setNote("");
    setError(null);
  }, [target, setError]);

  const interval = instrument?.calibration_interval_months ?? null;
  const fromInterval = kind === "calibration" && interval && day ? addMonths(day, interval) : null;
  const submit = () => {
    if (url.trim() && !isWebUrl(url)) return setError(t("The link must start with http:// or https://"));
    const c = numOrNull(cost);
    if (c === undefined) return setError(t("Cost must be a number"));
    void run(() =>
      toolsApi.recordInstrumentDue(instrument!.id, {
        kind,
        day: day!,
        next_due: next,
        number: number.trim() || null,
        issuer: issuer.trim() || null,
        cost_thb: c,
        url: url.trim() || null,
        note: note.trim() || null,
      })
    );
  };

  return (
    <Dialog open={target != null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t(kind === "calibration" ? "Record calibration · {name}" : "Record renewal · {name}", { name: instrument?.asset_tag ?? "" })}</DialogTitle>
          <DialogDescription>{instrument?.name}</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {kinds.length > 1 && (
            <Field id="du-kind" label={t("What")} wide>
              <Select value={kind} onValueChange={(v) => setKind(v as DueKind)}>
                <SelectTrigger id="du-kind" size="sm" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {kinds.map((k) => (
                    <SelectItem key={k} value={k}>
                      {t(DUE_KIND[k])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
          <Field id="du-day" label={kind === "calibration" ? t("Calibrated on") : t("Issued / renewed on")}>
            <DayInput id="du-day" value={day} onChange={setDay} max={plantToday()} />
          </Field>
          <Field
            id="du-next"
            label={t("Next due")}
            hint={
              next
                ? undefined
                : fromInterval
                  ? t("Empty = {day} ({n}-month interval)", { day: fmtDay(fromInterval), n: interval })
                  : t("Empty = no due date (shown as “No date”)")
            }
          >
            <DayInput id="du-next" value={next} onChange={setNext} min={day ?? undefined} clearable placeholder={fromInterval ? fmtDay(fromInterval) : t("Not entered")} />
          </Field>
          <Field id="du-no" label={kind === "calibration" ? t("Certificate no.") : t("Number")}>
            <Input id="du-no" value={number} onChange={(e) => setNumber(e.target.value)} />
          </Field>
          <Field id="du-iss" label={kind === "calibration" ? t("Lab") : t("Issuer")}>
            <Input id="du-iss" value={issuer} onChange={(e) => setIssuer(e.target.value)} />
          </Field>
          <Field id="du-cost" label={t("Cost (THB)")}>
            <Input id="du-cost" inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} />
          </Field>
          <Field id="du-url" label={t("Document link")}>
            <Input id="du-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" aria-invalid={url.trim() !== "" && !isWebUrl(url)} />
          </Field>
          <Field id="du-note" label={t("Note")} wide>
            <Textarea id="du-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
        </div>
        <Footer busy={busy} error={error} onClose={onClose} onSubmit={submit} label={t("Record")} disabled={!day} />
      </DialogContent>
    </Dialog>
  );
};

/* ------------------------------------------------------------------ confirm (retire / delete) */

export const ConfirmDialog: React.FC<{
  open: boolean;
  title: string;
  text: string;
  label: string;
  onClose: () => void;
  onConfirm: () => Promise<unknown>;
  onDone: () => void;
}> = ({ open, title, text, label, onClose, onConfirm, onDone }) => {
  const { busy, error, setError, run } = useSubmit(() => {
    onDone();
    onClose();
  });
  useEffect(() => {
    if (open) setError(null);
  }, [open, setError]);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{text}</DialogDescription>
        </DialogHeader>
        <Footer busy={busy} error={error} onClose={onClose} onSubmit={() => void run(onConfirm)} label={label} destructive />
      </DialogContent>
    </Dialog>
  );
};
