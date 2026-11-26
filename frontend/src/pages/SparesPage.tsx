/**
 * Operations → Inventory (`/inventory`, was `/spares` (redirects), everyone; docs/plans/spares-failed-units.md, phase 1): the parts
 * catalogue, stock locations (store, bins, crew vans), serialised spare units and the movement log.
 * Stock on hand is counted from the register, never typed in; every move is a log row that is never
 * edited (a correction reverses one). Everyone moves units (transfer, install, return); an admin or
 * store keeper receives, corrects and edits the catalogue and locations. Installs on plants the user
 * may not see are left out by the API. Phase 2: failed units bound to red tags (Failed units tab, URL
 * `tab=failed`, `fu` opens one, so a scanned red tag lands on it); anyone tags and moves one, an admin
 * or store keeper ships it to the supplier, takes it back and scraps it. Phase 3: Replace a device
 * (`spares/ReplaceDialog.tsx`, also on the Site register card) = failed unit off, spare on, register updated.
 * Phase 4: Batch scan (`spares/BatchScanPage.tsx`, `/inventory/scan`); the Stock tab opens `part=<id>`
 * and highlights `unit=<id>` (where scanned `sp:` labels land); `sp` / `loc` labels print from here.
 * Phase 5: stock count (`spares/CountScanPage.tsx`, `/inventory/scan?mode=count&loc=<id>`): Locations shows
 * Last counted and a Count action; the summary shows Missing units (a confirmed count did not find them).
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeftRight, ClipboardList, Download, PackagePlus, Pencil, Plus, Printer, Replace, ScanLine, Tag, Undo2 } from "lucide-react";
import {
  api,
  type StockLocation,
  type StockMovement,
  type StockMovementList,
  type StockPart,
  type StockSummary,
  type StockUnit,
} from "../api/client";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState, SkeletonRows, Suspended } from "../components/ui";
import { StatTile } from "./overview/StatTile";
import { notify } from "@/lib/notify";
import { MethodBadge } from "../components/scan/ScanDialog";
import { useAppContext } from "../context/AppContext";
import { useI18n } from "../i18n";
import { pick, useUrlState } from "@/lib/useUrlState";
import { CorrectDialog, LocationDialog, PartDialog } from "./spares/dialogs";
import { MoveDialog, type MoveKind } from "./spares/MoveDialog";
import { FailedUnitDialog, TagFailedDialog } from "./spares/FailedDialogs";
import { FailedTab } from "./spares/FailedTab";
import { ReplaceDialog, type ReplacePreset } from "./spares/ReplaceDialog";
import { InstalledTab } from "./spares/InstalledTab";
import { ModelsTab } from "./spares/ModelsTab";
import { FromModelsDialog } from "./spares/FromModelsDialog";
import { RegistryChip, registryKey, useClearRegistryOn, useRegistryWhere } from "./spares/RegistryWhere";
import { CATEGORY_LABEL, KIND_LABEL, MOVE_LABEL, STATE_LABEL, STATE_VARIANT, canManageStock, download, errorText, fmtStockAt } from "./spares/shared";

const TABS = ["stock", "failed", "installed", "models", "movements", "catalogue", "locations"] as const;
const MOVE_KINDS = ["all", "receive", "transfer", "issue", "return", "failed_in", "ship_out", "supplier_return", "scrap", "count_adjust", "correction"] as const;
const PAGE = 100;
/** rows per request when the CSV collects every matching movement (the API's own maximum) */
const EXPORT_PAGE = 1000;
const WARN = "text-amber-300";

