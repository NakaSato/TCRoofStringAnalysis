import React, { useState } from "react";
import { ScanLine } from "lucide-react";
import type { InputMethod } from "../../api/client";
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
  }
> = ({ value, onValueChange, formats = SERIAL_FORMATS, scanTitle, upper = false, fieldHint, className, maxLength, ...inputProps }) => {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [method, setMethod] = useState<InputMethod | null>(null);

  const set = (v: string, m: InputMethod) => {
    let out = hasThai(v) && m !== "manual" ? thaiToUs(v) : v;
    if (upper) out = out.toUpperCase();
    if (maxLength) out = out.slice(0, Number(maxLength));
    setMethod(m);
    onValueChange(out, m);
  };

  const onKeyDown = useFieldScanner((b) => set(b.value, "hid"));

  return (
    <div data-scan-field className="flex min-w-0 items-center gap-1.5">
      <div className="relative min-w-0 flex-1">
        <Input
          {...inputProps}
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
  );
};
