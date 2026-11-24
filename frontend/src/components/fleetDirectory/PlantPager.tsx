/** Plant directory footer: total, page buttons and page size. */
import React from "react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { FleetDirectory } from "./useFleetDirectory";
import { useI18n } from "../../i18n";
import { pageWindow } from "./parts";

export const PlantPager: React.FC<{ d: FleetDirectory }> = ({ d }) => {
  const { pageSize, setPageSize, setCurrentPage, filteredPlants, totalPages, safePage } = d;
  const { t } = useI18n();
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/[0.07] bg-ink-900/50 px-5 py-3 text-xs text-slate-400">
      <div>
        {t("Total")}: <span className="num font-semibold text-slate-200">{filteredPlants.length}</span>
      </div>
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="xs"
            onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
            disabled={safePage <= 1}
            className="h-auto rounded px-2 py-1 text-xs font-normal text-slate-300 hover:bg-white/10 hover:text-slate-300 disabled:cursor-not-allowed disabled:text-slate-500 disabled:opacity-100"
          >
            ‹
          </Button>
          {pageWindow(safePage, totalPages).map((pg, i) =>
            pg === null ? (
              <span key={`gap-${i}`} className="px-1 text-slate-500">
                …
              </span>
            ) : (
            <Button
              key={pg}
              variant="ghost"
              size="xs"
              onClick={() => setCurrentPage(pg)}
              className={`num h-auto rounded px-2.5 py-0.5 text-xs font-semibold ${
                pg === safePage
                  ? "bg-sky-500/20 text-sky-300 ring-1 ring-sky-400/30 hover:bg-sky-500/20 hover:text-sky-300"
                  : "text-slate-400 hover:bg-white/5 hover:text-slate-200"
              }`}
            >
              {pg}
            </Button>
            )
          )}
          <Button
            variant="ghost"
            size="xs"
            onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
            disabled={safePage >= totalPages}
            className="h-auto rounded px-2 py-1 text-xs font-normal text-slate-300 hover:bg-white/10 hover:text-slate-300 disabled:cursor-not-allowed disabled:text-slate-500 disabled:opacity-100"
          >
            ›
          </Button>
        </div>
        <Select
          value={String(pageSize)}
          onValueChange={(v) => {
            setPageSize(Number(v));
            setCurrentPage(1);
          }}
        >
          <SelectTrigger size="sm" className="w-24 text-[11px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="10">{t("{n} / page", { n: 10 })}</SelectItem>
            <SelectItem value="25">{t("{n} / page", { n: 25 })}</SelectItem>
            <SelectItem value="50">{t("{n} / page", { n: 50 })}</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  );
};
