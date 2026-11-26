/**
 * Barcode decoding in the browser (docs/plans/barcode-scanning.md §5.1). Frames never leave the device.
 *
 * - The native `BarcodeDetector` when the browser has it and supports every format asked for
 *   (Chrome on Android, some desktop Chrome).
 * - Otherwise the `barcode-detector` ponyfill (ZXing-C++ in WASM): Safari on iPhone / iPad.
 *   Loaded with `import()` only when a camera or photo scan opens, and its `.wasm` is served from
 *   this app (Vite asset, precached by the service worker), never from a CDN.
 */
import type { BarcodeFormat, DetectedBarcode } from "barcode-detector/ponyfill";

export type { BarcodeFormat, DetectedBarcode };

/** Global scan: app labels and common 1D serial labels. */
export const GLOBAL_FORMATS: BarcodeFormat[] = ["qr_code", "data_matrix", "code_128", "code_39"];
/** Device serial fields: also retail / logistics symbologies seen on equipment labels. */
export const SERIAL_FORMATS: BarcodeFormat[] = [...GLOBAL_FORMATS, "ean_13", "ean_8", "upc_a", "itf", "pdf417"];

export interface Detector {
  detect(source: ImageBitmapSource | HTMLCanvasElement | OffscreenCanvas | HTMLVideoElement): Promise<DetectedBarcode[]>;
  engine: "native" | "zxing";
}

interface NativeDetectorCtor {
  new (o?: { formats?: string[] }): { detect(s: unknown): Promise<DetectedBarcode[]> };
  getSupportedFormats(): Promise<string[]>;
}

const cache = new Map<string, Promise<Detector>>();

const nativeCtor = (): NativeDetectorCtor | null => {
  const w = window as unknown as { BarcodeDetector?: NativeDetectorCtor };
  return typeof w.BarcodeDetector === "function" ? w.BarcodeDetector : null;
};

const load = async (formats: BarcodeFormat[]): Promise<Detector> => {
  const Native = nativeCtor();
  if (Native) {
    try {
      const supported = await Native.getSupportedFormats();
      if (formats.every((f) => supported.includes(f))) {
        const d = new Native({ formats });
        return { engine: "native", detect: (s) => d.detect(s) };
      }
    } catch {
      // fall through to the ponyfill
    }
  }
  const [{ BarcodeDetector, prepareZXingModule }, { default: wasmUrl }] = await Promise.all([
    import("barcode-detector/ponyfill"),
    import("zxing-wasm/reader/zxing_reader.wasm?url"),
  ]);
  // load the WASM now, so a failure shows when the scanner opens, not on the first frame
  await prepareZXingModule({
    overrides: { locateFile: (path: string, prefix: string) => (path.endsWith(".wasm") ? wasmUrl : prefix + path) },
    fireImmediately: true,
  });
  const d = new BarcodeDetector({ formats });
  return { engine: "zxing", detect: (s) => d.detect(s as never) };
};

/** One detector per format set, created on first use. */
export const getDetector = (formats: BarcodeFormat[] = GLOBAL_FORMATS): Promise<Detector> => {
  const key = [...formats].sort().join(",");
  let p = cache.get(key);
  if (!p) {
    p = load(formats);
    p.catch(() => cache.delete(key));
    cache.set(key, p);
  }
  return p;
};

/** Decode a still picture (photo fallback): full resolution, then turned 90 / 180 / 270°. */
export const decodeImage = async (file: Blob, formats: BarcodeFormat[]): Promise<DetectedBarcode | null> => {
  const det = await getDetector(formats);
  const bmp = await createImageBitmap(file);
  try {
    for (const deg of [0, 90, 180, 270]) {
      const swap = deg % 180 !== 0;
      const canvas = document.createElement("canvas");
      // cap very large photos: ZXing is slow on 12 MP and gains nothing past ~3000 px
      const scale = Math.min(1, 3000 / Math.max(bmp.width, bmp.height));
      const w = Math.round(bmp.width * scale);
      const h = Math.round(bmp.height * scale);
      canvas.width = swap ? h : w;
      canvas.height = swap ? w : h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.rotate((deg * Math.PI) / 180);
      ctx.drawImage(bmp, -w / 2, -h / 2, w, h);
      const found = await det.detect(canvas);
      if (found.length) return found[0];
    }
    return null;
  } finally {
    bmp.close();
  }
};
