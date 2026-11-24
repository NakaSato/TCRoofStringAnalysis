/** Plant directory table: sortable columns, one row per plant; a row click opens the plant. */
import React from "react";
import { Building2, MapPin, ArrowUpRight, ArrowUpDown } from "lucide-react";
import { StatusBadge, fmt, LOADING_STATUS } from "../ui";
import type { FleetDirectory } from "./useFleetDirectory";
import { PlantThumbnail } from "./parts";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import { useI18n } from "../../i18n";

export const PlantTable: React.FC<{ d: FleetDirectory }> = ({ d }) => {
  const { selectedGrowattPlantId, selectGrowattPlant, setSelectedUid, filteredPlants, handleSort, pagedPlants } = d;
  const { t } = useI18n();
  return (
    <div className="scroll-x-hint overflow-x-auto">
      <table className="w-full border-collapse text-left text-[11px]">
        <thead>
          <tr className="bg-ink-850 text-[11px] tracking-wider text-slate-400">
            <th className="whitespace-nowrap px-2.5 py-2.5 font-semibold">
              <Button
                onClick={() => handleSort("statusRank")}
                title={t("Sort by status (faulty first)")}
                variant="ghost"
                size="xs"
                className="h-auto justify-start gap-1 rounded-none p-0 text-[11px] font-semibold tracking-wider text-slate-400 hover:bg-transparent hover:text-white"
              >
                {t("Status")} <ArrowUpDown className="size-2.5 opacity-60" />
              </Button>
            </th>
            <th className="whitespace-nowrap px-2 py-2.5 font-semibold">{t("Plant Image")}</th>
            <th className="whitespace-nowrap px-2.5 py-2.5 font-semibold">
              <Button
                onClick={() => handleSort("name")}
                variant="ghost"
                size="xs"
                className="h-auto justify-start gap-1 rounded-none p-0 text-[11px] font-semibold tracking-wider text-slate-400 hover:bg-transparent hover:text-white"
              >
                {t("Plant Name")} <ArrowUpDown className="size-2.5 opacity-60" />
              </Button>
            </th>
            <th className="whitespace-nowrap px-2 py-2.5 font-semibold">
              <Button
                onClick={() => handleSort("location")}
                variant="ghost"
                size="xs"
                className="h-auto justify-start gap-1 rounded-none p-0 text-[11px] font-semibold tracking-wider text-slate-400 hover:bg-transparent hover:text-white"
              >
                {t("Country/Region")} <ArrowUpDown className="size-2.5 opacity-60" />
              </Button>
            </th>
            <th className="whitespace-nowrap px-2 py-2.5 font-semibold">
              <Button
                onClick={() => handleSort("createdDate")}
                variant="ghost"
                size="xs"
                className="h-auto justify-start gap-1 rounded-none p-0 text-[11px] font-semibold tracking-wider text-slate-400 hover:bg-transparent hover:text-white"
              >
                {t("Grid Connecti...")} <ArrowUpDown className="size-2.5 opacity-60" />
              </Button>
            </th>
            <th className="whitespace-nowrap px-2 py-2.5 text-right font-semibold">
              <Button
                onClick={() => handleSort("capacityKwp")}
                title={t("Total String Capacity (kWp)")}
                variant="ghost"
                size="xs"
                className="h-auto justify-end gap-1 rounded-none p-0 text-[11px] font-semibold tracking-wider text-slate-400 hover:bg-transparent hover:text-white"
              >
                {t("String Cap (kWp)")} <ArrowUpDown className="size-2.5 opacity-60" />
              </Button>
            </th>
            <th className="whitespace-nowrap px-2 py-2.5 text-right font-semibold">
              <Button
                onClick={() => handleSort("stringsCount")}
                variant="ghost"
                size="xs"
                className="h-auto justify-end gap-1 rounded-none p-0 text-[11px] font-semibold tracking-wider text-slate-400 hover:bg-transparent hover:text-white"
              >
                {t("Inverters")} <ArrowUpDown className="size-2.5 opacity-60" />
              </Button>
            </th>
            <th className="whitespace-nowrap px-2 py-2.5 font-semibold">{t("Battery")}</th>
            <th className="whitespace-nowrap px-2 py-2.5 text-right font-semibold">
              <Button
                onClick={() => handleSort("currentPowerKw")}
                variant="ghost"
                size="xs"
                className="h-auto justify-end gap-1 rounded-none p-0 text-[11px] font-semibold tracking-wider text-slate-400 hover:bg-transparent hover:text-white"
              >
                {t("Current Power (kW)")} <ArrowUpDown className="size-2.5 opacity-60" />
              </Button>
            </th>
            <th className="whitespace-nowrap px-2 py-2.5 text-right font-semibold">
              <Button
                onClick={() => handleSort("specificEnergyKwhPerKwp")}
                title={t("Specific Energy (kWh/kWp)")}
                variant="ghost"
                size="xs"
                className="h-auto justify-end gap-1 rounded-none p-0 text-[11px] font-semibold tracking-wider text-slate-400 hover:bg-transparent hover:text-white"
              >
                {t("Specific Energy")} <ArrowUpDown className="size-2.5 opacity-60" />
              </Button>
            </th>
            <th className="whitespace-nowrap px-2 py-2.5 text-right font-semibold">
              <Button
                onClick={() => handleSort("yieldTodayKwh")}
                variant="ghost"
                size="xs"
                className="h-auto justify-end gap-1 rounded-none p-0 text-[11px] font-semibold tracking-wider text-slate-400 hover:bg-transparent hover:text-white"
              >
                {t("Yield Today (kWh)")} <ArrowUpDown className="size-2.5 opacity-60" />
              </Button>
            </th>
            <th className="whitespace-nowrap px-2.5 py-2.5 text-right font-semibold">
              <Button
                onClick={() => handleSort("totalEnergyKwh")}
                variant="ghost"
                size="xs"
                className="h-auto justify-end gap-1 rounded-none p-0 text-[11px] font-semibold tracking-wider text-slate-400 hover:bg-transparent hover:text-white"
              >
                {t("Total Yield (kWh)")} <ArrowUpDown className="size-2.5 opacity-60" />
              </Button>
            </th>
          </tr>
        </thead>
        <tbody>
          {filteredPlants.length === 0 ? (
            <tr>
              <td colSpan={12} className="py-12 text-center">
                <div className="mx-auto flex flex-col items-center justify-center gap-2 text-slate-500">
                  <Building2 className="h-8 w-8 stroke-1 text-slate-500" />
                  <div className="text-xs font-medium text-slate-400">{t("No data")}</div>
                  <div className="text-[11px] text-slate-500">
                    {t("No solar plants match the current filter criteria.")}
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
                      title={t("Click to open {name} Overview", { name: p.name })}
                    >
                      <span className="truncate">{p.name}</span>
                      <ArrowUpRight className="h-3 w-3 shrink-0 text-sky-400 opacity-0 transition group-hover:opacity-100" />
                    </div>
                    <div className="mt-0.5 flex items-center gap-1 text-[11px] text-slate-500">
                      <span className="num">#{p.id}</span>
                      {p.phase != null && (
                        <>
                          <span>·</span>
                          <span className="whitespace-nowrap">{t("Phase {n}", { n: p.phase })}</span>
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
                        <span className="font-semibold text-white">{p.invertersCount}</span> {t("Inv")}
                      </div>
                    ) : (
                      "—"
                    )}
                    {p.invLive && (
                      <div
                        className="text-[10px]"
                        title={t(
                          "Live newest records (maxs_data, not stored): {normal} normal, {waiting} waiting, {fault} fault, {offline} offline (no record today){other}; {answered} answered",
                          {
                            normal: p.invLive.normal,
                            waiting: p.invLive.waiting,
                            fault: p.invLive.fault,
                            offline: p.invLive.offline,
                            other: p.invLive.other ? t(", {n} other", { n: p.invLive.other }) : "",
                            answered: p.invertersCount != null ? t("{n} of {total}", { n: p.invLive.answered, total: p.invertersCount }) : p.invLive.answered,
                          }
                        )}
                      >
                        <span className="text-emerald-300">{t("{n} normal", { n: p.invLive.normal })}</span>
                        {p.invLive.waiting > 0 && <span className="text-amber-300"> · {t("{n} waiting", { n: p.invLive.waiting })}</span>}
                        {p.invLive.fault > 0 && <span className="text-red-300"> · {t("{n} fault", { n: p.invLive.fault })}</span>}
                        {p.invLive.offline > 0 && <span className="text-slate-400"> · {t("{n} offline", { n: p.invLive.offline })}</span>}
                      </div>
                    )}
                  </td>

                  {/* 8. Battery */}
                  <td className="whitespace-nowrap px-2 py-2.5 text-[11px] text-slate-500">
                    {p.source === "local" ? t("Grid-Tied") : "--"}
                  </td>

                  {/* 9. Current Power (kW) */}
                  <td className="num whitespace-nowrap px-2 py-2.5 text-right">
                    <div className="font-semibold text-energy-300">{fmt(p.currentPowerKw, 2)}</div>
                    <Progress value={loadPct} className="ml-auto mt-1 h-1 w-14" indicatorClassName="bg-sky-400 duration-150" />
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
