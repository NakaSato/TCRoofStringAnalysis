/** Link that opens the Claims page's create dialog, prefilled (`/claims?new=…`; read back by
 * `readPrefill` in pages/claims/format.ts). Kept here so Issues, Inverters, the I-V sweep panel and
 * the Inventory replacement can link to it without loading the Claims page code. */
export type ClaimFrom = "issue" | "inverter" | "sweep" | "replacement";

export function newClaimHref(
  from: ClaimFrom,
  a: {
    plantId: number;
    sn?: string | null;
    stringNo?: number | null;
    /** issue id, sweep id, or (replacement) the failed unit's id */
    ref?: number | null;
    /** replacement: claim type, new SN installed, device label, red tag */
    claimType?: "equipment_warranty" | "inverter_warranty" | null;
    newSn?: string | null;
    label?: string | null;
    redTag?: string | null;
  }
): string {
  const q = new URLSearchParams({ new: from, p: String(a.plantId) });
  if (a.sn) q.set("sn", a.sn);
  if (a.stringNo != null) q.set("no", String(a.stringNo));
  if (a.ref != null) q.set("ref", String(a.ref));
  if (a.claimType) q.set("ct", a.claimType);
  if (a.newSn) q.set("nsn", a.newSn);
  if (a.label) q.set("dl", a.label);
  if (a.redTag) q.set("rt", a.redTag);
  return `/claims?${q}`;
}
