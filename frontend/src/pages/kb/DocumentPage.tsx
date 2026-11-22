/**
 * Knowledge Base document page (`/kb/doc/:docId`, spec §3): what the document is, its first page,
 * its revisions (each with the file's checksum and whether its text is searchable), its links
 * (fault codes, equipment, plants; a page link opens the viewer there) and the actions:
 * open / download, pin, and for whoever may edit: details, links, a new revision; admins also
 * release, withdraw, supersede and delete. docs/plans/kb-documents.md.
 */
import React, { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  BookOpen,
  CheckCircle2,
  Copy,
  Download,
  Eye,
  FileText,
  FileUp,
  Link2,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  RefreshCw,
  Trash2,
  XCircle,
} from "lucide-react";
import { api } from "../../api/client";
import type { KbDocDetail, KbDocLink } from "../../api/client";
import { useAppContext } from "../../context/AppContext";
import { plantPath } from "../../context/routes";
import { isAdmin } from "../../auth/access";
import { useI18n } from "../../i18n";
import { notify } from "@/lib/notify";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { EmptyState, LoadingState } from "../../components/ui";
import {
  DocStatusBadge,
  TEXT_STATUS,
  disciplineLabel,
  docSubtitle,
  docTitle,
  docTypeOf,
  faultLabel,
  fileHref,
  fmtBytes,
  languageLabel,
  revText,
  viewPath,
} from "./docFormat";
import { errText, fmtDateTime, timeAgo } from "./format";
import { DetailsDialog, LinksDialog, RevisionDialog, SupersedeDialog, WithdrawDialog } from "./DocDialogs";
import { invalidateKbContext, useLoad } from "./useDocs";
import { openPdf } from "./pdf";

/** the first page of the current revision, drawn once (pdf.js) */
const CoverPreview: React.FC<{ docId: number; revNo: number }> = ({ docId, revNo }) => {
  const ref = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<"busy" | "done" | "error">("busy");
  useEffect(() => {
    let cancelled = false;
    let task: ReturnType<typeof openPdf> | null = null;
    setState("busy");
    api
      .getKbDocFile(docId, { rev: revNo })
      .then(async (link) => {
        task = openPdf(fileHref(link));
        const pdf = await task.promise;
        const page = await pdf.getPage(1);
        if (cancelled || !ref.current) return;
        const w = 320 * Math.min(window.devicePixelRatio || 1, 2);
        const vp = page.getViewport({ scale: w / page.getViewport({ scale: 1 }).width });
        ref.current.width = Math.floor(vp.width);
        ref.current.height = Math.floor(vp.height);
        await page.render({ canvas: ref.current, viewport: vp }).promise;
        if (!cancelled) setState("done");
      })
      .catch(() => !cancelled && setState("error"));
    return () => {
      cancelled = true;
      void task?.destroy();
    };
  }, [docId, revNo]);
  return (
    <div className="relative mx-auto w-full max-w-[320px]">
      <canvas ref={ref} className="block w-full bg-white shadow-lg shadow-black/40 ring-1 ring-black/30" aria-hidden />
      {state !== "done" && (
        <div className="absolute inset-0 grid min-h-48 place-items-center bg-white/[0.03] text-slate-500">
          {state === "busy" ? <Spinner className="size-5" /> : <FileText className="size-6" aria-hidden />}
        </div>
      )}
    </div>
  );
};

const LinkItem: React.FC<{ docId: number; link: KbDocLink }> = ({ docId, link }) => {
  const { t } = useI18n();
  const name =
    link.target_type === "fault_code"
      ? faultLabel(link.target_id)
      : link.target_type === "plant"
        ? link.label ?? t("Plant {id}", { id: link.target_id })
        : link.label ?? link.target_id;
  return (
    <li className="flex items-center justify-between gap-2 py-1.5 text-xs">
      {link.target_type === "plant" ? (
        <Link to={plantPath(Number(link.target_id), "documents")} className="min-w-0 truncate text-slate-200 hover:text-solar-200">
          {name}
        </Link>
      ) : (
        <span className="min-w-0 truncate text-slate-200">{name}</span>
      )}
      {link.page != null ? (
        <Link to={viewPath(docId, { page: link.page })} className="num shrink-0 text-solar-200 hover:underline">
          {t("p.{n}", { n: link.page })}
        </Link>
      ) : (
        <span className="text-[11px] text-muted-foreground">{t("whole document")}</span>
      )}
    </li>
  );
};

