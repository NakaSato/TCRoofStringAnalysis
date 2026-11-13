import React from "react";
import { FleetPlantDirectoryPanel } from "../components/FleetPlantDirectoryPanel";

/** `/`: every plant the user may see. Clicking a plant opens `/plant/:id`. */
export const FleetHomePage: React.FC = () => <FleetPlantDirectoryPanel />;

export default FleetHomePage;
