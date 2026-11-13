import { useCallback } from "react";
import { useSearchParams } from "react-router-dom";

export type UrlPatch = Record<string, string | number | boolean | null | undefined>;

/**
 * A page's own choices (selected inverter, filters, day…) kept in the URL query, so a reload or a
 * shared link shows the same view. Switching plant drops them (the plant URL has no query).
 *
 * `set(patch)` changes several keys in one navigation; null / "" / false removes a key, so defaults
 * stay out of the URL. Changes replace the history entry: back goes to the previous page, not to
 * every filter click.
 */
export function useUrlState(): [URLSearchParams, (patch: UrlPatch) => void] {
  const [params, setParams] = useSearchParams();
  const set = useCallback(
    (patch: UrlPatch) =>
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(patch)) {
            if (v == null || v === "" || v === false) next.delete(k);
            else next.set(k, v === true ? "1" : String(v));
          }
          return next;
        },
        { replace: true }
      ),
    [setParams]
  );
  return [params, set];
}

/** A query value when it is one of `allowed`, else `fallback` (a hand-edited URL can't break the page). */
export const pick = <T extends string>(value: string | null, allowed: readonly T[], fallback: T): T =>
  value != null && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;

/** `YYYY-MM-DD` query value, else null. */
export const pickDay = (value: string | null): string | null =>
  value != null && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;

/** `HH:MM` query value, else "". */
export const pickTime = (value: string | null): string => (value != null && /^\d{2}:\d{2}$/.test(value) ? value : "");
