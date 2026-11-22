/**
 * One plant's Documents tab (`/plant/:id/documents`, spec §8.2): its Google Drive links (as-built
 * PDF, site photos; Settings → Plant documents), the Knowledge Base documents linked to the plant
 * (as-built drawings, inspection reports, …), the manuals for its inverter models, and the general
 * procedures (SOPs, work instructions, method statements, checklists). DB only, read on open.
 * docs/plans/kb-documents.md.
 */
import React, { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ExternalLink, FileText, FileUp, FolderOpen, Images } from "lucide-react";
import { api } from "../api/client";
import type { KbDocSummary, KbPlantDocuments } from "../api/client";
import { useAppContext } from "../context/AppContext";
import { useI18n } from "../i18n";
import { safeHref } from "../lib/safeUrl";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { LoadingState } from "../components/ui";
import { DocStatusBadge, docPath, docTitle, docTypeOf, revText, viewPath } from "./kb/docFormat";
import { UploadDocDialog } from "./kb/DocDialogs";
import { useLoad } from "./kb/useDocs";

type Item = KbDocSummary & { pages: number[] };

const DocRow: React.FC<{ d: Item }> = ({ d }) => {
  const { t, lang } = useI18n();
  const type = docTypeOf(d.doc_type);
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-xs">
      <type.icon className="size-4 shrink-0 text-slate-500" aria-hidden />
      <Link to={docPath(d.id)} className="min-w-0 flex-1 text-slate-100 hover:text-solar-200">
        <span className="num font-semibold text-solar-200">{d.number}</span> {docTitle(d, lang)}
      </Link>
      {d.status !== "released" && <DocStatusBadge status={d.status} />}
      <span className="text-muted-foreground">{revText(d.revision)}</span>
      {d.pages.map((p) => (
        <Link key={p} to={viewPath(d.id, { page: p })} className="num text-solar-200 hover:underline">
          {t("p.{n}", { n: p })}
        </Link>
      ))}
      <Button variant="ghost" size="xs" asChild>
        <Link to={viewPath(d.id)}>{t("Open")}</Link>
      </Button>
    </li>
  );
};

const Section: React.FC<{ title: string; hint?: string; docs: Item[]; empty: string; action?: React.ReactNode }> = ({ title, hint, docs, empty, action }) => (
  <Card className="gap-2 py-4">
    <CardHeader className="flex flex-row items-start justify-between gap-2">
      <div className="flex flex-col gap-0.5">
        <CardTitle className="text-sm">{title}</CardTitle>
        {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
      </div>
      {action}
    </CardHeader>
    <CardContent>
      {docs.length === 0 ? <p className="text-xs text-muted-foreground">{empty}</p> : <ul className="divide-y divide-white/[0.06]">{docs.map((d) => <DocRow key={d.id} d={d} />)}</ul>}
    </CardContent>
  </Card>
);

export const PlantDocumentsPage: React.FC = () => {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { selectedGrowattPlantId: plantId, user } = useAppContext();
  const canWrite = user?.role === "admin" || user?.role === "engineer";
  const [reload, setReload] = useState(0);
  const [upload, setUpload] = useState(false);
  const data = useLoad<KbPlantDocuments>(plantId != null ? `pd:${plantId}:${reload}` : null, () => api.getPlantKbDocuments(plantId!), { keepOnKeyChange: false });

  if (plantId == null) return null;
  if (data.error && !data.data) {
    return (
      <Alert variant="destructive">
        <AlertTitle>{t("Could not load the documents")}</AlertTitle>
        <AlertDescription>{data.error.text}</AlertDescription>
      </Alert>
    );
  }
  const d = data.data;
  if (!d) return <LoadingState label={t("Loading the documents…")} shape="lines" />;
  const asbuilt = d.drive.asbuilt ? safeHref(d.drive.asbuilt.url) : null;
  const photos = d.drive.site_photos ? safeHref(d.drive.site_photos.url) : null;
  const nothing = d.linked.length === 0 && d.equipment.every((e) => e.documents.length === 0) && d.procedures.length === 0 && !asbuilt && !photos;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          {asbuilt && (
            <Button variant="outline" size="sm" asChild>
              <a href={asbuilt} target="_blank" rel="noopener noreferrer">
                <FileText data-icon="inline-start" />
                {d.drive.asbuilt?.revision ? t("As-built {rev}", { rev: d.drive.asbuilt.revision }) : t("As-built")}
                <ExternalLink data-icon="inline-end" />
              </a>
            </Button>
          )}
          {photos && (
            <Button variant="outline" size="sm" asChild>
              <a href={photos} target="_blank" rel="noopener noreferrer">
                <Images data-icon="inline-start" />
                {t("Site photos")}
                <ExternalLink data-icon="inline-end" />
              </a>
            </Button>
          )}
          {(asbuilt || photos) && <span className="text-[11px] text-muted-foreground">{t("Google Drive links")}</span>}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" asChild>
            <Link to={`/kb?plant=${plantId}`}>
              <FolderOpen data-icon="inline-start" />
              {t("In the library")}
            </Link>
          </Button>
          {canWrite && (
            <Button size="sm" onClick={() => setUpload(true)}>
              <FileUp data-icon="inline-start" />
              {t("Upload for this plant")}
            </Button>
          )}
        </div>
      </div>

      {nothing ? (
        <Empty className="py-12">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FolderOpen />
            </EmptyMedia>
            <EmptyTitle>{t("No documents for this plant yet")}</EmptyTitle>
            <EmptyDescription>{t("Upload its as-built drawings or reports, or link manuals to its inverter models in the Knowledge Base.")}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <Section
            title={t("This plant's documents")}
            hint={t("Drawings, reports and other documents linked to this plant.")}
            docs={d.linked}
            empty={t("None linked to this plant yet.")}
          />
          <Card className="gap-2 py-4">
            <CardHeader>
              <CardTitle className="text-sm">{t("Manuals for its equipment")}</CardTitle>
              <p className="text-[11px] text-muted-foreground">{t("By the inverter models installed here.")}</p>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {d.equipment.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t("No inverter model known for this plant yet.")}</p>
              ) : (
                d.equipment.map((e) => (
                  <div key={e.model_key} className="flex flex-col gap-1">
                    <div className="flex items-center gap-2 text-xs">
                      <span className="font-semibold text-slate-200">{e.model}</span>
                      <Badge variant="neutral">{t("{n} inverters", { n: e.inverters })}</Badge>
                    </div>
                    {e.documents.length === 0 ? (
                      <p className="text-[11px] text-muted-foreground">
                        {t("No manual linked to this model yet.")}{" "}
                        <Link to={`/kb/search?q=${encodeURIComponent(e.model)}`} className="text-solar-200 hover:underline">
                          {t("Search the library")}
                        </Link>
                      </p>
                    ) : (
                      <ul className="divide-y divide-white/[0.06]">
                        {e.documents.map((x) => (
                          <DocRow key={x.id} d={x} />
                        ))}
                      </ul>
                    )}
                  </div>
                ))
              )}
            </CardContent>
          </Card>
          <Section title={t("Procedures")} hint={t("General SOPs, work instructions, method statements and checklists.")} docs={d.procedures} empty={t("No released procedure yet.")} />
        </>
      )}
      {canWrite && (
        <UploadDocDialog
          open={upload}
          onOpenChange={setUpload}
          user={user}
          initialPlantIds={[plantId]}
          initialType="drawing"
          onDone={(x) => {
            setUpload(false);
            setReload((k) => k + 1);
            navigate(docPath(x.id));
          }}
        />
      )}
    </div>
  );
};

export default PlantDocumentsPage;
