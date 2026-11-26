/**
 * Operations → Spares (`/spares`, everyone; docs/plans/spares-failed-units.md, phase 1): the parts
 * catalogue, stock locations (store, bins, crew vans), serialised spare units and the movement log.
 * Stock on hand is counted from the register, never typed in; every move is a log row that is never
 * edited (a correction reverses one). Everyone moves units (transfer, install, return); an admin or
 * store keeper receives, corrects and edits the catalogue and locations. Installs on plants the user
 * may not see are left out by the API.
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeftRight, Download, PackagePlus, Pencil, Plus, Undo2 } from "lucide-react";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState, SkeletonRows } from "../components/ui";
import { MethodBadge } from "../components/scan/ScanDialog";
import { useAppContext } from "../context/AppContext";
import { useI18n } from "../i18n";
import { pick, useUrlState } from "@/lib/useUrlState";
import { CorrectDialog, LocationDialog, PartDialog } from "./spares/dialogs";
import { MoveDialog, type MoveKind } from "./spares/MoveDialog";
import { CATEGORY_LABEL, KIND_LABEL, MOVE_LABEL, STATE_LABEL, canManageStock } from "./spares/shared";

const TABS = ["stock", "movements", "catalogue", "locations"] as const;
const MOVE_KINDS = ["all", "receive", "transfer", "issue", "return", "correction"] as const;
const PAGE = 100;

const csvCell = (v: unknown) => {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const download = (name: string, rows: unknown[][]) => {
  const blob = new Blob(["﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
};

const Stat: React.FC<{ label: string; value: number | string; tone?: "warn" }> = ({ label, value, tone }) => (
  <div className="flex flex-col rounded-lg border border-white/[0.07] px-3 py-2">
    <span className={tone === "warn" ? "num text-lg font-semibold text-amber-300" : "num text-lg font-semibold text-slate-100"}>{value}</span>
    <span className="text-[11px] text-muted-foreground">{label}</span>
  </div>
);

export const SparesPage: React.FC = () => {
  const { t } = useI18n();
  const { user } = useAppContext();
  const keeper = canManageStock(user);
  const [url, setUrl] = useUrlState();
  const tab = pick(url.get("tab"), TABS, "stock");
  const [parts, setParts] = useState<StockPart[] | null>(null);
  const [locations, setLocations] = useState<StockLocation[] | null>(null);
  const [summary, setSummary] = useState<StockSummary | null>(null);
  const [people, setPeople] = useState<{ id: number; name: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [move, setMove] = useState<{ kind: MoveKind; unit?: StockUnit | null } | null>(null);
  const [editPart, setEditPart] = useState<StockPart | null | undefined>(undefined);
  const [editLoc, setEditLoc] = useState<StockLocation | null | undefined>(undefined);
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

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col">
          <h1 className="text-lg font-semibold">{t("Spares")}</h1>
          <p className="text-xs text-muted-foreground">{t("Spare units in the store and the crews' vans, and every move in and out")}</p>
        </div>
        <div className="flex items-center gap-2">
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
        <div className="grid grid-cols-3 gap-2 sm:max-w-md">
          <Stat label={t("Units in stock")} value={summary.in_stock} />
          <Stat label={t("Installed from stock")} value={summary.installed} />
          <Stat label={t("Parts below minimum")} value={summary.parts_below_min} tone={summary.parts_below_min ? "warn" : undefined} />
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
        <TabsList variant="line">
          <TabsTrigger value="stock">{t("Stock")}</TabsTrigger>
          <TabsTrigger value="movements">{t("Movements")}</TabsTrigger>
          <TabsTrigger value="catalogue">{t("Catalogue")}</TabsTrigger>
          <TabsTrigger value="locations">{t("Locations")}</TabsTrigger>
        </TabsList>
      </Tabs>

      {!parts || !locations ? (
        <SkeletonRows rows={6} />
      ) : tab === "stock" ? (
        <StockTab parts={activeParts} locById={locById} version={version} onMove={(kind, unit) => setMove({ kind, unit })} />
      ) : tab === "movements" ? (
        <MovementsTab parts={parts} locations={locations} version={version} keeper={keeper} onChanged={reload} />
      ) : tab === "catalogue" ? (
        <CatalogueTab parts={parts} keeper={keeper} onEdit={setEditPart} />
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
  onMove: (kind: MoveKind, unit: StockUnit) => void;
}> = ({ parts, locById, version, onMove }) => {
  const { t } = useI18n();
  const [open, setOpen] = useState<number | null>(null);
  const [units, setUnits] = useState<StockUnit[] | null>(null);
  useEffect(() => {
    if (open == null) return;
    let alive = true;
    setUnits(null);
    api
      .listStockUnits({ part_id: open })
      .then((u) => alive && setUnits(u))
      .catch(() => alive && setUnits([]));
    return () => {
      alive = false;
    };
  }, [open, version]);
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
                      {!units ? (
                        <SkeletonRows rows={2} />
                      ) : !units.length ? (
                        <p className="text-xs text-muted-foreground">{t("No units of this part yet.")}</p>
                      ) : (
                        <ul className="flex flex-col gap-1">
                          {units.map((u) => (
                            <li key={u.id} className="flex flex-wrap items-center gap-2 text-xs">
                              <span className="min-w-36 font-mono text-slate-100">{u.serial}</span>
                              <Badge variant={u.state === "in_stock" ? "ok" : "neutral"}>{t(STATE_LABEL[u.state])}</Badge>
                              <span className="min-w-0 flex-1 truncate text-muted-foreground">{u.location_code ?? u.plant_name ?? "—"}</span>
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
const MovementsTab: React.FC<{ parts: StockPart[]; locations: StockLocation[]; version: number; keeper: boolean; onChanged: () => void }> = ({
  parts,
  version,
  keeper,
  onChanged,
}) => {
  const { t } = useI18n();
  const [kind, setKind] = useState<(typeof MOVE_KINDS)[number]>("all");
  const [partId, setPartId] = useState("all");
  const [serial, setSerial] = useState("");
  const [page, setPage] = useState(0);
  const [data, setData] = useState<StockMovementList | null>(null);
  const [correcting, setCorrecting] = useState<StockMovement | null>(null);
  useEffect(() => setPage(0), [kind, partId, serial]);
  useEffect(() => {
    let alive = true;
    const h = window.setTimeout(() => {
      api
        .listStockMovements({
          kind: kind === "all" ? undefined : kind,
          part_id: partId === "all" ? undefined : Number(partId),
          serial: serial.trim() || undefined,
          limit: PAGE,
          offset: page * PAGE,
        })
        .then((d) => alive && setData(d))
        .catch(() => alive && setData({ total: 0, movements: [] }));
    }, 200);
    return () => {
      alive = false;
      window.clearTimeout(h);
    };
  }, [kind, partId, serial, page, version]);
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
  const exportCsv = () =>
    data &&
    download("spares-movements.csv", [
      ["id", "day", "kind", "part", "serial", "from", "to", "plant", "from_state", "to_state", "by", "input", "note", "corrects"],
      ...data.movements.map((m) => [m.id, m.day, m.kind, m.part_code, m.serial, m.from_location_code, m.to_location_code, m.plant_name ?? m.plant_id, m.from_state, m.to_state, m.by, m.input_method, m.note, m.corrects_id]),
    ]);
  return (
    <Card className="gap-3 py-3">
      <CardContent className="flex flex-col gap-3 px-0">
        <div className="flex flex-wrap items-center gap-2 px-4">
          <Select value={kind} onValueChange={(v) => setKind(v as (typeof MOVE_KINDS)[number])}>
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
          <Select value={partId} onValueChange={setPartId}>
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
          <Input value={serial} onChange={(e) => setSerial(e.target.value)} placeholder={t("Serial contains…")} className="h-8 w-44 font-mono" aria-label={t("Serial no.")} />
          <span className="flex-1" />
          <Button variant="outline" size="sm" onClick={exportCsv} disabled={!data?.movements.length}>
            <Download data-icon="inline-start" />
            CSV
          </Button>
        </div>
        {!data ? (
          <SkeletonRows rows={5} className="px-4" />
        ) : !data.movements.length ? (
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
                    <Badge variant={m.kind === "correction" ? "warn" : "neutral"}>{t(MOVE_LABEL[m.kind])}</Badge>
                    {m.note && <span className="mt-0.5 block max-w-56 truncate text-[11px] text-muted-foreground">{m.note}</span>}
                  </TableCell>
                  <TableCell className="text-xs">
                    <span className="font-mono text-slate-100">{m.serial}</span>
                    <span className="block text-[11px] text-muted-foreground">{m.part_code}</span>
                  </TableCell>
                  <TableCell className="text-xs">{m.from_location_code ?? (m.from_state === "installed" ? m.plant_name ?? "—" : "—")}</TableCell>
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

const CatalogueTab: React.FC<{ parts: StockPart[]; keeper: boolean; onEdit: (p: StockPart | null) => void }> = ({ parts, keeper, onEdit }) => {
  const { t } = useI18n();
  return (
    <Card className="gap-3 py-3">
      <CardContent className="flex flex-col gap-3 px-0">
        {keeper && (
          <div className="px-4">
            <Button size="sm" variant="outline" onClick={() => onEdit(null)}>
              <Plus data-icon="inline-start" />
              {t("Add part")}
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
  const { t } = useI18n();
  return (
    <Card className="gap-3 py-3">
      <CardContent className="flex flex-col gap-3 px-0">
        {keeper && (
          <div className="px-4">
            <Button size="sm" variant="outline" onClick={() => onEdit(null)}>
              <Plus data-icon="inline-start" />
              {t("Add location")}
            </Button>
          </div>
        )}
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
                  <TableCell className="pr-4 text-right">
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
