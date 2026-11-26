import React from "react";
import { BrowserRouter, Routes, Route, Navigate, Outlet, Link, useParams, useLocation } from "react-router-dom";
import { SearchX } from "lucide-react";
import { AppProvider, DataScope, useAppContext } from "./context/AppContext";
import { getLastPlantId, plantPath } from "./context/routes";
import type { PlantPage } from "./context/routes";
import { LoginPage } from "./pages/LoginPage";
import { EmptyState, LoadingState } from "./components/ui";
import { Button } from "@/components/ui/button";
import { Layout } from "./components/Layout";
import { isAdmin } from "./auth/access";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/toast";
import { I18nProvider, useI18n } from "./i18n";

// Each page is its own chunk, fetched on first visit (Layout shows a fallback meanwhile).
const page = <K extends string>(load: () => Promise<Record<K, React.ComponentType>>, name: K) =>
  React.lazy(() => load().then((m) => ({ default: m[name] })));
const FleetHomePage = page(() => import("./pages/FleetHomePage"), "FleetHomePage");
const OverviewPage = page(() => import("./pages/OverviewPage"), "OverviewPage");
const GenerationPrPage = page(() => import("./pages/GenerationPrPage"), "GenerationPrPage");
const InvertersPage = page(() => import("./pages/InvertersPage"), "InvertersPage");
const StringAnalysisPage = page(() => import("./pages/StringAnalysisPage"), "StringAnalysisPage");
const StringLayoutPage = page(() => import("./pages/StringLayoutPage"), "StringLayoutPage");
const StringDetailPage = page(() => import("./pages/StringDetailPage"), "StringDetailPage");
const PlantMaintenancePage = page(() => import("./pages/PlantMaintenancePage"), "PlantMaintenancePage");
const PlantSettingsPage = page(() => import("./pages/PlantSettingsPage"), "PlantSettingsPage");
const ActiveAlarmPage = page(() => import("./pages/ActiveAlarmPage"), "ActiveAlarmPage");
const PlantMapPage = page(() => import("./pages/PlantMapPage"), "PlantMapPage");
const DevicesPage = page(() => import("./pages/DevicesPage"), "DevicesPage");
const CurtailmentPage = page(() => import("./pages/CurtailmentPage"), "CurtailmentPage");
const PlantSensorsPage = page(() => import("./pages/SensorsPage"), "PlantSensorsPage");
const UsersPage = page(() => import("./pages/UsersPage"), "UsersPage");
const SystemLogsPage = page(() => import("./pages/SystemLogsPage"), "SystemLogsPage");
const AiUsagePage = page(() => import("./pages/AiUsagePage"), "AiUsagePage");
const CalendarPage = page(() => import("./pages/CalendarPage"), "CalendarPage");
const ToolsPage = page(() => import("./pages/ToolsPage"), "ToolsPage");
const ClaimsPage = page(() => import("./pages/ClaimsPage"), "ClaimsPage");
const OmCenterPage = page(() => import("./pages/OmCenterPage"), "OmCenterPage");
const KnowledgeBasePage = page(() => import("./pages/KnowledgeBasePage"), "KnowledgeBasePage");
const KbArticlePage = page(() => import("./pages/kb/ArticlePage"), "KbArticlePage");
const KbEditorPage = page(() => import("./pages/kb/EditorPage"), "KbEditorPage");
const KbDocumentPage = page(() => import("./pages/kb/DocumentPage"), "KbDocumentPage");
const KbDocViewerPage = page(() => import("./pages/kb/DocViewerPage"), "KbDocViewerPage");
const KbSearchPage = page(() => import("./pages/kb/SearchPage"), "KbSearchPage");
const PlantDocumentsPage = page(() => import("./pages/PlantDocumentsPage"), "PlantDocumentsPage");
const PlantBillingPage = page(() => import("./pages/PlantBillingPage"), "PlantBillingPage");
const VisitRoutePage = page(() => import("./pages/VisitRoutePage"), "VisitRoutePage");
const ScanRedirectPage = page(() => import("./pages/ScanRedirectPage"), "ScanRedirectPage");

