/**
 * Rear camera for live scanning (docs/plans/barcode-scanning.md §5.2–5.3). The stream is only
 * shown and decoded on the device; every track is stopped when the scanner closes, the page is
 * hidden or the route changes, so the camera light goes off.
 */

export type CameraError = "insecure" | "unsupported" | "denied" | "not_found" | "busy" | "other";

export const cameraSupported = (): boolean => typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;

/** Has this device a camera at all? (labels need a granted permission; the kind does not) */
export const hasCamera = async (): Promise<boolean> => {
  if (!cameraSupported()) return false;
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    return devs.some((d) => d.kind === "videoinput");
  } catch {
    return false;
  }
};

export const cameraErrorOf = (e: unknown): CameraError => {
  if (!window.isSecureContext) return "insecure";
  const name = e instanceof DOMException ? e.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "denied";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "not_found";
  if (name === "NotReadableError" || name === "AbortError") return "busy";
  return "other";
};

/** Rear camera at 1080p if it can, else 720p, else whatever it gives. */
export const openCamera = async (deviceId?: string): Promise<MediaStream> => {
  if (!window.isSecureContext) throw new DOMException("insecure", "SecurityError");
  if (!cameraSupported()) throw new DOMException("unsupported", "NotSupportedError");
  const base: MediaTrackConstraints = deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: "environment" } };
  const tries: MediaTrackConstraints[] = [
    { ...base, width: { ideal: 1920 }, height: { ideal: 1080 } },
    { ...base, width: { ideal: 1280 }, height: { ideal: 720 } },
    base,
  ];
  let last: unknown;
  for (const video of tries) {
    try {
      return await navigator.mediaDevices.getUserMedia({ video, audio: false });
    } catch (e) {
      last = e;
      if (e instanceof DOMException && e.name === "NotAllowedError") throw e;
    }
  }
  throw last;
};

export const stopStream = (s: MediaStream | null | undefined) => s?.getTracks().forEach((t) => t.stop());

/** Rear cameras listed by the browser (after permission, so labels are known). */
export const listCameras = async (): Promise<MediaDeviceInfo[]> => {
  try {
    return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
  } catch {
    return [];
  }
};

/** torch / zoom where the track reports them (never assumed: iOS support varies by version). */
export interface CameraControls {
  torch: boolean;
  zoom: { min: number; max: number; step: number; value: number } | null;
}

type Caps = MediaTrackCapabilities & { torch?: boolean; zoom?: { min: number; max: number; step?: number } };
type Sett = MediaTrackSettings & { torch?: boolean; zoom?: number };

export const controlsOf = (track: MediaStreamTrack | undefined): CameraControls => {
  if (!track || typeof track.getCapabilities !== "function") return { torch: false, zoom: null };
  const caps = track.getCapabilities() as Caps;
  const set = track.getSettings() as Sett;
  const zoom = caps.zoom && caps.zoom.max > caps.zoom.min ? { min: caps.zoom.min, max: caps.zoom.max, step: caps.zoom.step || 0.1, value: set.zoom ?? caps.zoom.min } : null;
  return { torch: caps.torch === true, zoom };
};

export const setTorch = (track: MediaStreamTrack, on: boolean) =>
  track.applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] });

export const setZoom = (track: MediaStreamTrack, zoom: number) =>
  track.applyConstraints({ advanced: [{ zoom } as MediaTrackConstraintSet] });
