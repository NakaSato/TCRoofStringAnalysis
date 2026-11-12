import React from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AppProvider } from "./context/AppContext";
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

export const App: React.FC = () => {
  return (
    <AppProvider>
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
    </AppProvider>
  );
};
export default App;
