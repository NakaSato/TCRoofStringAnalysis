import React from "react";
import { BrowserRouter, Routes, Route, Navigate, Outlet, Link, useParams } from "react-router-dom";
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
const MaintenanceRcaPage = page(() => import("./pages/MaintenanceRcaPage"), "MaintenanceRcaPage");
const SheSafetyPage = page(() => import("./pages/SheSafetyPage"), "SheSafetyPage");
const PlantSettingsPage = page(() => import("./pages/PlantSettingsPage"), "PlantSettingsPage");
const GrowattFleetPage = page(() => import("./pages/GrowattFleetPage"), "GrowattFleetPage");
const ActiveAlarmPage = page(() => import("./pages/ActiveAlarmPage"), "ActiveAlarmPage");
const PlantMapPage = page(() => import("./pages/PlantMapPage"), "PlantMapPage");
const SensorsPage = page(() => import("./pages/SensorsPage"), "SensorsPage");
const PlantSensorsPage = page(() => import("./pages/SensorsPage"), "PlantSensorsPage");
const UsersPage = page(() => import("./pages/UsersPage"), "UsersPage");
const SystemLogsPage = page(() => import("./pages/SystemLogsPage"), "SystemLogsPage");

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
  if (!plantId || !/^\d+$/.test(plantId)) return <Navigate to="/" replace />;
  if (plantError?.status === 404 && !selectedPlantOverview) {
    return (
      <EmptyState
        icon={SearchX}
        title={`Plant #${plantId} not found`}
        description={
          <>
            It does not exist, or it is not assigned to your account. Ask an admin if you need access.
            <span className="mt-3 block">
              <Button asChild variant="outline" size="sm">
                <Link to="/">All plants</Link>
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

/** Every page needs a signed-in user: splash while the stored token is checked, else the login page. */
const AuthGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user, authChecked } = useAppContext();
  if (!authChecked) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <LoadingState label="Checking session…" />
      </div>
    );
  }
  return user ? <>{children}</> : <LoginPage />;
};

export const App: React.FC = () => {
  return (
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
            <Route path="sensors" element={<SensorsPage />} />
            <Route path="she" element={<AdminOnly><SheSafetyPage /></AdminOnly>} />
            <Route path="settings" element={<PlantSettingsPage />} />
            <Route path="users" element={<AdminOnly><UsersPage /></AdminOnly>} />
            <Route path="logs" element={<AdminOnly><SystemLogsPage /></AdminOnly>} />
            {/* one plant: the plant id is in the URL */}
            <Route path="plant/:plantId" element={<PlantRoute />}>
              <Route index element={<OverviewPage />} />
              <Route path="generation" element={<GenerationPrPage />} />
              <Route path="sensors" element={<PlantSensorsPage />} />
              <Route path="inverters" element={<InvertersPage />} />
              <Route path="strings" element={<StringAnalysisPage />} />
              <Route path="string" element={<StringDetailPage />} />
              <Route path="string-layout" element={<StringLayoutPage />} />
              <Route path="maintenance" element={<AdminOnly><MaintenanceRcaPage /></AdminOnly>} />
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
  );
};
export default App;
