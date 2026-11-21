import React from "react";
import { useAppContext } from "../context/AppContext";
import { SelectedPlantBanner } from "../components/SelectedPlantBanner";
import { LoadingState } from "../components/ui";
import { SensorsView } from "./sensors/SensorsView";
import { useI18n } from "../i18n";

/**
 * Every weather sensor the user can see (`/growatt/sensors`, DB only): newest stored reading,
 * probes that report, and today's stored coverage, overlaid with the live online state
 * (`/growatt/live/sensors/status`, polled on `refresh_in_s` while visible). A sensor whose
 * datalogger the sweep has not reached yet stays "Not checked". Nothing is written to browser storage.
 */
export const SensorsPage: React.FC = () => <SensorsView />;

/**
 * Plant tab "Sensors": the same Status / Info views for the URL plant's sensors only
 * (`?plant_id=` on both endpoints, so the live sweep checks only this plant's dataloggers).
 */
export const PlantSensorsPage: React.FC = () => {
  const { selectedGrowattPlantId } = useAppContext();
  const { t } = useI18n();
  return (
    <div className="space-y-6">
      <SelectedPlantBanner />
      {selectedGrowattPlantId == null ? (
        <LoadingState label={t("Loading the plant…")} shape="page" />
      ) : (
        // remount on plant switch: no rows of the previous plant shown under the new one
        <SensorsView key={selectedGrowattPlantId} plantId={selectedGrowattPlantId} />
      )}
    </div>
  );
};

export default SensorsPage;
