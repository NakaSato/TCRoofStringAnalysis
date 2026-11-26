import React, { useEffect, useState } from "react";
import { AlertTriangle, ScanLine } from "lucide-react";
import { api, type InputMethod, type SerialCheck, type SerialWarning } from "../../api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useI18n } from "../../i18n";
import { SERIAL_FORMATS, type BarcodeFormat } from "../../lib/scan/decoder";
import { unlockAudio } from "../../lib/scan/feedback";
import { useFieldScanner } from "../../lib/scan/hidScanner";
import { hasThai, thaiToUs } from "../../lib/scan/keymap";
import { MethodBadge, ScanDialog, type FieldHintContext } from "./ScanDialog";
import { cn } from "@/lib/utils";

/**
 * A text input for serials and tags (docs/plans/barcode-scanning.md §7.2): typing, a keyboard
 * scanner (Thai layout corrected; Enter does not submit the form) and a camera button. Shows how
 * the value came in. The value is shown as read: never corrected (O / 0, I / 1) by the app.
 */
export const ScanField: React.FC<
  Omit<React.ComponentProps<typeof Input>, "value" | "onChange"> & {
    value: string;
    onValueChange: (value: string, method: InputMethod) => void;
    formats?: BarcodeFormat[];
    /** dialog title, e.g. the field's label */
    scanTitle?: string;
    /** upper-case the value (serial numbers) */
    upper?: boolean;
    /** device category + model: a multi-field label's serial field is remembered per pair */
    fieldHint?: FieldHintContext;
    /** warn when the value does not look like the registered serials of `fieldHint`'s category
     * (+ model) (§6.3; never blocks). Default: on whenever `fieldHint` is given */
    checkSerial?: boolean;
  }
> = ({ value, onValueChange, formats = SERIAL_FORMATS, scanTitle, upper = false, fieldHint, checkSerial = true, className, maxLength, ...inputProps }) => {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [method, setMethod] = useState<InputMethod | null>(null);
  const check = useSerialCheck(checkSerial && !inputProps.disabled ? fieldHint : undefined, value);

  const set = (v: string, m: InputMethod) => {
    let out = hasThai(v) && m !== "manual" ? thaiToUs(v) : v;
    if (upper) out = out.toUpperCase();
    if (maxLength) out = out.slice(0, Number(maxLength));
    setMethod(m);
    onValueChange(out, m);
  };

  const onKeyDown = useFieldScanner((b) => set(b.value, "hid"));

  const warnId = inputProps.id ? `${inputProps.id}-serial-warn` : undefined;
  const describedBy = [inputProps["aria-describedby"], check?.warnings.length ? warnId : undefined].filter(Boolean).join(" ") || undefined;

  return (
    <div data-scan-field className="min-w-0">
    <div className="flex min-w-0 items-center gap-1.5">
      <div className="relative min-w-0 flex-1">
        <Input
          {...inputProps}
          aria-describedby={describedBy}
          value={value}
          maxLength={maxLength}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => set(e.target.value, "manual")}
          onKeyDown={(e) => {
            // a scanner's Enter must not submit the form around the field
            if (e.key === "Enter") e.preventDefault();
            onKeyDown(e);
          }}
          className={cn("font-mono", method && method !== "manual" && value && "pr-20", className)}
        />
        {method && method !== "manual" && value && (
          <span className="pointer-events-none absolute top-1/2 right-1.5 -translate-y-1/2">
            <MethodBadge method={method} />
          </span>
        )}
      </div>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label={t("Scan with the camera")}
            disabled={inputProps.disabled}
            onClick={() => {
              unlockAudio();
              setOpen(true);
            }}
          >
            <ScanLine className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t("Scan with the camera")}</TooltipContent>
      </Tooltip>
      <ScanDialog open={open} onOpenChange={setOpen} mode="pick" formats={formats} title={scanTitle} fieldHint={fieldHint} onPick={(r) => set(r.value, r.method)} />
    </div>
    {check && check.warnings.length > 0 && (
      <ul id={warnId} className="mt-1 space-y-0.5 text-[11px] leading-snug text-amber-600 dark:text-amber-300" aria-live="polite">
        {check.warnings.map((w) => (
          <li key={w.code} className="flex items-start gap-1">
            <AlertTriangle className="mt-px size-3 shrink-0" aria-hidden />
            <span>{warningText(w, check.basis, t)}</span>
          </li>
        ))}
      </ul>
    )}
    </div>
  );
};

type T = (k: string, v?: Record<string, string | number>) => string;

const warningText = (w: SerialWarning, basis: SerialCheck["basis"], t: T): string => {
  const usual = basis === "model" ? t("this model") : t("this device type");
  switch (w.code) {
    case "length":
      return w.min === w.max
        ? t("Serials of {what} have {n} characters; this one has {got}.", { what: usual, n: w.min, got: w.got })
        : t("Serials of {what} have {min}–{max} characters; this one has {got}.", { what: usual, min: w.min, max: w.max, got: w.got });
    case "digits":
      return t("Serials of {what} are digits only.", { what: usual });
    case "alnum":
      return t("Serials of {what} have only letters and digits.", { what: usual });
    case "prefix":
      return t("Serials of {what} start with {prefix}.", { what: usual, prefix: w.prefix });
    case "imei":
      return t("This looks like an IMEI (15 digits), not the serial number.");
    case "iccid":
      return t("This looks like a SIM card number (ICCID), not the serial number.");
  }
};

const MIN_CHECK_LEN = 3;
const CHECK_DELAY_MS = 500;

/** The §6.3 check of `value`, asked 0.5 s after the last change; null while short, unchecked or on error. */
const useSerialCheck = (ctx: FieldHintContext | undefined, value: string): SerialCheck | null => {
  const [out, setOut] = useState<SerialCheck | null>(null);
  const category = ctx?.category;
  const model = ctx?.model?.trim() || null;
  const v = value.trim();
  useEffect(() => {
    setOut(null);
    if (!category || v.length < MIN_CHECK_LEN) return;
    let alive = true;
    const timer = window.setTimeout(() => {
      api
        .checkSerial(category, v, model)
        .then((r) => alive && setOut(r))
        .catch(() => alive && setOut(null)); // a warning is optional: no check, no warning
    }, CHECK_DELAY_MS);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [category, model, v]);
  return out;
};
