/**
 * Inventory → Batch scan → Count (`/inventory/scan?mode=count&loc=<id>`, docs/plans/spares-failed-units.md
 * §5.7, §8 step 5): scan a location's label, then every unit in it. The list holds only the scans
 * (nothing is written per scan); each change re-runs `api.previewCount` (debounced 400 ms), which
 * compares the scans with the register: matched · will move here · found again · new · missing, plus
 * rows that stop the confirm (needs part, several parts, can't count). Anyone counts; an admin or store
 * keeper confirms (D-1) with the preview's `expected_ids`, which writes `count_adjust` movements; a 409
 * `stock_changed` re-runs the preview and says so, a 409 with rows marks them. An empty location's
 * first count puts every scanned unit in as new stock (D-5). URL `loc`, `part` (part for new serials);
 * the list is kept in `sessionStorage` per location. Pure logic: `lib/scan/count.ts`.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, ClipboardCheck, Info, Printer, ScanLine, Trash2, X } from "lucide-react";
import { api, type CountPreview, type CountRow, type InputMethod, type StockCount, type StockLocation, type StockLookup, type StockPart, type StockUnit } from "../../api/client";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { LoadingState } from "../../components/ui";
import { MethodBadge } from "../../components/scan/ScanDialog";
import { useAppContext } from "../../context/AppContext";
import { useI18n } from "../../i18n";
import { notify } from "../../lib/notify";
import { useUrlState } from "@/lib/useUrlState";
import { signal, unlockAudio } from "../../lib/scan/feedback";
import { pushScanTarget } from "../../lib/scan/hidScanner";
import { markServerErrors, serialKey } from "../../lib/scan/batch";
import {
  RESULT_LABEL,
  RESULT_TONE,
  buildCountScans,
  confirmGate,
  countStorageKey,
  findCountDuplicate,
  groupRows,
  isFirstCount,
  isStockChanged,
  previewByRow,
  readCountRows,
  rowErrors,
  scansKey,
  writeCountRows,
  type CountListRow,
  type CountTone,
  type GroupKey,
} from "../../lib/scan/count";
import { clean, normalise } from "../../lib/scan/parse";
import { KIND_LABEL, STATE_LABEL, canManageStock, errorText, fmtStockAt } from "./shared";
import { STATUS_ICON, STATUS_ROW, STATUS_TEXT, ScanInputs, newRowId } from "./scanShared";
import { cn } from "@/lib/utils";

const NONE = "__none";
const PREVIEW_DEBOUNCE_MS = 400;
const FLASH_MS = 1200;
const COUNT_KINDS = new Set(["store", "bin", "van"]);

const TONE_ROW: Record<CountTone, string> = { ...STATUS_ROW, info: "border-sky-500/25 bg-sky-500/[0.04]" };
const TONE_TEXT: Record<CountTone, string> = { ...STATUS_TEXT, info: "text-sky-300" };
const TONE_BADGE: Record<CountTone, "ok" | "info" | "warn" | "crit"> = { ok: "ok", info: "info", warn: "warn", error: "crit" };
const TONE_ICON: Record<CountTone, React.ReactNode> = { ...STATUS_ICON, info: <Info className="size-5 text-sky-400" aria-hidden /> };

interface LastScan {
  status: "ok" | "warn" | "error";
  text: string;
}

interface PreviewState {
  key: string;
  /** the list row id of each scan index the preview answered */
  ids: string[];
  data: CountPreview;
}