export const KbDocumentPage: React.FC = () => {
  const { t, lang } = useI18n();
  const navigate = useNavigate();
  const { user } = useAppContext();
  const admin = isAdmin(user);
  const { docId } = useParams();
  const id = docId && /^\d+$/.test(docId) ? Number(docId) : null;
  const doc = useLoad<KbDocDetail>(id != null ? `doc:${id}` : null, () => api.getKbDoc(id!), { keepOnKeyChange: false });
  const [dialog, setDialog] = useState<null | "details" | "links" | "revision" | "withdraw" | "supersede">(null);
  const [busy, setBusy] = useState<string | null>(null);

  if (id == null) return <EmptyState icon={FileText} title={t("Document not found")} />;
  if (doc.error?.status === 404) {
    return (
      <EmptyState
        icon={FileText}
        title={t("Document not found")}
        description={t("It does not exist, it was withdrawn, or it belongs to plants not assigned to you.")}
      />
    );
  }
  if (!doc.data) {
    return doc.error ? (
      <Alert variant="destructive">
        <AlertTitle>{t("Could not load the document")}</AlertTitle>
        <AlertDescription>{doc.error.text}</AlertDescription>
      </Alert>
    ) : (
      <LoadingState label={t("Loading the document…")} shape="page" />
    );
  }
  const d = doc.data;
  const cur = d.current_revision;
  const type = docTypeOf(d.doc_type);
  const sub = docSubtitle(d, lang);
  const done = (x: KbDocDetail) => {
    doc.setData(x);
    setDialog(null);
  };

  const run = async (key: string, fn: () => Promise<KbDocDetail | void>, ok?: string) => {
    setBusy(key);
    try {
      const x = await fn();
      if (x) doc.setData(x);
      if (ok) notify("ok", ok);
    } catch (e) {
      notify("crit", errText(e));
    } finally {
      setBusy(null);
    }
  };
  const download = (rev?: number) =>
    run("download", async () => {
      const link = await api.getKbDocFile(d.id, { rev: rev ?? null, download: true });
      const a = document.createElement("a");
      a.href = fileHref(link);
      a.download = link.filename;
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
    });
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${viewPath(d.id)}`);
      notify("ok", t("Link copied"));
    } catch {
      notify("warn", t("Could not copy the link"));
    }
  };
  const togglePin = () =>
    run("pin", async () => {
      const r = await api.pinKbDoc(d.id, !d.pinned);
      doc.setData({ ...d, pinned: r.pinned });
    });
  const del = async () => {
    if (!window.confirm(d.released_at ? t("Withdraw {number}? It was released, so it is withdrawn, not deleted.", { number: d.number }) : t("Delete the draft {number} and its files?", { number: d.number }))) return;
    setBusy("delete");
    try {
      const r = await api.deleteKbDoc(d.id);
      invalidateKbContext();
      notify("ok", r.result === "deleted" ? t("{number} deleted", { number: d.number }) : t("{number} withdrawn", { number: d.number }));
      if (r.result === "deleted") navigate("/kb");
      else await doc.reload();
    } catch (e) {
      notify("crit", errText(e));
    } finally {
      setBusy(null);
    }
  };

  const groups: { type: KbDocLink["target_type"]; title: string }[] = [
    { type: "fault_code", title: t("Fault codes") },
    { type: "equipment", title: t("Equipment") },
    { type: "plant", title: t("Plants") },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start gap-3">
        <Button variant="ghost" size="icon-sm" asChild>
          <Link to="/kb" aria-label={t("Back to the library")}>
            <ArrowLeft />
          </Link>
        </Button>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="num text-sm font-semibold text-solar-200">{d.number}</span>
            <DocStatusBadge status={d.status} />
            <Badge variant="neutral">
              <type.icon data-icon="inline-start" aria-hidden />
              {t(type.label)}
            </Badge>
            {!d.general && <Badge variant="info">{t("Plants only")}</Badge>}
          </div>
          <h1 className="text-lg font-semibold text-slate-100">{docTitle(d, lang)}</h1>
          {sub && <p className="text-sm text-muted-foreground">{sub}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" asChild disabled={!cur}>
            <Link to={viewPath(d.id)}>
              <Eye data-icon="inline-start" />
              {t("Open")}
            </Link>
          </Button>
          <Button variant="outline" size="sm" onClick={() => download()} disabled={!cur || busy === "download"}>
            {busy === "download" ? <Spinner data-icon="inline-start" className="size-3" /> : <Download data-icon="inline-start" />}
            {t("Download")}
          </Button>
          <Button variant="ghost" size="sm" onClick={togglePin} disabled={busy === "pin"} aria-pressed={d.pinned}>
            {d.pinned ? <PinOff data-icon="inline-start" /> : <Pin data-icon="inline-start" />}
            {d.pinned ? t("Unpin") : t("Pin")}
          </Button>
          {(d.can_edit || admin) && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label={t("More actions")}>
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {d.can_edit && (
                  <>
                    <DropdownMenuItem onSelect={() => setDialog("details")}>
                      <Pencil />
                      {t("Edit details")}
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => setDialog("links")}>
                      <Link2 />
                      {t("Edit links")}
                    </DropdownMenuItem>
                    {d.status !== "withdrawn" && (
                      <DropdownMenuItem onSelect={() => setDialog("revision")}>
                        <FileUp />
                        {t("Upload a new revision")}
                      </DropdownMenuItem>
                    )}
                  </>
                )}
                <DropdownMenuItem onSelect={copyLink}>
                  <Copy />
                  {t("Copy link")}
                </DropdownMenuItem>
                {admin && (
                  <>
                    <DropdownMenuSeparator />
                    {d.status !== "released" && (
                      <DropdownMenuItem onSelect={() => run("release", () => api.releaseKbDoc(d.id).then((x) => (invalidateKbContext(), x)), t("{number} released", { number: d.number }))}>
                        <CheckCircle2 />
                        {t("Release")}
                      </DropdownMenuItem>
                    )}
                    {(d.status === "released" || d.status === "superseded") && (
                      <DropdownMenuItem onSelect={() => setDialog("supersede")}>
                        <BookOpen />
                        {t("Mark superseded")}
                      </DropdownMenuItem>
                    )}
                    {d.status !== "withdrawn" && (
                      <DropdownMenuItem onSelect={() => setDialog("withdraw")}>
                        <XCircle />
                        {t("Withdraw")}
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem onSelect={del} className="text-red-300">
                      <Trash2 />
                      {d.released_at ? t("Delete (withdraws)") : t("Delete draft")}
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      {d.status === "superseded" && (
        <Alert>
          <AlertTitle>{t("Superseded")}</AlertTitle>
          <AlertDescription>
            {d.superseded_by ? (
              <>
                {t("Replaced by {doc}.", { doc: `${d.superseded_by.number} ${d.superseded_by.title}` })}{" "}
                <Link to={`/kb/doc/${d.superseded_by.id}`} className="text-solar-200 underline">
                  {t("Open current")}
                </Link>
              </>
            ) : (
              t("This document is no longer current.")
            )}
            {d.status_note && <span className="block text-muted-foreground">{d.status_note}</span>}
          </AlertDescription>
        </Alert>
      )}
      {d.status === "withdrawn" && (
        <Alert variant="destructive">
          <AlertTitle>{t("Withdrawn")}</AlertTitle>
          <AlertDescription>{d.status_note ?? t("Not to be used.")}</AlertDescription>
        </Alert>
      )}
      {d.status === "draft" && (
        <Alert>
          <AlertTitle>{t("Draft")}</AlertTitle>
          <AlertDescription>
            {admin ? t("Only you and its uploader see it until you release it.") : t("Only you and admins see it until an admin releases it.")}
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 lg:grid-cols-[340px_1fr]">
        <Card className="py-4">
          <CardContent className="flex flex-col gap-3">
            {cur ? (
              <Link to={viewPath(d.id)} aria-label={t("Open {number}", { number: d.number })}>
                <CoverPreview docId={d.id} revNo={cur.rev_no} />
              </Link>
            ) : (
              <p className="text-xs text-muted-foreground">{t("No file.")}</p>
            )}
            {cur && (
              <div className="flex flex-wrap items-center justify-center gap-2 text-[11px] text-muted-foreground">
                <span>{t("{n} pages", { n: cur.page_count })}</span>
                <span>·</span>
                <span>{fmtBytes(cur.bytes)}</span>
                <span>·</span>
                <Badge variant={TEXT_STATUS[cur.text_status].variant} title={t(TEXT_STATUS[cur.text_status].hint)}>
                  {t(TEXT_STATUS[cur.text_status].label)}
                </Badge>
              </div>
            )}
          </CardContent>
        </Card>

        <div className="flex flex-col gap-4">
          <Card className="gap-3 py-4">
            <CardHeader>
              <CardTitle className="text-sm">{t("Details")}</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-xs sm:grid-cols-[auto_1fr_auto_1fr]">
                <dt className="text-muted-foreground">{t("Revision")}</dt>
                <dd className="text-slate-200">{revText(cur)}</dd>
                <dt className="text-muted-foreground">{t("Discipline")}</dt>
                <dd className="text-slate-200">
                  {d.discipline} · {t(disciplineLabel(d.discipline))}
                </dd>
                <dt className="text-muted-foreground">{t("Language")}</dt>
                <dd className="text-slate-200">{t(languageLabel(d.language))}</dd>
                <dt className="text-muted-foreground">{t("Owner")}</dt>
                <dd className="text-slate-200">{d.owner ?? "—"}</dd>
                <dt className="text-muted-foreground">{t("Released")}</dt>
                <dd className="text-slate-200" title={fmtDateTime(d.released_at)}>
                  {d.released_at ? `${timeAgo(d.released_at)} · ${d.released_by ?? "—"}` : "—"}
                </dd>
                <dt className="text-muted-foreground">{t("Updated")}</dt>
                <dd className="text-slate-200" title={fmtDateTime(d.updated_at)}>
                  {timeAgo(d.updated_at)} · {d.updated_by ?? "—"}
                </dd>
                <dt className="text-muted-foreground">{t("Visible to")}</dt>
                <dd className="text-slate-200">{d.general ? t("Everyone") : t("Users of the linked plants")}</dd>
                <dt className="text-muted-foreground">{t("Tags")}</dt>
                <dd className="flex flex-wrap gap-1">
                  {d.tags.length === 0
                    ? "—"
                    : d.tags.map((x) => (
                        <Link key={x} to={`/kb?tag=${encodeURIComponent(x)}`} className="rounded-full border border-white/10 bg-white/5 px-1.5 py-px text-[10px] text-slate-300 hover:text-solar-200">
                          #{x}
                        </Link>
                      ))}
                </dd>
              </dl>
            </CardContent>
          </Card>

          <Card className="gap-3 py-4">
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="text-sm">{t("Links")}</CardTitle>
              {d.can_edit && (
                <Button variant="ghost" size="xs" onClick={() => setDialog("links")}>
                  <Pencil data-icon="inline-start" />
                  {t("Edit")}
                </Button>
              )}
            </CardHeader>
            <CardContent>
              {d.links.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  {t("No links yet.")} {d.can_edit && t("Link fault codes with their page so alarms open the right page.")}
                </p>
              ) : (
                <div className="grid gap-4 sm:grid-cols-3">
                  {groups.map((g) => {
                    const list = d.links.filter((l) => l.target_type === g.type);
                    return (
                      <div key={g.type} className="min-w-0">
                        <p className="eyebrow mb-1">{g.title}</p>
                        {list.length === 0 ? (
                          <p className="text-xs text-muted-foreground">—</p>
                        ) : (
                          <ul className="divide-y divide-white/[0.05]">
                            {list.map((l, i) => (
                              <LinkItem key={i} docId={d.id} link={l} />
                            ))}
                          </ul>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="gap-3 py-4">
            <CardHeader>
              <CardTitle className="text-sm">{t("Revisions")}</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="divide-y divide-white/[0.06]">
                {d.revisions.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-xs">
                    <span className="font-semibold text-slate-100">{revText(r)}</span>
                    {r.is_current && <Badge variant="ok">{t("Current")}</Badge>}
                    <Badge variant={TEXT_STATUS[r.text_status].variant} title={t(TEXT_STATUS[r.text_status].hint)}>
                      {t(TEXT_STATUS[r.text_status].label)}
                      {r.ocr_pending_pages > 0 && ` · ${r.ocr_pending_pages}`}
                    </Badge>
                    <span className="text-muted-foreground" title={fmtDateTime(r.created_at)}>
                      {timeAgo(r.created_at)} · {r.uploaded_by ?? "—"}
                    </span>
                    <span className="text-muted-foreground">
                      {t("{n} pages", { n: r.page_count })} · {fmtBytes(r.bytes)}
                    </span>
                    <span className="num text-[10px] text-slate-500" title={`SHA-256 ${r.sha256}`}>
                      {r.sha256.slice(0, 12)}
                    </span>
                    <span className="ml-auto flex items-center gap-1">
                      {admin && (r.text_status === "partial" || r.text_status === "no_text" || r.text_status === "ocr_pending") && (
                        <Button
                          variant="ghost"
                          size="xs"
                          disabled={busy === `ocr${r.rev_no}`}
                          onClick={() =>
                            run(`ocr${r.rev_no}`, async () => {
                              const x = await api.ocrKbDocAgain(d.id, r.rev_no);
                              notify("ok", t("{n} pages queued for OCR", { n: x.pages }));
                              return api.getKbDoc(d.id);
                            })
                          }
                          title={t("Send the pages without text to OCR again (after tesseract or a language was installed)")}
                        >
                          {busy === `ocr${r.rev_no}` ? <Spinner data-icon="inline-start" className="size-3" /> : <RefreshCw data-icon="inline-start" />}
                          {t("OCR again")}
                        </Button>
                      )}
                      <Button variant="ghost" size="xs" asChild>
                        <Link to={viewPath(d.id, { rev: r.is_current ? null : r.rev_no })}>{t("Open")}</Link>
                      </Button>
                      <Button variant="ghost" size="icon-sm" onClick={() => download(r.rev_no)} aria-label={t("Download {rev}", { rev: revText(r) })}>
                        <Download />
                      </Button>
                    </span>
                    {r.change_note && <p className="basis-full text-muted-foreground">{r.change_note}</p>}
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </div>
      </div>

      {d.can_edit && (
        <>
          <DetailsDialog doc={d} admin={admin} open={dialog === "details"} onOpenChange={(v) => setDialog(v ? "details" : null)} onDone={done} />
          <LinksDialog doc={d} open={dialog === "links"} onOpenChange={(v) => setDialog(v ? "links" : null)} onDone={done} />
          <RevisionDialog doc={d} open={dialog === "revision"} onOpenChange={(v) => setDialog(v ? "revision" : null)} onDone={done} />
        </>
      )}
      {admin && (
        <>
          <WithdrawDialog doc={d} open={dialog === "withdraw"} onOpenChange={(v) => setDialog(v ? "withdraw" : null)} onDone={done} />
          <SupersedeDialog doc={d} open={dialog === "supersede"} onOpenChange={(v) => setDialog(v ? "supersede" : null)} onDone={done} />
        </>
      )}
    </div>
  );
};

export default KbDocumentPage;
