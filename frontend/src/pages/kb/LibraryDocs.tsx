/**
 * Knowledge Base library, Documents tab (`/kb`, spec §4.1): "Pinned for you" (pins, documents
 * for the user's plants and their inverter models, newest changes) and every document the user may
 * see as a list or a grid, with filters (type, status, equipment, plant, language, owner, tag,
 * fault code). On a phone the filters fold away behind a button. DB only, never polled.
 *
 * URL: `type`, `dstatus`, `eq`, `plant`, `fault`, `dtag`, `lang`, `owner`, `sort`, `desc`, `view`.
 */
import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { FileText, LayoutGrid, List, Pin, SlidersHorizontal, X } from "lucide-react";
import { api } from "../../api/client";
import type { KbDocHome, KbDocList, KbDocQuery, KbDocStatus, KbDocSummary, KbDocType, KbDocLanguage, UserProfile } from "../../api/client";
import { isAdmin } from "../../auth/access";
import { useFleet } from "../../context/FleetContext";
import { useI18n } from "../../i18n";
import { pick, useUrlState } from "@/lib/useUrlState";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Card, CardContent } from "@/components/ui/card";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SkeletonRows, Suspended, fmtInt } from "../../components/ui";
import { TablePager, pageBounds } from "../../components/TablePager";
import { DOC_STATUS, DOC_STATUS_KEYS, DOC_TYPES, DOC_TYPE_KEYS, DocStatusBadge, LANGUAGES, docPath, docSubtitle, docTitle, docTypeOf, revText } from "./docFormat";
import { fmtDateTime, timeAgo } from "./format";
import { useLoad } from "./useDocs";

const PAGE_SIZE = 25;
const ALL = "all";
const SORTS = ["updated", "number", "title"] as const;

const DocCard: React.FC<{ d: KbDocSummary }> = ({ d }) => {
  const { t, lang } = useI18n();
  const type = docTypeOf(d.doc_type);
  return (
    <Link
      to={docPath(d.id)}
      className="group flex w-full flex-col gap-2 rounded-lg border border-white/[0.07] bg-ink-900/60 p-3 transition-colors hover:border-solar-400/40 hover:bg-white/[0.03]"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 text-[11px] text-slate-400">
          <type.icon className="size-3.5" aria-hidden />
          {t(type.label)}
        </span>
        {d.pinned && <Pin className="size-3.5 text-solar-300" aria-label={t("Pinned")} />}
      </div>
      <span className="num text-xs font-semibold text-solar-200">{d.number}</span>
      <span className="line-clamp-2 text-sm font-medium text-slate-100 group-hover:text-solar-100">{docTitle(d, lang)}</span>
      <div className="mt-auto flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
        <DocStatusBadge status={d.status} />
        <span>{revText(d.revision)}</span>
      </div>
    </Link>
  );
};

const Strip: React.FC<{ title: string; docs: KbDocSummary[] }> = ({ title, docs }) =>
  docs.length === 0 ? null : (
    <section className="flex flex-col gap-2">
      <h2 className="eyebrow">{title}</h2>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
        {docs.slice(0, 10).map((d) => (
          <DocCard key={d.id} d={d} />
        ))}
      </div>
    </section>
  );

