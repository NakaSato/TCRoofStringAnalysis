/** Edit one device of a station (the pencil on its tile in Site register → Devices on site), or add one:
 * kind, number and every field, grouped by section, or remove it. Fields a kind does not usually have stay under
 * "More fields" while empty. Saved as the station's whole list with this device replaced / added / left out
 * (`api.putPlantSiteDevices`, all or nothing); empty = null. Closing with unsaved edits asks first. */

import React, { useMemo, useState } from "react";
import { ChevronDown, Info, Trash2 } from "lucide-react";
import { api, ApiError } from "../../api/client";
import type { PlantSiteRegister, SiteDevice, SiteDeviceKind } from "../../api/client";
import { useI18n } from "../../i18n";
import { notify } from "../../lib/notify";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { KIND_ICON, KIND_LABEL, KINDS } from "./kinds";

type TextField = Exclude<keyof SiteDevice, "kind" | "seq">;
type FieldDef = { f: TextField; label: string; max?: number; date?: boolean; mono?: boolean; placeholder?: string };

/** Every editable field by section: label, column length (backend `_MAX_LEN`), date or text. */
const SECTIONS: { title: string; fields: FieldDef[] }[] = [
  {
    title: "Device",
    fields: [
      { f: "brand_model", label: "Brand / model", max: 120 },
      { f: "serial", label: "Serial number", max: 64, mono: true },
      { f: "status", label: "Status", max: 32 },
      { f: "firmware", label: "Firmware", max: 32, mono: true },
    ],
  },
  {
    title: "Communication",
    fields: [
      { f: "ip", label: "IP", max: 45, mono: true, placeholder: "192.168.1.10" },
      { f: "network", label: "Network", max: 43, mono: true, placeholder: "192.168.1.0/24" },
      { f: "sim", label: "SIM", max: 16, mono: true },
      { f: "address", label: "Address", max: 8, mono: true },
      { f: "link_status", label: "Link status", max: 64 },
    ],
  },
  {
    title: "Metering",
    fields: [
      { f: "ct_setting", label: "CT setting", max: 16, mono: true, placeholder: "400/5" },
      { f: "ct_site", label: "CT on site", max: 16, mono: true, placeholder: "400/5" },
      { f: "billing_cut_days", label: "Billing cut-off day", max: 16 },
    ],
  },
  {
    title: "Dates & warranty",
    fields: [
      { f: "sales_start", label: "Sales start", date: true },
      { f: "warranty_start", label: "Warranty start (COD)", date: true },
      { f: "warranty_end", label: "Warranty end", date: true },
      { f: "cod_clear_note", label: "Clear data COD", max: 200 },
    ],
  },
];
const FIELDS = SECTIONS.flatMap((s) => s.fields);

/** The fields each kind usually has (the rest show under "More fields" while empty; nothing with a value is hidden). */
const COMMON: TextField[] = ["brand_model", "serial", "status", "firmware", "ip", "warranty_start", "warranty_end"];
const USUAL: Record<SiteDeviceKind, Set<TextField>> = {
  datalogger: new Set([...COMMON, "network", "sim", "address", "link_status"]),
  weather_station: new Set([...COMMON, "address"]),
  revenue_meter: new Set([...COMMON, "address", "ct_setting", "ct_site", "billing_cut_days", "sales_start", "cod_clear_note"]),
  router: new Set([...COMMON, "network", "sim", "link_status"]),
  pqm: new Set([...COMMON, "address", "ct_setting", "ct_site"]),
  shinemaster: new Set([...COMMON, "network", "link_status"]),
};

const blank = (kind: SiteDeviceKind, seq: number): SiteDevice => ({
  kind,
  seq,
  brand_model: null,
  serial: null,
  firmware: null,
  ip: null,
  network: null,
  sim: null,
  address: null,
  ct_setting: null,
  ct_site: null,
  billing_cut_days: null,
  sales_start: null,
  cod_clear_note: null,
  link_status: null,
  status: null,
  warranty_start: null,
  warranty_end: null,
  note: null,
});

export const nextSeq = (rows: SiteDevice[], kind: SiteDeviceKind) => Math.max(0, ...rows.filter((r) => r.kind === kind).map((r) => r.seq)) + 1;

