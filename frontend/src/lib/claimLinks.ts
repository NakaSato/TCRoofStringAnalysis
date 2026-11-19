/** Link that opens the Claims page's create dialog, prefilled (`/claims?new=…`; read back by
 * `readPrefill` in pages/claims/format.ts). Kept here so Issues, Inverters and the I-V sweep panel
 * can link to it without loading the Claims page code. */
export type ClaimFrom = "issue" | "inverter" | "sweep";

export function newClaimHref(from: ClaimFrom, a: { plantId: number; sn?: string | null; stringNo?: number | null; ref?: number | null }): string {
  const q = new URLSearchParams({ new: from, p: String(a.plantId) });
  if (a.sn) q.set("sn", a.sn);
  if (a.stringNo != null) q.set("no", String(a.stringNo));
  if (a.ref != null) q.set("ref", String(a.ref));
  return `/claims?${q}`;
}
