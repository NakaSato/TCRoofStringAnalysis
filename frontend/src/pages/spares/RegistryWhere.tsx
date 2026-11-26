/**
 * L-3 serial cross-links (docs/plans/inventory-installed-base.md): where the Growatt registry and the
 * site register have a serial shown in Inventory. `GET /stock/registry-where` (≤ 200 serials a call),
 * read once per serial for the page session (module cache, "no hit" included) and batched across
 * every component on screen. A link is optional: a failed lookup shows nothing.
 */
import React, { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, MapPin } from "lucide-react";
import { api, type RegistryHit } from "../../api/client";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { useI18n } from "../../i18n";
import { cn } from "@/lib/utils";
import { CATEGORY_LABEL } from "./shared";

const CHUNK = 200;
const MAX_LEN = 64;
const DEBOUNCE_MS = 300;

/** the key the API answers by: trimmed upper case */
export const registryKey = (serial: string | null | undefined) => (serial ?? "").trim().toUpperCase();

/** serial key → hits ([] = asked, no hit) */
const cache = new Map<string, RegistryHit[]>();
const inflight = new Set<string>();
const queue = new Set<string>();
let flushTimer: number | undefined;
/** bumped by clearRegistryWhere: answers to older requests are dropped */
let generation = 0;
/** bumped whenever the cache changes */
let version = 0;
const listeners = new Set<() => void>();

const changed = () => {
  version += 1;
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
const getVersion = () => version;

const flush = () => {
  flushTimer = undefined;
  const keys = [...queue].filter((k) => !cache.has(k) && !inflight.has(k));
  queue.clear();
  const gen = generation;
  for (let i = 0; i < keys.length; i += CHUNK) {
    const chunk = keys.slice(i, i + CHUNK);
    for (const k of chunk) inflight.add(k);
    api
      .registryWhere(chunk)
      .then((r) => {
        if (gen !== generation) return;
        const found = new Map<string, RegistryHit[]>();
        for (const [k, v] of Object.entries(r?.items ?? {})) if (Array.isArray(v)) found.set(registryKey(k), v);
        for (const k of chunk) cache.set(k, found.get(k) ?? []);
      })
      .catch(() => {
        // optional link: remember "nothing" for the session rather than retry on every render
        if (gen === generation) for (const k of chunk) cache.set(k, []);
      })
      .finally(() => {
        for (const k of chunk) inflight.delete(k);
        if (gen === generation) changed();
      });
  }
};

const request = (keys: string[]) => {
  let added = false;
  for (const k of keys) {
    if (cache.has(k) || inflight.has(k)) continue;
    queue.add(k);
    added = true;
  }
  // a short tick so every component that asked in the same render shares one call
  if (added && flushTimer == null) flushTimer = window.setTimeout(flush, 20);
};

/** Forget every answer (after a change that moves devices, e.g. a replacement): visible serials are asked again. */
export const clearRegistryWhere = () => {
  cache.clear();
  inflight.clear();
  queue.clear();
  generation += 1;
  changed();
};

/** Clears the cache when `value` changes after mount (pass the page's data version). */
export const useClearRegistryOn = (value: unknown) => {
  const first = useRef(value);
  useEffect(() => {
    if (Object.is(first.current, value)) return;
    first.current = value;
    clearRegistryWhere();
  }, [value]);
};

/**
 * Where the registry has these serials: `{ SERIAL_KEY: RegistryHit[] }` with only the serials that
 * have a hit (key = `registryKey(serial)`). Empty, comma-bearing and over-long values are ignored.
 */
export const useRegistryWhere = (serials: readonly (string | null | undefined)[]): Record<string, RegistryHit[]> => {
  // the caller's array is usually new each render: the joined keys compare by content
  const keySet = new Set<string>();
  for (const s of serials) {
    const k = registryKey(s);
    if (k && k.length <= MAX_LEN && !k.includes(",")) keySet.add(k);
  }
  const keyList = [...keySet].sort().join("\n");
  const v = useSyncExternalStore(subscribe, getVersion);
  useEffect(() => {
    if (!keyList) return;
    const keys = keyList.split("\n");
    const h = window.setTimeout(() => request(keys), DEBOUNCE_MS);
    return () => window.clearTimeout(h);
  }, [keyList, v]);
  return useMemo(() => {
    const out: Record<string, RegistryHit[]> = {};
    if (!keyList) return out;
    for (const k of keyList.split("\n")) {
      const hits = cache.get(k);
      if (hits?.length) out[k] = hits;
    }
    return out;
  }, [keyList, v]);
};

/** label · site code (or plant name) */
export const hitWhere = (h: RegistryHit) => `${h.label} · ${h.site_code ?? h.plant_name ?? "—"}`;

const hitTitle = (h: RegistryHit, t: (s: string, v?: Record<string, string | number>) => string) =>
  [
    `${t(CATEGORY_LABEL[h.category] ?? h.category)} ${h.label}`,
    `${t("Plant")}: ${h.plant_name ?? "—"}${h.site_code ? ` (${h.site_code})` : ""}`,
    h.ip || h.network ? `${t("IP / network")}: ${[h.ip, h.network].filter(Boolean).join(" · ")}` : null,
    h.sim ? `SIM: ${h.sim}` : null,
  ]
    .filter(Boolean)
    .join("\n");

/**
 * Where the registry has a serial: category + label · site, linking to the device. `warn` = amber
 * (a spare in stock that the registry also has installed on a plant). Several hits = the first + "+n".
 */
export const RegistryChip: React.FC<{ hits: RegistryHit[] | undefined; warn?: boolean; className?: string }> = ({ hits, warn, className }) => {
  const { t } = useI18n();
  if (!hits?.length) return null;
  const [first, ...rest] = hits;
  const title = (warn ? `${t("Registered as installed: a spare should not also be on a plant.")}\n` : `${t("In the registry")}\n`) + hitTitle(first, t);
  const Icon = warn ? AlertTriangle : MapPin;
  return (
    <span className={cn("inline-flex max-w-full min-w-0 items-center gap-1", className)}>
      <Badge asChild variant={warn ? "warn" : "info"} className="max-w-full min-w-0 shrink justify-start hover:brightness-125">
        <Link to={first.path} title={title} onClick={(e) => e.stopPropagation()}>
          <Icon data-icon="inline-start" aria-hidden />
          <span className="min-w-0 truncate">
            {/* a site device's label is its type already ("4G router", "Revenue meter 2"): don't say it twice */}
            {first.label.startsWith(CATEGORY_LABEL[first.category] ?? "\u0000") ? null : `${t(CATEGORY_LABEL[first.category] ?? first.category)} `}
            {hitWhere(first)}
          </span>
        </Link>
      </Badge>
      {rest.length > 0 && (
        <Badge variant={warn ? "warn" : "info"} title={rest.map((h) => hitTitle(h, t)).join("\n\n")}>
          +{rest.length}
        </Badge>
      )}
    </span>
  );
};

/** On receive: the serial is registered as installed. A warning only, never blocking. */
export const RegistryReceiveWarning: React.FC<{ hits: RegistryHit[] | undefined; className?: string }> = ({ hits, className }) => {
  const { t } = useI18n();
  if (!hits?.length) return null;
  return (
    <Alert variant="warn" className={className}>
      <AlertTriangle aria-hidden />
      <AlertDescription className="flex min-w-0 flex-col gap-1.5">
        <span>
          {t("Registered as installed at {where}; receive it anyway only if it really came off the plant.", {
            where: hits.map(hitWhere).join(", "),
          })}
        </span>
        <RegistryChip hits={hits} warn />
      </AlertDescription>
    </Alert>
  );
};
