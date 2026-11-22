/**
 * One plant's Documents tab (`/plant/:id/documents`, spec §8.2). Top to bottom: the plant's Google
 * Drive files (as-built PDF and site photo folder; Settings → Plant documents) as two tiles, then the
 * Knowledge Base: documents linked to the plant (as-built drawings, inspection reports, …) and the
 * general procedures (SOPs, work instructions, method statements, checklists) beside the manuals for
 * its inverter models. DB only, read on open. docs/plans/kb-documents.md.
 */
import React, { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { BookOpen, ExternalLink, FileText, FileUp, FolderOpen, Images, Settings2 } from "lucide-react";
import { api } from "../api/client";
import type { KbDocSummary, KbPlantDocuments } from "../api/client";
import { useAppContext } from "../context/AppContext";
import { useI18n } from "../i18n";
import { safeHref } from "../lib/safeUrl";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { LoadingState } from "../components/ui";
import { SelectedPlantBanner } from "../components/SelectedPlantBanner";
import { DocStatusBadge, docPath, docTitle, docTypeOf, revText, viewPath } from "./kb/docFormat";
import { UploadDocDialog } from "./kb/DocDialogs";
import { useLoad } from "./kb/useDocs";
import { SiteRegisterCard } from "./siteRegister/SiteRegisterCard";

type Item = KbDocSummary & { pages: number[] };
type DriveLink = KbPlantDocuments["drive"][string];

const DocRow: React.FC<{ d: Item }> = ({ d }) => {
  const { t, lang } = useI18n();
  const type = docTypeOf(d.doc_type);
  return (
    <li className="group flex items-center gap-3 py-2 text-xs">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-white/[0.04] text-slate-400">
        <type.icon className="size-3.5" aria-hidden />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <Link to={docPath(d.id)} className="truncate text-slate-100 hover:text-solar-200">
          {docTitle(d, lang)}
        </Link>
        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
          <span className="num text-solar-200/80">{d.number}</span>
          <span>{revText(d.revision)}</span>
          {d.status !== "released" && <DocStatusBadge status={d.status} />}
          {d.pages.map((p) => (
            <Link key={p} to={viewPath(d.id, { page: p })} className="num text-solar-200 hover:underline">
              {t("p.{n}", { n: p })}
            </Link>
          ))}
        </span>
      </div>
      <Button variant="ghost" size="xs" asChild>
        <Link to={viewPath(d.id)}>{t("Open")}</Link>
      </Button>
    </li>
  );
};

const DocList: React.FC<{ docs: Item[]; empty: React.ReactNode }> = ({ docs, empty }) =>
  docs.length === 0 ? (
    <p className="py-2 text-xs text-muted-foreground">{empty}</p>
  ) : (
    <ul className="divide-y divide-white/[0.06]">
      {docs.map((d) => (
        <DocRow key={d.id} d={d} />
      ))}
    </ul>
  );

const SectionCard: React.FC<{ title: string; count: number; children: React.ReactNode; className?: string }> = ({ title, count, children, className }) => (
  <Card className={cn("gap-1 py-4", className)}>
    <CardHeader className="flex flex-row items-center gap-2">
      <CardTitle className="text-sm">{title}</CardTitle>
      <Badge variant="neutral" className="num">
        {count}
      </Badge>
    </CardHeader>
    <CardContent>{children}</CardContent>
  </Card>
);

/** One Drive file / folder: icon, kind, the file name as on Drive, open button; a dashed tile when none is set. */
const DriveTile: React.FC<{ icon: React.ElementType; label: string; link: DriveLink | undefined; missing: string; admin: boolean }> = ({
  icon: Icon,
  label,
  link,
  missing,
  admin,
}) => {
  const { t } = useI18n();
  const href = link ? safeHref(link.url) : null;
  if (!href) {
    return (
      <div className="flex min-w-0 items-center gap-3 rounded-lg border border-dashed border-white/10 px-4 py-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-white/[0.03] text-slate-600">
          <Icon className="size-5" aria-hidden />
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-xs font-medium text-slate-400">{label}</span>
          <span className="text-[11px] text-muted-foreground">{missing}</span>
        </div>
        {admin && (
          <Button variant="ghost" size="xs" asChild>
            <Link to="/settings?tab=documents">
              <Settings2 data-icon="inline-start" />
              {t("Set link")}
            </Link>
          </Button>
        )}
      </div>
    );
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="group flex min-w-0 items-center gap-3 rounded-lg border border-white/[0.08] bg-white/[0.02] px-4 py-3 outline-none transition-colors hover:border-solar-400/40 hover:bg-solar-400/[0.04] focus-visible:ring-1 focus-visible:ring-solar-400/50"
    >
      <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-solar-400/10 text-solar-300">
        <Icon className="size-5" aria-hidden />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2 text-xs font-medium text-slate-100">
          {label}
          {link?.revision && (
            <Badge variant="info" className="num">
              {link.revision}
            </Badge>
          )}
        </span>
        {link?.title && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="truncate text-[11px] text-muted-foreground">{link.title}</span>
            </TooltipTrigger>
            <TooltipContent>{link.title}</TooltipContent>
          </Tooltip>
        )}
      </div>
      <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground group-hover:text-solar-200">
        <span className="hidden sm:inline">{t("Open in Drive")}</span>
        <ExternalLink className="size-3.5" aria-hidden />
      </span>
    </a>
  );
};

