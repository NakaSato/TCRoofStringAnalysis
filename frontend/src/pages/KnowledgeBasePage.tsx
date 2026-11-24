/**
 * Operations → Knowledge Base (`/kb`, everyone signed in): the library of the team's documents.
 * Two tabs (`tab`): Documents (default; uploaded PDFs: vendor manuals, datasheets, SOPs, drawings,
 * reports, in `pages/kb/LibraryDocs.tsx`, docs/plans/kb-documents.md) and Articles (O&M manuals
 * written in the app as Markdown, docs/plans/knowledge-base.md). The header's search box opens
 * `/kb/search`, which searches both, page by page for the PDFs. The document page, viewer, article
 * and editor are in `pages/kb/`, their own chunks.
 *
 * Articles URL: `q` (as typed), `cat`, `tag`, `status` (admins). Documents URL: see LibraryDocs.
 */
import React, { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { BookOpen, FileText, FileUp, Plus, Search, X } from "lucide-react";
import type { KbArticleListItem, UserProfile } from "../api/client";
import { useAppContext } from "../context/AppContext";
import { isAdmin } from "../auth/access";
import { useI18n } from "../i18n";
import { pick, useUrlState } from "@/lib/useUrlState";
import { SkeletonRows, Suspended, fmtInt } from "../components/ui";
import { TablePager, pageBounds } from "../components/TablePager";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CATEGORIES, CATEGORY_KEYS, STATUS, STATUS_KEYS, articlePath, categoryOf, fmtDateTime, searchWords, updatedText } from "./kb/format";
import { useArticleList } from "./kb/useKb";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { LibraryDocs } from "./kb/LibraryDocs";
import { UploadDocDialog } from "./kb/DocDialogs";
import { docPath, searchPath } from "./kb/docFormat";

const PAGE_SIZE = 25;
const ALL = "all";
const SEARCH_DEBOUNCE_MS = 300;

/** "/" focuses the search box unless the user is typing somewhere */
const useSlashFocus = (ref: React.RefObject<HTMLInputElement | null>) => {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      e.preventDefault();
      ref.current?.focus();
      ref.current?.select();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ref]);
};

const ArticleRow: React.FC<{ a: KbArticleListItem; onTag: (tag: string) => void }> = ({ a, onTag }) => {
  const { t } = useI18n();
  const c = categoryOf(a.category);
  return (
    <li className="relative flex flex-col gap-1.5 px-4 py-3 transition-colors hover:bg-white/[0.03] sm:px-5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Link to={articlePath(a.slug)} className="min-w-0 text-sm font-semibold text-slate-100 after:absolute after:inset-0 hover:text-solar-200">
          {a.title}
        </Link>
        {a.status !== "published" && <Badge variant={STATUS[a.status].variant}>{t(STATUS[a.status].label)}</Badge>}
      </div>
      {a.excerpt && <p className="line-clamp-2 text-xs text-muted-foreground">{a.excerpt}</p>}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1 text-slate-300">
          <c.icon className="size-3.5 text-slate-500" aria-hidden />
          {t(c.label)}
        </span>
        {a.tags.length > 0 && (
          <span className="relative z-10 flex flex-wrap gap-1">
            {a.tags.map((tag) => (
              <Button
                key={tag}
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => onTag(tag)}
                className="h-auto rounded-full border-white/10 bg-white/5 px-1.5 py-px text-[10px] font-normal text-slate-300 hover:border-solar-400/40 hover:bg-white/5 hover:text-solar-200"
                title={t("Show articles tagged {tag}", { tag })}
              >
                #{tag}
              </Button>
            ))}
          </span>
        )}
        <span title={fmtDateTime(a.updated_at ?? a.created_at)}>{updatedText(a)}</span>
      </div>
    </li>
  );
};

