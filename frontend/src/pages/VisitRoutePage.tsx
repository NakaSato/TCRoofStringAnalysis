/**
 * Operations → Visit Route (`/route`, admins and engineers): plan a day of site visits. Pick the
 * plants that need a visit (candidates of the day / team / person) or any plant, choose the start,
 * get the best order with drive times, see it on the map and open it in Google Maps.
 * docs/plans/site-visit-route.md §9 (v2 layout); phase 2: nothing is saved yet, no team bases yet.
 * The start can be a saved office (admins manage them in the start picker); a fresh page starts
 * from the default office.
 *
 * Layout: the settings bar (`visitRoute/RouteSettingsBar`; on a phone one line + a sheet), then the
 * panel (tabs Plants to visit / Route, and the action slot `visitRoute/ActionBar`) beside the map
 * (on a phone the map on top, 30 / 65 vh).
 *
 * Drive times are modelled: Geoapify road estimates (OpenStreetMap), else straight-line estimates,
 * labelled so. State in `visitRoute/useVisitRoute`; the map is `visitRoute/RouteMap`.
 *
 * URL: `d` (day, default today Bangkok), `team`, `user` (candidates), `tab` (plants | route; none =
 * Route when the page opens with stops, else Plants), `add=<id>,<id>` (links from Calendar / O&M
 * Dashboard / Plant Map: added as stops once, then dropped). Stops stay in component state only.
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Maximize2, Minimize2 } from "lucide-react";
import { useI18n } from "../i18n";
import { PageHeader, fmtInt } from "../components/ui";
import { notify } from "@/lib/notify";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { RouteMap, type RouteMapCandidate, type RouteMapPoint, type RouteMapStop } from "./visitRoute/RouteMap";
import { useVisitRoute, type RouteTab } from "./visitRoute/useVisitRoute";
import { RouteSettingsBar } from "./visitRoute/RouteSettingsBar";
import { StopList } from "./visitRoute/StopList";
import { RouteSummary } from "./visitRoute/RouteSummary";
import { CandidatesPanel } from "./visitRoute/CandidatesPanel";
import { ActionBar } from "./visitRoute/ActionBar";
import { MAX_STOPS, hasLocation } from "./visitRoute/format";

/** the lg breakpoint: the settings bar (with the start popover) instead of the phone line + sheet */
const isDesktop = () => typeof window !== "undefined" && window.matchMedia("(min-width: 1024px)").matches;

