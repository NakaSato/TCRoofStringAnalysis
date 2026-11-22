/** Released Knowledge Base documents by fault code ("Error:203") and by inverter model, for the
 * alarm rows and inverter pages (`/kb/docs/context`, DB only). Kept in tab memory for 5 minutes and
 * shared by every caller; cleared on sign-out (another user has another plant scope). */
import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { KbDocContext } from "../api/client";

const CONTEXT_TTL_MS = 5 * 60_000;
let ctxCache: { at: number; value: KbDocContext } | null = null;
let ctxInflight: Promise<KbDocContext> | null = null;
const listeners = new Set<(v: KbDocContext) => void>();

const loadContext = (): Promise<KbDocContext> => {
  if (ctxCache && Date.now() - ctxCache.at < CONTEXT_TTL_MS) return Promise.resolve(ctxCache.value);
  if (!ctxInflight) {
    ctxInflight = api
      .getKbDocContext()
      .then((v) => {
        ctxCache = { at: Date.now(), value: v };
        listeners.forEach((f) => f(v));
        return v;
      })
      .finally(() => {
        ctxInflight = null;
      });
  }
  return ctxInflight;
};

/** drop the cache (after a document's links or status changed) */
export const invalidateKbContext = () => {
  ctxCache = null;
};

/** Released documents by fault code ("Error:203") and model key; null until loaded or when the
 * request failed (the links are a convenience: a failure shows nothing, never an error). */
export function useKbContext(enabled = true): KbDocContext | null {
  const [v, setV] = useState<KbDocContext | null>(ctxCache?.value ?? null);
  useEffect(() => {
    if (!enabled) return;
    listeners.add(setV);
    loadContext().then(setV, () => undefined);
    return () => {
      listeners.delete(setV);
    };
  }, [enabled]);
  return enabled ? v : null;
}

/** model name → the key the backend links by (spaces / underscores dropped, upper case) */
export const modelKey = (name: string | null | undefined) => (name ?? "").replace(/[\s_]+/g, "").toUpperCase();

/** "Error" + 203 → "Error:203" (the backend's fault-code link key) */
export const faultKey = (faultType: string | null | undefined, code: number | string | null | undefined): string | null => {
  if (!faultType || code == null || code === "") return null;
  const t = String(faultType).trim();
  return `${t.charAt(0).toUpperCase()}${t.slice(1).toLowerCase()}:${String(code).trim()}`;
};

/** sign-out: forget the cache and tell mounted callers */
export const clearKbContext = () => {
  ctxCache = null;
  ctxInflight = null;
  listeners.forEach((f) => f({ fault_codes: {}, equipment: {} }));
};
