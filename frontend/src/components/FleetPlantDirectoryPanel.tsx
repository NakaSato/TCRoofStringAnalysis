/**
 * Plant directory (fleet home page `/`): hero banner, filter bar, table, string strip and pager.
 * State lives in `fleetDirectory/useFleetDirectory`; each section is a component in `fleetDirectory/`.
 */
import React from "react";
import { Card } from "@/components/ui/card";
import { useFleetDirectory } from "./fleetDirectory/useFleetDirectory";
import { HeroBanner } from "./fleetDirectory/HeroBanner";
import { PlantFilterBar } from "./fleetDirectory/PlantFilterBar";
import { PlantTable } from "./fleetDirectory/PlantTable";
import { SelectedPlantStrip } from "./fleetDirectory/SelectedPlantStrip";
import { PlantPager } from "./fleetDirectory/PlantPager";

export type { UnifiedPlantItem } from "./fleetDirectory/types";

/* -------------------------------------------------------------------------- */
export const FleetPlantDirectoryPanel: React.FC = () => {
  const d = useFleetDirectory();
  return (
    <div className="space-y-5">
      {/* ==================================================================== */}
      {/* 1. FUSIONSOLAR-STYLE 3-COLUMN FLEET HERO BANNER                      */}
      {/* ==================================================================== */}
      <HeroBanner d={d} />

      {/* ==================================================================== */}
      {/* 2. FUSIONSOLAR-STYLE MULTI-FILTER BAR + FULL-WIDTH PLANT TABLE        */}
      {/* ==================================================================== */}
      <Card className="gap-0 overflow-hidden py-0">
        {/* Multi-Field Filter Toolbar */}
        <PlantFilterBar d={d} />

        {/* Full-Width 12-Column Sortable Plant Directory Table */}
        <PlantTable d={d} />

        {/* Selected Plant Quick String & Inverter Strip (expandable below row) */}
        <SelectedPlantStrip d={d} />

        {/* Pagination Footer (matches FusionSolar bottom bar) */}
        <PlantPager d={d} />
      </Card>
    </div>
  );
};
