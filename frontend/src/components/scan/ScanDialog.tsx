import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Camera, ImageUp, Keyboard, RotateCcw } from "lucide-react";
import { ApiError, api, type InputMethod, type ScanFieldHint, type ScanMatch, type ScanResolve } from "../../api/client";
import { useAuth } from "../../context/AuthContext";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useI18n } from "../../i18n";
import { cameraSupported, hasCamera } from "../../lib/scan/camera";
import { decodeImage, GLOBAL_FORMATS, type BarcodeFormat, type DetectedBarcode } from "../../lib/scan/decoder";
import { signal, unlockAudio } from "../../lib/scan/feedback";
import { rememberScan } from "../../lib/scan/lastScan";
import { pushScanTarget, useFieldScanner, type Burst } from "../../lib/scan/hidScanner";
import { hasThai, thaiToUs } from "../../lib/scan/keymap";
import { clean, defaultField, hintFor, isSimCategory, pickByHint, splitFields, type LabelField } from "../../lib/scan/parse";
import { CameraScanner } from "./CameraScanner";
import { cn } from "@/lib/utils";

type Tab = "camera" | "photo" | "type";

/** a ScanField's device category + model: which field of a multi-field label is the serial is remembered per pair */
export interface FieldHintContext {
  category: string;
  model: string | null | undefined;
}

export interface ScanRead {
  value: string;
  method: InputMethod;
  /** the symbology, when a camera / photo read it */
  format?: string;
}

const METHOD_LABEL: Record<InputMethod, string> = { hid: "Scanner", camera: "Camera", photo: "Photo", manual: "Typed" };
const KIND_LABEL: Record<ScanMatch["kind"], string> = { instrument: "Instrument", inverter: "Inverter", datalogger: "Datalogger", site_device: "Site device", failed_unit: "Failed unit", spare_unit: "Spare unit", part: "Part", location: "Stock location" };
const UNSUPPORTED_LABEL: Record<string, string> = { rt: "Red tags", sp: "Spare parts", loc: "Stock locations", df: "Defects" };
const ROLE_LABEL: Record<LabelField["role"], string> = { serial: "SN", imei: "IMEI", iccid: "SIM", mac: "MAC", part: "P/N", model: "Model", other: "" };

/** A read value, the way it came in. */
export const MethodBadge: React.FC<{ method: InputMethod }> = ({ method }) => {
  const { t } = useI18n();
  return (
    <Badge variant={method === "manual" ? "neutral" : "info"} className="shrink-0">
      {t(METHOD_LABEL[method])}
    </Badge>
  );
};

/** Fields of a multi-field label, as buttons. */
const FieldChoices: React.FC<{ fields: LabelField[]; selected?: number | null; onPick: (f: LabelField, index: number) => void }> = ({ fields, selected, onPick }) => {
  const { t } = useI18n();
  return (
    <div className="flex flex-wrap gap-1.5">
      {fields.map((f, i) => (
        <Button
          key={`${i}-${f.value}`}
          size="xs"
          variant={selected === i ? "accent" : "outline"}
          aria-pressed={selected === i}
          onClick={() => onPick(f, i)}
          className="max-w-full font-mono"
          title={f.key ?? undefined}
        >
          {(f.key || ROLE_LABEL[f.role]) && <span className="text-muted-foreground">{f.key ?? t(ROLE_LABEL[f.role])}</span>}
          <span className="truncate">{f.value}</span>
        </Button>
      ))}
    </div>
  );
};

/** Type tab: an input that also takes a keyboard scanner (Thai layout corrected). */
const TypeBox: React.FC<{ onSubmit: (r: ScanRead) => void; autoFocus: boolean; label: string }> = ({ onSubmit, autoFocus, label }) => {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const onKeyDown = useFieldScanner((b: Burst) => {
    setText(b.value);
    onSubmit({ value: b.value, method: "hid" });
  });
  const submit = () => {
    if (clean(text)) onSubmit({ value: text, method: "manual" });
  };
  return (
    <form
      data-scan-field
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="flex gap-2">
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          autoFocus={autoFocus}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={512}
          aria-label={label}
          placeholder={t("Type or scan a code")}
          className="font-mono"
        />
        <Button type="submit" disabled={!clean(text)}>
          {t("Look up")}
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground">{t("Check O / 0 and I / 1. A barcode reader in keyboard mode can scan into this box.")}</p>
    </form>
  );
};

