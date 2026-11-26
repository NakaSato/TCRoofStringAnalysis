/**
 * A4 label sheets (docs/plans/barcode-scanning.md §13 decision 4): weatherproof polyester labels
 * for instruments, bins and spares, paper tags for red tags. Sizes match the common Avery-type
 * sheets (L7159 / L7165 layout); "start at" leaves the used labels of a part-used sheet empty.
 * Pure module, `bun test`.
 */
import type { ScanLabel, ScanLabelKind } from "../../api/types/scan";

export type LayoutId = "poly24" | "tag8";

export interface SheetLayout {
  id: LayoutId;
  name: string;
  /** label size, mm */
  w: number;
  h: number;
  cols: number;
  rows: number;
  /** page margins and gaps, mm (A4 210 × 297) */
  left: number;
  top: number;
  colGap: number;
  rowGap: number;
  /** printed QR side, mm (≥ 15 mm for phone cameras at 10–20 cm, plan §6.1) */
  qr: number;
}

export const LAYOUTS: Record<LayoutId, SheetLayout> = {
  poly24: { id: "poly24", name: "Polyester 63.5 × 33.9 mm, 24 a sheet", w: 63.5, h: 33.9, cols: 3, rows: 8, left: 7.25, top: 12.9, colGap: 2.5, rowGap: 0, qr: 25 },
  tag8: { id: "tag8", name: "Paper tag 99.1 × 67.7 mm, 8 a sheet", w: 99.1, h: 67.7, cols: 2, rows: 4, left: 4.65, top: 13.1, colGap: 2.5, rowGap: 0, qr: 40 },
};

/** red tags go on paper tags, everything else on polyester */
export const defaultLayout = (kind: ScanLabelKind): LayoutId => (kind === "rt" ? "tag8" : "poly24");

export const perSheet = (l: SheetLayout) => l.cols * l.rows;

/** Labels in sheet order, `startAt` (1-based) skipping the used ones on the first sheet. */
export const toSheets = <T>(items: T[], layout: SheetLayout, startAt = 1): Array<Array<T | null>> => {
  const n = perSheet(layout);
  const skip = Math.min(Math.max(1, Math.floor(startAt)), n) - 1;
  const cells: Array<T | null> = [...Array<null>(skip).fill(null), ...items];
  const out: Array<Array<T | null>> = [];
  for (let i = 0; i < cells.length; i += n) {
    const page = cells.slice(i, i + n);
    while (page.length < n) page.push(null);
    out.push(page);
  }
  return items.length ? out : [];
};

/** Top-left corner of cell `i` on a sheet, mm. */
export const cellAt = (l: SheetLayout, i: number): { x: number; y: number } => ({
  x: l.left + (i % l.cols) * (l.w + l.colGap),
  y: l.top + Math.floor(i / l.cols) * (l.h + l.rowGap),
});

export const qrUrl = (origin: string, item: Pick<ScanLabel, "path">): string => origin.replace(/\/+$/, "") + item.path;

const csvCell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** For a label printer or a print shop: one row per label. */
export const labelsCsv = (items: ScanLabel[], origin: string): string =>
  [["code", "qr_url", "title", "text"], ...items.map((i) => [i.code, qrUrl(origin, i), i.title, i.lines.join(" | ")])]
    .map((r) => r.map(csvCell).join(","))
    .join("\r\n");

/** An address a phone elsewhere cannot open: a label printed from here would not work in the field. */
export const isLocalOrigin = (origin: string): boolean => {
  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    return true;
  }
  return (
    host === "localhost" ||
    host === "[::1]" ||
    host.endsWith(".local") ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  );
};
