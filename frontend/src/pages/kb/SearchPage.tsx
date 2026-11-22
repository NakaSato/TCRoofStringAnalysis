/**
 * Knowledge Base search (`/kb/search?q=`, spec §4.2): fault-code links first ("growatt 203",
 * "error 407" open the linked manual page), then documents (number, titles, tags, file name, and
 * the text of every page, OCR'd scans included) with the matching pages and a snippet each, each
 * opening the viewer at that page with the words highlighted; then the Markdown articles.
 * Thai is split into words in the browser (`Intl.Segmenter`); the backend needs every word.
 */
import React, { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { BookOpen, FileSearch, Search, TriangleAlert, X } from "lucide-react";
import { api } from "../../api/client";
import type { KbArticleList, KbSearchResult } from "../../api/client";
import { useI18n } from "../../i18n";
import { useUrlState } from "@/lib/useUrlState";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { SkeletonRows, Suspended } from "../../components/ui";
import { DocStatusBadge, docPath, docTitle, docTypeOf, faultLabel, revText, viewPath } from "./docFormat";
import { articlePath, categoryOf, searchWords } from "./format";
import { useLoad } from "./useDocs";

const DEBOUNCE_MS = 300;

/** the snippet with the search words marked */
const Marked: React.FC<{ text: string; words: string[] }> = ({ text, words }) => {
  if (words.length === 0) return <>{text}</>;
  const esc = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).sort((a, b) => b.length - a.length);
  const re = new RegExp(`(${esc.join("|")})`, "gi");
  const parts = text.split(re);
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="rounded-sm bg-solar-400/25 px-0.5 text-solar-100">
            {p}
          </mark>
        ) : (
          <React.Fragment key={i}>{p}</React.Fragment>
        )
      )}
    </>
  );
};

