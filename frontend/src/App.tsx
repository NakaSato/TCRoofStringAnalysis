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
const GrowattFleetPage = page(() => import("./pages/GrowattFleetPage"), "GrowattFleetPage");
const ActiveAlarmPage = page(() => import("./pages/ActiveAlarmPage"), "ActiveAlarmPage");
const PlantMapPage = page(() => import("./pages/PlantMapPage"), "PlantMapPage");
const SensorsPage = page(() => import("./pages/SensorsPage"), "SensorsPage");
const PlantSensorsPage = page(() => import("./pages/SensorsPage"), "PlantSensorsPage");
const UsersPage = page(() => import("./pages/UsersPage"), "UsersPage");
const SystemLogsPage = page(() => import("./pages/SystemLogsPage"), "SystemLogsPage");
const AiUsagePage = page(() => import("./pages/AiUsagePage"), "AiUsagePage");
const CalendarPage = page(() => import("./pages/CalendarPage"), "CalendarPage");
const ToolsPage = page(() => import("./pages/ToolsPage"), "ToolsPage");
const ClaimsPage = page(() => import("./pages/ClaimsPage"), "ClaimsPage");
const OmCenterPage = page(() => import("./pages/OmCenterPage"), "OmCenterPage");

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

/** The PWA Meter page is now part of the Engineering O&M (`/center`): old links land on its meter
 * sites list and keep the site they opened (`?site=`) and the phase. */
const PwaMeterRedirect: React.FC = () => {
  const old = new URLSearchParams(useLocation().search);
  const next = new URLSearchParams({ view: "sites" });
  for (const k of ["site", "phase", "q"]) if (old.get(k)) next.set(k, old.get(k)!);
  return <Navigate to={{ pathname: "/center", search: `?${next}` }} replace />;
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
      <AuthGate>
      <BrowserRouter>
        <DataScope>
        <Routes>
          <Route path="/" element={<Layout />}>
            {/* fleet-wide pages */}
            <Route index element={<FleetHomePage />} />
            <Route path="map" element={<PlantMapPage />} />
            <Route path="growatt" element={<GrowattFleetPage />} />
            <Route path="alarms" element={<ActiveAlarmPage />} />
            <Route path="calendar" element={<CalendarPage />} />
            <Route path="tools" element={<ToolsPage />} />
            <Route path="claims" element={<ClaimsPage />} />
            <Route path="center" element={<OmCenterPage />} />
            <Route path="center/*" element={<PwaMeterRedirect />} />
            <Route path="pwa-meter" element={<PwaMeterRedirect />} />
            <Route path="sensors" element={<SensorsPage />} />
            <Route path="settings" element={<PlantSettingsPage />} />
            <Route path="users" element={<AdminOnly><UsersPage /></AdminOnly>} />
            <Route path="logs" element={<AdminOnly><SystemLogsPage /></AdminOnly>} />
            <Route path="ai-usage" element={<AdminOnly><AiUsagePage /></AdminOnly>} />
            {/* one plant: the plant id is in the URL */}
            <Route path="plant/:plantId" element={<PlantRoute />}>
              <Route index element={<OverviewPage />} />
              <Route path="generation" element={<GenerationPrPage />} />
              <Route path="sensors" element={<PlantSensorsPage />} />
              <Route path="inverters" element={<InvertersPage />} />
              <Route path="strings" element={<StringAnalysisPage />} />
              <Route path="string" element={<StringDetailPage />} />
              <Route path="string-layout" element={<StringLayoutPage />} />
              <Route path="maintenance" element={<PlantMaintenancePage />} />
              <Route path="*" element={<Navigate to=".." relative="path" replace />} />
            </Route>
            {/* URLs from before the plant was in the URL */}
            <Route path="generation" element={<LegacyPlantRedirect page="generation" />} />
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
      </TooltipProvider>
    </AppProvider>
    </I18nProvider>
  );
};
export default App;