export const CountScanPage: React.FC<{ tabs: React.ReactNode }> = ({ tabs }) => {
  const { t, locale } = useI18n();
  const { user } = useAppContext();
  const keeper = canManageStock(user);
  const [url, setUrl] = useUrlState();
  const locRaw = Number(url.get("loc"));
  const loc = Number.isInteger(locRaw) && locRaw > 0 ? locRaw : null;
  const partRaw = Number(url.get("part"));
  const partParam = Number.isInteger(partRaw) && partRaw > 0 ? partRaw : null;

  const [parts, setParts] = useState<StockPart[] | null>(null);
  const [locations, setLocations] = useState<StockLocation[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    Promise.all([api.listStockParts(), api.listStockLocations()])
      .then(([p, l]) => {
        if (!alive) return;
        setParts(p.filter((x) => x.active));
        setLocations(l);
      })
      .catch((e) => alive && setLoadError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, []);

  const countable = useMemo(() => (locations ?? []).filter((l) => l.active && COUNT_KINDS.has(l.kind)), [locations]);
  const place = useMemo(() => countable.find((l) => l.id === loc) ?? null, [countable, loc]);
  const locId = place?.id ?? null;
  const partForNew = useMemo(() => (parts ?? []).find((p) => p.id === partParam) ?? null, [parts, partParam]);
  const partById = useMemo(() => new Map((parts ?? []).map((p) => [p.id, p])), [parts]);

  // ---- the list, kept per location in sessionStorage (another location has its own list)
  const key = countStorageKey(loc);
  const [list, setList] = useState(() => ({ key, rows: readCountRows(key) }));
  const rowsRef = useRef(list.rows);
  rowsRef.current = list.rows;
  useEffect(() => {
    if (list.key !== key) setList({ key, rows: readCountRows(key) });
  }, [key]);
  useEffect(() => {
    if (list.key === key) writeCountRows(key, list.rows);
  }, [list, key]);
  const rows = list.key === key ? list.rows : [];
  const setRows = useCallback((fn: (r: CountListRow[]) => CountListRow[]) => {
    setList((l) => {
      const next = { ...l, rows: fn(l.rows) };
      rowsRef.current = next.rows;
      return next;
    });
  }, []);

  const [last, setLast] = useState<LastScan | null>(null);
  const [flashId, setFlashId] = useState<string | null>(null);
  const flashTimer = useRef<number | undefined>(undefined);
  const flash = (id: string) => {
    setFlashId(id);
    window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlashId(null), FLASH_MS);
  };
  useEffect(() => () => window.clearTimeout(flashTimer.current), []);

  const [pendingLoc, setPendingLoc] = useState<StockLocation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);
  const [done, setDone] = useState<StockCount | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState("");

  // ---- the preview: re-run (debounced) whenever the location or the scans change
  const { scans, ids } = useMemo(() => buildCountScans(rows, partForNew?.id ?? null), [rows, partForNew]);
  const pkey = scansKey(locId, scans);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (locId == null) {
      setPreview(null);
      return;
    }
    let alive = true;
    const sentIds = ids;
    const h = window.setTimeout(() => {
      api
        .previewCount(locId, scans)
        .then((data) => {
          if (!alive) return;
          setPreview({ key: pkey, ids: sentIds, data });
          setPreviewError(null);
        })
        .catch((e) => alive && setPreviewError(errorText(e, t)));
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      alive = false;
      window.clearTimeout(h);
    };
    // pkey stands for locId + scans
  }, [pkey, nonce]);
  // a preview of another location is never shown
  const pv = preview && preview.data.location.id === locId ? preview : null;
  const fresh = !!pv && pv.key === pkey;
  const byId = useMemo(() => previewByRow(pv?.data ?? null, pv?.ids ?? []), [pv]);
  const groups = useMemo(() => groupRows(rows, byId), [rows, byId]);
  const serverErrors = rows.filter((r) => r.server_error).length;
  const gate = confirmGate({ keeper, locationId: locId, preview: pv?.data ?? null, fresh, busy, serverErrors });
  const first = isFirstCount(pv?.data ?? null);
  const lastCount = pv?.data.location ?? place;

  // ---- earlier counts of this location
  const [history, setHistory] = useState<StockCount[] | null>(null);
  useEffect(() => {
    if (locId == null) return;
    let alive = true;
    setHistory(null);
    api
      .listCounts(locId)
      .then((c) => alive && setHistory(c))
      .catch(() => alive && setHistory([]));
    return () => {
      alive = false;
    };
  }, [locId, done]);

  // what the scan handler reads (it runs after an await, so not from the render's closure)
  const ctx = useRef({ locId, countable, t });
  ctx.current = { locId, countable, t };

  const handle = useCallback(
    async (raw: string, method: InputMethod) => {
      const text = clean(raw);
      if (!text) return;
      const { t: tr } = ctx.current;
      let res: StockLookup;
      try {
        res = await api.stockLookup(text);
      } catch (e) {
        signal("error");
        setLast({ status: "error", text: `${text}: ${errorText(e, tr)}` });
        return;
      }
      const { locId: d, countable: places } = ctx.current;

      if (res.kind === "location" && res.location) {
        const l = places.find((x) => x.id === res.location!.id);
        if (!l) {
          signal("error");
          setLast({ status: "error", text: tr("{code}: not an active store, bin or van", { code: res.location.code }) });
          return;
        }
        if (l.id === d) {
          signal("ok");
          setLast({ status: "ok", text: tr("Counting {code}", { code: l.code }) });
        } else if (!rowsRef.current.length) {
          signal("ok");
          setUrl({ loc: l.id });
          setLast({ status: "ok", text: tr("Counting {code}", { code: l.code }) });
        } else {
          signal("warn");
          setPendingLoc(l);
        }
        return;
      }
      if (res.kind === "part" && res.part) {
        signal("ok");
        setUrl({ part: res.part.id });
        setLast({ status: "ok", text: tr("Part for new serials: {code}", { code: res.part.code }) });
        return;
      }
      if (d == null) {
        signal("warn");
        setLast({ status: "warn", text: tr("Scan or pick the location first, then its units.") });
        return;
      }

      const serial = res.kind === "unit" && res.units[0] ? res.units[0].serial : res.code || normalise(text).value;
      const rows0 = rowsRef.current;
      const dup = findCountDuplicate(rows0, serial);
      if (dup >= 0) {
        signal("warn");
        flash(rows0[dup].id);
        setLast({ status: "warn", text: `${serial}: ${tr("Duplicate in this list")}` });
        return;
      }
      const row: CountListRow = { id: newRowId(), raw: text, input_method: method, serial, kind: res.kind, units: res.units, part_id: null, server_error: null };
      setRows((r) => [row, ...r.filter((x) => serialKey(x.serial) !== serialKey(serial))]);
      setChanged(false);
      setDone(null);
      signal("ok");
      flash(row.id);
      setLast({ status: "ok", text: `${serial}: ${tr("Scanned")}` });
    },
    [setRows, setUrl]
  );

  // one scan at a time, in order: a fast scanner must not race the duplicate check
  const queue = useRef<Promise<void>>(Promise.resolve());
  const enqueue = useCallback(
    (raw: string, method: InputMethod) => {
      queue.current = queue.current.then(() => handle(raw, method)).catch(() => undefined);
    },
    [handle]
  );
  useEffect(() => pushScanTarget((b) => enqueue(b.value, "hid")), [enqueue]);

  const removeRow = (id: string) => setRows((r) => r.filter((x) => x.id !== id));
  const patchRow = (id: string, patch: Partial<CountListRow>) => setRows((r) => r.map((x) => (x.id === id ? { ...x, ...patch, server_error: null } : x)));

  const confirm = async () => {
    if (!pv || !gate.ok || locId == null) return;
    const sent = { scans, ids, expected: pv.data.expected_ids, code: pv.data.location.code };
    setBusy(true);
    setError(null);
    setChanged(false);
    try {
      const res = await api.confirmCount(locId, sent.scans, sent.expected, note.trim() || undefined);
      const c = res.count;
      setRows(() => []);
      setLast(null);
      setNote("");
      setConfirming(false);
      setDone(c);
      notify(
        "ok",
        t("Count of {code} saved: {matched} matched, {moved} moved here, {found} found again, {new} new, {missing} marked missing", {
          code: sent.code,
          matched: c.matched,
          moved: c.moved_here,
          found: c.found_again,
          new: c.new_units,
          missing: c.missing,
        })
      );
    } catch (e) {
      signal("error");
      setConfirming(false);
      if (isStockChanged(e)) {
        setChanged(true);
        // the shown preview is out of date: Confirm waits for the new one
        setPreview((p) => (p ? { ...p, key: "" } : p));
        setNonce((n) => n + 1);
      } else {
        const d = rowErrors(e);
        if (d) {
          setRows((r) => markServerErrors(r, sent.ids, d.errors));
          const general = d.errors.filter((x) => x.row == null).map((x) => x.error);
          setError([t("Nothing was saved: fix or remove the rows marked ✕, then confirm again."), d.message, ...general].filter(Boolean).join("\n"));
        } else {
          setError(errorText(e, t));
        }
      }
    } finally {
      setBusy(false);
    }
  };

  if (loadError) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{loadError}</AlertDescription>
      </Alert>
    );
  }
  if (!parts || !locations) return <LoadingState />;

  const c = pv?.data.counts;

  return (
    <div className="flex min-w-0 flex-col gap-4" onPointerDown={unlockAudio}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Button asChild variant="ghost" size="icon-sm" aria-label={t("Back")}>
            <Link to="/inventory?tab=locations">
              <ArrowLeft />
            </Link>
          </Button>
          <div className="flex min-w-0 flex-col">
            <h1 className="text-lg font-semibold">{t("Batch scan")}</h1>
            <p className="text-xs text-muted-foreground">{t("Count a location: scan its label, then every unit in it. Nothing changes until an admin or store keeper confirms.")}</p>
          </div>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link to="/labels?kind=loc">
            <Printer data-icon="inline-start" />
            {t("Location labels")}
          </Link>
        </Button>
      </div>

      {tabs}

      <Card className="py-4">
        <CardContent className="flex flex-col gap-4 px-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex min-w-0 flex-col gap-1.5">
              <Label htmlFor="cs-loc" className="text-xs">
                {t("Location being counted")}
              </Label>
              <Select
                value={locId != null ? String(locId) : NONE}
                onValueChange={(v) => {
                  const l = countable.find((x) => String(x.id) === v);
                  if (l) setUrl({ loc: l.id });
                }}
              >
                <SelectTrigger id="cs-loc" className="w-full">
                  <SelectValue placeholder={t("Pick or scan a location label")} />
                </SelectTrigger>
                <SelectContent>
                  {locId == null && (
                    <SelectItem value={NONE} disabled>
                      {t("Pick or scan a location label")}
                    </SelectItem>
                  )}
                  {countable.map((l) => (
                    <SelectItem key={l.id} value={String(l.id)}>
                      {l.code} · {l.name} ({t(KIND_LABEL[l.kind])})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {loc != null && !place && <span className="text-[11px] text-amber-300">{t("The location in the link is not an active store, bin or van.")}</span>}
              {lastCount && (
                <span className="text-[11px] text-muted-foreground">
                  {lastCount.last_count_at
                    ? t("Last counted {when} by {by}", { when: fmtStockAt(lastCount.last_count_at, locale), by: lastCount.last_count_by ?? "—" })
                    : t("Never counted")}
                </span>
              )}
            </div>
            <div className="flex min-w-0 flex-col gap-1.5">
              <Label htmlFor="cs-part" className="text-xs">
                {t("Part for new serials")}
              </Label>
              <Select value={partForNew ? String(partForNew.id) : NONE} onValueChange={(v) => setUrl({ part: v === NONE ? null : v })}>
                <SelectTrigger id="cs-part" className="w-full">
                  <SelectValue placeholder={t("Pick a part")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>{t("Pick a part")}</SelectItem>
                  {parts.map((p) => (
                    <SelectItem key={p.id} value={String(p.id)}>
                      {p.code} · {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="text-[11px] text-muted-foreground">{t("Or scan the part's label. A serial not in the register is counted as this part.")}</span>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <ScanInputs onScan={enqueue} />
            {last && (
              <div role="status" aria-live="polite" className={cn("flex min-w-0 items-center gap-2 rounded-md border px-3 py-2 text-sm", STATUS_ROW[last.status])}>
                {STATUS_ICON[last.status]}
                <span className={cn("min-w-0 break-words", STATUS_TEXT[last.status])}>{last.text}</span>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {changed && (
        <Alert variant="warn">
          <AlertDescription>{t("Stock here changed since you started; check the list again")}</AlertDescription>
        </Alert>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertDescription className="whitespace-pre-line">{error}</AlertDescription>
        </Alert>
      )}
      {previewError && (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center gap-2">
            {t("Could not compare the scans with the register: {error}", { error: previewError })}
            <Button size="xs" variant="outline" onClick={() => setNonce((n) => n + 1)}>
              {t("Try again")}
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {done && <CountDone count={done} />}
      {first && (
        <Alert variant="default">
          <Info />
          <AlertDescription>{t("First count of this location: every unit you scan goes in as new stock")}</AlertDescription>
        </Alert>
      )}

      {locId != null && c && (
        <div className={cn("grid grid-cols-3 gap-2 sm:grid-cols-5 lg:grid-cols-9", !fresh && "opacity-60")} aria-busy={!fresh}>
          <CountStat label={t("Matched")} value={c.matched} />
          <CountStat label={t("Will move here")} value={c.moved_here} tone={c.moved_here ? "info" : undefined} />
          <CountStat label={t("Found again")} value={c.found_again} tone={c.found_again ? "info" : undefined} />
          <CountStat label={t("New")} value={c.new} tone={c.new ? "info" : undefined} />
          <CountStat label={t("Missing")} value={c.missing} tone={c.missing ? "warn" : undefined} />
          <CountStat label={t("Needs part")} value={c.needs_part} tone={c.needs_part ? "error" : undefined} />
          <CountStat label={t("Several parts")} value={c.ambiguous} tone={c.ambiguous ? "warn" : undefined} />
          <CountStat label={t("Can't count")} value={c.blocked} tone={c.blocked ? "error" : undefined} />
          <CountStat label={t("Duplicate")} value={c.duplicate} tone={c.duplicate ? "warn" : undefined} />
        </div>
      )}

      {!rows.length && !pv?.data.missing.length ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-white/10 px-4 py-10 text-center text-sm text-muted-foreground">
          <ScanLine className="size-6 text-slate-500" aria-hidden />
          {locId == null ? t("Scan or pick the location first, then its units.") : t("Scan every unit here: each scan adds a row.")}
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {groups.map((g) => (
            <section key={g.key} className="flex flex-col gap-2">
              <GroupHeading k={g.key} n={g.rows.length} />
              <ul className="flex flex-col gap-2">
                {g.rows.map((r) => (
                  <CountRowItem
                    key={r.id}
                    row={r}
                    res={byId.get(r.id) ?? null}
                    parts={parts}
                    partById={partById}
                    partForNew={partForNew?.id ?? null}
                    flash={flashId === r.id}
                    onRemove={() => removeRow(r.id)}
                    onPatch={(p) => patchRow(r.id, p)}
                  />
                ))}
              </ul>
            </section>
          ))}
          {!!pv?.data.missing.length && (
            <section className="flex flex-col gap-2">
              <div className="flex flex-wrap items-baseline gap-2">
                <h2 className="text-sm font-semibold text-amber-300">
                  {t("Missing")} · {pv.data.missing.length}
                </h2>
                <span className="text-[11px] text-muted-foreground">{t("In the register here but not scanned: marked missing on confirm")}</span>
              </div>
              <ul className="flex flex-col gap-1.5">
                {pv.data.missing.map((u) => (
                  <MissingItem key={u.id} unit={u} />
                ))}
              </ul>
            </section>
          )}
        </div>
      )}

      {locId != null && !!history?.length && <CountHistory counts={history.slice(0, 5)} />}

      <div className="sticky bottom-0 z-10 -mx-1 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-white/10 bg-background/95 px-3 py-2.5 backdrop-blur">
        <span className="text-sm font-medium">{t("{n} scanned", { n: rows.length })}</span>
        {pv && (
          <span className="text-xs text-muted-foreground">{t("{n} in the register here", { n: pv.data.expected.length })}</span>
        )}
        {locId != null && !fresh && !previewError && (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Spinner className="size-3" /> {t("Checking…")}
          </span>
        )}
        <span className="flex-1" />
        {rows.length > 0 && (
          <Button variant="ghost" size="sm" onClick={() => setRows(() => [])} disabled={busy}>
            <Trash2 data-icon="inline-start" />
            {t("Clear list")}
          </Button>
        )}
        {keeper ? (
          <div className="flex min-w-0 flex-col items-end gap-0.5">
            <Button onClick={() => setConfirming(true)} disabled={!gate.ok}>
              {busy ? <Spinner data-icon="inline-start" /> : <ClipboardCheck data-icon="inline-start" />}
              {t("Confirm count")}
            </Button>
            {gate.reason && gate.reason !== "Checking the list…" && <span className="text-[11px] text-amber-300">{t(gate.reason, gate.vars)}</span>}
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">{t("An admin or store keeper confirms the count")}</span>
        )}
      </div>

      <AlertDialog open={confirming} onOpenChange={(o) => !busy && setConfirming(o)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Confirm the count of {code}?", { code: pv?.data.location.code ?? "" })}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("The register is set to what you scanned. Every change is a Count adjustment in the movement log.")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {c && (
            <ul className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
              <li>
                {t("Matched")}: <span className="num">{c.matched}</span>
              </li>
              <li>
                {t("Will move here")}: <span className="num">{c.moved_here}</span>
              </li>
              <li>
                {t("Found again")}: <span className="num">{c.found_again}</span>
              </li>
              <li>
                {t("New")}: <span className="num">{c.new}</span>
              </li>
              <li className={c.missing ? "text-amber-300" : undefined}>
                {t("Marked missing")}: <span className="num">{c.missing}</span>
              </li>
            </ul>
          )}
          {c && c.missing > 0 && c.matched + c.moved_here + c.found_again + c.new === 0 && (
            // nothing scanned counts in: confirming empties the location in the register
            <p role="alert" className="callout-warn text-sm font-medium">
              {t("Nothing you scanned is counted here: all {n} units in the register at this location will be marked missing.", { n: c.missing })}
            </p>
          )}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cs-note" className="text-xs">
              {t("Note (optional)")}
            </Label>
            <Textarea id="cs-note" value={note} rows={2} maxLength={2000} onChange={(e) => setNote(e.target.value)} />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>{t("Cancel")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy || !gate.ok}
              onClick={(e) => {
                e.preventDefault();
                void confirm();
              }}
            >
              {busy && <Spinner data-icon="inline-start" />}
              {c && c.missing > 0 && c.matched + c.moved_here + c.found_again + c.new === 0
                ? t("Mark all {n} missing", { n: c.missing })
                : t("Confirm count")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!pendingLoc} onOpenChange={(o) => !o && setPendingLoc(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Count {code} instead?", { code: pendingLoc?.code ?? "" })}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("The {n} scans of {old} stay saved on this device for {old}; {code} opens its own list.", {
                n: rows.length,
                old: place?.code ?? "—",
                code: pendingLoc?.code ?? "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Keep {code}", { code: place?.code ?? "—" })}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingLoc) setUrl({ loc: pendingLoc.id });
                setPendingLoc(null);
              }}
            >
              {t("Change it")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

const CountStat: React.FC<{ label: string; value: number; tone?: CountTone }> = ({ label, value, tone }) => (
  <div className="flex min-w-0 flex-col rounded-lg border border-white/[0.07] px-3 py-2">
    <span className={cn("num text-lg font-semibold", tone ? TONE_TEXT[tone] : "text-slate-100")}>{value}</span>
    <span className="truncate text-[11px] text-muted-foreground" title={label}>
      {label}
    </span>
  </div>
);

const GroupHeading: React.FC<{ k: GroupKey; n: number }> = ({ k, n }) => {
  const { t } = useI18n();
  return (
    <h2 className={cn("text-sm font-semibold", k === "pending" ? "text-muted-foreground" : TONE_TEXT[RESULT_TONE[k]])}>
      {k === "pending" ? t("Checking…") : t(RESULT_LABEL[k])} · {n}
    </h2>
  );
};

const CountRowItem: React.FC<{
  row: CountListRow;
  res: CountRow | null;
  parts: StockPart[];
  partById: Map<number, StockPart>;
  partForNew: number | null;
  flash: boolean;
  onRemove: () => void;
  onPatch: (p: Partial<CountListRow>) => void;
}> = ({ row, res, parts, partById, partForNew, flash, onRemove, onPatch }) => {
  const { t } = useI18n();
  const tone: CountTone = row.server_error ? "error" : res ? RESULT_TONE[res.result] : "ok";
  const unit = res?.unit ?? (row.units.length === 1 ? row.units[0] : null);
  const partId = res?.part_id ?? row.part_id ?? (!row.units.length ? partForNew : null);
  const part = partId != null ? partById.get(partId) : undefined;
  const partLine = unit ? `${unit.part_code} · ${unit.part_name}` : part ? `${part.code} · ${part.name}` : null;
  const where = unit && res && res.result !== "matched" && res.result !== "new" ? (unit.location_code ?? unit.plant_name ?? null) : null;
  // several parts have the serial: pick the unit's part; a serial not in the register: the part it goes in as
  const pickUnit = row.units.length > 1;
  const pickPart = !pickUnit && ((!row.units.length && row.kind === "serial") || res?.result === "needs_part" || res?.result === "ambiguous");
  const partValue = row.part_id ?? (!row.units.length ? partForNew : null);
  const msg = row.server_error ?? res?.message ?? null;
  return (
    <li
      className={cn(
        "flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border px-3 py-2.5 transition-shadow",
        res || row.server_error ? TONE_ROW[tone] : "border-white/10",
        flash && "ring-2 ring-sky-400/80"
      )}
    >
      <span className="shrink-0">{res || row.server_error ? TONE_ICON[tone] : <Spinner className="size-5 text-muted-foreground" />}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="font-mono text-base break-all text-slate-100">{res?.serial ?? row.serial}</span>
          <MethodBadge method={row.input_method} />
          {res && (
            <Badge variant={TONE_BADGE[RESULT_TONE[res.result]]} className="shrink-0">
              {t(RESULT_LABEL[res.result])}
            </Badge>
          )}
        </span>
        {partLine && <span className="truncate text-xs text-muted-foreground">{partLine}</span>}
        {where && unit && (
          <span className="text-xs text-muted-foreground">{t("Register says: {state} at {where}", { state: t(STATE_LABEL[unit.state]), where })}</span>
        )}
        {msg && <span className={cn("text-sm", TONE_TEXT[tone])}>{msg}</span>}
      </div>
      {pickUnit && (
        <Select value={row.part_id != null ? String(row.part_id) : NONE} onValueChange={(v) => onPatch({ part_id: v === NONE ? null : Number(v) })}>
          <SelectTrigger size="sm" className="w-full sm:w-64" aria-label={t("Which part?")}>
            <SelectValue placeholder={t("Which part?")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE} disabled>
              {t("Which part?")}
            </SelectItem>
            {row.units.map((u) => (
              <SelectItem key={u.id} value={String(u.part_id)}>
                {u.part_code} · {u.part_name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {pickPart && (
        <Select value={partValue != null ? String(partValue) : NONE} onValueChange={(v) => onPatch({ part_id: v === NONE ? null : Number(v) })}>
          <SelectTrigger size="sm" className="w-full sm:w-56" aria-label={t("Part")}>
            <SelectValue placeholder={t("Pick a part")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE} disabled>
              {t("Pick a part")}
            </SelectItem>
            {parts.map((p) => (
              <SelectItem key={p.id} value={String(p.id)}>
                {p.code} · {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      <Button variant="ghost" size="icon-sm" aria-label={t("Remove {serial}", { serial: row.serial })} onClick={onRemove} className="shrink-0">
        <X />
      </Button>
    </li>
  );
};

const MissingItem: React.FC<{ unit: StockUnit }> = ({ unit }) => {
  const { t } = useI18n();
  return (
    <li className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2">
      <span className="font-mono text-sm break-all text-slate-100">{unit.serial}</span>
      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
        {unit.part_code} · {unit.part_name}
      </span>
      <Badge variant="warn" className="shrink-0">
        {t("Missing")}
      </Badge>
    </li>
  );
};

const CountDone: React.FC<{ count: StockCount }> = ({ count }) => {
  const { t } = useI18n();
  return (
    <Alert variant="default">
      <ClipboardCheck />
      <AlertDescription className="flex flex-col gap-2">
        <span className="font-medium text-slate-100">{t("Count of {code} saved", { code: count.location_code })}</span>
        <span>
          {t("{scanned} scanned: {matched} matched, {moved} moved here, {found} found again, {new} new, {missing} marked missing", {
            scanned: count.scanned,
            matched: count.matched,
            moved: count.moved_here,
            found: count.found_again,
            new: count.new_units,
            missing: count.missing,
          })}
        </span>
        <Button asChild size="sm" variant="outline" className="self-start">
          <Link to="/inventory?tab=movements">{t("Open the movement log")}</Link>
        </Button>
      </AlertDescription>
    </Alert>
  );
};

const CountHistory: React.FC<{ counts: StockCount[] }> = ({ counts }) => {
  const { t, locale } = useI18n();
  return (
    <section className="flex flex-col gap-1.5">
      <h2 className="text-sm font-semibold text-muted-foreground">{t("Earlier counts here")}</h2>
      <ul className="flex flex-col gap-1 text-xs">
        {counts.map((c) => (
          <li key={c.id} className="flex flex-wrap gap-x-3 gap-y-0.5 rounded border border-white/[0.07] px-3 py-1.5">
            <span className="num text-slate-100">{c.at ? fmtStockAt(c.at, locale) : c.day}</span>
            <span className="text-muted-foreground">{c.by ?? "—"}</span>
            <span className="text-muted-foreground">
              {t("{scanned} scanned · {missing} missing · {new} new", { scanned: c.scanned, missing: c.missing, new: c.new_units })}
            </span>
            {c.note && <span className="min-w-0 truncate text-muted-foreground">{c.note}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
};