/** Photo tab: the native camera or the gallery, decoded on the device (the photo is not uploaded). */
const PhotoBox: React.FC<{ formats: BarcodeFormat[]; onRead: (r: ScanRead) => void }> = ({ formats, onRead }) => {
  const { t } = useI18n();
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onFile = async (f: File | undefined) => {
    if (!f) return;
    setBusy(true);
    setError(null);
    try {
      const hit = await decodeImage(f, formats);
      if (hit?.rawValue) {
        signal("ok");
        onRead({ value: hit.rawValue, method: "photo", format: hit.format });
      } else {
        signal("error");
        setError(t("No code found in the photo. Take it closer, straight on, without glare."));
      }
    } catch (e) {
      signal("error");
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      if (ref.current) ref.current.value = "";
    }
  };
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-white/10 p-6 text-center">
      <input ref={ref} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => void onFile(e.target.files?.[0])} />
      <Button
        onClick={() => {
          unlockAudio();
          ref.current?.click();
        }}
        disabled={busy}
      >
        {busy ? <Spinner data-icon="inline-start" /> : <ImageUp data-icon="inline-start" className="size-4" />}
        {busy ? t("Reading the photo…") : t("Take or choose a photo")}
      </Button>
      <p className="max-w-sm text-[11px] text-muted-foreground">{t("For small or curved labels the live camera cannot focus on. The photo is read on this device and not uploaded.")}</p>
      {error && <p className="text-xs text-amber-200">{error}</p>}
    </div>
  );
};

/** A suggested spelling, the swapped characters marked. */
const Lookalike: React.FC<{ code: string; typed: string }> = ({ code, typed }) => (
  <>
    {[...code].map((ch, i) =>
      ch === typed[i] ? (
        <React.Fragment key={i}>{ch}</React.Fragment>
      ) : (
        <mark key={i} className="rounded-sm bg-solar-400/25 px-px text-solar-100">
          {ch}
        </mark>
      )
    )}
  </>
);

