/**
 * One plant's Documents tab (`/plant/:id/documents`). Top to bottom: the plant's Google Drive files
 * (as-built PDF and site photo folder; Settings → Plant documents) as two tiles, then the O&M site
 * register card. DB only, read on open. The plant's Knowledge Base documents are in the library
 * (`/kb?plant=`), not on this tab.
 */
import React from "react";
import { Link } from "react-router-dom";
import { ExternalLink, FileText, Images, Settings2 } from "lucide-react";
import { api } from "../api/client";
import type { KbPlantDocuments } from "../api/client";
import { useAppContext } from "../context/AppContext";
import { useI18n } from "../i18n";
import { safeHref } from "../lib/safeUrl";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { LoadingState } from "../components/ui";
import { SelectedPlantBanner } from "../components/SelectedPlantBanner";
import { useLoad } from "./kb/useDocs";
import { SiteRegisterCard } from "./siteRegister/SiteRegisterCard";

type DriveLink = KbPlantDocuments["drive"][string];

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
  const { user } = useAppContext();
  const admin = user?.role === "admin";
  const data = useLoad<KbPlantDocuments>(`pd:${plantId}`, () => api.getPlantKbDocuments(plantId), { keepOnKeyChange: false });

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