/** `/kb/doc/:docId/rev/:rev`: one revision, read only = the viewer on that revision. */
const KbRevisionRedirect: React.FC = () => {
  const { docId, rev } = useParams();
  const { search } = useLocation();
  const p = new URLSearchParams(search);
  if (rev && /^\d+$/.test(rev)) p.set("rev", rev);
  return <Navigate to={`/kb/doc/${docId}/view?${p.toString()}`} replace />;
};

/** Admin-only page (the backend answers 403 anyway): engineers are sent to the overview. */
const AdminOnly: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user } = useAppContext();
  return isAdmin(user) ? <>{children}</> : <Navigate to="/" replace />;
};

/**
 * `/plant/:plantId/*`: the plant comes from the URL (DataScope loads it). An id that is not a
 * number, or a plant the backend answers 404 for (unknown, or not assigned to this engineer),
 * shows "not found" instead of the page.
 */
const PlantRoute: React.FC = () => {
  const { plantId } = useParams();
  const { plantError, selectedPlantOverview } = useAppContext();
  const { t } = useI18n();
  if (!plantId || !/^\d+$/.test(plantId)) return <Navigate to="/" replace />;
  if (plantError?.status === 404 && !selectedPlantOverview) {
    return (
      <EmptyState
        icon={SearchX}
        title={t("Plant #{id} not found", { id: plantId })}
        description={
          <>
            {t("It does not exist, or it is not assigned to your account. Ask an admin if you need access.")}
            <span className="mt-3 block">
              <Button asChild variant="outline" size="sm">
                <Link to="/">{t("All plants")}</Link>
              </Button>
            </span>
          </>
        }
      />
    );
  }
  return <Outlet />;
};

/** Old URLs (`/inverters`, …): the same page of the last plant opened, else the plant directory. */
const LegacyPlantRedirect: React.FC<{ page: PlantPage }> = ({ page }) => {
  const last = getLastPlantId();
  return <Navigate to={last != null ? plantPath(last, page) : "/"} replace />;
};

/** `/plant/:id/generation` (the Performance page's old path): same plant, query and hash. */
const GenerationRedirect: React.FC = () => {
  const { search, hash } = useLocation();
  return <Navigate to={{ pathname: "../performance", search, hash }} relative="path" replace />;
};

/** The Growatt Fleet page (`/growatt`) was removed: `?plant=<id>` (a plant's Energy & Billing there for a
 * while) opens that plant's Energy & Billing tab with the rest of the query, anything else the directory. */
const GrowattRedirect: React.FC = () => {
  const q = new URLSearchParams(useLocation().search);
  const plant = q.get("plant");
  q.delete("plant");
  if (!plant || !/^\d+$/.test(plant)) return <Navigate to="/" replace />;
  const rest = q.toString();
  return <Navigate to={{ pathname: plantPath(Number(plant), "billing"), search: rest ? `?${rest}` : "" }} replace />;
};

/** Energy & Billing (`/energy-billing`, was Engineering O&M at `/center`). */
const ENERGY_BILLING = "/energy-billing";

/** The PWA Meter page is now part of Energy & Billing: old links land on its meter sites list and
 * keep the site they opened (`?site=`) and the phase. */
const PwaMeterRedirect: React.FC = () => {
  const old = new URLSearchParams(useLocation().search);
  const next = new URLSearchParams({ view: "sites" });
  for (const k of ["site", "phase", "q"]) if (old.get(k)) next.set(k, old.get(k)!);
  return <Navigate to={{ pathname: ENERGY_BILLING, search: `?${next}` }} replace />;
};

/** Old `/center` links keep their whole query (period, view, site, sort …). */
const CenterRedirect: React.FC = () => <Navigate to={{ pathname: ENERGY_BILLING, search: useLocation().search }} replace />;

/** The Weather Sensors page is the Devices page's sensors tab: `/sensors` links (Active Alarm, …) keep
 * their query, with the sensor view's `tab=status|info` moved to `view` (Devices uses `tab` itself). */
const SensorsRedirect: React.FC = () => {
  const q = new URLSearchParams(useLocation().search);
  const view = q.get("tab");
  q.delete("tab");
  q.delete("view");
  if (view === "status" || view === "info") q.set("view", view);
  q.set("tab", "sensors");
  return <Navigate to={{ pathname: "/devices", search: `?${q}` }} replace />;
};