export const SparesPage: React.FC = () => {
  const { t } = useI18n();
  const { user } = useAppContext();
  const keeper = canManageStock(user);
  const [url, setUrl] = useUrlState();
  const tab = pick(url.get("tab"), TABS, "stock");
  const fuRaw = Number(url.get("fu"));
  const fu = Number.isInteger(fuRaw) && fuRaw > 0 ? fuRaw : null;
  const idParam = (k: string) => {
    const n = Number(url.get(k));
    return Number.isInteger(n) && n > 0 ? n : null;
  };
  const openPart = idParam("part");
  const unitParam = idParam("unit");
  const [tagging, setTagging] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [parts, setParts] = useState<StockPart[] | null>(null);
  const [locations, setLocations] = useState<StockLocation[] | null>(null);
  const [summary, setSummary] = useState<StockSummary | null>(null);
  const [people, setPeople] = useState<{ id: number; name: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [move, setMove] = useState<{ kind: MoveKind; unit?: StockUnit | null } | null>(null);
  const [editPart, setEditPart] = useState<StockPart | null | undefined>(undefined);
  const [editLoc, setEditLoc] = useState<StockLocation | null | undefined>(undefined);
  const [fromModels, setFromModels] = useState(false);
  const [replacePreset, setReplacePreset] = useState<ReplacePreset | null>(null);
  const reload = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    let alive = true;
    Promise.all([api.listStockParts(true), api.listStockLocations(true), api.getStockSummary(), api.listStockPeople()])
      .then(([p, l, s, pe]) => {
        if (!alive) return;
        setParts(p);
        setLocations(l);
        setSummary(s);
        setPeople(pe);
        setError(null);
      })
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [version]);

  const locById = useMemo(() => new Map((locations ?? []).map((l) => [l.id, l])), [locations]);
  const activeParts = useMemo(() => (parts ?? []).filter((p) => p.active), [parts]);
  // the Stock tab lists active parts, plus an inactive one opened by the URL (a scanned `sp:` label of its unit)
  const stockParts = useMemo(() => (parts ?? []).filter((p) => p.active || p.id === openPart), [parts, openPart]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col">
          <h1 className="text-lg font-semibold">{t("Inventory")}</h1>
          <p className="text-xs text-muted-foreground">{t("Spare units in the store and the crews' vans, failed units, and every move in and out")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild size="sm" variant="outline">
            <Link to="/inventory/scan">
              <ScanLine data-icon="inline-start" />
              {t("Batch scan")}
            </Link>
          </Button>
          <Button size="sm" variant="accent" onClick={() => setReplacing(true)} disabled={!locations?.length}>
            <Replace data-icon="inline-start" />
            {t("Replace a device")}
          </Button>
          <Button variant="outline" size="sm" onClick={() => setTagging(true)} disabled={!locations?.length}>
            <Tag data-icon="inline-start" />
            {t("Tag a failed unit")}
          </Button>
          <Button variant="outline" size="sm" onClick={() => setMove({ kind: "transfer" })} disabled={!parts?.length || !locations?.length}>
            <ArrowLeftRight data-icon="inline-start" />
            {t("Move a unit")}
          </Button>
          {keeper && (
            <Button size="sm" onClick={() => setMove({ kind: "receive" })} disabled={!activeParts.length || !locations?.length}>
              <PackagePlus data-icon="inline-start" />
              {t("Receive")}
            </Button>
          )}
        </div>
      </div>

      {summary && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:max-w-4xl lg:grid-cols-6">
          <StatTile label={t("Units in stock")} num={summary.in_stock} digits={0} countUp />
          <StatTile label={t("Installed from stock")} num={summary.installed} digits={0} countUp />
          <StatTile label={t("Parts below minimum")} num={summary.parts_below_min} digits={0} countUp tone={summary.parts_below_min > 0 ? WARN : undefined} />
          <StatTile label={t("Failed units open")} num={summary.failed_open} digits={0} countUp />
          <StatTile label={t("Failed, not sent yet (overdue)")} num={summary.failed_unsent_overdue} digits={0} countUp tone={summary.failed_unsent_overdue > 0 ? WARN : undefined} />
          <StatTile label={t("Missing units")} num={summary.missing_units ?? null} digits={0} countUp tone={summary.missing_units > 0 ? WARN : undefined} />
        </div>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {parts && locations && !locations.length && (
        <Alert variant="warn">
          <AlertDescription>
            {keeper
              ? t("Start here: add the store and its bins, and one location per crew van (Locations), then the parts (Catalogue).")
              : t("No stock locations yet: an admin or store keeper sets up the store, bins and vans first.")}
          </AlertDescription>
        </Alert>
      )}

      <Tabs value={tab} onValueChange={(v) => setUrl({ tab: v === "stock" ? null : v })}>
        <TabsList variant="line" className="max-w-full overflow-x-auto">
          <TabsTrigger value="stock">{t("Stock")}</TabsTrigger>
          <TabsTrigger value="failed">{t("Failed units")}</TabsTrigger>
          <TabsTrigger value="installed">{t("Installed")}</TabsTrigger>
          <TabsTrigger value="models">{t("Spares per model")}</TabsTrigger>
          <TabsTrigger value="movements">{t("Movements")}</TabsTrigger>
          <TabsTrigger value="catalogue">{t("Catalogue")}</TabsTrigger>
          <TabsTrigger value="locations">{t("Locations")}</TabsTrigger>
        </TabsList>
      </Tabs>

      {!parts || !locations ? (
        <SkeletonRows rows={6} />
      ) : tab === "stock" ? (
        <StockTab
          parts={stockParts}
          locById={locById}
          version={version}
          open={openPart}
          highlight={unitParam}
          onOpen={(id) => setUrl({ part: id, unit: null })}
          onMove={(kind, unit) => setMove({ kind, unit })}
        />
      ) : tab === "failed" ? (
        <FailedTab version={version} />
      ) : tab === "installed" ? (
        <InstalledTab
          version={version}
          keeper={keeper}
          onReplace={(r) => {
            setReplacePreset({ plantId: r.plant_id, siteDeviceId: r.site_device_id, inverterSn: r.inverter_sn });
            setReplacing(true);
          }}
        />
      ) : tab === "models" ? (
        <ModelsTab version={version} keeper={keeper} onChanged={reload} />
      ) : tab === "movements" ? (
        <MovementsTab parts={parts} locations={locations} version={version} keeper={keeper} onChanged={reload} onOpenFailed={(id) => setUrl({ fu: id })} />
      ) : tab === "catalogue" ? (
        <CatalogueTab parts={parts} keeper={keeper} onEdit={setEditPart} onFromModels={() => setFromModels(true)} />
      ) : (
        <LocationsTab locations={locations} locById={locById} keeper={keeper} onEdit={setEditLoc} />
      )}

      <MoveDialog
        open={!!move}
        onOpenChange={(o) => !o && setMove(null)}
        kind={move?.kind ?? "transfer"}
        unit={move?.unit}
        parts={parts ?? []}
        locations={locations ?? []}
        onDone={reload}
      />
      <ReplaceDialog
        open={replacing}
        onOpenChange={(o) => {
          setReplacing(o);
          if (!o) setReplacePreset(null);
        }}
        preset={replacePreset}
        locations={locations ?? []} onDone={reload} />
      <TagFailedDialog open={tagging} onOpenChange={setTagging} parts={parts ?? []} locations={locations ?? []} onDone={reload} />
      <FailedUnitDialog id={fu} onOpenChange={(o) => !o && setUrl({ fu: null })} parts={parts ?? []} locations={locations ?? []} onChanged={reload} />
      <FromModelsDialog open={fromModels} onOpenChange={setFromModels} onDone={reload} />
      <PartDialog part={editPart ?? null} open={editPart !== undefined} onOpenChange={(o) => !o && setEditPart(undefined)} onDone={reload} />
      <LocationDialog
        location={editLoc ?? null}
        locations={locations ?? []}
        people={people}
        open={editLoc !== undefined}
        onOpenChange={(o) => !o && setEditLoc(undefined)}
        onDone={reload}
      />
    </div>
  );
};

/** Parts with their stock; a part opens its units, each with its moves. */
const StockTab: React.FC<{
  parts: StockPart[];
  locById: Map<number, StockLocation>;
  version: number;
  /** the part whose units are open (URL `part`) */
  open: number | null;
  /** a unit row to highlight (URL `unit`, a scanned `sp:` label) */
  highlight: number | null;
  onOpen: (id: number | null) => void;
  onMove: (kind: MoveKind, unit: StockUnit) => void;
}> = ({ parts, locById, version, open, highlight, onOpen, onMove }) => {
  const { t } = useI18n();
  const setOpen = onOpen;
  const [units, setUnits] = useState<StockUnit[] | null>(null);
  const [unitsError, setUnitsError] = useState<string | null>(null);
  const [unitsBusy, setUnitsBusy] = useState(false);
  const hlRef = React.useRef<HTMLLIElement | null>(null);
  useEffect(() => {
    if (units && highlight != null) hlRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [units, highlight]);
  useEffect(() => {
    // another part: drop the old units so they never show under its name
    setUnits(null);
    setUnitsError(null);
  }, [open]);
  useEffect(() => {
    if (open == null) return;
    let alive = true;
    setUnitsBusy(true);
    api
      .listStockUnits({ part_id: open })
      .then((u) => {
        if (!alive) return;
        setUnits(u);
        setUnitsError(null);
      })
      .catch((e) => alive && setUnitsError(errorText(e, t)))
      .finally(() => alive && setUnitsBusy(false));
    return () => {
      alive = false;
    };
  }, [open, version, t]);
  // L-3: where the registry has these serials (a spare in stock that is also installed = amber)
  useClearRegistryOn(version);
  const where = useRegistryWhere(units?.map((u) => u.serial) ?? []);
  if (!parts.length) return <EmptyState title={t("No parts in the catalogue yet.")} />;
  return (
    <Card className="py-0">
      <CardContent className="px-0">
        <Table containerClassName="table-wrap">
          <TableHeader>
            <TableRow>
              <TableHead className="pl-4">{t("Part")}</TableHead>
              <TableHead>{t("Category")}</TableHead>
              <TableHead className="text-right">{t("In stock")}</TableHead>
              <TableHead>{t("Where")}</TableHead>
              <TableHead className="pr-4 text-right">{t("Minimum")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {parts.map((p) => (
              <React.Fragment key={p.id}>
                <TableRow className="cursor-pointer" onClick={() => setOpen(open === p.id ? null : p.id)} aria-expanded={open === p.id}>
                  <TableCell className="pl-4">
                    <span className="font-mono text-xs whitespace-nowrap text-slate-100">{p.code}</span>
                    {!p.active && <Badge variant="neutral" className="ml-2">{t("Inactive")}</Badge>}
                    <span className="block text-[11px] text-muted-foreground">{p.name}</span>
                  </TableCell>
                  <TableCell className="text-xs">{t(CATEGORY_LABEL[p.category])}</TableCell>
                  <TableCell className="num text-right">
                    {p.on_hand}
                    {p.below_min && (
                      <Badge variant="warn" className="ml-2">
                        {t("Below minimum")}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-[11px] text-muted-foreground">
                    {p.on_hand_by_location.map((x) => `${(x.location_id != null && locById.get(x.location_id)?.code) || "—"} ${x.qty}`).join(" · ") || "—"}
                  </TableCell>
                  <TableCell className="num pr-4 text-right text-xs">{p.min_qty ?? "—"}</TableCell>
                </TableRow>
                {open === p.id && (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={5} className="bg-white/[0.015] px-4 py-3">
                      {unitsError && (
                        <Alert variant="destructive" className="mb-2">
                          <AlertDescription>{t("Could not load the units: {error}", { error: unitsError })}</AlertDescription>
                        </Alert>
                      )}
                      {!units ? (
                        !unitsError && <SkeletonRows rows={2} />
                      ) : !units.length ? (
                        <p className="text-xs text-muted-foreground">{t("No units of this part yet.")}</p>
                      ) : (
                        <Suspended busy={unitsBusy} pill={false} contentClassName="flex flex-col gap-2">
                        {units.some((u) => u.state === "in_stock") && (
                          <Button asChild size="xs" variant="outline" className="self-start">
                            <Link to={`/labels?kind=sp&part_id=${p.id}`}>
                              <Printer data-icon="inline-start" />
                              {t("Print labels")}
                            </Link>
                          </Button>
                        )}
                        <ul className="flex flex-col gap-1">
                          {units.map((u) => (
                            <li
                              key={u.id}
                              ref={u.id === highlight ? hlRef : undefined}
                              className={
                                u.id === highlight
                                  ? "-mx-1.5 flex flex-wrap items-center gap-2 rounded px-1.5 py-0.5 text-xs ring-2 ring-sky-400/70"
                                  : "flex flex-wrap items-center gap-2 text-xs"
                              }
                            >
                              <span className="min-w-36 font-mono text-slate-100">{u.serial}</span>
                              <Badge variant={STATE_VARIANT[u.state] ?? "neutral"}>{t(STATE_LABEL[u.state] ?? u.state)}</Badge>
                              <span className="min-w-0 flex-1 truncate text-muted-foreground">{u.location_code ?? u.plant_name ?? "—"}</span>
                              {(u.state === "in_stock" || u.state === "missing") && <RegistryChip hits={where[registryKey(u.serial)]} warn className="basis-full sm:basis-auto" />}
                              {u.state === "installed" && <RegistryChip hits={where[registryKey(u.serial)]} className="basis-full sm:basis-auto" />}
                              {u.state === "in_stock" && (
                                <>
                                  <Button size="xs" variant="ghost" onClick={() => onMove("transfer", u)}>
                                    {t(MOVE_LABEL.transfer)}
                                  </Button>
                                  <Button size="xs" variant="ghost" onClick={() => onMove("issue", u)}>
                                    {t(MOVE_LABEL.issue)}
                                  </Button>
                                </>
                              )}
                              {u.state === "installed" && (
                                <Button size="xs" variant="ghost" onClick={() => onMove("return", u)}>
                                  {t(MOVE_LABEL.return)}
                                </Button>
                              )}
                            </li>
                          ))}
                        </ul>
                        </Suspended>
                      )}
                    </TableCell>
                  </TableRow>
                )}
              </React.Fragment>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
};

/** The movement log: newest first, filters, CSV, correction of a unit's latest move. */
const MovementsTab: React.FC<{
  parts: StockPart[];
  locations: StockLocation[];
  version: number;
  keeper: boolean;
  onChanged: () => void;
  onOpenFailed: (id: number) => void;
}> = ({ parts, version, keeper, onChanged, onOpenFailed }) => {
  const { t } = useI18n();
  // filters in the URL: `mvk` move kind, `mvp` part id, `mvq` serial contains
  const [url, setUrl] = useUrlState();
  const kind = pick(url.get("mvk"), MOVE_KINDS, "all");
  const mvp = url.get("mvp") ?? "";
  const partId = /^\d+$/.test(mvp) ? mvp : "all";
  const serial = url.get("mvq") ?? "";
  const [page, setPage] = useState(0);
  const [data, setData] = useState<StockMovementList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [correcting, setCorrecting] = useState<StockMovement | null>(null);
  useClearRegistryOn(version);
  const where = useRegistryWhere(data?.movements.map((m) => m.serial) ?? []);
  const filters = useMemo(
    () => ({ kind: kind === "all" ? undefined : kind, part_id: partId === "all" ? undefined : Number(partId), serial: serial.trim() || undefined }),
    [kind, partId, serial]
  );
  useEffect(() => setPage(0), [filters]);
  useEffect(() => {
    let alive = true;
    setBusy(true);
    const h = window.setTimeout(() => {
      api
        .listStockMovements({ ...filters, limit: PAGE, offset: page * PAGE })
        .then((d) => {
          if (!alive) return;
          setData(d);
          setError(null);
        })
        .catch((e) => alive && setError(errorText(e, t)))
        .finally(() => alive && setBusy(false));
    }, 200);
    return () => {
      alive = false;
      window.clearTimeout(h);
    };
  }, [filters, page, version, t]);
  const corrected = useMemo(() => new Set((data?.movements ?? []).map((m) => m.corrects_id).filter((x): x is number => x != null)), [data]);
  // only a unit's latest movement can be corrected (the list is newest first; filters may hide later ones, the API checks)
  const latest = useMemo(() => {
    const seen = new Set<number>();
    const out = new Set<number>();
    for (const m of data?.movements ?? []) {
      if (m.unit_id == null || seen.has(m.unit_id)) continue;
      seen.add(m.unit_id);
      out.add(m.id);
    }
    return out;
  }, [data]);
  // every movement matching the filters, not only the page on screen
  const exportCsv = async () => {
    setExporting(true);
    try {
      const all: StockMovement[] = [];
      for (let offset = 0; ; offset += EXPORT_PAGE) {
        const d = await api.listStockMovements({ ...filters, limit: EXPORT_PAGE, offset });
        all.push(...d.movements);
        if (d.movements.length < EXPORT_PAGE || all.length >= d.total) break;
      }
      download("spares-movements.csv", [
        ["id", "day", "kind", "part", "serial", "from", "to", "plant", "from_state", "to_state", "by", "input", "note", "corrects", "failed_unit_id"],
        ...all.map((m) => [m.id, m.day, m.kind, m.part_code, m.serial, m.from_location_code, m.to_location_code, m.plant_name ?? m.plant_id, m.from_state, m.to_state, m.by, m.input_method, m.note, m.corrects_id, m.failed_unit_id]),
      ]);
    } catch (e) {
      notify("crit", t("CSV export failed: {error}", { error: errorText(e, t) }));
    } finally {
      setExporting(false);
    }
  };
  return (
    <Card className="gap-3 py-3">
      <CardContent className="flex flex-col gap-3 px-0">
        <div className="flex flex-wrap items-center gap-2 px-4">
          <Select value={kind} onValueChange={(v) => setUrl({ mvk: v === "all" ? null : v })}>
            <SelectTrigger size="sm" className="w-44" aria-label={t("Move")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MOVE_KINDS.map((k) => (
                <SelectItem key={k} value={k}>
                  {k === "all" ? t("All moves") : t(MOVE_LABEL[k])}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={partId} onValueChange={(v) => setUrl({ mvp: v === "all" ? null : v })}>
            <SelectTrigger size="sm" className="w-52" aria-label={t("Part")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("All parts")}</SelectItem>
              {parts.map((p) => (
                <SelectItem key={p.id} value={String(p.id)}>
                  {p.code}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input value={serial} onChange={(e) => setUrl({ mvq: e.target.value })} placeholder={t("Serial contains…")} className="h-8 w-44 font-mono" aria-label={t("Serial no.")} />
          <span className="flex-1" />
          <Button variant="outline" size="sm" onClick={exportCsv} disabled={!data?.movements.length || exporting}>
            {exporting ? <Spinner data-icon="inline-start" className="size-3" /> : <Download data-icon="inline-start" />}
            CSV
          </Button>
        </div>
        {error && (
          <Alert variant="destructive" className="mx-4 w-auto">
            <AlertDescription>{t("Could not load the movements: {error}", { error })}</AlertDescription>
          </Alert>
        )}
        {!data ? (
          !error && <SkeletonRows rows={5} className="px-4" />
        ) : (
          <Suspended busy={busy}>
          {!data.movements.length ? (
          <EmptyState title={t("No movements yet.")} />
        ) : (
          <Table containerClassName="table-wrap">
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">{t("Day")}</TableHead>
                <TableHead>{t("Move")}</TableHead>
                <TableHead>{t("Unit")}</TableHead>
                <TableHead>{t("From")}</TableHead>
                <TableHead>{t("To")}</TableHead>
                <TableHead>{t("By")}</TableHead>
                <TableHead className="pr-4 text-right" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.movements.map((m) => (
                <TableRow key={m.id} className={corrected.has(m.id) ? "opacity-50" : undefined}>
                  <TableCell className="num pl-4 text-xs">{m.day}</TableCell>
                  <TableCell className="text-xs">
                    <Badge variant={m.kind === "correction" ? "warn" : m.kind === "count_adjust" ? "info" : "neutral"}>{t(MOVE_LABEL[m.kind] ?? m.kind)}</Badge>
                    {m.note && <span className="mt-0.5 block max-w-56 truncate text-[11px] text-muted-foreground">{m.note}</span>}
                  </TableCell>
                  <TableCell className="text-xs">
                    <span className="font-mono text-slate-100">{m.serial ?? "—"}</span>
                    <span className="block text-[11px] text-muted-foreground">{m.part_code ?? "—"}</span>
                    <RegistryChip hits={where[registryKey(m.serial)]} className="mt-0.5 max-w-56" />
                    {m.failed_unit_id != null && (
                      <Button size="xs" variant="link" className="h-auto px-0 text-[11px]" onClick={() => onOpenFailed(m.failed_unit_id!)}>
                        {t("Failed unit")}
                      </Button>
                    )}
                  </TableCell>
                  <TableCell className="text-xs">
                    {m.from_location_code ?? ((m.from_state === "installed" || m.kind === "failed_in") ? m.plant_name ?? "—" : "—")}
                  </TableCell>
                  <TableCell className="text-xs">{m.to_location_code ?? (m.to_state === "installed" ? m.plant_name ?? "—" : m.to_state ? t(STATE_LABEL[m.to_state]) : "—")}</TableCell>
                  <TableCell className="text-xs">
                    <span className="flex items-center gap-1.5">
                      {m.by ?? "—"}
                      {m.input_method && <MethodBadge method={m.input_method} />}
                    </span>
                  </TableCell>
                  <TableCell className="pr-4 text-right">
                    {keeper && m.kind !== "correction" && !corrected.has(m.id) && latest.has(m.id) && (
                      <Button size="icon-xs" variant="ghost" aria-label={t("Correct")} title={t("Correct")} onClick={() => setCorrecting(m)}>
                        <Undo2 className="size-3.5" />
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
          </Suspended>
        )}
        {data && data.total > PAGE && (
          <div className="flex items-center justify-end gap-2 px-4 text-xs text-muted-foreground">
            {t("{from}–{to} of {total}", { from: page * PAGE + 1, to: Math.min((page + 1) * PAGE, data.total), total: data.total })}
            <Button size="xs" variant="outline" disabled={page === 0} onClick={() => setPage(page - 1)}>
              {t("Newer")}
            </Button>
            <Button size="xs" variant="outline" disabled={(page + 1) * PAGE >= data.total} onClick={() => setPage(page + 1)}>
              {t("Older")}
            </Button>
          </div>
        )}
      </CardContent>
      <CorrectDialog movement={correcting} onOpenChange={(o) => !o && setCorrecting(null)} onDone={onChanged} />
    </Card>
  );
};

const CatalogueTab: React.FC<{ parts: StockPart[]; keeper: boolean; onEdit: (p: StockPart | null) => void; onFromModels: () => void }> = ({ parts, keeper, onEdit, onFromModels }) => {
  const { t } = useI18n();
  return (
    <Card className="gap-3 py-3">
      <CardContent className="flex flex-col gap-3 px-0">
        {keeper && (
          <div className="flex flex-wrap gap-2 px-4">
            <Button size="sm" variant="outline" onClick={() => onEdit(null)}>
              <Plus data-icon="inline-start" />
              {t("Add part")}
            </Button>
            <Button size="sm" variant="outline" onClick={onFromModels}>
              {t("From installed models")}
            </Button>
          </div>
        )}
        {!parts.length ? (
          <EmptyState title={t("No parts in the catalogue yet.")} />
        ) : (
          <Table containerClassName="table-wrap">
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">{t("Part code")}</TableHead>
                <TableHead>{t("Name")}</TableHead>
                <TableHead>{t("Category")}</TableHead>
                <TableHead>{t("Make / model")}</TableHead>
                <TableHead className="text-right">{t("Minimum")}</TableHead>
                <TableHead className="pr-4 text-right" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {parts.map((p) => (
                <TableRow key={p.id} className={p.active ? undefined : "opacity-50"}>
                  <TableCell className="pl-4 font-mono text-xs">{p.code}</TableCell>
                  <TableCell className="text-xs">
                    {p.name}
                    {!p.active && <Badge variant="neutral" className="ml-2">{t("Inactive")}</Badge>}
                  </TableCell>
                  <TableCell className="text-xs">{t(CATEGORY_LABEL[p.category])}</TableCell>
                  <TableCell className="text-xs">{[p.make, p.model].filter(Boolean).join(" ") || "—"}</TableCell>
                  <TableCell className="num text-right text-xs">{p.min_qty ?? "—"}</TableCell>
                  <TableCell className="pr-4 text-right">
                    {keeper && (
                      <Button size="icon-xs" variant="ghost" aria-label={t("Edit {code}", { code: p.code })} onClick={() => onEdit(p)}>
                        <Pencil className="size-3.5" />
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
};

const LocationsTab: React.FC<{ locations: StockLocation[]; locById: Map<number, StockLocation>; keeper: boolean; onEdit: (l: StockLocation | null) => void }> = ({
  locations,
  locById,
  keeper,
  onEdit,
}) => {
  const { t, locale } = useI18n();
  return (
    <Card className="gap-3 py-3">
      <CardContent className="flex flex-col gap-3 px-0">
        <div className="flex flex-wrap gap-2 px-4">
          {keeper && (
            <Button size="sm" variant="outline" onClick={() => onEdit(null)}>
              <Plus data-icon="inline-start" />
              {t("Add location")}
            </Button>
          )}
          {locations.some((l) => l.active) && (
            <Button asChild size="sm" variant="outline">
              <Link to="/labels?kind=loc">
                <Printer data-icon="inline-start" />
                {t("Print labels")}
              </Link>
            </Button>
          )}
        </div>
        {!locations.length ? (
          <EmptyState title={t("No stock locations yet.")} />
        ) : (
          <Table containerClassName="table-wrap">
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">{t("Code")}</TableHead>
                <TableHead>{t("Name")}</TableHead>
                <TableHead>{t("Kind")}</TableHead>
                <TableHead>{t("In store / crew lead")}</TableHead>
                <TableHead className="text-right">{t("Units")}</TableHead>
                <TableHead>{t("Last counted")}</TableHead>
                <TableHead className="pr-4 text-right" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {locations.map((l) => (
                <TableRow key={l.id} className={l.active ? undefined : "opacity-50"}>
                  <TableCell className="pl-4 font-mono text-xs">{l.code}</TableCell>
                  <TableCell className="text-xs">
                    {l.name}
                    {!l.active && <Badge variant="neutral" className="ml-2">{t("Inactive")}</Badge>}
                  </TableCell>
                  <TableCell className="text-xs">{t(KIND_LABEL[l.kind])}</TableCell>
                  <TableCell className="text-xs">{l.kind === "bin" ? (l.parent_id != null ? locById.get(l.parent_id)?.code : null) ?? "—" : l.holder_name ?? "—"}</TableCell>
                  <TableCell className="num text-right text-xs">{l.units}</TableCell>
                  <TableCell className="text-xs whitespace-nowrap">
                    {l.last_count_at ? (
                      <>
                        <span className="num">{fmtStockAt(l.last_count_at, locale)}</span>
                        <span className="block text-[11px] text-muted-foreground">{l.last_count_by ?? "—"}</span>
                      </>
                    ) : l.kind === "supplier" ? (
                      "—"
                    ) : (
                      <span className="text-muted-foreground">{t("Never")}</span>
                    )}
                  </TableCell>
                  <TableCell className="pr-4 text-right whitespace-nowrap">
                    {l.active && l.kind !== "supplier" && (
                      <Button asChild size="xs" variant="ghost">
                        <Link to={`/inventory/scan?loc=${l.id}`}>
                          <ScanLine data-icon="inline-start" />
                          {t("Scan into")}
                        </Link>
                      </Button>
                    )}
                    {l.active && l.kind !== "supplier" && (
                      <Button asChild size="xs" variant="ghost">
                        <Link to={`/inventory/scan?mode=count&loc=${l.id}`}>
                          <ClipboardList data-icon="inline-start" />
                          {t("Count")}
                        </Link>
                      </Button>
                    )}
                    {l.active && (
                      <Button asChild size="icon-xs" variant="ghost" aria-label={t("Print the label of {code}", { code: l.code })} title={t("Print the label of {code}", { code: l.code })}>
                        <Link to={`/labels?kind=loc&ids=${l.id}`}>
                          <Printer className="size-3.5" />
                        </Link>
                      </Button>
                    )}
                    {keeper && (
                      <Button size="icon-xs" variant="ghost" aria-label={t("Edit {code}", { code: l.code })} onClick={() => onEdit(l)}>
                        <Pencil className="size-3.5" />
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
};
