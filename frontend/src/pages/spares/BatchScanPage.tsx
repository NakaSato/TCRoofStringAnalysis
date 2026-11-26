/**
 * Inventory → Batch scan (`/inventory/scan`, docs/plans/spares-failed-units.md §5.1 / §5.2 / §5.6,
 * barcode-scanning.md §7.3): scan units one after another into a list, then Confirm = one
 * all-or-nothing `POST /stock/movements/batch`. URL `mode` = receive (admin / store keeper) |
 * transfer (default) | return, `loc` = the destination location id, `part` = receive's part for new
 * serials. Input: the keyboard scanner anywhere on the page (a scan target over the global listener),
 * the text box (Enter adds), or the camera in continuous mode. Each scan is looked up
 * (`api.stockLookup`, DB only); row status logic is `lib/scan/batch.ts`. The list is kept in
 * `sessionStorage` per mode + destination until confirmed. `mode=count` (phase 5) is `CountScanPage.tsx`.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, ArrowLeft, Check, Printer, ScanLine, Trash2, X } from "lucide-react";
import { ApiError, api, type InputMethod, type RegistryHit, type StockBatchError, type StockLocation, type StockLookup, type StockPart } from "../../api/client";
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
import { LoadingState } from "../../components/ui";
import { MethodBadge } from "../../components/scan/ScanDialog";
import { useAppContext } from "../../context/AppContext";
import { useI18n } from "../../i18n";
import { notify } from "../../lib/notify";
import { pick, useUrlState } from "@/lib/useUrlState";
import { signal, unlockAudio, type Feedback } from "../../lib/scan/feedback";
import { pushScanTarget } from "../../lib/scan/hidScanner";
import { clean, normalise } from "../../lib/scan/parse";
import {
  addScanRow,
  buildBatch,
  countRows,
  evaluateRow,
  findDuplicate,
  markServerErrors,
  readRows,
  removeSent,
  rowKey,
  storageKey,
  writeRows,
  type BatchMode,
  type BatchRow,
  type RowEval,
} from "../../lib/scan/batch";
import { KIND_LABEL, STATE_LABEL, canManageStock, errorText } from "./shared";
import { CountScanPage } from "./CountScanPage";
import { RegistryReceiveWarning, registryKey, useRegistryWhere } from "./RegistryWhere";
import { STATUS_ICON, STATUS_ROW, STATUS_TEXT, ScanInputs, ScanModeTabs, isMoveMode, newRowId as newId, scanModes } from "./scanShared";
import { cn } from "@/lib/utils";

const NONE = "__none";
const FLASH_MS = 1200;
const DEST_KINDS = new Set(["store", "bin", "van"]);

const MODE_HINT: Record<BatchMode, string> = {
  receive: "New units into the store: scan the bin label, pick the part, then scan each serial.",
  transfer: "Units in stock to another store, bin or van: scan the destination, then each unit.",
  return: "Spares taken to site and not installed, back to a store, bin or van.",
};
const DONE_LABEL: Record<BatchMode, string> = { receive: "{n} units received", transfer: "{n} units moved", return: "{n} units returned" };

interface LastScan {
  status: Feedback;
  text: string;
}

/** `/inventory/scan`: the move modes here, `mode=count` in `CountScanPage`. */
export const BatchScanPage: React.FC = () => {
  const { user } = useAppContext();
  const keeper = canManageStock(user);
  const [url, setUrl] = useUrlState();
  const modes = scanModes(keeper);
  const mode = pick(url.get("mode"), modes, "transfer");
  // a mode switch keeps `loc` (the same bin is often counted, then moved from) and drops the rest
  const tabs = <ScanModeTabs mode={mode} modes={modes} onChange={(m) => setUrl({ mode: m === "transfer" ? null : m })} />;
  return isMoveMode(mode) ? <MoveScanPage mode={mode} tabs={tabs} /> : <CountScanPage tabs={tabs} />;
};

