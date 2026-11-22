/** Plant Maintenance tab: the planned work (Calendar Team) and the site log, the same for everyone who
 * works on the plant (admins included). */
import React, { useState } from "react";
import { useAppContext } from "../context/AppContext";
import { SelectedPlantBanner } from "../components/SelectedPlantBanner";
import { SiteEventsCard } from "./maintenance/SiteEventsCard";
import { UpcomingTasksCard } from "./maintenance/UpcomingTasksCard";

export const PlantMaintenancePage: React.FC = () => {
  const { selectedGrowattPlantId } = useAppContext();
  // a task marked done writes a Site log event: remount the log so it shows
  const [logVersion, setLogVersion] = useState(0);
  return (
    <div className="space-y-6">
      <SelectedPlantBanner />
      {selectedGrowattPlantId != null && (
        <div className="space-y-6">
          <UpcomingTasksCard plantId={selectedGrowattPlantId} onDone={() => setLogVersion((v) => v + 1)} />
          <SiteEventsCard key={logVersion} plantId={selectedGrowattPlantId} />
        </div>
      )}
    </div>
  );
};
