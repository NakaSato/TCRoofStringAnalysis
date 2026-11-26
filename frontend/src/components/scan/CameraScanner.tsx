import React, { useCallback, useEffect, useRef, useState } from "react";
import { Camera, Flashlight, FlashlightOff, RotateCcw, ScanBarcode, ScanQrCode, SwitchCamera } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useI18n } from "../../i18n";
import { cameraErrorOf, controlsOf, listCameras, openCamera, setTorch, setZoom, stopStream, type CameraControls, type CameraError } from "../../lib/scan/camera";
import { getDetector, type BarcodeFormat, type DetectedBarcode } from "../../lib/scan/decoder";
import { signal, unlockAudio } from "../../lib/scan/feedback";
import { cn } from "@/lib/utils";

/** decodes a second at most (~10), plus a full frame every 5th try */
const DECODE_EVERY_MS = 100;
const FULL_FRAME_EVERY = 5;
const CAM_OK_KEY = "tcroof.scan.cameraOk";

type Box = "1d" | "2d";
type State = { kind: "explain" } | { kind: "starting" } | { kind: "running" } | { kind: "error"; error: CameraError; detail?: string };

const cameraOkBefore = (): boolean => {
  try {
    return localStorage.getItem(CAM_OK_KEY) === "1";
  } catch {
    return false;
  }
};

/** the centre box the decoder reads, as a share of the frame */
const cropOf = (box: Box, w: number, h: number) => {
  if (box === "1d") {
    const cw = Math.round(w * 0.7);
    const ch = Math.round(h * 0.4);
    return { x: Math.round((w - cw) / 2), y: Math.round((h - ch) / 2), w: cw, h: ch };
  }
  const s = Math.round(Math.min(w, h) * 0.6);
  return { x: Math.round((w - s) / 2), y: Math.round((h - s) / 2), w: s, h: s };
};

/**
 * Live rear-camera scanner (docs/plans/barcode-scanning.md §5.2). Frames are decoded on the device
 * and never sent anywhere. `paused` stops decoding but keeps the camera on (the parent shows the read
 * value); unmounting, a hidden page or closing the dialog stops every track.
 */
