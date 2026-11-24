/** Plant directory filter toolbar (name, province, device type, phase, engineer (admins), status). */
import React from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { FleetDirectory } from "./useFleetDirectory";
import { useI18n } from "../../i18n";

export const PlantFilterBar: React.FC<{ d: FleetDirectory }> = ({ d }) => {
  const { cloudNotice, plantNameFilter, setPlantNameFilter, provinceFilter, setProvinceFilter, provinceOptions, deviceTypeFilter, setDeviceTypeFilter, phaseFilter, setPhaseFilter, statusFilter, setStatusFilter, isAdmin, engineers, engineerFilter, setEngineerFilter, expandedFilters, setExpandedFilters, setCurrentPage, fetchCloudPlants, phaseOptions, handleResetFilters } = d;
  const { t } = useI18n();
  return (
    <div className="border-b border-white/[0.07] bg-ink-900/70 px-4 py-3.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          {/* Plant name */}
          <div className="flex items-center gap-1.5">
            <label className="whitespace-nowrap text-[11px] font-medium text-slate-300">
              {t("Plant name")}
            </label>
            <Input
              type="text"
              value={plantNameFilter}
              onChange={(e) => {
                setPlantNameFilter(e.target.value);
                setCurrentPage(1);
              }}
              placeholder={t("Plant name")}
              className="h-7 w-28 px-2 text-[11px]"
            />
          </div>

          {/* Province (O&M site register, Growatt city as fallback) */}
          <div className="flex items-center gap-1.5">
            <label className="whitespace-nowrap text-[11px] font-medium text-slate-300">
              {t("Province")}
            </label>
            <Select
              value={provinceFilter}
              onValueChange={(v) => {
                setProvinceFilter(v);
                setCurrentPage(1);
              }}
            >
              <SelectTrigger size="sm" className="w-36 text-[11px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">{t("All provinces")}</SelectItem>
                {provinceOptions.provinces.map(([name, n]) => (
                  <SelectItem key={name} value={name}>
                    {name} ({n})
                  </SelectItem>
                ))}
                {provinceOptions.unset > 0 && (
                  <SelectItem value="NONE">{t("No province")} ({provinceOptions.unset})</SelectItem>
                )}
              </SelectContent>
            </Select>
          </div>

          {/* Device type */}
          <div className="flex items-center gap-1.5">
            <label className="whitespace-nowrap text-[11px] font-medium text-slate-300">
              {t("Device type")}
            </label>
            <Select
              value={deviceTypeFilter}
              onValueChange={(v) => {
                setDeviceTypeFilter(v);
                setCurrentPage(1);
              }}
            >
              <SelectTrigger size="sm" className="w-28 text-[11px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">{t("All")}</SelectItem>
                <SelectItem value="String Inverter (SCADA)">SCADA String</SelectItem>
                <SelectItem value="Growatt MAX Inverter">Growatt MAX</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Project phase (one Growatt account per phase) */}
          <div className="flex items-center gap-1.5">
            <label className="whitespace-nowrap text-[11px] font-medium text-slate-300">
              {t("Phase")}
            </label>
            <Select
              value={String(phaseFilter)}
              onValueChange={(v) => {
                setPhaseFilter(v === "ALL" || v === "NONE" ? v : Number(v));
                setCurrentPage(1);
              }}
            >
              <SelectTrigger size="sm" className="w-28 text-[11px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">{t("All phases")}</SelectItem>
                {phaseOptions.phases.map(([ph, n]) => (
                  <SelectItem key={ph} value={String(ph)}>
                    {t("Phase {n}", { n: ph })} ({n})
                  </SelectItem>
                ))}
                {phaseOptions.untagged > 0 && (
                  <SelectItem value="NONE">{t("Untagged")} ({phaseOptions.untagged})</SelectItem>
                )}
              </SelectContent>
            </Select>
          </div>

          {/* Engineer (admins only: engineers see only their own plants) */}
          {isAdmin && (
            <div className="flex items-center gap-1.5">
              <label className="whitespace-nowrap text-[11px] font-medium text-slate-300">
                {t("Engineer")}
              </label>
              <Select
                value={String(engineerFilter)}
                onValueChange={(v) => {
                  setEngineerFilter(v === "ALL" || v === "NONE" ? v : Number(v));
                  setCurrentPage(1);
                }}
              >
                <SelectTrigger size="sm" className="w-36 text-[11px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">{t("All engineers")}</SelectItem>
                  {engineers.map((u) => (
                    <SelectItem key={u.id} value={String(u.id)}>
                      {u.full_name || u.username} ({u.plant_ids?.length ?? 0})
                    </SelectItem>
                  ))}
                  <SelectItem value="NONE">{t("No engineer assigned")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Expand toggle */}
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => setExpandedFilters((v) => !v)}
            className="h-auto gap-0.5 rounded-none px-1 py-0 text-[11px] font-medium text-sky-400 hover:bg-transparent hover:text-sky-300"
          >
            {expandedFilters ? t("Collapse") : t("Expand")}
            {expandedFilters ? (
              <ChevronUp className="size-3.5" />
            ) : (
              <ChevronDown className="size-3.5" />
            )}
          </Button>

          {/* Search & Reset buttons */}
          <Button
            type="button"
            size="sm"
            onClick={() => fetchCloudPlants(false)}
            className="h-auto rounded-md border-transparent bg-sky-600 px-3 py-1 text-white shadow-sm hover:border-transparent hover:bg-sky-500"
          >
            {t("Search")}
          </Button>
          <Button
            type="button"
            onClick={handleResetFilters}
            size="sm"
          >
            {t("Reset")}
          </Button>
        </div>
      </div>

      {/* Expandable secondary filters */}
      {expandedFilters && (
        <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-white/[0.06] pt-3 text-xs">
          <span className="text-slate-400">{t("Plant Status")}:</span>
          <ToggleGroup
            type="single"
            size="sm"
            spacing={3}
            value={statusFilter}
            onValueChange={(v) => {
              // Clicking the pressed chip again gives "": keep it selected, as before.
              setStatusFilter((v || statusFilter) as typeof statusFilter);
              setCurrentPage(1);
            }}
            className="flex-wrap"
          >
            {(["ALL", "Normal", "Faulty", "Disconnected"] as const).map((st) => (
              <ToggleGroupItem
                key={st}
                value={st}
                className="h-auto rounded-md bg-white/5 px-2.5 py-1 text-[11px] font-semibold text-slate-400 hover:bg-white/5 hover:text-slate-200 data-[state=on]:border-transparent data-[state=on]:bg-sky-500/20 data-[state=on]:text-sky-300 data-[state=on]:ring-1 data-[state=on]:ring-sky-400/40"
              >
                {st === "ALL" ? t("All Statuses") : t(st)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          {cloudNotice && (
            <span className="ml-auto text-[11px] text-amber-300/90">
              {t("Cloud API status")}: {cloudNotice}
            </span>
          )}
        </div>
      )}
    </div>
  );
};
