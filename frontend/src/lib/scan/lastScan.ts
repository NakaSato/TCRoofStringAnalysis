/**
 * The record a scan just opened, and how it was read (docs/plans/barcode-scanning.md §7.2, §9):
 * a form that acts on that record (an instrument check-out) can then say the asset tag was
 * scanned, without the person scanning twice. Memory only (this tab), forgotten after 15 min.
 */
import type { InputMethod, ScanMatch } from "../../api/client";

const MAX_AGE_MS = 15 * 60_000;

interface LastScan {
  kind: ScanMatch["kind"];
  id: string;
  method: InputMethod;
  raw: string | null;
  at: number;
}

let last: LastScan | null = null;

export const rememberScan = (m: Pick<ScanMatch, "kind" | "id">, method: InputMethod, raw: string | null): void => {
  last = { kind: m.kind, id: m.id, method, raw: raw ? raw.slice(0, 512) : null, at: Date.now() };
};

/** How `kind` `id` was opened, if a scan opened it in the last 15 min; else null. */
export const scanOf = (kind: ScanMatch["kind"], id: string | number): { method: InputMethod; raw: string | null } | null =>
  last && last.kind === kind && last.id === String(id) && Date.now() - last.at < MAX_AGE_MS ? { method: last.method, raw: last.raw } : null;

export const forgetScan = (): void => {
  last = null;
};