export const CameraScanner: React.FC<{
  formats: BarcodeFormat[];
  paused?: boolean;
  onDetect: (code: DetectedBarcode) => void;
  /** offered when the camera cannot be used */
  onFallback?: (to: "photo" | "type") => void;
  /** beep and flash on each read (default); false = the parent gives the feedback (batch mode: a code held in view reads again every frame) */
  feedback?: boolean;
}> = ({ formats, paused = false, onDetect, onFallback, feedback = true }) => {
  const { t } = useI18n();
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [state, setState] = useState<State>(() => (cameraOkBefore() ? { kind: "starting" } : { kind: "explain" }));
  const [controls, setControls] = useState<CameraControls>({ torch: false, zoom: null });
  const [torchOn, setTorchOn] = useState(false);
  const [zoom, setZoomValue] = useState<number | null>(null);
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string | undefined>(undefined);
  const [box, setBox] = useState<Box>("2d");
  const [flash, setFlash] = useState(false);
  const [hidden, setHidden] = useState(() => document.hidden);
  const onDetectRef = useRef(onDetect);
  onDetectRef.current = onDetect;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const feedbackRef = useRef(feedback);
  feedbackRef.current = feedback;
  const boxRef = useRef(box);
  boxRef.current = box;

  // ---- the page going to the background stops the camera; coming back starts it again
  useEffect(() => {
    const onVis = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  // ---- open the stream
  const wanted = state.kind === "starting" || state.kind === "running";
  useEffect(() => {
    if (!wanted || hidden) return;
    let alive = true;
    (async () => {
      try {
        const [stream] = await Promise.all([openCamera(deviceId), getDetector(formats)]);
        if (!alive) {
          stopStream(stream);
          return;
        }
        streamRef.current = stream;
        try {
          localStorage.setItem(CAM_OK_KEY, "1");
        } catch {
          // storage blocked: the explanation shows again next time
        }
        const v = videoRef.current;
        if (v) {
          v.srcObject = stream;
          await v.play().catch(() => undefined);
        }
        const track = stream.getVideoTracks()[0];
        const c = controlsOf(track);
        setControls(c);
        setZoomValue(c.zoom?.value ?? null);
        setTorchOn(false);
        setCameras(await listCameras());
        setState({ kind: "running" });
      } catch (e) {
        if (!alive) return;
        const error = e instanceof Error && /wasm|WebAssembly|fetch/i.test(e.message) ? "unsupported" : cameraErrorOf(e);
        setState({ kind: "error", error, detail: e instanceof Error ? e.message : String(e) });
      }
    })();
    return () => {
      alive = false;
      stopStream(streamRef.current);
      streamRef.current = null;
      if (videoRef.current) videoRef.current.srcObject = null;
    };
    // formats are fixed for one scanner; a new set remounts it
  }, [wanted, hidden, deviceId]);

  // ---- decode loop
  useEffect(() => {
    if (state.kind !== "running" || hidden) return;
    let alive = true;
    let busy = false;
    let last = 0;
    let n = 0;
    let handle = 0;
    const v = videoRef.current;
    if (!v) return;
    const useRvfc = "requestVideoFrameCallback" in v;
    const schedule = () => {
      if (!alive) return;
      if (useRvfc) handle = (v as HTMLVideoElement & { requestVideoFrameCallback(cb: () => void): number }).requestVideoFrameCallback(tick);
      else handle = requestAnimationFrame(tick);
    };
    const tick = async () => {
      if (!alive) return;
      const now = performance.now();
      if (busy || pausedRef.current || now - last < DECODE_EVERY_MS || !v.videoWidth) {
        schedule();
        return;
      }
      busy = true;
      last = now;
      n += 1;
      try {
        const det = await getDetector(formats);
        const canvas = (canvasRef.current ??= document.createElement("canvas"));
        const full = n % FULL_FRAME_EVERY === 0;
        const r = full ? { x: 0, y: 0, w: v.videoWidth, h: v.videoHeight } : cropOf(boxRef.current, v.videoWidth, v.videoHeight);
        canvas.width = r.w;
        canvas.height = r.h;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (ctx) {
          ctx.drawImage(v, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
          const found = await det.detect(canvas);
          const hit = found.find((b) => b.rawValue);
          if (alive && hit && !pausedRef.current) {
            if (feedbackRef.current) {
              signal("ok");
              setFlash(true);
              window.setTimeout(() => setFlash(false), 350);
            }
            onDetectRef.current(hit);
          }
        }
      } catch {
        // a frame that fails to decode is just skipped
      } finally {
        busy = false;
        schedule();
      }
    };
    schedule();
    return () => {
      alive = false;
      if (useRvfc) (v as HTMLVideoElement & { cancelVideoFrameCallback?(h: number): void }).cancelVideoFrameCallback?.(handle);
      else cancelAnimationFrame(handle);
    };
  }, [state.kind, hidden]);

  const track = () => streamRef.current?.getVideoTracks()[0];

  const toggleTorch = useCallback(async () => {
    const tr = track();
    if (!tr) return;
    try {
      await setTorch(tr, !torchOn);
      setTorchOn((o) => !o);
    } catch {
      setControls((c) => ({ ...c, torch: false }));
    }
  }, [torchOn]);

  const changeZoom = (z: number) => {
    const tr = track();
    setZoomValue(z);
    if (tr) void setZoom(tr, z).catch(() => undefined);
  };

  const nextCamera = () => {
    if (cameras.length < 2) return;
    const cur = track()?.getSettings().deviceId;
    const i = cameras.findIndex((c) => c.deviceId === cur);
    setDeviceId(cameras[(i + 1) % cameras.length].deviceId);
    setState({ kind: "starting" });
  };

  const start = () => {
    unlockAudio();
    setState({ kind: "starting" });
  };

  if (state.kind === "explain") {
    return (
      <div className="flex flex-col items-center gap-3 rounded-lg border border-white/[0.07] bg-ink-900/60 p-6 text-center">
        <Camera className="size-8 text-slate-400" aria-hidden />
        <p className="max-w-sm text-xs text-muted-foreground">
          {t("The camera is used only to read the code. Nothing is recorded or sent; only the code it reads is used.")}
        </p>
        <Button onClick={start}>{t("Turn on camera")}</Button>
        <p className="text-[11px] text-muted-foreground">{t("On iPhone and iPad the browser may ask again in a later session. That is expected.")}</p>
      </div>
    );
  }

  if (state.kind === "error") {
    const msg: Record<CameraError, string> = {
      insecure: t("The camera needs a secure (https) page. Open the app from its https address."),
      unsupported: t("This browser cannot scan with the camera. Use Photo or type the code."),
      denied: t("Camera access is blocked for this site. iPhone / iPad: Settings → Safari → Camera (or this site's settings for the installed app). Android: the site's settings in Chrome. Then try again."),
      not_found: t("No camera was found on this device."),
      busy: t("The camera is in use by another app. Close it and try again."),
      other: t("The camera could not be started."),
    };
    return (
      <div className="flex flex-col items-center gap-3 rounded-lg border border-amber-400/30 bg-amber-500/5 p-5 text-center">
        <p className="max-w-sm text-xs text-amber-100">{msg[state.error]}</p>
        <div className="flex flex-wrap justify-center gap-2">
          {state.error !== "insecure" && state.error !== "not_found" && state.error !== "unsupported" && (
            <Button size="sm" variant="outline" onClick={start}>
              <RotateCcw data-icon="inline-start" className="size-3" />
              {t("Try again")}
            </Button>
          )}
          {onFallback && (
            <>
              <Button size="sm" variant="secondary" onClick={() => onFallback("photo")}>
                {t("Take a photo")}
              </Button>
              <Button size="sm" variant="secondary" onClick={() => onFallback("type")}>
                {t("Type it")}
              </Button>
            </>
          )}
        </div>
      </div>
    );
  }

  const crop = box === "1d" ? "inset-x-[15%] inset-y-[30%]" : "left-1/2 top-1/2 aspect-square h-[60%] -translate-x-1/2 -translate-y-1/2";

  return (
    <div className="flex flex-col gap-2">
      <div className="relative overflow-hidden rounded-lg bg-black">
        <video ref={videoRef} playsInline muted autoPlay className="block aspect-[4/3] w-full object-cover" />
        {/* the box the decoder reads first */}
        <div
          aria-hidden
          className={cn(
            "pointer-events-none absolute rounded-md border-2 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)] transition-colors",
            crop,
            flash ? "border-emerald-400 bg-emerald-400/20" : paused ? "border-slate-500" : "border-white/80"
          )}
        />
        {state.kind === "starting" && (
          <div className="absolute inset-0 flex items-center justify-center gap-2 text-xs text-slate-300">
            <Spinner className="size-4" /> {t("Starting camera…")}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <ToggleGroup type="single" size="xs" variant="outline" value={box} onValueChange={(v) => v && setBox(v as Box)} aria-label={t("Code shape")}>
          <ToggleGroupItem value="2d" aria-label={t("QR / DataMatrix")}>
            <ScanQrCode className="size-3.5" /> {t("QR")}
          </ToggleGroupItem>
          <ToggleGroupItem value="1d" aria-label={t("Barcode")}>
            <ScanBarcode className="size-3.5" /> {t("Barcode")}
          </ToggleGroupItem>
        </ToggleGroup>
        {controls.torch && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="icon-sm" variant={torchOn ? "accent" : "ghost"} aria-pressed={torchOn} aria-label={t("Torch")} onClick={toggleTorch}>
                {torchOn ? <Flashlight className="size-4" /> : <FlashlightOff className="size-4" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("Torch")}</TooltipContent>
          </Tooltip>
        )}
        {cameras.length > 1 && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="icon-sm" variant="ghost" aria-label={t("Switch camera")} onClick={nextCamera}>
                <SwitchCamera className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("Switch camera")}</TooltipContent>
          </Tooltip>
        )}
        {controls.zoom && zoom != null && (
          <div className="flex min-w-32 flex-1 items-center gap-2 text-[11px] text-muted-foreground">
            {t("Zoom")}
            <Slider
              min={controls.zoom.min}
              max={controls.zoom.max}
              step={controls.zoom.step}
              value={[zoom]}
              onValueChange={(v) => changeZoom(v[0])}
              aria-label={t("Zoom")}
            />
          </div>
        )}
      </div>
      <p className="text-[11px] text-muted-foreground">{t("Hold the code inside the box. If it will not read, move a little closer or further away, or use Photo.")}</p>
    </div>
  );
};