const MoveScanPage: React.FC<{ mode: BatchMode; tabs: React.ReactNode }> = ({ mode, tabs }) => {
  const { t } = useI18n();
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

  const destinations = useMemo(() => (locations ?? []).filter((l) => l.active && DEST_KINDS.has(l.kind)), [locations]);
  const dest = useMemo(() => destinations.find((l) => l.id === loc) ?? null, [destinations, loc]);
  const destId = dest?.id ?? null;
  const partForNew = useMemo(() => (parts ?? []).find((p) => p.id === partParam) ?? null, [parts, partParam]);

  // ---- the list, kept per mode + destination in sessionStorage
  const key = storageKey(mode, loc);
  const [list, setList] = useState(() => ({ key, mode, rows: readRows(key) }));
  const rowsRef = useRef(list.rows);
  rowsRef.current = list.rows;
  useEffect(() => {
    if (list.key === key) return;
    if (list.mode !== mode || !list.rows.length) {
      // another mode has its own list; nothing scanned yet: the destination's own saved list comes back
      setList({ key, mode, rows: readRows(key) });
    } else {
      // a new destination: the scanned units go there, so the list follows it
      writeRows(list.key, []);
      setList({ key, mode, rows: list.rows.map((r) => (r.server_error ? { ...r, server_error: null } : r)) });
    }
  }, [key, mode]);
  useEffect(() => {
    if (list.key === key) writeRows(key, list.rows);
  }, [list, key]);
  const rows = list.rows;
  // L-3: a received serial the registry has installed on a plant warns (never blocks)
  const where = useRegistryWhere(mode === "receive" ? rows.map((r) => r.serial) : []);
  const setRows = useCallback((fn: (r: BatchRow[]) => BatchRow[]) => {
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
  const [received, setReceived] = useState<number[] | null>(null);

  // what the scan handler reads (it runs after an await, so not from the render's closure)
  const ctx = useRef({ mode, destId, partForNew, destinations, t });
  ctx.current = { mode, destId, partForNew, destinations, t };

  const evalText = useCallback(
    (ev: RowEval) => t(ev.msg, { state: ev.state ? t(STATE_LABEL[ev.state]) : "", where: ev.where ?? "—" }),
    [t]
  );

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
      const { mode: m, destId: d, partForNew: p, destinations: dests } = ctx.current;

      if (res.kind === "location" && res.location) {
        const l = dests.find((x) => x.id === res.location!.id);
        if (!l) {
          signal("error");
          setLast({ status: "error", text: tr("{code}: not an active store, bin or van", { code: res.location.code }) });
          return;
        }
        if (l.id === d) {
          signal("ok");
          setLast({ status: "ok", text: tr("Destination: {code}", { code: l.code }) });
        } else if (!rowsRef.current.length) {
          signal("ok");
          setUrl({ loc: l.id });
          setLast({ status: "ok", text: tr("Destination: {code}", { code: l.code }) });
        } else {
          signal("warn");
          setPendingLoc(l);
        }
        return;
      }
      if (res.kind === "part" && m === "receive" && res.part) {
        if (!res.part.active) {
          // the part list holds active parts only: an inactive one cannot take new serials
          signal("error");
          setLast({ status: "error", text: tr("{code}: an inactive part, not used for new serials", { code: res.part.code }) });
          return;
        }
        signal("ok");
        setUrl({ part: res.part.id });
        setLast({ status: "ok", text: tr("Part for new serials: {code}", { code: res.part.code }) });
        return;
      }

      const serial = res.kind === "unit" && res.units[0] ? res.units[0].serial : res.code || normalise(text).value;
      const rows0 = rowsRef.current;
      // a unit label is that unit (two parts may share a serial), else the serial
      const dup = findDuplicate(m, rows0, { serial, units: res.units, unit_id: null }, d);
      if (dup >= 0) {
        signal("warn");
        flash(rows0[dup].id);
        setLast({ status: "warn", text: `${serial}: ${tr("Duplicate in this list")}` });
        return;
      }
      const row: BatchRow = {
        id: newId(),
        raw: text,
        input_method: method,
        serial,
        kind: res.kind,
        units: res.units,
        unit_id: null,
        part: m === "receive" && res.kind === "serial" && !res.units.length && p ? { id: p.id, code: p.code, name: p.name } : null,
        server_error: null,
      };
      // a row in error of the same scan (unit, else serial) is replaced by the new scan
      setRows((r) => addScanRow(r, row, rowKey));
      const ev = evaluateRow(m, row, d);
      signal(ev.status);
      flash(row.id);
      setLast({ status: ev.status, text: `${serial}: ${tr(ev.msg, { state: ev.state ? tr(STATE_LABEL[ev.state]) : "", where: ev.where ?? "—" })}` });
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

  // keyboard-scanner bursts anywhere on the page (the global listener hands them to the top target)
  useEffect(() => pushScanTarget((b) => enqueue(b.value, "hid")), [enqueue]);

  const counts = useMemo(() => countRows(mode, rows, destId), [mode, rows, destId]);
  const sendable = counts.ok;

  const confirm = async () => {
    if (destId == null || busy) return;
    const snapshot = rowsRef.current;
    const b = buildBatch(mode, snapshot, destId);
    if (!b.rows.length) return;
    const ids = b.index.map((i) => snapshot[i].id);
    setBusy(true);
    setError(null);
    setReceived(null);
    try {
      const res = await api.postStockBatch(b.rows);
      // only the rows sent go: rows not sent (warn / error) and scans added while posting stay
      setRows((r) => removeSent(r, ids));
      setLast(null);
      notify("ok", t(DONE_LABEL[mode], { n: b.rows.length }));
      if (mode === "receive") {
        const created = res.movements.map((m) => m.unit_id).filter((x): x is number => x != null);
        setReceived(created.length ? created : null);
      }
    } catch (e) {
      signal("error");
      if (e instanceof ApiError && e.status === 409 && e.detail && typeof e.detail === "object" && "errors" in e.detail) {
        const d = e.detail as StockBatchError;
        setRows((r) => markServerErrors(r, ids, d.errors));
        const general = d.errors.filter((x) => x.row == null).map((x) => x.error);
        setError([t("Nothing was saved: fix or remove the rows marked ✕, then confirm again."), d.message, ...general].filter(Boolean).join("\n"));
      } else {
        setError(errorText(e, t));
      }
    } finally {
      setBusy(false);
    }
  };

  const removeRow = (id: string) => setRows((r) => r.filter((x) => x.id !== id));
  const patchRow = (id: string, patch: Partial<BatchRow>) => setRows((r) => r.map((x) => (x.id === id ? { ...x, ...patch, server_error: null } : x)));

  if (loadError) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{loadError}</AlertDescription>
      </Alert>
    );
  }
  if (!parts || !locations) return <LoadingState />;

  return (
    <div className="flex min-w-0 flex-col gap-4" onPointerDown={unlockAudio}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Button asChild variant="ghost" size="icon-sm" aria-label={t("Back")}>
            <Link to="/inventory">
              <ArrowLeft />
            </Link>
          </Button>
          <div className="flex min-w-0 flex-col">
            <h1 className="text-lg font-semibold">{t("Batch scan")}</h1>
            <p className="text-xs text-muted-foreground">{t(MODE_HINT[mode])}</p>
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
              <Label htmlFor="bs-dest" className="text-xs">
                {t("Destination: where the scanned units go")}
              </Label>
              <Select
                value={destId != null ? String(destId) : NONE}
                onValueChange={(v) => {
                  const l = destinations.find((x) => String(x.id) === v);
                  if (l) setUrl({ loc: l.id });
                }}
              >
                <SelectTrigger id="bs-dest" className="w-full">
                  <SelectValue placeholder={t("Pick or scan a location label")} />
                </SelectTrigger>
                <SelectContent>
                  {destId == null && (
                    <SelectItem value={NONE} disabled>
                      {t("Pick or scan a location label")}
                    </SelectItem>
                  )}
                  {destinations.map((l) => (
                    <SelectItem key={l.id} value={String(l.id)}>
                      {l.code} · {l.name} ({t(KIND_LABEL[l.kind])})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {loc != null && !dest && <span className="text-[11px] text-amber-300">{t("The location in the link is not an active store, bin or van.")}</span>}
            </div>
            {mode === "receive" && (
              <div className="flex min-w-0 flex-col gap-1.5">
                <Label htmlFor="bs-part" className="text-xs">
                  {t("Part for new serials")}
                </Label>
                <Select value={partForNew ? String(partForNew.id) : NONE} onValueChange={(v) => setUrl({ part: v === NONE ? null : v })}>
                  <SelectTrigger id="bs-part" className="w-full">
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
                <span className="text-[11px] text-muted-foreground">{t("Or scan the part's label. A serial not in the register goes in as this part.")}</span>
              </div>
            )}
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

      {received && (
        <Alert variant="default">
          <AlertDescription className="flex flex-wrap items-center gap-2">
            {t("{n} units received.", { n: received.length })}
            <Button asChild size="sm" variant="outline">
              <Link to={`/labels?kind=sp&ids=${received.join(",")}`}>
                <Printer data-icon="inline-start" />
                {t("Print labels for them")}
              </Link>
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertDescription className="whitespace-pre-line">{error}</AlertDescription>
        </Alert>
      )}

      {!rows.length ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-white/10 px-4 py-10 text-center text-sm text-muted-foreground">
          <ScanLine className="size-6 text-slate-500" aria-hidden />
          {destId == null ? t("Scan or pick the destination first, then scan the units.") : t("Scan a unit: each scan adds a row here.")}
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((r) => (
            <BatchRowItem
              key={r.id}
              row={r}
              ev={evaluateRow(mode, r, destId)}
              mode={mode}
              parts={parts}
              flash={flashId === r.id}
              registry={mode === "receive" ? where[registryKey(r.serial)] : undefined}
              text={evalText}
              onRemove={() => removeRow(r.id)}
              onPatch={(p) => patchRow(r.id, p)}
            />
          ))}
        </ul>
      )}

      <div className="sticky bottom-0 z-10 -mx-1 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-white/10 bg-background/95 px-3 py-2.5 backdrop-blur">
        <span className="text-sm font-medium">{t("{n} rows", { n: counts.total })}</span>
        <span className="flex items-center gap-1 text-sm text-emerald-300">
          <Check className="size-4" aria-hidden /> {counts.ok}
        </span>
        <span className="flex items-center gap-1 text-sm text-amber-300">
          <AlertTriangle className="size-4" aria-hidden /> {counts.warn}
        </span>
        <span className="flex items-center gap-1 text-sm text-red-300">
          <X className="size-4" aria-hidden /> {counts.error}
        </span>
        <span className="flex-1" />
        {rows.length > 0 && (
          <Button variant="ghost" size="sm" onClick={() => setRows(() => [])} disabled={busy}>
            <Trash2 data-icon="inline-start" />
            {t("Clear list")}
          </Button>
        )}
        <Button onClick={() => void confirm()} disabled={busy || !sendable || destId == null}>
          {busy && <Spinner data-icon="inline-start" />}
          {t("Confirm {n}", { n: sendable })}
        </Button>
      </div>

      <AlertDialog open={!!pendingLoc} onOpenChange={(o) => !o && setPendingLoc(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Change the destination to {code}?", { code: pendingLoc?.code ?? "" })}</AlertDialogTitle>
            <AlertDialogDescription>{t("The {n} units in the list then go to {code} instead.", { n: rows.length, code: pendingLoc?.code ?? "" })}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Keep {code}", { code: dest?.code ?? "—" })}</AlertDialogCancel>
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

const BatchRowItem: React.FC<{
  row: BatchRow;
  ev: RowEval;
  mode: BatchMode;
  parts: StockPart[];
  flash: boolean;
  /** receive: where the registry has this serial installed */
  registry?: RegistryHit[];
  text: (ev: RowEval) => string;
  onRemove: () => void;
  onPatch: (p: Partial<BatchRow>) => void;
}> = ({ row, ev, mode, parts, flash, registry, text, onRemove, onPatch }) => {
  const { t } = useI18n();
  const unit = row.units.length === 1 ? row.units[0] : (row.units.find((u) => u.id === row.unit_id) ?? null);
  const newSerial = mode === "receive" && row.kind === "serial" && !row.units.length;
  const partLine = unit ? `${unit.part_code} · ${unit.part_name}` : row.part ? `${row.part.code} · ${row.part.name}` : null;
  return (
    <li
      className={cn(
        "flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border px-3 py-2.5 transition-shadow",
        STATUS_ROW[ev.status],
        flash && "ring-2 ring-sky-400/80"
      )}
    >
      <span className="shrink-0">{STATUS_ICON[ev.status]}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="font-mono text-base break-all text-slate-100">{row.serial}</span>
          <MethodBadge method={row.input_method} />
        </span>
        {partLine && <span className="truncate text-xs text-muted-foreground">{partLine}</span>}
        <span className={cn("text-sm", STATUS_TEXT[ev.status])}>{text(ev)}</span>
        <RegistryReceiveWarning hits={registry} className="mt-1" />
      </div>
      {ev.pick && (
        <Select value={row.unit_id != null ? String(row.unit_id) : NONE} onValueChange={(v) => onPatch({ unit_id: v === NONE ? null : Number(v) })}>
          <SelectTrigger size="sm" className="w-full sm:w-64" aria-label={t("Which part?")}>
            <SelectValue placeholder={t("Which part?")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE} disabled>
              {t("Which part?")}
            </SelectItem>
            {row.units.map((u) => (
              <SelectItem key={u.id} value={String(u.id)}>
                {u.part_code} · {t(STATE_LABEL[u.state])} · {u.location_code ?? u.plant_name ?? "—"}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {newSerial && (
        <Select
          value={row.part ? String(row.part.id) : NONE}
          onValueChange={(v) => {
            const p = parts.find((x) => String(x.id) === v);
            onPatch({ part: p ? { id: p.id, code: p.code, name: p.name } : null });
          }}
        >
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
      {!ev.send && ev.status === "warn" && ev.msg === "Already here" && (
        <Badge variant="warn" className="shrink-0">
          {t("Skipped")}
        </Badge>
      )}
      <Button variant="ghost" size="icon-sm" aria-label={t("Remove {serial}", { serial: row.serial })} onClick={onRemove} className="shrink-0">
        <X />
      </Button>
    </li>
  );
};
