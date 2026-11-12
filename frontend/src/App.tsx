import React from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AppProvider, useAppContext } from "./context/AppContext";
import { LoginPage } from "./pages/LoginPage";
import { LoadingState } from "./components/ui";
import { Layout } from "./components/Layout";
import { OverviewPage } from "./pages/OverviewPage";
import { GenerationPrPage } from "./pages/GenerationPrPage";
import { StringAnalysisPage } from "./pages/StringAnalysisPage";
import { MaintenanceRcaPage } from "./pages/MaintenanceRcaPage";
import { SubcontractorPqPage } from "./pages/SubcontractorPqPage";
import { SheSafetyPage } from "./pages/SheSafetyPage";
import { ReportsPage } from "./pages/ReportsPage";
import { PlantSettingsPage } from "./pages/PlantSettingsPage";
import { GrowattFleetPage } from "./pages/GrowattFleetPage";

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
            <Route path="maintenance" element={<MaintenanceRcaPage />} />
            <Route path="quality" element={<SubcontractorPqPage />} />
            <Route path="she" element={<SheSafetyPage />} />
            <Route path="reports" element={<ReportsPage />} />
            <Route path="settings" element={<PlantSettingsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
      </AuthGate>
    </AppProvider>
  );
};
export default App;