export const LibraryDocs: React.FC<{ user: UserProfile | null; onUpload: () => void; reloadKey: number }> = ({ user, onUpload, reloadKey }) => {
  const { t, lang } = useI18n();
  const admin = isAdmin(user);
  const canWrite = user?.role === "admin" || user?.role === "engineer";
  const { growattPlants } = useFleet();
  const [url, setUrl] = useUrlState();
  const type = pick(url.get("type"), [ALL, ...DOC_TYPE_KEYS] as const, ALL);
  const statusKeys = admin ? DOC_STATUS_KEYS : DOC_STATUS_KEYS.filter((s) => s !== "withdrawn");
  const status = pick(url.get("dstatus"), [ALL, ...statusKeys] as const, ALL);
  const eq = url.get("eq") ?? "";
  const plantRaw = url.get("plant");
  const plantId = plantRaw && /^\d+$/.test(plantRaw) ? Number(plantRaw) : null;
  const fault = (url.get("fault") ?? "").slice(0, 40);
  const tag = url.get("dtag") ?? "";
  const language = pick(url.get("lang"), [ALL, "en", "th", "both"] as const, ALL);
  const owner = url.get("owner") ?? "";
  const sort = pick(url.get("sort"), SORTS, "updated");
  const view = pick(url.get("view"), ["list", "grid"] as const, "list");
  const [showFilters, setShowFilters] = useState(false);
  const [faultText, setFaultText] = useState(fault);
  useEffect(() => setFaultText(fault), [fault]);

  const [page, setPage] = useState(0);
  useEffect(() => setPage(0), [type, status, eq, plantId, fault, tag, language, owner, sort]);

  const query: KbDocQuery = {
    type: type === ALL ? undefined : (type as KbDocType),
    status: status === ALL ? undefined : (status as KbDocStatus),
    equipment: eq || undefined,
    plant_id: plantId ?? undefined,
    fault: fault || undefined,
    tag: tag || undefined,
    language: language === ALL ? undefined : (language as KbDocLanguage),
    owner: owner || undefined,
    sort,
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  };
  const key = JSON.stringify(query) + `|${reloadKey}`;
  const list = useLoad<KbDocList>(key, () => api.listKbDocs(query));
  const home = useLoad<KbDocHome>(`home|${reloadKey}`, () => api.getKbDocHome());
  const total = list.data?.total ?? 0;
  const { pageNo } = pageBounds(total, PAGE_SIZE, page);
  const facets = list.data?.facets;
  const filters = [type !== ALL, status !== ALL, !!eq, plantId != null, !!fault, !!tag, language !== ALL, !!owner].filter(Boolean).length;
  const clear = () => setUrl({ type: null, dstatus: null, eq: null, plant: null, fault: null, dtag: null, lang: null, owner: null });
  const plants = useMemo(() => [...growattPlants].sort((a, b) => a.name.localeCompare(b.name)), [growattPlants]);

  const sel = (id: string, label: string, value: string, onChange: (v: string) => void, items: React.ReactNode) => (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id} className="text-[11px] text-muted-foreground">
        {label}
      </Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} size="sm" className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>{items}</SelectContent>
      </Select>
    </div>
  );

  const filterPanel = (
    <div className="flex flex-col gap-3">
      {sel(
        "kbf-type",
        t("Type"),
        type,
        (v) => setUrl({ type: v === ALL ? null : v }),
        <>
          <SelectItem value={ALL}>{t("All types")}</SelectItem>
          <SelectSeparator />
          {DOC_TYPES.map((x) => (
            <SelectItem key={x.value} value={x.value}>
              {t(x.label)}
            </SelectItem>
          ))}
        </>
      )}
      {sel(
        "kbf-status",
        t("Status"),
        status,
        (v) => setUrl({ dstatus: v === ALL ? null : v }),
        <>
          <SelectItem value={ALL}>{admin ? t("All but withdrawn") : t("All")}</SelectItem>
          <SelectSeparator />
          {statusKeys.map((s) => (
            <SelectItem key={s} value={s}>
              {t(DOC_STATUS[s].label)}
            </SelectItem>
          ))}
        </>
      )}
      {sel(
        "kbf-eq",
        t("Equipment"),
        eq || ALL,
        (v) => setUrl({ eq: v === ALL ? null : v }),
        <>
          <SelectItem value={ALL}>{t("All equipment")}</SelectItem>
          {(facets?.equipment.length ?? 0) > 0 && <SelectSeparator />}
          {eq && !facets?.equipment.some((e) => e.label === eq || e.key === eq) && <SelectItem value={eq}>{eq}</SelectItem>}
          {facets?.equipment.map((e) => (
            <SelectItem key={e.key} value={e.label}>
              {e.label} · {e.count}
            </SelectItem>
          ))}
        </>
      )}
      {sel(
        "kbf-plant",
        t("Plant"),
        plantId != null ? String(plantId) : ALL,
        (v) => setUrl({ plant: v === ALL ? null : v }),
        <>
          <SelectItem value={ALL}>{t("All plants")}</SelectItem>
          <SelectSeparator />
          {plants.map((p) => (
            <SelectItem key={p.plant_id} value={String(p.plant_id)}>
              {p.name}
            </SelectItem>
          ))}
        </>
      )}
      <form
        className="flex flex-col gap-1"
        onSubmit={(e) => {
          e.preventDefault();
          setUrl({ fault: faultText.trim() || null });
        }}
      >
        <Label htmlFor="kbf-fault" className="text-[11px] text-muted-foreground">
          {t("Linked to fault code")}
        </Label>
        <Input
          id="kbf-fault"
          value={faultText}
          onChange={(e) => setFaultText(e.target.value)}
          onBlur={() => setUrl({ fault: faultText.trim() || null })}
          placeholder={t("e.g. 203 or Error:203")}
          className="num h-8 text-xs"
        />
      </form>
      {sel(
        "kbf-lang",
        t("Language"),
        language,
        (v) => setUrl({ lang: v === ALL ? null : v }),
        <>
          <SelectItem value={ALL}>{t("All languages")}</SelectItem>
          <SelectSeparator />
          {LANGUAGES.map((x) => (
            <SelectItem key={x.value} value={x.value}>
              {t(x.label)}
            </SelectItem>
          ))}
        </>
      )}
      {(facets?.owners.length ?? 0) > 1 &&
        sel(
          "kbf-owner",
          t("Owner"),
          owner || ALL,
          (v) => setUrl({ owner: v === ALL ? null : v }),
          <>
            <SelectItem value={ALL}>{t("Everyone")}</SelectItem>
            <SelectSeparator />
            {facets!.owners.map((o) => (
              <SelectItem key={o} value={o}>
                {o}
              </SelectItem>
            ))}
          </>
        )}
      {(facets?.tags.length ?? 0) > 0 &&
        sel(
          "kbf-tag",
          t("Tag"),
          tag || ALL,
          (v) => setUrl({ dtag: v === ALL ? null : v }),
          <>
            <SelectItem value={ALL}>{t("All tags")}</SelectItem>
            <SelectSeparator />
            {tag && !facets!.tags.includes(tag) && <SelectItem value={tag}>#{tag}</SelectItem>}
            {facets!.tags.map((x) => (
              <SelectItem key={x} value={x}>
                #{x}
              </SelectItem>
            ))}
          </>
        )}
      {filters > 0 && (
        <Button variant="ghost" size="sm" onClick={clear} className="self-start">
          <X data-icon="inline-start" />
          {t("Clear filters")}
        </Button>
      )}
    </div>
  );

  const items = list.data?.items ?? [];
  const h = home.data;
  const emptyLibrary = list.data != null && total === 0 && filters === 0;

  return (
    <div className="grid gap-4 lg:grid-cols-[220px_1fr]">
      <div className="flex flex-col gap-2">
        <Button variant="outline" size="sm" className="justify-between lg:hidden" onClick={() => setShowFilters((v) => !v)} aria-expanded={showFilters}>
          <span className="inline-flex items-center gap-1.5">
            <SlidersHorizontal data-icon="inline-start" />
            {t("Filters")}
            {filters > 0 && <span className="num text-solar-200">· {filters}</span>}
          </span>
        </Button>
        <Card className={cn("py-3 lg:sticky lg:top-2 lg:block", showFilters ? "block" : "hidden")}>
          <CardContent>{filterPanel}</CardContent>
        </Card>
      </div>

      <div className="flex min-w-0 flex-col gap-4">
        {h && filters === 0 && (
          <>
            <Strip title={t("Pinned for you")} docs={h.pinned} />
            <Strip title={t("For your plants")} docs={h.for_plants} />
          </>
        )}

        <Card className="gap-0 py-0">
          <CardContent className="flex flex-wrap items-center justify-between gap-2 border-b py-2.5">
            <span className="text-sm font-semibold">
              {t("All documents")} <span className="num text-muted-foreground">({fmtInt(total)})</span>
            </span>
            <div className="flex items-center gap-2">
              <Select value={sort} onValueChange={(v) => setUrl({ sort: v === "updated" ? null : v })}>
                <SelectTrigger size="sm" className="w-40" aria-label={t("Sort")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="updated">{t("Sort: updated")}</SelectItem>
                  <SelectItem value="number">{t("Sort: number")}</SelectItem>
                  <SelectItem value="title">{t("Sort: title")}</SelectItem>
                </SelectContent>
              </Select>
              <ToggleGroup
                type="single"
                size="icon-sm"
                spacing={0}
                className="rounded-md border border-white/10"
                aria-label={t("View")}
                value={view}
                onValueChange={(v) => v && setUrl({ view: v === "grid" ? "grid" : null })}
              >
                <ToggleGroupItem value="list" aria-label={t("List view")}>
                  <List />
                </ToggleGroupItem>
                <ToggleGroupItem value="grid" aria-label={t("Grid view")}>
                  <LayoutGrid />
                </ToggleGroupItem>
              </ToggleGroup>
            </div>
          </CardContent>
          <Suspended busy={list.refreshing} label={t("Loading documents…")}>
            {list.loading && !list.data ? (
              <SkeletonRows rows={6} className="p-4" />
            ) : list.error && !list.data ? (
              <p className="callout-crit m-4 text-xs">{list.error.text}</p>
            ) : items.length === 0 ? (
              <Empty className="py-12">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <FileText />
                  </EmptyMedia>
                  <EmptyTitle>{emptyLibrary ? t("No documents yet") : t("No matching documents")}</EmptyTitle>
                  <EmptyDescription>
                    {emptyLibrary ? t("Upload a vendor manual, datasheet or drawing as PDF.") : t("Try another filter, or search the text of every page.")}
                  </EmptyDescription>
                </EmptyHeader>
                {emptyLibrary && canWrite && (
                  <EmptyContent>
                    <Button size="sm" onClick={onUpload}>
                      {t("Upload PDF")}
                    </Button>
                  </EmptyContent>
                )}
              </Empty>
            ) : view === "grid" ? (
              <div className="grid grid-cols-2 gap-2 p-3 sm:grid-cols-3 xl:grid-cols-4">
                {items.map((d) => (
                  <DocCard key={d.id} d={d} />
                ))}
              </div>
            ) : (
              <>
                <ul className="divide-y divide-white/[0.06] md:hidden">
                  {items.map((d) => (
                    <li key={d.id} className="px-3 py-2">
                      <DocCard d={d} />
                    </li>
                  ))}
                </ul>
                <Table containerClassName="table-wrap hidden md:block">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-32">{t("Number")}</TableHead>
                      <TableHead>{t("Title")}</TableHead>
                      <TableHead className="w-36">{t("Type")}</TableHead>
                      <TableHead className="w-28">{t("Rev")}</TableHead>
                      <TableHead className="w-32">{t("Status")}</TableHead>
                      <TableHead className="w-32">{t("Updated")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items.map((d) => {
                      const tp = docTypeOf(d.doc_type);
                      const sub = docSubtitle(d, lang);
                      return (
                        <TableRow key={d.id} className="relative">
                          <TableCell className="num text-xs font-semibold text-solar-200">
                            <span className="inline-flex items-center gap-1">
                              {d.number}
                              {d.pinned && <Pin className="size-3 text-solar-300" aria-label={t("Pinned")} />}
                            </span>
                          </TableCell>
                          <TableCell className="max-w-0">
                            <Link to={docPath(d.id)} className="block truncate text-sm text-slate-100 after:absolute after:inset-0 hover:text-solar-200">
                              {docTitle(d, lang)}
                            </Link>
                            {sub && <span className="block truncate text-[11px] text-muted-foreground">{sub}</span>}
                          </TableCell>
                          <TableCell className="text-xs text-slate-300">
                            <span className="inline-flex items-center gap-1.5">
                              <tp.icon className="size-3.5 text-slate-500" aria-hidden />
                              {t(tp.label)}
                            </span>
                          </TableCell>
                          <TableCell className="text-xs text-slate-300">{revText(d.revision)}</TableCell>
                          <TableCell>
                            <DocStatusBadge status={d.status} />
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground" title={fmtDateTime(d.updated_at)}>
                            {timeAgo(d.updated_at)}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </>
            )}
          </Suspended>
          <CardContent className="border-t py-2.5">
            <TablePager rows={total} pageSize={PAGE_SIZE} pageNo={pageNo} onPage={setPage} />
          </CardContent>
        </Card>

        {h && filters === 0 && h.recent.length > 0 && sort !== "updated" && <Strip title={t("Recently changed")} docs={h.recent.slice(0, 5)} />}
      </div>
    </div>
  );
};
