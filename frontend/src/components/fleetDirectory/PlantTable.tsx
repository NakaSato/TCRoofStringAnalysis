/** Plant directory table: sortable columns, one row per plant; a row click opens the plant. */
import React from "react";
import { Building2, MapPin, ArrowUpRight, ArrowUpDown } from "lucide-react";
import { StatusBadge, fmt, LOADING_STATUS } from "../ui";
import type { FleetDirectory } from "./useFleetDirectory";
import { PlantThumbnail } from "./parts";

export const PlantTable: React.FC<{ d: FleetDirectory }> = ({ d }) => {
  const { selectedGrowattPlantId, selectGrowattPlant, setSelectedUid, filteredPlants, handleSort, pagedPlants } = d;
  return (
    <div className="scroll-x-hint overflow-x-auto">
      <table className="w-full border-collapse text-left text-[11px]">
        <thead>
          <tr className="bg-ink-850 text-[11px] uppercase tracking-wider text-slate-400">
            <th className="whitespace-nowrap px-2.5 py-2.5 font-semibold">
              <button
                onClick={() => handleSort("statusRank")}
                title="Sort by status (faulty first)"
                className="inline-flex items-center gap-1 font-semibold uppercase tracking-wider text-slate-400 hover:text-white"
              >
                Status <ArrowUpDown className="h-2.5 w-2.5 opacity-60" />
              </button>
            </th>
            <th className="whitespace-nowrap px-2 py-2.5 font-semibold">Plant Image</th>
            <th className="whitespace-nowrap px-2.5 py-2.5 font-semibold">
              <button
                onClick={() => handleSort("name")}
                className="inline-flex items-center gap-1 font-semibold uppercase tracking-wider text-slate-400 hover:text-white"
              >
                Plant Name <ArrowUpDown className="h-2.5 w-2.5 opacity-60" />
              </button>
            </th>
            <th className="whitespace-nowrap px-2 py-2.5 font-semibold">
              <button
                onClick={() => handleSort("location")}
                className="inline-flex items-center gap-1 font-semibold uppercase tracking-wider text-slate-400 hover:text-white"
              >
                Country/Region <ArrowUpDown className="h-2.5 w-2.5 opacity-60" />
              </button>
            </th>
            <th className="whitespace-nowrap px-2 py-2.5 font-semibold">
              <button
                onClick={() => handleSort("createdDate")}
                className="inline-flex items-center gap-1 font-semibold uppercase tracking-wider text-slate-400 hover:text-white"
              >
                Grid Connecti... <ArrowUpDown className="h-2.5 w-2.5 opacity-60" />
              </button>
            </th>
            <th className="whitespace-nowrap px-2 py-2.5 text-right font-semibold">
              <button
                onClick={() => handleSort("capacityKwp")}
                title="Total String Capacity (kWp)"
                className="inline-flex items-center justify-end gap-1 font-semibold uppercase tracking-wider text-slate-400 hover:text-white"
              >
                String Cap (kWp) <ArrowUpDown className="h-2.5 w-2.5 opacity-60" />
              </button>
            </th>
            <th className="whitespace-nowrap px-2 py-2.5 text-right font-semibold">
              <button
                onClick={() => handleSort("stringsCount")}
                className="inline-flex items-center justify-end gap-1 font-semibold uppercase tracking-wider text-slate-400 hover:text-white"
              >
                Inverters <ArrowUpDown className="h-2.5 w-2.5 opacity-60" />
              </button>
            </th>
            <th className="whitespace-nowrap px-2 py-2.5 font-semibold">Battery</th>
            <th className="whitespace-nowrap px-2 py-2.5 text-right font-semibold">
              <button
                onClick={() => handleSort("currentPowerKw")}
                className="inline-flex items-center justify-end gap-1 font-semibold uppercase tracking-wider text-slate-400 hover:text-white"
              >
                Current Power (kW) <ArrowUpDown className="h-2.5 w-2.5 opacity-60" />
              </button>
            </th>
            <th className="whitespace-nowrap px-2 py-2.5 text-right font-semibold">
              <button
                onClick={() => handleSort("specificEnergyKwhPerKwp")}
                title="Specific Energy (kWh/kWp)"
                className="inline-flex items-center justify-end gap-1 font-semibold uppercase tracking-wider text-slate-400 hover:text-white"
              >
                Specific Energy <ArrowUpDown className="h-2.5 w-2.5 opacity-60" />
              </button>
            </th>
            <th className="whitespace-nowrap px-2 py-2.5 text-right font-semibold">
              <button
                onClick={() => handleSort("yieldTodayKwh")}
                className="inline-flex items-center justify-end gap-1 font-semibold uppercase tracking-wider text-slate-400 hover:text-white"
              >
                Yield Today (kWh) <ArrowUpDown className="h-2.5 w-2.5 opacity-60" />
              </button>
            </th>
            <th className="whitespace-nowrap px-2.5 py-2.5 text-right font-semibold">
              <button
                onClick={() => handleSort("totalEnergyKwh")}
                className="inline-flex items-center justify-end gap-1 font-semibold uppercase tracking-wider text-slate-400 hover:text-white"
              >
                Total Yield (kWh) <ArrowUpDown className="h-2.5 w-2.5 opacity-60" />
              </button>
            </th>
          </tr>
        </thead>
        <tbody>
          {filteredPlants.length === 0 ? (
            <tr>
              <td colSpan={12} className="py-12 text-center">
                <div className="mx-auto flex flex-col items-center justify-center gap-2 text-slate-500">
                  <Building2 className="h-8 w-8 stroke-1 text-slate-500" />
                  <div className="text-xs font-medium text-slate-400">No data</div>
                  <div className="text-[11px] text-slate-500">
                    No solar plants match the current filter criteria.
                  </div>
                </div>
              </td>
            </tr>
          ) : (
            pagedPlants.map((p) => {
              const isSelected = p.id === selectedGrowattPlantId;
              const loadPct =
                p.capacityKwp && p.currentPowerKw != null
                  ? Math.min(100, (p.currentPowerKw / p.capacityKwp) * 100)
                  : 0;

              return (
                <tr
                  key={p.uid}
                  onClick={() => {
                    setSelectedUid(p.uid);
                    selectGrowattPlant(p.id);
                  }}
                  className={`group cursor-pointer border-t border-white/[0.05] transition ${
                    isSelected ? "bg-sky-500/[0.09]" : "hover:bg-white/[0.04]"
                  }`}
                >
                  {/* 1. Status */}
                  <td className="px-2.5 py-2.5">
                    <StatusBadge status={p.statusLabel} level={p.statusLevel} loading={p.statusLabel === LOADING_STATUS} dot />
                  </td>

                  {/* 2. Plant Image */}
                  <td className="px-2 py-2.5">
                    <PlantThumbnail statusLevel={p.statusLevel} source={p.source} lat={p.latitude} lon={p.longitude} name={p.name} />
                  </td>

                  {/* 3. Plant Name */}
                  <td className="max-w-[220px] px-2.5 py-2.5">
                    <div
                      className="flex items-center gap-1.5 truncate font-semibold text-white group-hover:text-sky-300"
                      title={`Click to open ${p.name} Overview`}
                    >
                      <span className="truncate">{p.name}</span>
                      <ArrowUpRight className="h-3 w-3 shrink-0 text-sky-400 opacity-0 transition group-hover:opacity-100" />
                    </div>
                    <div className="mt-0.5 flex items-center gap-1 text-[11px] text-slate-500">
                      <span className="num">#{p.id}</span>
                      {p.phase != null && (
                        <>
                          <span>·</span>
                          <span className="whitespace-nowrap">Phase {p.phase}</span>
                        </>
                      )}
                      <span>·</span>
                      <span className="truncate">{p.source === "local" ? "SCADA" : "Growatt MAX"}</span>
                      {p.prPct != null && (
                        <>
                          <span>·</span>
                          <span className="num font-semibold text-emerald-400">
                            PR {fmt(p.prPct, 1)}%
                          </span>
                        </>
                      )}
                    </div>
                  </td>

                  {/* 4. Country/Region */}
                  <td className="max-w-[140px] px-2 py-2.5">
                    <div className="flex items-center gap-1 truncate text-[11px] text-slate-300" title={p.location}>
                      <MapPin className="h-3 w-3 shrink-0 text-slate-500" />
                      <span className="truncate">{p.location}</span>
                    </div>
                  </td>

                  {/* 5. Grid Connection */}
                  <td className="num whitespace-nowrap px-2 py-2.5 text-[11px] text-slate-300">
                    {p.createdDate || "—"}
                  </td>

                  {/* 6. Total String Capacity (kWp) */}
                  <td className="num whitespace-nowrap px-2 py-2.5 text-right font-semibold text-slate-200">
                    {fmt(p.capacityKwp, 2)}
                  </td>

                  {/* 7. Inverters / String Quantity */}
                  <td className="num whitespace-nowrap px-2 py-2.5 text-right text-[11px] text-slate-300">
                    {p.invertersCount != null ? (
                      <div>
                        <span className="font-semibold text-white">{p.invertersCount}</span> Inv
                      </div>
                    ) : (
                      "—"
                    )}
                  </td>

                  {/* 8. Battery */}
                  <td className="whitespace-nowrap px-2 py-2.5 text-[11px] text-slate-500">
                    {p.source === "local" ? "Grid-Tied" : "--"}
                  </td>

                  {/* 9. Current Power (kW) */}
                  <td className="num whitespace-nowrap px-2 py-2.5 text-right">
                    <div className="font-semibold text-energy-300">{fmt(p.currentPowerKw, 2)}</div>
                    <div className="ml-auto mt-1 h-1 w-14 overflow-hidden rounded-full bg-white/[0.07]">
                      <div
                        className="h-full rounded-full bg-sky-400"
                        style={{ width: `${loadPct}%` }}
                      />
                    </div>
                  </td>

                  {/* 10. Specific Energy (kWh/kWp) */}
                  <td className="num whitespace-nowrap px-2 py-2.5 text-right font-medium text-slate-200">
                    {fmt(p.specificEnergyKwhPerKwp, 2)}
                  </td>

                  {/* 11. Yield Today (kWh) */}
                  <td className="num whitespace-nowrap px-2 py-2.5 text-right font-semibold text-solar-300">
                    {fmt(p.yieldTodayKwh, 2)}
                  </td>

                  {/* 12. Total Yield (kWh) */}
                  <td className="num whitespace-nowrap px-2.5 py-2.5 text-right font-bold text-emerald-300">
                    {fmt(p.totalEnergyKwh, 2)}
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
};
