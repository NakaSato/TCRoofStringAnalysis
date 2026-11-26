/**
 * Pieces shared by the batch scan page's modes (`BatchScanPage.tsx`: receive / transfer / return,
 * `CountScanPage.tsx`: count): the mode tabs, the text box, the continuous camera and the
 * status colours.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Camera, CameraOff, Check, X } from "lucide-react";
import type { InputMethod } from "../../api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CameraScanner } from "../../components/scan/CameraScanner";
import { useI18n } from "../../i18n";
import { cameraSupported } from "../../lib/scan/camera";
import { SERIAL_FORMATS, type DetectedBarcode } from "../../lib/scan/decoder";
import { unlockAudio, type Feedback } from "../../lib/scan/feedback";
import { useFieldScanner } from "../../lib/scan/hidScanner";
import { clean } from "../../lib/scan/parse";
import { BATCH_MODES, type BatchMode } from "../../lib/scan/batch";

/** the page's modes: the three moves plus the count (phase 5) */
export const SCAN_MODES = [...BATCH_MODES, "count"] as const;
export type ScanMode = (typeof SCAN_MODES)[number];

export const MODE_LABEL: Record<ScanMode, string> = { receive: "Receive", transfer: "Transfer", return: "Return from plant", count: "Count" };

/** receive is for admins / store keepers; the count is offered to everyone (only its confirm is not) */
export const scanModes = (keeper: boolean): ScanMode[] => SCAN_MODES.filter((m) => keeper || m !== "receive");

export const ScanModeTabs: React.FC<{ mode: ScanMode; modes: ScanMode[]; onChange: (m: ScanMode) => void }> = ({ mode, modes, onChange }) => {
  const { t } = useI18n();
  return (
    <Tabs value={mode} onValueChange={(v) => onChange(v as ScanMode)}>
      <TabsList variant="line" className="max-w-full overflow-x-auto">
        {modes.map((m) => (
          <TabsTrigger key={m} value={m}>
            {t(MODE_LABEL[m])}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
};

export const isMoveMode = (m: ScanMode): m is BatchMode => m !== "count";

export const STATUS_ICON: Record<Feedback, React.ReactNode> = {
  ok: <Check className="size-5 text-emerald-400" aria-hidden />,
  warn: <AlertTriangle className="size-5 text-amber-400" aria-hidden />,
  error: <X className="size-5 text-red-400" aria-hidden />,
};
export const STATUS_ROW: Record<Feedback, string> = {
  ok: "border-emerald-500/25 bg-emerald-500/[0.04]",
  warn: "border-amber-500/30 bg-amber-500/[0.06]",
  error: "border-red-500/30 bg-red-500/[0.06]",
};
export const STATUS_TEXT: Record<Feedback, string> = { ok: "text-emerald-300", warn: "text-amber-300", error: "text-red-300" };

/** The text box: typing + Enter, or a keyboard scanner while it has focus (Thai layout corrected). */
export const ScanBox: React.FC<{ onSubmit: (raw: string, method: InputMethod) => void }> = ({ onSubmit }) => {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const onKeyDown = useFieldScanner((b) => {
    setText("");
    onSubmit(b.value, "hid");
  });
  return (
    <form
      data-scan-field
      className="flex min-w-0 flex-1 gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!clean(text)) return;
        onSubmit(text, "manual");
        setText("");
      }}
    >
      <Input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        maxLength={512}
        aria-label={t("Serial or label")}
        placeholder={t("Type or scan a code")}
        className="h-10 min-w-0 flex-1 font-mono text-base"
      />
      <Button type="submit" variant="outline" className="h-10 shrink-0" disabled={!clean(text)}>
        {t("Add")}
      </Button>
    </form>
  );
};

/** the same code held in front of the camera is read again every frame: ignore it this long */
const CAMERA_REPEAT_MS = 2000;
/** after a camera read, stop decoding briefly so the next label can come into view */
const CAMERA_PAUSE_MS = 700;

/** The text box, the Camera toggle and the continuous camera under them. */
export const ScanInputs: React.FC<{ onScan: (raw: string, method: InputMethod) => void }> = ({ onScan }) => {
  const { t } = useI18n();
  const [camera, setCamera] = useState(false);
  const [camPaused, setCamPaused] = useState(false);
  const lastCam = useRef<{ value: string; at: number } | null>(null);
  const camTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(camTimer.current), []);
  const onDetect = useCallback(
    (d: DetectedBarcode) => {
      const now = performance.now();
      const prev = lastCam.current;
      if (prev && prev.value === d.rawValue && now - prev.at < CAMERA_REPEAT_MS) {
        prev.at = now; // still in view: keep ignoring it
        return;
      }
      lastCam.current = { value: d.rawValue, at: now };
      setCamPaused(true);
      window.clearTimeout(camTimer.current);
      camTimer.current = window.setTimeout(() => setCamPaused(false), CAMERA_PAUSE_MS);
      onScan(d.rawValue, "camera");
    },
    [onScan]
  );
  return (
    <>
      <div className="flex min-w-0 items-center gap-2">
        <ScanBox onSubmit={onScan} />
        {cameraSupported() && (
          <Button
            type="button"
            variant={camera ? "accent" : "outline"}
            aria-pressed={camera}
            onClick={() => {
              unlockAudio();
              setCamera((c) => !c);
            }}
            className="shrink-0"
          >
            {camera ? <CameraOff data-icon="inline-start" /> : <Camera data-icon="inline-start" />}
            {t("Camera")}
          </Button>
        )}
      </div>
      <p className="text-[11px] text-muted-foreground">{t("A barcode reader in keyboard mode scans anywhere on this page.")}</p>
      {camera && (
        <div className="w-full max-w-md self-center">
          <CameraScanner formats={SERIAL_FORMATS} paused={camPaused} onDetect={onDetect} onFallback={() => setCamera(false)} feedback={false} />
        </div>
      )}
    </>
  );
};

let seq = 0;
export const newRowId = () => `${Date.now().toString(36)}-${(seq++).toString(36)}`;
