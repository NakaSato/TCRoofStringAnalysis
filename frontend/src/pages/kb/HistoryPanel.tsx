/** An article's edit history: the revision list (newest first) and a dialog per revision with its
 * text, a diff against the current text, and "Restore this version" for users who may edit. */
import React, { useEffect, useState } from "react";
import { History } from "lucide-react";
import { api } from "../../api/client";
import type { KbArticle, KbRevision, KbRevisionItem } from "../../api/client";
import { notify } from "@/lib/notify";
import { cn } from "@/lib/utils";
import { SkeletonRows } from "../../components/ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useI18n } from "../../i18n";
import { ArticleBody } from "./ArticleBody";
import { DiffView } from "./DiffView";
import { categoryOf, errText, fmtDateTime, kbConflict, timeAgo } from "./format";

const RevisionDialog: React.FC<{
  article: KbArticle;
  revNo: number | null;
  onClose: () => void;
  onRestored: (a: KbArticle) => void;
}> = ({ article, revNo, onClose, onRestored }) => {
  const { t } = useI18n();
  const [rev, setRev] = useState<KbRevision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"text" | "diff">("diff");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setRev(null);
    setError(null);
    setView("diff");
    if (revNo == null) return;
    let live = true;
    api
      .getKbRevision(article.id, revNo)
      .then((r) => live && setRev(r))
      .catch((e) => live && setError(errText(e)));
    return () => {
      live = false;
    };
  }, [article.id, revNo]);

  const isCurrent = revNo === article.version;
  const restore = async () => {
    if (revNo == null) return;
    setBusy(true);
    try {
      const a = await api.restoreKbRevision(article.id, revNo, article.version);
      notify("ok", t("Revision {n} restored as version {v}", { n: revNo, v: a.version }));
      onRestored(a);
      onClose();
    } catch (e) {
      const c = kbConflict(e);
      if (c) {
        notify("warn", t("Someone saved a newer version. The article was reloaded; check it before restoring."));
        onRestored(c.current);
        onClose();
      } else notify("crit", errText(e));
    } finally {
      setBusy(false);
    }
  };

  const metaChanges =
    rev &&
    [
      rev.title !== article.title && t("Title then: {v}", { v: rev.title }),
      rev.category !== article.category && t("Category then: {v}", { v: t(categoryOf(rev.category).label) }),
      rev.tags.join("\u0000") !== article.tags.join("\u0000") && t("Tags then: {v}", { v: rev.tags.length ? rev.tags.map((x) => `#${x}`).join(" ") : "—" }),
    ].filter((x): x is string => typeof x === "string");

  return (
    <Dialog open={revNo != null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[90vh] flex-col sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {t("Revision {n}", { n: revNo ?? "" })}
            {isCurrent && (
              <Badge variant="ok" className="ml-2 align-middle">
                {t("Current version")}
              </Badge>
            )}
          </DialogTitle>
          <DialogDescription>
            {rev ? `${rev.author ?? "—"} · ${fmtDateTime(rev.created_at)}${rev.note ? ` · ${rev.note}` : ""}` : " "}
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <p className="callout-crit">{error}</p>
        ) : !rev ? (
          <SkeletonRows rows={6} />
        ) : (
          <div className="flex min-h-0 flex-col gap-3">
            <Tabs value={view} onValueChange={(v) => setView(v as "text" | "diff")}>
              <TabsList variant="line" className="border-0 p-0">
                <TabsTrigger value="diff" className="px-3 py-2 text-sm">
                  {t("Changes vs current")}
                </TabsTrigger>
                <TabsTrigger value="text" className="px-3 py-2 text-sm">
                  {t("This version")}
                </TabsTrigger>
              </TabsList>
            </Tabs>
            {metaChanges && metaChanges.length > 0 && (
              <ul className="callout space-y-0.5">
                {metaChanges.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            )}
            <div className="min-h-0 overflow-y-auto">
              {view === "diff" ? (
                <DiffView a={rev.body_md} b={article.body_md} delLabel={t("Only in revision {n}", { n: rev.rev_no })} addLabel={t("Only in the current version")} />
              ) : (
                <>
                  <h2 className="mb-2 text-base font-semibold text-slate-100">{rev.title}</h2>
                  <ArticleBody markdown={rev.body_md} />
                </>
              )}
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t("Close")}
          </Button>
          {article.can_edit && !isCurrent && (
            <Button onClick={() => void restore()} disabled={!rev || busy}>
              {busy && <Spinner data-icon="inline-start" className="size-3" />}
              {t("Restore this version")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export const HistoryPanel: React.FC<{ article: KbArticle; onRestored: (a: KbArticle) => void }> = ({ article, onRestored }) => {
  const { t } = useI18n();
  const [items, setItems] = useState<KbRevisionItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openRev, setOpenRev] = useState<number | null>(null);

  // re-read whenever the article gets a new version (an edit, a restore)
  useEffect(() => {
    let live = true;
    setError(null);
    api
      .listKbRevisions(article.id)
      .then((r) => live && setItems(r.items))
      .catch((e) => live && setError(errText(e)));
    return () => {
      live = false;
    };
  }, [article.id, article.version]);

  return (
    <Card className="gap-3 py-4">
      <CardHeader className="px-4">
        <CardTitle className="flex items-center gap-2 text-sm">
          <History className="size-4 text-slate-500" aria-hidden />
          {t("History")}
          {items && <span className="num text-xs font-normal text-muted-foreground">{items.length}</span>}
        </CardTitle>
      </CardHeader>
      <CardContent className="px-2">
        {error ? (
          <p className="callout-crit mx-2">{error}</p>
        ) : !items ? (
          <SkeletonRows rows={3} className="px-2" />
        ) : items.length === 0 ? (
          <p className="px-2 text-xs text-muted-foreground">{t("No revisions")}</p>
        ) : (
          <ol className="flex max-h-96 flex-col overflow-y-auto">
            {items.map((r) => (
              <li key={r.rev_no}>
                <button
                  type="button"
                  onClick={() => setOpenRev(r.rev_no)}
                  className={cn("flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-white/[0.04]")}
                >
                  <span className="flex items-center gap-2 text-xs">
                    <span className="num text-slate-400">#{r.rev_no}</span>
                    <span className="truncate text-slate-200">{r.author ?? "—"}</span>
                    <span className="ml-auto shrink-0 text-[11px] text-muted-foreground" title={fmtDateTime(r.created_at)}>
                      {timeAgo(r.created_at)}
                    </span>
                  </span>
                  {r.note && <span className="line-clamp-2 pl-6 text-[11px] text-muted-foreground">{r.note}</span>}
                </button>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
      <RevisionDialog article={article} revNo={openRev} onClose={() => setOpenRev(null)} onRestored={onRestored} />
    </Card>
  );
};
