/**
 * QR codes for printed labels (docs/plans/barcode-scanning.md §6.1): drawn in the browser as one
 * SVG path, nothing sent anywhere. Error correction Q (labels get dirty), a 4-module quiet zone,
 * text encoded as UTF-8. Pure module, `bun test`.
 */
import qrcode from "qrcode-generator";

// UTF-8, not the library's default (each character's low byte), so a Thai character survives
const utf8 = new TextEncoder();
qrcode.stringToBytes = (s: string) => Array.from(utf8.encode(s));

export const QUIET_ZONE = 4;

export interface QrSvg {
  /** modules per side, quiet zone included (the SVG viewBox is 0 0 size size) */
  size: number;
  /** one path of 1×1 squares for the dark modules */
  d: string;
}

export const qrSvg = (text: string, ec: "L" | "M" | "Q" | "H" = "Q"): QrSvg => {
  const qr = qrcode(0, ec);
  qr.addData(text, "Byte");
  qr.make();
  const n = qr.getModuleCount();
  const parts: string[] = [];
  for (let r = 0; r < n; r++) {
    // runs of dark modules in a row as one rectangle each: a much shorter path
    let c = 0;
    while (c < n) {
      if (!qr.isDark(r, c)) {
        c++;
        continue;
      }
      const start = c;
      while (c < n && qr.isDark(r, c)) c++;
      parts.push(`M${start + QUIET_ZONE} ${r + QUIET_ZONE}h${c - start}v1h-${c - start}z`);
    }
  }
  return { size: n + 2 * QUIET_ZONE, d: parts.join("") };
};