export const VisitRoutePage: React.FC = () => {
  const { t } = useI18n();
  const d = useVisitRoute();
  const [picking, setPicking] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const [startOpen, setStartOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  /** phone: the map at 30 vh or 65 vh */
  const [bigMap, setBigMap] = useState(false);
  const mapBox = useRef<HTMLDivElement>(null);

  // Esc stops picking the start on the map
  useEffect(() => {
    if (!picking) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setPicking(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [picking]);

  const res = d.sameSet ? d.answer : null;
  const mapStart: RouteMapPoint | null = d.start
    ? {
        plant_id: d.start.kind === "plant" ? d.start.plant_id : null,
        // a plant's or an office's name as stored; a point's label is ours, so translated
        name: d.start.kind === "point" ? t(d.start.label) : d.start.name,
        lat: d.start.lat,
        lon: d.start.lon,
      }
    : null;
  const mapStops: RouteMapStop[] = useMemo(() => {
    const out = new Map((res?.stops ?? []).map((s) => [s.plant_id, s]));
    return d.stops.map((s, i) => {
      const o = out.get(s.plant_id);
      return {
        plant_id: s.plant_id,
        name: s.name,
        lat: s.lat,
        lon: s.lon,
        seq: o ? i + 1 : null,
        late: !!o && (o.after_sunset === true || o.after_latest || o.late_min > 0),
        eta: o?.eta ?? null,
      };
    });
  }, [d.stops, res]);
  const mapCandidates: RouteMapCandidate[] = useMemo(
    () =>
      (d.cands?.candidates ?? [])
        .filter((c) => c.has_location && hasLocation(c.lat, c.lon))
        .map((c) => ({
          plant_id: c.plant_id,
          name: c.name,
          lat: c.lat as number,
          lon: c.lon as number,
          reasonKinds: c.reasons.map((r) => r.kind),
          inRoute: d.inRoute.has(c.plant_id),
        })),
    [d.cands, d.inRoute]
  );
  const showLine = d.sameOrder && res != null;

  /** add stops and say so when the Route tab isn't on screen (it shows them itself) */
  const add = (ids: number[]) => {
    const before = d.stops.length;
    const { added, skipped } = d.addStops(ids);
    if (skipped > 0) {
      notify("warn", t("{n} plants were not added: over {max} stops a day, or no location in Growatt.", { n: fmtInt(skipped), max: MAX_STOPS }));
    } else if (added > 0 && d.tab !== "route") {
      const name = ids.length === 1 ? (d.candById.get(ids[0])?.name ?? d.plantById.get(ids[0])?.name ?? null) : null;
      notify(
        "ok",
        name
          ? t("Added {name} ({n} / {max})", { name, n: before + added, max: MAX_STOPS })
          : t("Added {count} plants ({n} / {max})", { count: added, n: before + added, max: MAX_STOPS })
      );
    }
  };
  const toggleStop = (id: number) => (d.inRoute.has(id) ? d.removeStop(id) : add([id]));

  const chooseStart = () => (isDesktop() ? setStartOpen(true) : setSheetOpen(true));
  const showMap = () => mapBox.current?.scrollIntoView({ block: "start", behavior: "smooth" });

  return (
    <div className="flex flex-col gap-3 lg:h-[calc(100vh-6.5rem)] lg:min-h-[640px]">
      <PageHeader title={t("Visit Route")} description={t("Pick plants, get the best order and drive times. Nothing is saved yet.")} />

      <RouteSettingsBar
        d={d}
        picking={picking}
        setPicking={setPicking}
        startOpen={startOpen}
        setStartOpen={setStartOpen}
        sheetOpen={sheetOpen}
        setSheetOpen={setSheetOpen}
        onPickFromSheet={showMap}
      />

      <div className="grid grid-cols-[minmax(0,1fr)] gap-3 lg:min-h-0 lg:flex-1 lg:grid-cols-[420px_minmax(0,1fr)]">
        {/* map: on top on a phone */}
        <div
          ref={mapBox}
          className={cn(
            "order-1 scroll-mt-20 overflow-hidden rounded-xl border border-white/10 transition-[height] lg:order-2 lg:h-full",
            bigMap ? "h-[65vh]" : "h-[30vh] min-h-[220px]"
          )}
        >
          <RouteMap
            className="h-full w-full min-h-0!"
            start={mapStart}
            stops={mapStops}
            geometry={showLine ? res.geometry : null}
            geometrySource={showLine ? res.geometry_source : null}
            candidates={mapCandidates}
            selectedPlantId={selected}
            onSelect={setSelected}
            onToggleStop={toggleStop}
            pickingStart={picking}
            onPickStart={(lat, lon) => {
              setPicking(false);
              d.setStart({ kind: "point", source: "map", label: "Point on the map", lat, lon, accuracy_m: null });
            }}
            attribution={res?.attribution ?? []}
            controls={
              <Button
                size="icon-sm"
                variant="secondary"
                className="border border-white/10 bg-ink-950/85 backdrop-blur lg:hidden"
                onClick={() => setBigMap((b) => !b)}
                aria-label={bigMap ? t("Smaller map") : t("Larger map")}
                aria-pressed={bigMap}
              >
                {bigMap ? <Minimize2 /> : <Maximize2 />}
              </Button>
            }
          />
        </div>

        {/* panel: tabs, the tab's content (scrolls on desktop), the action slot */}
        <div className="order-2 flex flex-col rounded-xl border border-white/10 bg-ink-900/30 lg:order-1 lg:min-h-0 lg:overflow-hidden">
          <Tabs value={d.tab} onValueChange={(v) => d.setTab(v as RouteTab)} className="shrink-0 gap-0">
            <TabsList variant="line" className="w-full justify-start border-0 border-b border-white/[0.06] px-2 pt-1">
              <TabsTrigger value="plants">
                {t("Plants to visit")}
                <span className="num text-[11px] opacity-70">{d.cands ? fmtInt(d.cands.candidates.length) : "—"}</span>
              </TabsTrigger>
              <TabsTrigger value="route">
                {t("Route")}
                <span className={cn("num text-[11px] opacity-70", d.full && "text-amber-300 opacity-100")}>
                  {fmtInt(d.stops.length)} / {MAX_STOPS}
                </span>
              </TabsTrigger>
            </TabsList>
          </Tabs>

          <div className="flex min-h-0 flex-1 flex-col lg:overflow-y-auto">
            {d.tab === "plants" ? (
              <CandidatesPanel d={d} selectedPlantId={selected} onSelect={setSelected} onAdd={add} />
            ) : (
              <>
                {d.stops.length > 0 && <RouteSummary d={d} />}
                <StopList d={d} selectedPlantId={selected} onSelect={setSelected} onAddPlants={() => d.setTab("plants")} />
              </>
            )}
          </div>

          <ActionBar d={d} onChooseStart={chooseStart} />
        </div>
      </div>
    </div>
  );
};

export default VisitRoutePage;
