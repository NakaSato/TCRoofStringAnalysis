import { useEffect, useRef } from "react";
import type { GrowattLive } from "../api/client";

const FALLBACK_S = 60; // backend did not say (older API)
const JITTER_MS = 5_000; // spread users so they don't all hit an expiring key together
const ERROR_BACKOFF_S = [30, 60, 120];

/**
 * Poll a `/growatt/live/*` endpoint when the backend says new data can exist (`refresh_in_s`),
 * not on a fixed timer. Hidden tabs don't poll; a tab that becomes visible past its due time
 * refreshes at once. Changing `key` restarts the loop; `enabled = false` stops it.
 */
export function useLivePoll<T>(
  enabled: boolean,
  key: unknown,
  fetcher: () => Promise<GrowattLive<T>>,
  onData: (r: GrowattLive<T>) => void,
  onError: (err: unknown) => void
): void {
  // latest callbacks without restarting the loop on every render
  const cb = useRef({ fetcher, onData, onError });
  cb.current = { fetcher, onData, onError };

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer: number | undefined;
    let dueAt = 0;
    let inFlight = false;
    let failures = 0;

    const schedule = (seconds: number) => {
      dueAt = Date.now() + seconds * 1000 + Math.random() * JITTER_MS;
      window.clearTimeout(timer);
      timer = window.setTimeout(run, dueAt - Date.now());
    };

    function run() {
      if (cancelled || inFlight) return;
      if (document.hidden) return; // due; the visibility handler picks it up
      inFlight = true;
      cb.current
        .fetcher()
        .then((r) => {
          if (cancelled) return;
          failures = 0;
          cb.current.onData(r);
          schedule(r.refresh_in_s ?? FALLBACK_S);
        })
        .catch((err) => {
          if (cancelled) return;
          cb.current.onError(err);
          schedule(ERROR_BACKOFF_S[Math.min(failures++, ERROR_BACKOFF_S.length - 1)]);
        })
        .finally(() => {
          inFlight = false;
        });
    }

    const onVisible = () => {
      if (!document.hidden && Date.now() >= dueAt) {
        window.clearTimeout(timer);
        run();
      }
    };

    document.addEventListener("visibilitychange", onVisible);
    run();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled, key]);
}