/** What a code opened: one match navigates, several are listed, none says so. */
const ResolveResult: React.FC<{
  read: ScanRead;
  onOpen: (m: ScanMatch) => void;
  onLookup: (value: string) => void;
}> = ({ read, onOpen, onLookup }) => {
  const { t } = useI18n();
  const [res, setRes] = useState<ScanResolve | null>(null);
  const [error, setError] = useState<string | null>(null);
  const thai = hasThai(read.value);
  const value = thai ? thaiToUs(read.value) : read.value;
  const fields = useMemo(() => splitFields(value), [value]);

  useEffect(() => {
    let alive = true;
    setRes(null);
    setError(null);
    api
      .resolveScan(value, read.method === "manual")
      .then((r) => {
        if (!alive) return;
        setRes(r);
        if (r.matches.length === 1) {
          signal("ok");
          onOpen(r.matches[0]);
        } else signal(r.matches.length || r.did_you_mean.length ? "warn" : "error");
      })
      .catch((e) => {
        if (!alive) return;
        signal("error");
        if (e instanceof ApiError && e.status === 404) setError(t("Not found, or not on one of your plants."));
        else if (e instanceof ApiError && e.status === 429) setError(t("Too many scans; try again in a minute."));
        else setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [value]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex min-w-0 items-center gap-2 text-xs">
        <MethodBadge method={read.method} />
        <code className="min-w-0 truncate rounded bg-ink-900 px-1.5 py-0.5 font-mono text-slate-100">{clean(value)}</code>
      </div>
      {thai && <p className="callout-warn text-[11px]">{t("Thai characters were read; they were turned into the keys of an English keyboard. Switch the keyboard to English for best results.")}</p>}
      {error && <p className="text-xs text-amber-200">{error}</p>}
      {!res && !error && (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Spinner className="size-3" /> {t("Looking up…")}
        </p>
      )}
      {res && res.matches.length > 1 && (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs text-muted-foreground">{t("{n} records have this code. Pick one:", { n: res.matches.length })}</p>
          {res.matches.map((m) => (
            <button
              key={`${m.kind}-${m.id}-${m.plant_id}`}
              type="button"
              onClick={() => onOpen(m)}
              className="flex flex-col gap-0.5 rounded-md border border-white/[0.07] px-3 py-2 text-left text-xs hover:border-white/20 hover:bg-white/[0.03]"
            >
              <span className="flex items-center gap-2">
                <Badge variant="neutral">{t(KIND_LABEL[m.kind])}</Badge>
                <span className="truncate font-medium text-slate-100">{m.label}</span>
              </span>
              <span className="truncate text-muted-foreground">{[m.plant_name, m.detail].filter(Boolean).join(" · ") || "—"}</span>
            </button>
          ))}
        </div>
      )}
      {res && res.matches.length === 1 && (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Spinner className="size-3" /> {t("Opening {name}…", { name: res.matches[0].label })}
        </p>
      )}
      {res && res.matches.length === 0 && (
        <div className="flex flex-col gap-2 text-xs">
          {res.red_tag ? (
            <p className="text-slate-200">
              {res.red_tag.status === "reserved"
                ? t("Red tag {code}: blank (reserved in batch {batch}). Tying it to a failed unit comes with the failed-unit register.", {
                    code: res.red_tag.code,
                    batch: res.red_tag.batch,
                  })
                : t("Red tag {code}: {status}.", { code: res.red_tag.code, status: res.red_tag.status })}
            </p>
          ) : res.unsupported_kind ? (
            <p className="text-amber-200">
              {t("{what} are not in the app yet, so this label opens nothing.", { what: t(UNSUPPORTED_LABEL[res.unsupported_kind] ?? res.unsupported_kind) })}
            </p>
          ) : (
            <p className="text-amber-200">{t("Nothing you can see in the app has this code (instruments, inverters, dataloggers and site register devices are searched).")}</p>
          )}
          {res.did_you_mean.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <p className="text-muted-foreground">{t("Did you mean (O / 0 and I / 1 swapped)?")}</p>
              {res.did_you_mean.map((s) => (
                <button
                  key={s.code}
                  type="button"
                  onClick={() => (s.matches.length === 1 ? onOpen(s.matches[0]) : onLookup(s.code))}
                  className="flex flex-col gap-0.5 rounded-md border border-white/[0.07] px-3 py-2 text-left hover:border-white/20 hover:bg-white/[0.03]"
                >
                  <code className="font-mono text-slate-100">
                    <Lookalike code={s.code} typed={res.code} />
                  </code>
                  <span className="truncate text-muted-foreground">
                    {s.matches.map((m) => [t(KIND_LABEL[m.kind]), m.label, m.plant_name].filter(Boolean).join(" · ")).join(" / ")}
                  </span>
                </button>
              ))}
            </div>
          )}
          {res.part_number && <p className="text-muted-foreground">{t("The label says P/N: this is a part number, not a serial.")}</p>}
          {fields.length > 1 && (
            <div className="flex flex-col gap-1.5">
              <p className="text-muted-foreground">{t("This label holds several values. Pick one to look up:")}</p>
              <FieldChoices fields={fields} onPick={(f) => onLookup(f.value)} />
            </div>
          )}
        </div>
      )}
    </div>
  );
};

/** Pick mode: the value read, with Use / Scan again; a multi-field label asks which field, the
 *  choice remembered per category + model when the field passes them (`fieldHint`). */
const PickResult: React.FC<{ read: ScanRead; fieldHint?: FieldHintContext; onUse: (r: ScanRead) => void }> = ({ read, fieldHint, onUse }) => {
  const { t } = useI18n();
  const { user } = useAuth();
  const thai = hasThai(read.value);
  const base = clean(thai ? thaiToUs(read.value) : read.value);
  const fields = useMemo(() => splitFields(base), [base]);
  const model = fieldHint?.model?.trim() || null;
  const remembers = fields.length > 1 && !!fieldHint && !!model;
  const [hint, setHint] = useState<ScanFieldHint | null | undefined>(remembers ? undefined : null);
  const sim = isSimCategory(fieldHint?.category);
  // before a remembered hint: the ICCID for a SIM field, the labelled serial otherwise
  const defaultAt = () => {
    const f = defaultField(fields, fieldHint?.category);
    return f ? fields.indexOf(f) : null;
  };
  const [chosen, setChosen] = useState<number | null>(defaultAt);
  // a pick made before the hint arrives wins over it
  const touched = useRef(false);

  useEffect(() => {
    if (!remembers) return;
    let alive = true;
    api
      .listScanFieldHints(fieldHint!.category, model!)
      .then((list) => {
        if (!alive) return;
        const h = list[0] ?? null;
        setHint(h);
        const f = pickByHint(fields, h);
        if (f && !touched.current) setChosen(fields.indexOf(f));
      })
      .catch(() => alive && setHint(null));
    return () => {
      alive = false;
    };
    // PickResult is keyed by the read, so this runs once per read
  }, []);

  const value = fields.length > 1 ? (chosen != null ? fields[chosen].value : "") : base;
  const fromHint = hint ? pickByHint(fields, hint) : null;
  const usesHint = fromHint != null && chosen != null && fields[chosen] === fromHint;
  const canChange = !hint || user?.role === "admin";

  const use = () => {
    // only once the remembered hint is known: before that a click must not overwrite it
    if (remembers && hint !== undefined && chosen != null && !usesHint && canChange) {
      // remembered for the next label of this model; a failure only means it is not remembered
      void api.putScanFieldHint({ category: fieldHint!.category, model: model!, ...hintFor(fields, chosen) }).catch(() => undefined);
    }
    onUse({ ...read, value });
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex min-w-0 items-center gap-2 text-xs">
        <MethodBadge method={read.method} />
        <code className="min-w-0 truncate rounded bg-ink-900 px-1.5 py-0.5 font-mono text-slate-100">{base}</code>
      </div>
      {thai && <p className="callout-warn text-[11px]">{t("Thai characters were read; they were turned into the keys of an English keyboard. Switch the keyboard to English for best results.")}</p>}
      {fields.length > 1 && (
        <div className="flex flex-col gap-1.5 text-xs">
          <p className="text-muted-foreground">{t("This label holds several values. Pick the one for this field:")}</p>
          <FieldChoices
            fields={fields}
            selected={chosen}
            onPick={(_, i) => {
              touched.current = true;
              setChosen(i);
            }}
          />
          <p className="text-[11px] text-muted-foreground">
            {sim ? t("The SIM number is the ICCID; the serial and IMEI are not it.") : t("IMEI and SIM numbers are not the device serial.")}
          </p>
          {remembers && hint !== undefined && (
            <p className="text-[11px] text-muted-foreground">
              {usesHint
                ? t("Picked as remembered for {model}.", { model: model! })
                : !canChange
                  ? t("Another field is remembered for {model}; only an admin can change it.", { model: model! })
                  : hint
                    ? t("Using this field will be remembered for {model} instead.", { model: model! })
                    : t("The field you use is remembered for {model}, so the next label picks it.", { model: model! })}
            </p>
          )}
        </div>
      )}
      <Button disabled={!value} onClick={use} className="self-start">
        {t("Use {value}", { value: value || "…" })}
      </Button>
    </div>
  );
};

/**
 * Scan dialog (docs/plans/barcode-scanning.md §7): Camera | Photo | Type. `mode="resolve"` (top-bar
 * Scan, keyboard scanner with nothing focused) looks the code up and opens the record; `mode="pick"`
 * (a ScanField) hands the value back. While open it takes keyboard-scanner bursts itself.
 */
export const ScanDialog: React.FC<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "resolve" | "pick";
  formats?: BarcodeFormat[];
  title?: string;
  /** a code already read (keyboard scanner): shown at once */
  initial?: ScanRead | null;
  onPick?: (r: ScanRead) => void;
  /** pick mode: remember which field of a multi-field label is the serial for this category + model */
  fieldHint?: FieldHintContext;
}> = ({ open, onOpenChange, mode, formats = GLOBAL_FORMATS, title, initial, onPick, fieldHint }) => {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab | null>(null);
  const [read, setRead] = useState<ScanRead | null>(null);

  // first tab: the camera where there is one, else Type (a desk with a barcode reader)
  useEffect(() => {
    if (!open) {
      setRead(null);
      setTab(null);
      return;
    }
    setRead(initial ?? null);
    let alive = true;
    if (!cameraSupported() || !window.isSecureContext) setTab("type");
    else void hasCamera().then((yes) => alive && setTab((cur) => cur ?? (yes ? "camera" : "type")));
    return () => {
      alive = false;
    };
  }, [open, initial]);

  // keyboard-scanner bursts while open belong to this dialog
  useEffect(() => {
    if (!open) return;
    return pushScanTarget((b) => setRead({ value: b.value, method: "hid" }));
  }, [open]);

  const onDetect = useCallback((d: DetectedBarcode) => setRead({ value: d.rawValue, method: "camera", format: d.format }), []);

  const openMatch = useCallback(
    (m: ScanMatch) => {
      onOpenChange(false);
      navigate(m.path);
    },
    [navigate, onOpenChange]
  );

  const use = (r: ScanRead) => {
    onPick?.(r);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title ?? t("Scan a code")}</DialogTitle>
          <DialogDescription>
            {mode === "resolve"
              ? t("QR label, barcode or serial number: opens the instrument, inverter, datalogger or site device it belongs to.")
              : t("Scan the label, or type the value.")}
          </DialogDescription>
        </DialogHeader>

        <Tabs value={tab ?? "type"} onValueChange={(v) => setTab(v as Tab)} className="min-w-0">
          <TabsList variant="line">
            <TabsTrigger value="camera" disabled={!cameraSupported()}>
              <Camera className="size-3.5" /> {t("Camera")}
            </TabsTrigger>
            <TabsTrigger value="photo">
              <ImageUp className="size-3.5" /> {t("Photo")}
            </TabsTrigger>
            {/* while the camera check runs, Type in already shows as selected, so the tabs report no
                change for a click on it: take it here, or the check would switch to Camera after it */}
            <TabsTrigger value="type" onClick={() => setTab("type")}>
              <Keyboard className="size-3.5" /> {t("Type in")}
            </TabsTrigger>
          </TabsList>
          {/* the camera runs only while its tab is open and nothing is read */}
          <TabsContent value="camera" className={cn(read && "hidden")}>
            {open && tab === "camera" && <CameraScanner formats={formats} paused={!!read} onDetect={onDetect} onFallback={(to) => setTab(to)} />}
          </TabsContent>
          <TabsContent value="photo" className={cn(read && "hidden")}>
            <PhotoBox formats={formats} onRead={setRead} />
          </TabsContent>
          <TabsContent value="type" className={cn(read && "hidden")} onFocusCapture={() => setTab((cur) => cur ?? "type")}>
            {tab !== null && <TypeBox onSubmit={setRead} autoFocus={tab === "type"} label={title ?? t("Code")} />}
          </TabsContent>
        </Tabs>

        {read && (
          <div className="flex min-w-0 flex-col gap-3 border-t border-white/[0.06] pt-3">
            {mode === "resolve" ? (
              <ResolveResult
                key={read.value}
                read={read}
                onOpen={(m) => {
                  rememberScan(m, read.method, read.value);
                  openMatch(m);
                }}
                onLookup={(value) => setRead({ ...read, value })} />
            ) : (
              <PickResult key={read.value} read={read} fieldHint={fieldHint} onUse={use} />
            )}
            <Button variant="ghost" size="sm" className="self-start" onClick={() => setRead(null)}>
              <RotateCcw data-icon="inline-start" className="size-3" />
              {t("Scan again")}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};