const ArticlesTab: React.FC<{ user: UserProfile | null }> = ({ user }) => {
  const admin = isAdmin(user);
  const canWrite = user?.role === "admin" || user?.role === "engineer";
  const { t } = useI18n();
  const [url, setUrl] = useUrlState();
  const urlQ = url.get("q") ?? "";
  const cat = pick(url.get("cat"), [ALL, ...CATEGORY_KEYS] as const, ALL);
  const tag = url.get("tag") ?? "";
  const status = admin ? pick(url.get("status"), [ALL, ...STATUS_KEYS] as const, ALL) : ALL;

  // the box updates at once; the URL (and the request) after a short pause
  const [text, setText] = useState(urlQ);
  const lastSent = useRef(urlQ);
  useEffect(() => {
    if (urlQ !== lastSent.current) {
      lastSent.current = urlQ;
      setText(urlQ);
    }
  }, [urlQ]);
  useEffect(() => {
    if (text === lastSent.current) return;
    const h = setTimeout(() => {
      lastSent.current = text;
      setUrl({ q: text });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(h);
  }, [text, setUrl]);

  const searchRef = useRef<HTMLInputElement>(null);
  useSlashFocus(searchRef);

  const q = searchWords(urlQ);
  const [page, setPage] = useState(0);
  useEffect(() => setPage(0), [q, cat, tag, status]);

  const { data, loading, refreshing, error } = useArticleList({
    q: q || undefined,
    category: cat === ALL ? undefined : cat,
    tag: tag || undefined,
    status: status === ALL ? undefined : status,
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  });
  const total = data?.total ?? 0;
  const { pageNo } = pageBounds(total, PAGE_SIZE, page);
  const tags = data?.tags ?? [];
  const anyFilter = q !== "" || cat !== ALL || tag !== "" || status !== ALL;
  const clearFilters = () => {
    lastSent.current = "";
    setText("");
    setUrl({ q: null, cat: null, tag: null, status: null });
  };

  return (
    <div className="flex flex-col gap-4">

      {error && !data && (
        <Alert variant="destructive">
          <AlertTitle>{t("Could not load the articles")}</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Card className="gap-0 py-0">
        <CardContent className="flex flex-col gap-3 border-b py-3">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-slate-500" aria-hidden />
            <Input
              ref={searchRef}
              className="h-9 pr-14 pl-8"
              placeholder={t("Search manuals (press / )")}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape" && text) {
                  e.preventDefault();
                  setText("");
                }
              }}
              aria-label={t("Search manuals")}
            />
            <Kbd className="absolute top-1/2 right-2.5 hidden -translate-y-1/2 bg-transparent text-slate-500 sm:inline-flex">/</Kbd>
          </div>
          {/* clicking the selected category again (value "") goes back to All */}
          <ToggleGroup
            type="single"
            size="sm"
            spacing={1.5}
            className="flex-wrap"
            aria-label={t("Category")}
            value={cat}
            onValueChange={(v) => setUrl({ cat: v && v !== ALL ? v : null })}
          >
            <ToggleGroupItem value={ALL}>{t("All")}</ToggleGroupItem>
            {CATEGORIES.map((c) => (
              <ToggleGroupItem key={c.value} value={c.value} className="data-[state=on]:text-solar-200">
                <c.icon data-icon="inline-start" />
                {t(c.label)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <div className="flex flex-wrap items-center gap-2">
            <Select value={tag || ALL} onValueChange={(v) => setUrl({ tag: v === ALL ? null : v })}>
              <SelectTrigger size="sm" className="w-48 max-w-full" aria-label={t("Filter by tag")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>{t("All tags")}</SelectItem>
                {(tags.length > 0 || tag) && <SelectSeparator />}
                {tag && !tags.includes(tag) && <SelectItem value={tag}>#{tag}</SelectItem>}
                {tags.map((x) => (
                  <SelectItem key={x} value={x}>
                    #{x}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {admin && (
              <Select value={status} onValueChange={(v) => setUrl({ status: v === ALL ? null : v })}>
                <SelectTrigger size="sm" className="w-44 max-w-full" aria-label={t("Status")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>{t("Published and drafts")}</SelectItem>
                  <SelectSeparator />
                  {STATUS_KEYS.map((k) => (
                    <SelectItem key={k} value={k}>
                      {t(STATUS[k].label)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {anyFilter && (
              <Button variant="ghost" size="sm" onClick={clearFilters} className="ml-auto">
                <X data-icon="inline-start" />
                {t("Clear")}
              </Button>
            )}
          </div>
        </CardContent>

        <Suspended busy={refreshing} label={t("Loading articles…")}>
          {loading && !data ? (
            <SkeletonRows rows={6} className="p-4" />
          ) : !data || data.items.length === 0 ? (
            <Empty className="py-12">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <BookOpen />
                </EmptyMedia>
                <EmptyTitle>{!data ? t("Articles unavailable") : anyFilter ? t("No matching articles") : t("No articles yet")}</EmptyTitle>
                {data && anyFilter && q && <EmptyDescription>{t("Every word must appear in the title, tags or text.")}</EmptyDescription>}
                {data && !anyFilter && canWrite && <EmptyDescription>{t("Write the first one with “New article”.")}</EmptyDescription>}
              </EmptyHeader>
            </Empty>
          ) : (
            <ul className="divide-y divide-white/[0.06]">
              {data.items.map((a) => (
                <ArticleRow key={a.id} a={a} onTag={(x) => setUrl({ tag: x })} />
              ))}
            </ul>
          )}
        </Suspended>
        <CardContent className="border-t py-2.5">
          <TablePager
            rows={total}
            pageSize={PAGE_SIZE}
            pageNo={pageNo}
            onPage={setPage}
            extra={data && q ? <span className="text-xs text-muted-foreground">{t("{n} found", { n: fmtInt(total) })}</span> : undefined}
          />
        </CardContent>
      </Card>
    </div>
  );
};

/** the library: header with the whole-library search, Documents / Articles tabs */
export const KnowledgeBasePage: React.FC = () => {
  const { user } = useAppContext();
  const canWrite = user?.role === "admin" || user?.role === "engineer";
  const { t } = useI18n();
  const navigate = useNavigate();
  const [url, setUrl] = useUrlState();
  const tab = pick(url.get("tab"), ["docs", "articles"] as const, "docs");
  const [search, setSearch] = useState("");
  const [upload, setUpload] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const noRef = useRef<HTMLInputElement>(null);
  // on the Articles tab "/" focuses that tab's own search box
  useSlashFocus(tab === "docs" ? searchRef : noRef);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col">
          <h1 className="text-lg font-semibold">{t("Knowledge Base")}</h1>
          <p className="text-xs text-muted-foreground">{t("Manuals, datasheets, SOPs, drawings and reports, searchable page by page")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <form
            className="relative w-full sm:w-80"
            onSubmit={(e) => {
              e.preventDefault();
              if (search.trim()) navigate(searchPath(search.trim()));
            }}
          >
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-slate-500" aria-hidden />
            <Input
              ref={searchRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("Search manuals, SOPs, fault codes…")}
              className="h-8 pl-8 text-xs"
              aria-label={t("Search the library")}
            />
          </form>
          {canWrite && (
            <Button size="sm" onClick={() => setUpload(true)}>
              <FileUp data-icon="inline-start" />
              {t("Upload PDF")}
            </Button>
          )}
          {canWrite && (
            <Button size="sm" variant="outline" asChild>
              <Link to="/kb/new">
                <Plus data-icon="inline-start" />
                {t("New article")}
              </Link>
            </Button>
          )}
        </div>
      </div>
      <Tabs value={tab} onValueChange={(v) => setUrl({ tab: v === "docs" ? null : v })}>
        <TabsList variant="line" aria-label={t("Library")}>
          <TabsTrigger value="docs">
            <FileText data-icon="inline-start" />
            {t("Documents")}
          </TabsTrigger>
          <TabsTrigger value="articles">
            <BookOpen data-icon="inline-start" />
            {t("Articles")}
          </TabsTrigger>
        </TabsList>
      </Tabs>
      {tab === "docs" ? <LibraryDocs user={user} onUpload={() => setUpload(true)} reloadKey={reloadKey} /> : <ArticlesTab user={user} />}
      {canWrite && (
        <UploadDocDialog
          open={upload}
          onOpenChange={setUpload}
          user={user}
          onDone={(d) => {
            setUpload(false);
            setReloadKey((k) => k + 1);
            navigate(docPath(d.id));
          }}
        />
      )}
    </div>
  );
};

export default KnowledgeBasePage;
