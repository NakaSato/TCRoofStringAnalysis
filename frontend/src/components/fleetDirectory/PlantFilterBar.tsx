/** Plant directory filter toolbar (name, region, device type, phase, plant ID, status) with Sync / Add Plant. */
import React from "react";
import { Link } from "react-router-dom";
import { RefreshCw, ChevronDown, ChevronUp, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import type { FleetDirectory } from "./useFleetDirectory";

export const PlantFilterBar: React.FC<{ d: FleetDirectory }> = ({ d }) => {
  const { loadingCloud, cloudNotice, plantNameFilter, setPlantNameFilter, regionFilter, setRegionFilter, deviceTypeFilter, setDeviceTypeFilter, phaseFilter, setPhaseFilter, deviceSnFilter, setDeviceSnFilter, statusFilter, setStatusFilter, expandedFilters, setExpandedFilters, setCurrentPage, fetchCloudPlants, phaseOptions, handleResetFilters } = d;
  return (
    <div className="border-b border-white/[0.07] bg-ink-900/70 px-4 py-3.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          {/* Plant name */}
          <div className="flex items-center gap-1.5">
            <label className="whitespace-nowrap text-[11px] font-medium text-slate-300">
              Plant name
            </label>
            <Input
              type="text"
              value={plantNameFilter}
              onChange={(e) => {
                setPlantNameFilter(e.target.value);
                setCurrentPage(1);
              }}
              placeholder="Plant name"
              className="h-7 w-28 px-2 text-[11px]"
            />
          </div>

          {/* Country/Region */}
          <div className="flex items-center gap-1.5">
            <label className="whitespace-nowrap text-[11px] font-medium text-slate-300">
              Country/Region
            </label>
            <Input
              type="text"
              value={regionFilter}
              onChange={(e) => {
                setRegionFilter(e.target.value);
                setCurrentPage(1);
              }}
              placeholder="Country/Region"
              className="h-7 w-28 px-2 text-[11px]"
            />
          </div>

          {/* Device type */}
          <div className="flex items-center gap-1.5">
            <label className="whitespace-nowrap text-[11px] font-medium text-slate-300">
              Device type
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
                <SelectItem value="ALL">All</SelectItem>
                <SelectItem value="String Inverter (SCADA)">SCADA String</SelectItem>
                <SelectItem value="Growatt MAX Inverter">Growatt MAX</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Project phase (one Growatt account per phase) */}
          <div className="flex items-center gap-1.5">
            <label className="whitespace-nowrap text-[11px] font-medium text-slate-300">
              Phase
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
                <SelectItem value="ALL">All phases</SelectItem>
                {phaseOptions.phases.map(([ph, n]) => (
                  <SelectItem key={ph} value={String(ph)}>
                    Phase {ph} ({n})
                  </SelectItem>
                ))}
                {phaseOptions.untagged > 0 && (
                  <SelectItem value="NONE">Untagged ({phaseOptions.untagged})</SelectItem>
                )}
              </SelectContent>
            </Select>
          </div>

          {/* Device SN */}
          <div className="flex items-center gap-1.5">
            <label className="whitespace-nowrap text-[11px] font-medium text-slate-300">
              Plant ID
            </label>
            <Input
              type="text"
              value={deviceSnFilter}
              onChange={(e) => {
                setDeviceSnFilter(e.target.value);
                setCurrentPage(1);
              }}
              placeholder="Plant ID"
              className="h-7 w-24 px-2 text-[11px]"
            />
          </div>

          {/* Expand toggle */}
          <button
            type="button"
            onClick={() => setExpandedFilters((v) => !v)}
            className="inline-flex items-center gap-0.5 px-1 text-[11px] font-medium text-sky-400 transition hover:text-sky-300"
          >
            {expandedFilters ? "Collapse" : "Expand"}
            {expandedFilters ? (
              <ChevronUp className="h-3.5 w-3.5" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5" />
            )}
          </button>

          {/* Search & Reset buttons */}
          <button
            type="button"
            onClick={() => fetchCloudPlants(false)}
            className="inline-flex cursor-pointer items-center gap-1 rounded-md bg-sky-600 px-3 py-1 text-[11px] font-semibold text-white shadow-sm transition hover:bg-sky-500"
          >
            Search
          </button>
          <Button
            type="button"
            onClick={handleResetFilters}
            size="sm"
          >
            Reset
          </Button>
        </div>

        {/* Right actions: Sync Cloud + Add Plant */}
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            onClick={() => fetchCloudPlants(true)}
            disabled={loadingCloud}
            variant="ghost"
            size="sm"
            title="Refresh Growatt Cloud Plants"
          >
            {loadingCloud ? <Spinner data-icon="inline-start" className="size-3" /> : <RefreshCw data-icon="inline-start" />}
            Sync
          </Button>
          <Link
            to="/settings"
            className="inline-flex items-center gap-1 rounded-md bg-sky-600 px-3 py-1 text-[11px] font-semibold text-white shadow-sm transition hover:bg-sky-500"
          >
            <Plus className="h-3 w-3" />
            Add Plant
          </Link>
        </div>
      </div>

      {/* Expandable secondary filters */}
      {expandedFilters && (
        <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-white/[0.06] pt-3 text-xs">
          <span className="text-slate-400">Plant Status:</span>
          {(["ALL", "Normal", "Faulty", "Disconnected"] as const).map((st) => (
            <button
              key={st}
              onClick={() => {
                setStatusFilter(st);
                setCurrentPage(1);
              }}
              className={`rounded-md px-2.5 py-1 text-[11px] font-semibold transition ${
                statusFilter === st
                  ? "bg-sky-500/20 text-sky-300 ring-1 ring-sky-400/40"
                  : "bg-white/5 text-slate-400 hover:text-slate-200"
              }`}
            >
              {st === "ALL" ? "All Statuses" : st}
            </button>
          ))}
          {cloudNotice && (
            <span className="ml-auto text-[11px] text-amber-300/90">
              Cloud API status: {cloudNotice}
            </span>
          )}
        </div>
      )}
    </div>
  );
};