/** Trimmed, empty text = null: what is sent and what "unsaved" compares. */
const clean = (d: SiteDevice): SiteDevice => {
  const out: SiteDevice = { ...d };
  for (const { f } of FIELDS) out[f] = out[f]?.trim() || null;
  out.note = out.note?.trim() || null;
  return out;
};
const same = (a: SiteDevice, b: SiteDevice) => JSON.stringify(clean(a)) === JSON.stringify(clean(b));

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
/** A soft hint under a field (nothing blocks the save). */
const hintFor = (f: TextField, d: SiteDevice): string | null => {
  const v = d[f]?.trim();
  if (!v) return null;
  if (f === "ip" && !v.includes(":") && !IPV4.test(v)) return "Not an IPv4 address";
  if (f === "warranty_end" && d.warranty_start && v < d.warranty_start) return "Ends before it starts";
  if (f === "ct_site" && d.ct_setting?.trim() && d.ct_setting.trim() !== v) return "Differs from the CT setting";
  return null;
};

const uniq = (xs: (string | null)[]) => [...new Set(xs.map((x) => x?.trim()).filter((x): x is string => !!x))].sort();

/** What the dialog edits: the device at `index` of the station's list, or a new one of `kind`. */
export type DeviceTarget = { index: number } | { kind: SiteDeviceKind };

