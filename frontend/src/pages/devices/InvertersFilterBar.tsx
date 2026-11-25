/** Devices page, Inverters tab: search and the filter selects (all in the URL, set through `setUrl`). */
import React from "react";
import { Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useI18n } from "../../i18n";
import { LIVE_STATES, STATE_LABEL } from "./inverters";
import type { InverterFilters } from "./invertersTable";

type SetUrl = (patch: Record<string, string | null>) => void;

const FilterSelect: React.FC<{
  value: string;
  all: string;
  options: Array<[string, string]>;
  label: string;
  width?: string;
  onChange: (v: string | null) => void;
}> = ({ value, all, options, label, width = "min-w-28", onChange }) => (
  <Select value={value || "all"} onValueChange={(v) => onChange(v === "all" ? null : v)}>
    <SelectTrigger size="sm" className={cn("w-auto", width)} aria-label={label}>
      <SelectValue />
    </SelectTrigger>
    <SelectContent>
      <SelectItem value="all">{all}</SelectItem>
      {options.map(([v, l]) => (
        <SelectItem key={v} value={v}>
          {l}
        </SelectItem>
      ))}
    </SelectContent>
  </Select>
);

export const InvertersFilterBar: React.FC<{
  f: InverterFilters;
  phases: number[];
  models: string[];
  fws: string[];
  setUrl: SetUrl;
}> = ({ f, phases, models, fws, setUrl }) => {
  const { t } = useI18n();
  const filtered = !!(f.query || f.phase || f.model || f.fw || f.status || f.show !== "all");
  const set = (key: string) => (v: string | null) => setUrl({ [key]: v });
  return (
    <div className="flex w-full flex-wrap items-center gap-2">
      <InputGroup className="h-8 w-60">
        <InputGroupAddon>
          <Search className="size-3.5" />
        </InputGroupAddon>
        <InputGroupInput value={f.query} onChange={(e) => setUrl({ q: e.target.value || null })} placeholder={t("Plant, inverter, alias or SN")} aria-label={t("Search inverters")} />
        {f.query && (
          <InputGroupAddon align="inline-end">
            <InputGroupButton size="icon-xs" onClick={() => setUrl({ q: null })} aria-label={t("Clear search")}>
              <X className="size-3.5" />
            </InputGroupButton>
          </InputGroupAddon>
        )}
      </InputGroup>
      <FilterSelect value={f.status} all={t("Any status")} options={LIVE_STATES.map((s) => [s, t(STATE_LABEL[s])])} label={t("Status")} onChange={set("status")} />
      {phases.length > 1 && (
        <FilterSelect value={f.phase} all={t("All phases")} options={phases.map((p) => [String(p), t("Phase {n}", { n: p })])} label={t("Phase")} onChange={set("phase")} />
      )}
      <FilterSelect value={f.model} all={t("All models")} options={models.map((m) => [m, m])} label={t("Model")} width="min-w-32" onChange={set("model")} />
      <FilterSelect value={f.fw} all={t("All firmware")} options={fws.map((m) => [m, m])} label={t("Firmware")} width="min-w-32" onChange={set("fw")} />
      <FilterSelect
        value={f.show === "all" ? "" : f.show}
        all={t("All inverters")}
        options={[["limited", t("Limited or switched off")], ["issues", t("With open issues")]]}
        label={t("Show")}
        width="min-w-32"
        onChange={set("show")}
      />
      {filtered && (
        <Button variant="ghost" size="sm" onClick={() => setUrl({ q: null, phase: null, model: null, fw: null, status: null, show: null })}>
          {t("Clear")}
        </Button>
      )}
    </div>
  );
};