/** Every page needs a signed-in user: splash while the stored token is checked, else the login page. */
const AuthGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user, authChecked } = useAppContext();
  const { t } = useI18n();
  if (!authChecked) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <LoadingState label={t("Checking session…")} />
      </div>
    );
  }
  return user ? <>{children}</> : <LoginPage />;
};

export const App: React.FC = () => {
  return (
    <I18nProvider>
    <AppProvider>
      <TooltipProvider delayDuration={200}>
      {/* save outcomes (`lib/notify`) */}
      <Toaster>
      <AuthGate>
      <BrowserRouter>
        <DataScope>
        <Routes>
          <Route path="/" element={<Layout />}>
            {/* fleet-wide pages */}
            <Route index element={<FleetHomePage />} />
            <Route path="map" element={<PlantMapPage />} />
            <Route path="growatt" element={<GrowattRedirect />} />
            <Route path="alarms" element={<ActiveAlarmPage />} />
            <Route path="calendar" element={<CalendarPage />} />
            <Route path="route" element={<VisitRoutePage />} />
            <Route path="tools" element={<ToolsPage />} />
            {/* app labels (QR): `/s/<kind>/<code>` opens the record it names */}
            <Route path="s/:kind/:code" element={<ScanRedirectPage />} />
            <Route path="claims" element={<ClaimsPage />} />
            <Route path="kb" element={<KnowledgeBasePage />} />
            <Route path="kb/new" element={<KbEditorPage />} />
            <Route path="kb/search" element={<KbSearchPage />} />
            <Route path="kb/doc/:docId" element={<KbDocumentPage />} />
            <Route path="kb/doc/:docId/view" element={<KbDocViewerPage />} />
            <Route path="kb/doc/:docId/rev/:rev" element={<KbRevisionRedirect />} />
            <Route path="kb/:slug" element={<KbArticlePage />} />
            <Route path="kb/:slug/edit" element={<KbEditorPage />} />
            <Route path="energy-billing" element={<OmCenterPage />} />
            <Route path="curtailment" element={<CurtailmentPage />} />
            <Route path="center" element={<CenterRedirect />} />
            <Route path="center/*" element={<PwaMeterRedirect />} />
            <Route path="pwa-meter" element={<PwaMeterRedirect />} />
            <Route path="devices" element={<DevicesPage />} />
            <Route path="sensors" element={<SensorsRedirect />} />
            <Route path="settings" element={<PlantSettingsPage />} />
            <Route path="users" element={<AdminOnly><UsersPage /></AdminOnly>} />
            <Route path="logs" element={<AdminOnly><SystemLogsPage /></AdminOnly>} />
            <Route path="ai-usage" element={<AdminOnly><AiUsagePage /></AdminOnly>} />
            {/* one plant: the plant id is in the URL */}
            <Route path="plant/:plantId" element={<PlantRoute />}>
              <Route index element={<OverviewPage />} />
              <Route path="performance" element={<GenerationPrPage />} />
              <Route path="generation" element={<GenerationRedirect />} />
              <Route path="sensors" element={<PlantSensorsPage />} />
              <Route path="inverters" element={<InvertersPage />} />
              <Route path="strings" element={<StringAnalysisPage />} />
              <Route path="string" element={<StringDetailPage />} />
              <Route path="string-layout" element={<StringLayoutPage />} />
              <Route path="maintenance" element={<PlantMaintenancePage />} />
              <Route path="documents" element={<PlantDocumentsPage />} />
              <Route path="billing" element={<PlantBillingPage />} />
              <Route path="*" element={<Navigate to=".." relative="path" replace />} />
            </Route>
            {/* URLs from before the plant was in the URL */}
            <Route path="performance" element={<LegacyPlantRedirect page="performance" />} />
            <Route path="generation" element={<LegacyPlantRedirect page="performance" />} />
            <Route path="inverters" element={<LegacyPlantRedirect page="inverters" />} />
            <Route path="strings" element={<LegacyPlantRedirect page="strings" />} />
            <Route path="string-layout" element={<LegacyPlantRedirect page="string-layout" />} />
            <Route path="maintenance" element={<LegacyPlantRedirect page="maintenance" />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
        </DataScope>
      </BrowserRouter>
      </AuthGate>
      </Toaster>
      </TooltipProvider>
    </AppProvider>
    </I18nProvider>
  );
};
export default App;
