/** Plant Maintenance tab: the planned work (Calendar Team) and the site log for everyone who works
 * on the plant; admins also get the legacy PM / CM / RCA modules (local `plants` table) under it. */
import React, { useState } from "react";
import { useAppContext } from "../context/AppContext";
import { isAdmin } from "../auth/access";
import { SelectedPlantBanner } from "../components/SelectedPlantBanner";
import { MaintenanceRcaPage } from "./MaintenanceRcaPage";
import { SiteEventsCard } from "./maintenance/SiteEventsCard";
import { UpcomingTasksCard } from "./maintenance/UpcomingTasksCard";

export const PlantMaintenancePage: React.FC = () => {
  const { user, selectedGrowattPlantId } = useAppContext();
  // a task marked done writes a Site log event: remount the log so it shows
  const [logVersion, setLogVersion] = useState(0);
  const log =
    selectedGrowattPlantId != null ? (
      <div className="space-y-6">
        <UpcomingTasksCard plantId={selectedGrowattPlantId} onDone={() => setLogVersion((v) => v + 1)} />
        <SiteEventsCard key={logVersion} plantId={selectedGrowattPlantId} />
      </div>
    ) : null;
  if (isAdmin(user)) return <MaintenanceRcaPage top={log} />;
  return (
    <div className="space-y-6">
      <SelectedPlantBanner />
      {log}
    </div>
  );
};