export const KbSearchPage: React.FC = () => {
  const { t, lang } = useI18n();
  const [url, setUrl] = useUrlState();
  const urlQ = url.get("q") ?? "";
  const [text, setText] = useState(urlQ);
  const last = useRef(urlQ);
  useEffect(() => {
    if (urlQ !== last.current) {
      last.current = urlQ;
      setText(urlQ);
    }
  }, [urlQ]);
  useEffect(() => {
    if (text === last.current) return;
    const h = setTimeout(() => {
      last.current = text;
      setUrl({ q: text });
    }, DEBOUNCE_MS);
    return () => clearTimeout(h);
  }, [text, setUrl]);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);

  const q = searchWords(urlQ);
  const docs = useLoad<KbSearchResult>(q ? `s:${q}` : null, () => api.searchKb(q, 30));
  const arts = useLoad<KbArticleList>(q ? `a:${q}` : null, () => api.listKbArticles({ q, limit: 10 }));
  const words = docs.data?.words ?? q.toLowerCase().split(" ").filter(Boolean);

  const res = docs.data;
  const nothing = !!res && res.total === 0 && res.faults.length === 0 && (arts.data?.total ?? 0) === 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Link to="/kb" className="hover:text-slate-200">
            {t("Knowledge Base")}
          </Link>
          <span aria-hidden>/</span>
          <span>{t("Search")}</span>
        </div>
        <h1 className="text-lg font-semibold">{t("Search manuals, SOPs and documents")}</h1>
      </div>
      <form
        className="relative"
        onSubmit={(e) => {
          e.preventDefault();
          last.current = text;
          setUrl({ q: text });
        }}
      >
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-slate-500" aria-hidden />
        <Input
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={t("Fault code, equipment model, or any words, e.g. growatt 203, isolation, ไฟตก")}
          className="h-10 pr-9 pl-8"
          aria-label={t("Search")}
        />
        {text && (
          <Button type="button" variant="ghost" size="icon-sm" className="absolute top-1/2 right-1 -translate-y-1/2" aria-label={t("Clear")} onClick={() => setText("")}>
            <X />
          </Button>
        )}
      </form>

      {!q ? (
        <Empty className="py-12">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FileSearch />
            </EmptyMedia>
            <EmptyTitle>{t("Search the whole library")}</EmptyTitle>
            <EmptyDescription>{t("Titles, numbers, tags and the text of every page, scans included once OCR has read them.")}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : docs.error && !res ? (
        <Alert variant="destructive">
          <AlertTitle>{t("Search failed")}</AlertTitle>
          <AlertDescription>{docs.error.text}</AlertDescription>
        </Alert>
      ) : !res ? (
        <SkeletonRows rows={6} />
      ) : nothing ? (
        <Empty className="py-12">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FileSearch />
            </EmptyMedia>
            <EmptyTitle>{t("No matches")}</EmptyTitle>
            <EmptyDescription>{t("Try the fault code or the equipment model. Every word must appear in a document's details or on one of its pages.")}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Suspended busy={docs.refreshing || arts.refreshing} label={t("Searching…")}>
          <div className="flex flex-col gap-4">
            {res.faults.length > 0 && (
              <Card className="gap-2 border-amber-400/20 py-4">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-sm">
                    <TriangleAlert className="size-4 text-amber-300" aria-hidden />
                    {t("Fault codes")}
                  </CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  {res.faults.map((f) => (
                    <div key={f.key} className="flex flex-col gap-1">
                      <p className="num text-xs font-semibold text-amber-200">{faultLabel(f.key)}</p>
                      <ul className="flex flex-col gap-1">
                        {f.links.map((l, i) => (
                          <li key={i} className="flex flex-wrap items-center gap-2 text-xs">
                            <Link to={viewPath(l.doc.id, { page: l.page })} className="font-medium text-slate-100 hover:text-solar-200">
                              <span className="num text-solar-200">{l.doc.number}</span> {docTitle(l.doc, lang)}
                              {l.page != null && <span className="num text-solar-200"> · {t("p.{n}", { n: l.page })}</span>}
                            </Link>
                            {l.doc.status !== "released" && <DocStatusBadge status={l.doc.status} />}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}

            {res.documents.length > 0 && (
              <Card className="gap-0 py-0">
                <CardHeader className="border-b py-3">
                  <CardTitle className="text-sm">{t("Documents · {n}", { n: res.total })}</CardTitle>
                </CardHeader>
                <ul className="divide-y divide-white/[0.06]">
                  {res.documents.map((d) => {
                    const type = docTypeOf(d.doc_type);
                    return (
                      <li key={d.id} className="flex flex-col gap-1.5 px-4 py-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <type.icon className="size-4 text-slate-500" aria-hidden />
                          <Link to={docPath(d.id)} className="text-sm font-semibold text-slate-100 hover:text-solar-200">
                            <span className="num text-solar-200">{d.number}</span> <Marked text={docTitle(d, lang)} words={words} />
                          </Link>
                          {d.status !== "released" && <DocStatusBadge status={d.status} />}
                          <span className="text-[11px] text-muted-foreground">
                            {t(type.label)} · {revText(d.revision)}
                          </span>
                        </div>
                        {d.pages.length > 0 ? (
                          <ul className="flex flex-col gap-1">
                            {d.pages.map((p) => (
                              <li key={p.page_no}>
                                <Link
                                  to={viewPath(d.id, { page: p.page_no, q })}
                                  className="group flex gap-2 rounded-md px-2 py-1 text-xs hover:bg-white/[0.04]"
                                >
                                  <span className="num shrink-0 font-semibold text-solar-200 group-hover:underline">{t("p.{n}", { n: p.page_no })}</span>
                                  <span className="line-clamp-2 text-slate-400">
                                    <Marked text={p.snippet} words={words} />
                                  </span>
                                </Link>
                              </li>
                            ))}
                            {d.page_hits > d.pages.length && (
                              <li className="px-2 text-[11px] text-muted-foreground">
                                <Link to={viewPath(d.id, { q })} className="hover:text-slate-200">
                                  {t("{n} more pages · open and find", { n: d.page_hits - d.pages.length })}
                                </Link>
                              </li>
                            )}
                          </ul>
                        ) : (
                          <p className="text-[11px] text-muted-foreground">{t("Matches the document's details.")}</p>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </Card>
            )}

            {arts.data && arts.data.items.length > 0 && (
              <Card className="gap-0 py-0">
                <CardHeader className="border-b py-3">
                  <CardTitle className="flex items-center gap-2 text-sm">
                    <BookOpen className="size-4 text-slate-500" aria-hidden />
                    {t("Articles · {n}", { n: arts.data.total })}
                  </CardTitle>
                </CardHeader>
                <ul className="divide-y divide-white/[0.06]">
                  {arts.data.items.map((a) => {
                    const c = categoryOf(a.category);
                    return (
                      <li key={a.id} className="flex flex-col gap-1 px-4 py-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <Link to={articlePath(a.slug)} className="text-sm font-semibold text-slate-100 hover:text-solar-200">
                            <Marked text={a.title} words={words} />
                          </Link>
                          <Badge variant="neutral">
                            <c.icon data-icon="inline-start" aria-hidden />
                            {t(c.label)}
                          </Badge>
                        </div>
                        {a.excerpt && (
                          <p className="line-clamp-2 text-xs text-muted-foreground">
                            <Marked text={a.excerpt} words={words} />
                          </p>
                        )}
                      </li>
                    );
                  })}
                </ul>
                {arts.data.total > arts.data.items.length && (
                  <CardContent className="border-t py-2 text-xs">
                    <Link to={`/kb?tab=articles&q=${encodeURIComponent(urlQ)}`} className="text-solar-200 hover:underline">
                      {t("All {n} articles", { n: arts.data.total })}
                    </Link>
                  </CardContent>
                )}
              </Card>
            )}
          </div>
        </Suspended>
      )}
    </div>
  );
};

export default KbSearchPage;
