/** String strip under the table for a selected local (SCADA) plant with an analysis run. */
import React from "react";
import { Link } from "react-router-dom";
import { Cpu, ArrowUpRight } from "lucide-react";
import { plantPath } from "../../context/routes";
import { Led, fmt } from "../ui";
import type { StatusLevel } from "../ui";
import type { FleetDirectory } from "./useFleetDirectory";
import { useI18n } from "../../i18n";

export const SelectedPlantStrip: React.FC<{ d: FleetDirectory }> = ({ d }) => {
  const { setInspectedStringId, showInspectorDrawer, setShowInspectorDrawer, selectedPlant, strings } = d;
  const { t } = useI18n();
  return (
    <>
      {showInspectorDrawer && selectedPlant && selectedPlant.source === "local" && strings.length > 0 && (
        <div className="border-t border-white/[0.07] bg-ink-950/60 px-5 py-3.5">
          <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs">
              <Cpu className="h-3.5 w-3.5 text-sky-400" />
              <span className="font-semibold text-white">{selectedPlant.name}</span>
              <span className="text-slate-500">—</span>
              <span className="text-slate-400">
                {t("Live String Array Telemetry (click any string to open Inspector Drawer)")}
              </span>
            </div>
            <div className="flex items-center gap-3">
              <Link
                to={selectedPlant ? plantPath(selectedPlant.id, "strings") : "/strings"}
                className="inline-flex items-center gap-1 text-[11px] font-semibold text-sky-400 hover:text-sky-300"
              >
                {t("Full String Diagnostics")} <ArrowUpRight className="h-3 w-3" />
              </Link>
              <button
                onClick={() => setShowInspectorDrawer(false)}
                className="text-[11px] text-slate-500 hover:text-slate-300"
              >
                {t("Hide")}
              </button>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
            {strings.map((s: Record<string, any>) => {
              const sid = String(s.string_id);
              const st = String(s.status);
              const level: StatusLevel =
                st === "Critical" ? "crit" : st === "Warning" ? "warn" : "ok";
              return (
                <button
                  key={sid}
                  onClick={() => setInspectedStringId(sid)}
                  className="group flex flex-col justify-between rounded-lg border border-white/[0.07] bg-ink-900/90 p-2.5 text-left transition hover:border-sky-400/40 hover:bg-ink-850"
                >
                  <div className="flex items-center justify-between">
                    <span className="num text-xs font-bold text-white group-hover:text-sky-300">
                      {sid}
                    </span>
                    <Led level={level} pulse={level === "crit"} />
                  </div>
                  <div className="mt-1.5 flex items-baseline justify-between">
                    <span className="num text-xs font-semibold text-slate-200">
                      {fmt(Number(s.pr_pct), 1)}%
                    </span>
                    <span className="num text-[11px] text-slate-500">
                      {fmt(Number(s.actual_energy_kwh), 0)} kWh
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
};
