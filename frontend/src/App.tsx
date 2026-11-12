import React from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AppProvider, useAppContext } from "./context/AppContext";
import { LoginPage } from "./pages/LoginPage";
import { LoadingState } from "./components/ui";
import { Layout } from "./components/Layout";
import { isAdmin } from "./auth/access";

// Each page is its own chunk, fetched on first visit (Layout shows a fallback meanwhile).
const page = <K extends string>(load: () => Promise<Record<K, React.ComponentType>>, name: K) =>
  React.lazy(() => load().then((m) => ({ default: m[name] })));
const OverviewPage = page(() => import("./pages/OverviewPage"), "OverviewPage");
const GenerationPrPage = page(() => import("./pages/GenerationPrPage"), "GenerationPrPage");
const StringAnalysisPage = page(() => import("./pages/StringAnalysisPage"), "StringAnalysisPage");
const MaintenanceRcaPage = page(() => import("./pages/MaintenanceRcaPage"), "MaintenanceRcaPage");
const SubcontractorPqPage = page(() => import("./pages/SubcontractorPqPage"), "SubcontractorPqPage");
const SheSafetyPage = page(() => import("./pages/SheSafetyPage"), "SheSafetyPage");
const ReportsPage = page(() => import("./pages/ReportsPage"), "ReportsPage");
const PlantSettingsPage = page(() => import("./pages/PlantSettingsPage"), "PlantSettingsPage");
const GrowattFleetPage = page(() => import("./pages/GrowattFleetPage"), "GrowattFleetPage");
const UsersPage = page(() => import("./pages/UsersPage"), "UsersPage");

/** Admin-only page (the backend answers 403 anyway): engineers are sent to the overview. */
const AdminOnly: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user } = useAppContext();
  return isAdmin(user) ? <>{children}</> : <Navigate to="/" replace />;
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
      <AuthGate>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Layout />}>
            <Route index element={<OverviewPage />} />
            <Route path="growatt" element={<GrowattFleetPage />} />
            <Route path="generation" element={<GenerationPrPage />} />
            <Route path="strings" element={<StringAnalysisPage />} />
            <Route path="maintenance" element={<AdminOnly><MaintenanceRcaPage /></AdminOnly>} />
            <Route path="quality" element={<AdminOnly><SubcontractorPqPage /></AdminOnly>} />
            <Route path="she" element={<AdminOnly><SheSafetyPage /></AdminOnly>} />
            <Route path="reports" element={<AdminOnly><ReportsPage /></AdminOnly>} />
            <Route path="settings" element={<PlantSettingsPage />} />
            <Route path="users" element={<AdminOnly><UsersPage /></AdminOnly>} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
      </AuthGate>
    </AppProvider>
  );
};
export default App;