export const DeviceEditDialog: React.FC<{
  plantId: number;
  station: string;
  devices: SiteDevice[];
  target: DeviceTarget | null;
  onClose: () => void;
  onSaved: (reg: PlantSiteRegister) => void;
}> = ({ plantId, station, devices, target, onClose, onSaved }) => {
  const { t } = useI18n();
  const [initial, setInitial] = useState<SiteDevice | null>(null);
  const [draft, setDraft] = useState<SiteDevice | null>(null);
  const [busy, setBusy] = useState<"save" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [showAll, setShowAll] = useState(false);

  // a fresh draft each time the dialog opens on a device
  const [openedFor, setOpenedFor] = useState<DeviceTarget | null>(null);
  if (target !== openedFor) {
    setOpenedFor(target);
    const start = target == null ? null : "index" in target ? { ...devices[target.index] } : blank(target.kind, nextSeq(devices, target.kind));
    setInitial(start);
    setDraft(start);
    setError(null);
    setConfirmRemove(false);
    setConfirmDiscard(false);
    setShowAll(false);
  }

  const index = target && "index" in target ? target.index : null;
  const others = devices.filter((_, i) => i !== index);
  const d = draft;
  const dirty = d != null && initial != null && !same(d, initial);
  const dupe = d != null && others.some((o) => o.kind === d.kind && o.seq === d.seq);
  const badSeq = d != null && (!Number.isInteger(d.seq) || d.seq < 1 || d.seq > 99);
  const patch = (p: Partial<SiteDevice>) => {
    setDraft((x) => (x ? { ...x, ...p } : x));
    setConfirmDiscard(false);
  };

  // suggestions from this station's devices (status for every kind; model / firmware for the same kind)
  const suggest = useMemo(() => {
    const kind = d?.kind;
    const sameKind = devices.filter((x) => x.kind === kind);
    return {
      status: uniq(["ใช้งาน", ...devices.map((x) => x.status)]),
      brand_model: uniq(sameKind.map((x) => x.brand_model)),
      firmware: uniq(sameKind.map((x) => x.firmware)),
    } as Partial<Record<TextField, string[]>>;
  }, [devices, d?.kind]);

  const requestClose = () => {
    if (busy) return;
    if (dirty && !confirmDiscard) setConfirmDiscard(true);
    else onClose();
  };

  const setKind = (kind: SiteDeviceKind) => {
    if (!d || kind === d.kind) return;
    // a new device keeps its auto number in step with the kind
    const auto = index == null && d.seq === nextSeq(devices, d.kind);
    patch({ kind, ...(auto ? { seq: nextSeq(devices, kind) } : {}) });
  };

  const send = async (list: SiteDevice[], what: "save" | "remove") => {
    setBusy(what);
    setError(null);
    try {
      const reg = await api.putPlantSiteDevices(plantId, list);
      onSaved(reg);
      notify("ok", what === "remove" ? t("Device removed.") : t("Device saved."));
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const canSave = d != null && busy == null && !dupe && !badSeq && (index == null || dirty);
  const save = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!d || !canSave) return;
    const c = clean(d);
    void send(index == null ? [...devices, c] : devices.map((x, i) => (i === index ? c : x)), "save");
  };

  const usual = d ? USUAL[d.kind] : new Set<TextField>();
  const visible = (f: TextField) => showAll || usual.has(f) || !!d?.[f]?.trim();
  const hiddenCount = d ? FIELDS.filter(({ f }) => !visible(f)).length : 0;
  const Icon = d ? KIND_ICON[d.kind] : null;

  return (
    <Dialog open={target != null} onOpenChange={(o) => !o && requestClose()}>
      <DialogContent className="flex max-h-[90vh] flex-col gap-0 p-0 sm:max-w-3xl">
        <DialogHeader className="border-b border-white/[0.06] px-5 pt-5 pb-3">
          <DialogTitle className="flex items-center gap-2">
            {Icon && (
              <span className="grid size-7 shrink-0 place-items-center rounded-md bg-white/5 text-slate-300">
                <Icon className="size-4" aria-hidden />
              </span>
            )}
            {index == null ? t("Add device") : t("Edit device")}
            {d && <span className="font-normal text-slate-400">· {t(KIND_LABEL[d.kind])} {Number.isFinite(d.seq) ? d.seq : ""}</span>}
          </DialogTitle>
          <DialogDescription>{station}</DialogDescription>
        </DialogHeader>

        {d && (
          <form onSubmit={save} className="flex min-h-0 flex-1 flex-col">
            <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
              {/* kind and number */}
              <div className="flex flex-col gap-2">
                <Label className="text-[10px] text-muted-foreground" id="dev-kind-label">
                  {t("Device")}
                </Label>
                <div role="radiogroup" aria-labelledby="dev-kind-label" className="grid grid-cols-3 gap-1.5 sm:grid-cols-6">
                  {KINDS.map((k) => {
                    const KIcon = KIND_ICON[k];
                    const on = d.kind === k;
                    return (
                      <button
                        key={k}
                        type="button"
                        role="radio"
                        aria-checked={on}
                        onClick={() => setKind(k)}
                        className={cn(
                          "flex flex-col items-center gap-1 rounded-lg border px-2 py-2 text-[11px] transition outline-none focus-visible:ring-3 focus-visible:ring-ring/30",
                          on ? "border-sky-400/50 bg-sky-400/10 text-sky-100" : "border-white/[0.06] bg-white/[0.02] text-slate-400 hover:bg-white/5 hover:text-slate-200",
                        )}
                      >
                        <KIcon className="size-4" aria-hidden />
                        <span className="truncate">{t(KIND_LABEL[k])}</span>
                      </button>
                    );
                  })}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Label htmlFor="dev-seq" className="text-[10px] text-muted-foreground">
                    {t("No.")}
                  </Label>
                  <Input
                    id="dev-seq"
                    type="number"
                    min={1}
                    max={99}
                    value={Number.isFinite(d.seq) ? d.seq : ""}
                    onChange={(e) => patch({ seq: e.target.value === "" ? NaN : Number(e.target.value) })}
                    aria-invalid={dupe || badSeq}
                    aria-describedby={dupe || badSeq ? "dev-seq-msg" : undefined}
                    className="h-8 w-20 text-xs"
                  />
                  {(dupe || badSeq) && (
                    <span id="dev-seq-msg" className="flex items-center gap-2 text-[11px] text-amber-300">
                      {dupe ? t("Listed twice: change the number") : t("A number from 1 to 99")}
                      <Button type="button" variant="outline" size="xs" onClick={() => patch({ seq: nextSeq(others, d.kind) })}>
                        {t("Use {n}", { n: nextSeq(others, d.kind) })}
                      </Button>
                    </span>
                  )}
                </div>
              </div>

              {SECTIONS.map((s) => {
                const fields = s.fields.filter(({ f }) => visible(f));
                if (fields.length === 0) return null;
                return (
                  <fieldset key={s.title} className="flex flex-col gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
                    <legend className="px-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">{t(s.title)}</legend>
                    <div className="grid grid-cols-1 gap-x-3 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
                      {fields.map(({ f, label, max, date, mono, placeholder }) => {
                        const hint = hintFor(f, d);
                        const list = suggest[f]?.length ? `dev-${f}-list` : undefined;
                        return (
                          <div key={f} className="flex min-w-0 flex-col gap-1">
                            <Label htmlFor={`dev-${f}`} className="text-[10px] text-muted-foreground">
                              {t(label)}
                            </Label>
                            <Input
                              id={`dev-${f}`}
                              type={date ? "date" : "text"}
                              maxLength={max}
                              placeholder={placeholder}
                              list={list}
                              autoFocus={f === "brand_model"}
                              autoComplete="off"
                              spellCheck={false}
                              value={d[f] ?? ""}
                              onChange={(e) => patch({ [f]: e.target.value })}
                              aria-describedby={hint ? `dev-${f}-hint` : undefined}
                              className={cn("h-8 text-xs", mono && "num", date && "[color-scheme:dark]", hint && "border-amber-400/40")}
                            />
                            {list && (
                              <datalist id={list}>
                                {suggest[f]!.map((v) => (
                                  <option key={v} value={v} />
                                ))}
                              </datalist>
                            )}
                            {hint && (
                              <span id={`dev-${f}-hint`} className="text-[10px] text-amber-300">
                                {t(hint)}
                              </span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </fieldset>
                );
              })}

              {(hiddenCount > 0 || showAll) && (
                <button
                  type="button"
                  onClick={() => setShowAll((x) => !x)}
                  className="flex items-center gap-1 self-start text-[11px] text-sky-300 hover:text-sky-200"
                  aria-expanded={showAll}
                >
                  <ChevronDown className={cn("size-3.5 transition", showAll && "rotate-180")} aria-hidden />
                  {showAll ? t("Fewer fields") : t("More fields ({n})", { n: hiddenCount })}
                </button>
              )}

              <div className="flex flex-col gap-1">
                <Label htmlFor="dev-note" className="text-[10px] text-muted-foreground">
                  {t("Note")}
                </Label>
                <Textarea
                  id="dev-note"
                  rows={2}
                  value={d.note ?? ""}
                  onChange={(e) => patch({ note: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save();
                  }}
                  className="text-xs"
                />
              </div>

              <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
                <Info className="mt-px size-3.5 shrink-0" aria-hidden />
                {t("A later workbook import replaces these devices again; export the register first to keep your edits.")}
              </p>

              {error && (
                <div className="callout-crit text-xs" role="alert">
                  {error}
                </div>
              )}
            </div>

            {confirmDiscard && (
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-amber-400/20 bg-amber-400/[0.06] px-5 py-2 text-[11px] text-amber-200" role="alert">
                {t("Discard your changes?")}
                <div className="flex gap-2">
                  <Button type="button" size="xs" variant="ghost" onClick={() => setConfirmDiscard(false)}>
                    {t("Keep editing")}
                  </Button>
                  <Button type="button" size="xs" variant="destructive" onClick={onClose}>
                    {t("Discard")}
                  </Button>
                </div>
              </div>
            )}

            <DialogFooter className="items-center border-t border-white/[0.06] px-5 py-3 sm:justify-between">
              {index != null ? (
                <Button
                  type="button"
                  variant={confirmRemove ? "destructive" : "ghost"}
                  onClick={() => (confirmRemove ? void send(others, "remove") : setConfirmRemove(true))}
                  onBlur={() => setConfirmRemove(false)}
                  disabled={busy != null}
                >
                  {busy === "remove" ? <Spinner className="size-3.5" data-icon="inline-start" /> : <Trash2 data-icon="inline-start" />}
                  {confirmRemove ? t("Remove this device?") : t("Remove device")}
                </Button>
              ) : (
                <span />
              )}
              <div className="flex items-center gap-2">
                {index != null && !dirty && <span className="text-[11px] text-muted-foreground">{t("No changes")}</span>}
                <Button type="button" variant="ghost" onClick={requestClose} disabled={busy != null}>
                  {t("Cancel")}
                </Button>
                <Button type="submit" disabled={!canSave}>
                  {busy === "save" && <Spinner className="size-3.5" data-icon="inline-start" />}
                  {index == null ? t("Add device") : t("Save")}
                </Button>
              </div>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
};
