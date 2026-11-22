/**
 * One Knowledge Base article (`/kb/:slug`): the rendered Markdown body, a side panel with its
 * details and edit history, and the actions: Edit (`can_edit`), Publish / Archive (`can_publish`,
 * admins), Delete (admins; a never-published draft is deleted, anything else archived), Copy link.
 */
import React, { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Archive, BookOpen, Link2, MoreHorizontal, Pencil, Send, Trash2 } from "lucide-react";
import { api } from "../../api/client";
import type { KbArticle } from "../../api/client";
import { useAppContext } from "../../context/AppContext";
import { isAdmin } from "../../auth/access";
import { notify } from "@/lib/notify";
import { LoadingState } from "../../components/ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { useI18n } from "../../i18n";
import { ArticleBody } from "./ArticleBody";
import { HistoryPanel } from "./HistoryPanel";
import { STATUS, articlePath, categoryOf, errText, fmtDateTime, timeAgo, updatedText } from "./format";
import { useArticle } from "./useKb";

type Confirm = { title: string; text: string; label: string; destructive?: boolean; run: () => Promise<void> };

const ConfirmDialog: React.FC<{ confirm: Confirm | null; onClose: () => void }> = ({ confirm, onClose }) => {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const go = async () => {
    if (!confirm) return;
    setBusy(true);
    try {
      await confirm.run();
      onClose();
    } catch (e) {
      notify("crit", errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={confirm != null} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{confirm?.title}</DialogTitle>
          <DialogDescription>{confirm?.text}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t("Cancel")}
          </Button>
          <Button variant={confirm?.destructive ? "destructive" : "default"} onClick={() => void go()} disabled={busy}>
            {busy && <Spinner data-icon="inline-start" className="size-3" />}
            {confirm?.label}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

const Meta: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="flex flex-col gap-0.5">
    <dt className="eyebrow">{label}</dt>
    <dd className="text-xs text-slate-300">{children}</dd>
  </div>
);

const MetaPanel: React.FC<{ a: KbArticle }> = ({ a }) => {
  const { t } = useI18n();
  const c = categoryOf(a.category);
  const when = (iso: string | null, by: string | null) =>
    iso ? (
      <span title={fmtDateTime(iso)}>
        {timeAgo(iso)} · {by ?? "—"}
      </span>
    ) : (
      "—"
    );
  return (
    <Card className="gap-3 py-4">
      <CardHeader className="px-4">
        <CardTitle className="text-sm">{t("Details")}</CardTitle>
      </CardHeader>
      <CardContent className="px-4">
        <dl className="grid grid-cols-2 gap-3 lg:grid-cols-1">
          <Meta label={t("Category")}>
            <span className="inline-flex items-center gap-1">
              <c.icon className="size-3.5 text-slate-500" aria-hidden />
              {t(c.label)}
            </span>
          </Meta>
          <Meta label={t("Status")}>
            <Badge variant={STATUS[a.status].variant}>{t(STATUS[a.status].label)}</Badge>
          </Meta>
          <Meta label={t("Tags")}>
            {a.tags.length ? (
              <span className="flex flex-wrap gap-1">
                {a.tags.map((x) => (
                  <Link key={x} to={`/kb?tag=${encodeURIComponent(x)}`} className="rounded-full border border-white/10 bg-white/5 px-1.5 py-px text-[10px] hover:text-solar-200">
                    #{x}
                  </Link>
                ))}
              </span>
            ) : (
              "—"
            )}
          </Meta>
          <Meta label={t("Version")}>
            <span className="num">{a.version}</span>
          </Meta>
          <Meta label={t("Created")}>{when(a.created_at, a.created_by)}</Meta>
          <Meta label={t("Last edited")}>{when(a.updated_at, a.updated_by)}</Meta>
          <Meta label={t("Published")}>{when(a.published_at, a.published_by)}</Meta>
        </dl>
      </CardContent>
    </Card>
  );
};

export const KbArticlePage: React.FC = () => {
  const { slug = "" } = useParams();
  const { user } = useAppContext();
  const admin = isAdmin(user);
  const { t } = useI18n();
  const navigate = useNavigate();
  const { article: a, setArticle, loading, error, reload } = useArticle(slug);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [busy, setBusy] = useState(false);

  if (error && !a) {
    return (
      <Empty className="py-16">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <BookOpen />
          </EmptyMedia>
          <EmptyTitle>{error.status === 404 ? t("Article not found") : t("Could not load the article")}</EmptyTitle>
          <EmptyDescription>
            {error.status === 404 ? t("It does not exist, or it is a draft or archived article you cannot see.") : error.text}
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button asChild variant="outline" size="sm">
            <Link to="/kb">{t("All articles")}</Link>
          </Button>
        </EmptyContent>
      </Empty>
    );
  }
  if (loading && !a) return <LoadingState label={t("Loading article…")} shape="lines" />;
  if (!a) return null;

  const copyLink = async () => {
    const link = `${window.location.origin}${articlePath(a.slug)}`;
    try {
      await navigator.clipboard.writeText(link);
      notify("ok", t("Link copied"));
    } catch {
      notify("warn", link);
    }
  };

  const setStatus = async (to: "publish" | "archive") => {
    setBusy(true);
    try {
      const next = to === "publish" ? await api.publishKbArticle(a.id) : await api.archiveKbArticle(a.id);
      setArticle(next);
      notify("ok", to === "publish" ? t("Published") : t("Archived"));
    } catch (e) {
      notify("crit", errText(e));
    } finally {
      setBusy(false);
    }
  };

  const askDelete = () =>
    setConfirm({
      title: t("Delete “{name}”", { name: a.title }),
      text: a.published_at
        ? t("This article has been published, so it is archived instead of deleted (its history is kept).")
        : t("This draft and its history are deleted for good."),
      label: a.published_at ? t("Archive") : t("Delete"),
      destructive: true,
      run: async () => {
        const r = await api.deleteKbArticle(a.id);
        if (r.result === "deleted") {
          notify("ok", t("Article deleted"));
          navigate("/kb", { replace: true });
        } else {
          notify("ok", t("Article archived"));
          await reload();
        }
      },
    });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button variant="ghost" size="sm" asChild className="-ml-2">
          <Link to="/kb">
            <ArrowLeft data-icon="inline-start" />
            {t("Knowledge Base")}
          </Link>
        </Button>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void copyLink()}>
            <Link2 data-icon="inline-start" />
            {t("Copy link")}
          </Button>
          {a.can_publish && a.status !== "published" && (
            <Button variant="outline" size="sm" onClick={() => void setStatus("publish")} disabled={busy}>
              {busy ? <Spinner data-icon="inline-start" className="size-3" /> : <Send data-icon="inline-start" />}
              {a.status === "archived" ? t("Publish again") : t("Publish")}
            </Button>
          )}
          {a.can_edit && (
            <Button size="sm" asChild>
              <Link to={`${articlePath(a.slug)}/edit`}>
                <Pencil data-icon="inline-start" />
                {t("Edit")}
              </Link>
            </Button>
          )}
          {(admin || (a.can_publish && a.status !== "archived")) && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="icon-sm" variant="ghost" aria-label={t("More actions")} disabled={busy}>
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                {a.can_publish && a.status !== "archived" && (
                  <DropdownMenuItem
                    onSelect={() =>
                      setConfirm({
                        title: t("Archive “{name}”", { name: a.title }),
                        text: t("Engineers will no longer see it. Its history is kept and an admin can publish it again."),
                        label: t("Archive"),
                        run: () => setStatus("archive"),
                      })
                    }
                  >
                    <Archive />
                    {t("Archive")}
                  </DropdownMenuItem>
                )}
                {admin && (
                  <>
                    {a.can_publish && a.status !== "archived" && <DropdownMenuSeparator />}
                    <DropdownMenuItem variant="destructive" onSelect={askDelete}>
                      <Trash2 />
                      {t("Delete")}
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
        <Card className="min-w-0 gap-3 py-5">
          <CardHeader className="gap-2 px-4 sm:px-6">
            <div className="flex flex-wrap items-center gap-2">
              {a.status !== "published" && <Badge variant={STATUS[a.status].variant}>{t(STATUS[a.status].label)}</Badge>}
              <span className="text-[11px] text-muted-foreground" title={fmtDateTime(a.updated_at ?? a.created_at)}>
                {t(categoryOf(a.category).label)} · {updatedText(a)}
              </span>
            </div>
            <h1 className="text-xl font-semibold text-slate-50 sm:text-2xl">{a.title}</h1>
          </CardHeader>
          <CardContent className="px-4 sm:px-6">
            {a.body_md.trim() ? <ArticleBody markdown={a.body_md} /> : <p className="text-sm text-muted-foreground">{t("This article has no text yet.")}</p>}
          </CardContent>
        </Card>
        <aside className="flex min-w-0 flex-col gap-4">
          <MetaPanel a={a} />
          <HistoryPanel article={a} onRestored={setArticle} />
        </aside>
      </div>

      <ConfirmDialog confirm={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
};

export default KbArticlePage;
