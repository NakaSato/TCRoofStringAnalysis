import React, { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { LocateFixed } from "lucide-react";
import { fmt } from "./ui";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useI18n } from "../i18n";

/** Esri World Imagery: free satellite tiles, no key; attribution is required. */
const ESRI_IMAGERY = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
const ESRI_ATTRIBUTION = "Imagery © Esri, Maxar, Earthstar Geographics";
const SITE_ZOOM = 18;

/** Satellite map centred on one plant. Loaded lazily (Leaflet is only fetched on the Overview page). */
const PlantSatelliteMap: React.FC<{
  lat: number;
  lon: number;
  name: string;
  capacityKwp: number | null;
  /** Tailwind height classes of the map (default h-60). */
  heightClass?: string;
}> = ({ lat, lon, name, capacityKwp, heightClass = "h-60" }) => {
  const el = useRef<HTMLDivElement>(null);
  const { t } = useI18n();
  const map = useRef<L.Map | null>(null);
  const marker = useRef<L.CircleMarker | null>(null);

  useEffect(() => {
    if (!el.current) return;
    const m = L.map(el.current, { scrollWheelZoom: false, attributionControl: true, maxZoom: 19 });
    L.tileLayer(ESRI_IMAGERY, { maxZoom: 19, maxNativeZoom: 19, attribution: ESRI_ATTRIBUTION }).addTo(m);
    m.attributionControl.setPrefix(false);
    // circle marker: no image assets, so nothing breaks in the Vite bundle
    marker.current = L.circleMarker([0, 0], {
      radius: 8,
      color: "#fff",
      weight: 2,
      fillColor: "#f5b42a",
      fillOpacity: 0.95,
    }).addTo(m);
    map.current = m;
    // the map's box follows the window (e.g. a vh height), so Leaflet must re-measure it
    const ro = new ResizeObserver(() => m.invalidateSize());
    ro.observe(el.current);
    return () => {
      ro.disconnect();
      m.remove();
      map.current = null;
      marker.current = null;
    };
  }, []);

  // follow the selected plant
  useEffect(() => {
    if (!map.current || !marker.current) return;
    map.current.setView([lat, lon], SITE_ZOOM);
    marker.current.setLatLng([lat, lon]);
    const popup = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = name;
    popup.append(title, document.createElement("br"), `${fmt(capacityKwp, 1)} kWp · ${lat.toFixed(5)}, ${lon.toFixed(5)}`);
    marker.current.bindPopup(popup);
  }, [lat, lon, name, capacityKwp]);

  return (
    <div className="relative">
      <div ref={el} className={`plant-map w-full ${heightClass}`} aria-label={t("Satellite view of {name}", { name })} />
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="absolute right-2 top-2 z-[400] bg-ink-950/80"
            onClick={() => map.current?.setView([lat, lon], SITE_ZOOM)}
            aria-label={t("Recentre on the plant")}
          >
            <LocateFixed className="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t("Recentre on the plant")}</TooltipContent>
      </Tooltip>
    </div>
  );
};

export default PlantSatelliteMap;
