/** Plant Maintenance tab: the site log for everyone who works on the plant; admins also get the
 * legacy PM / CM / RCA modules (local `plants` table) under it. */
import React from "react";
import { useAppContext } from "../context/AppContext";
import { isAdmin } from "../auth/access";
import { SelectedPlantBanner } from "../components/SelectedPlantBanner";
import { MaintenanceRcaPage } from "./MaintenanceRcaPage";
import { SiteEventsCard } from "./maintenance/SiteEventsCard";

export const PlantMaintenancePage: React.FC = () => {
  const { user, selectedGrowattPlantId } = useAppContext();
  const log = selectedGrowattPlantId != null ? <SiteEventsCard plantId={selectedGrowattPlantId} /> : null;
  if (isAdmin(user)) return <MaintenanceRcaPage top={log} />;
  return (
    <div className="space-y-6">
      <SelectedPlantBanner />
      {log}
    </div>
  );
};