/** The tab body under the plant banner. */
const PlantDocuments: React.FC<{ plantId: number }> = ({ plantId }) => {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { user } = useAppContext();
  const admin = user?.role === "admin";
  const canWrite = admin || user?.role === "engineer";
  const [reload, setReload] = useState(0);
  const [upload, setUpload] = useState(false);
  const data = useLoad<KbPlantDocuments>(`pd:${plantId}:${reload}`, () => api.getPlantKbDocuments(plantId), { keepOnKeyChange: false });

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
  const manuals = d.equipment.reduce((n, e) => n + e.documents.length, 0);

  return (
    <div className="flex flex-col gap-4">
      {/* Google Drive: the site's own files */}
      <Card className="gap-3 py-4">
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <div className="flex flex-col gap-0.5">
            <CardTitle className="text-sm">{t("Site files")}</CardTitle>
            <p className="text-[11px] text-muted-foreground">{t("On the company Google Drive; opening needs Drive access.")}</p>
          </div>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <DriveTile icon={FileText} label={t("As-built drawing")} link={d.drive.asbuilt} missing={t("No as-built PDF on Drive yet")} admin={admin} />
          <DriveTile icon={Images} label={t("Site photos")} link={d.drive.site_photos} missing={t("No photo folder linked yet")} admin={admin} />
        </CardContent>
      </Card>

      {/* O&M site register: station data and the devices on site */}
      <SiteRegisterCard plantId={plantId} />

      {/* Knowledge Base */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-200">
          <BookOpen className="size-4 text-slate-500" aria-hidden />
          {t("Knowledge Base")}
        </h2>
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

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="flex flex-col gap-4 lg:col-span-2">
          <SectionCard title={t("This plant's documents")} count={d.linked.length}>
            <DocList
              docs={d.linked}
              empty={canWrite ? t("None linked to this plant yet. Upload its drawings or reports.") : t("None linked to this plant yet.")}
            />
          </SectionCard>
          <SectionCard title={t("Procedures")} count={d.procedures.length}>
            <DocList docs={d.procedures} empty={t("No released procedure yet.")} />
          </SectionCard>
        </div>
        <SectionCard title={t("Manuals for its equipment")} count={manuals} className="lg:self-start">
          {d.equipment.length === 0 ? (
            <p className="py-2 text-xs text-muted-foreground">{t("No inverter model known for this plant yet.")}</p>
          ) : (
            <div className="flex flex-col gap-3">
              {d.equipment.map((e) => (
                <div key={e.model_key} className="flex flex-col gap-1">
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="truncate font-semibold text-slate-200">{e.model}</span>
                    <Badge variant="neutral">{t("{n} inverters", { n: e.inverters })}</Badge>
                  </div>
                  <DocList
                    docs={e.documents}
                    empty={
                      <>
                        {t("No manual linked to this model yet.")}{" "}
                        <Link to={`/kb/search?q=${encodeURIComponent(e.model)}`} className="text-solar-200 hover:underline">
                          {t("Search the library")}
                        </Link>
                      </>
                    }
                  />
                </div>
              ))}
            </div>
          )}
        </SectionCard>
      </div>

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

/** `/plant/:id/documents`: the plant banner and tab bar, as on every plant tab, then the documents. */
export const PlantDocumentsPage: React.FC = () => {
  const { selectedGrowattPlantId: plantId } = useAppContext();
  return (
    <div className="space-y-6">
      <SelectedPlantBanner />
      {plantId != null && <PlantDocuments key={plantId} plantId={plantId} />}
    </div>
  );
};

export default PlantDocumentsPage;
