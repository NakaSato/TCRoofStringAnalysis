import React, { useCallback, useState } from "react";
import { ScanLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useI18n } from "../../i18n";
import { unlockAudio } from "../../lib/scan/feedback";
import { scanTarget, useHidScanner, type Burst } from "../../lib/scan/hidScanner";
import { ScanDialog, type ScanRead } from "./ScanDialog";

/**
 * Top-bar Scan button + the global keyboard-scanner listener (docs/plans/barcode-scanning.md §7.1).
 * A burst with nothing focused (or with the configured prefix) opens the dialog on its result;
 * while a scan dialog is open, bursts go to that dialog instead.
 */
export const ScanButton: React.FC = () => {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [initial, setInitial] = useState<ScanRead | null>(null);

  const onBurst = useCallback((b: Burst) => {
    const target = scanTarget();
    if (target) {
      target(b);
      return;
    }
    setInitial({ value: b.value, method: "hid" });
    setOpen(true);
  }, []);
  useHidScanner(onBurst);

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t("Scan a code")}
            onClick={() => {
              unlockAudio();
              setInitial(null);
              setOpen(true);
            }}
          >
            <ScanLine className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t("Scan a QR label, barcode or serial")}</TooltipContent>
      </Tooltip>
      <ScanDialog open={open} onOpenChange={setOpen} mode="resolve" initial={initial} />
    </>
  );
};
