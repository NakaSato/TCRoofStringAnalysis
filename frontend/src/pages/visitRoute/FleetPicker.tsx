/* Searchable picker over the user's Growatt plants (`useFleet().growattPlants`). Plants without a
   usable location are listed but disabled: they can't be routed. */
import React, { useState } from "react";
import { ChevronsUpDown } from "lucide-react";
import type { GrowattPlant } from "../../api/client";
import { useI18n } from "../../i18n";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { plantLocated } from "./format";

export const FleetPicker: React.FC<{
  plants: GrowattPlant[];
  onPick: (plantId: number) => void;
  /** plants shown ticked and not pickable (already stops) */
  takenIds?: ReadonlySet<number>;
  label: React.ReactNode;
  disabled?: boolean;
  variant?: "outline" | "secondary" | "ghost";
  className?: string;
  ariaLabel?: string;
}> = ({ plants, onPick, takenIds, label, disabled, variant = "outline", className, ariaLabel }) => {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant={variant}
          size="sm"
          role="combobox"
          aria-expanded={open}
          aria-label={ariaLabel}
          disabled={disabled}
          className={className ?? "justify-between"}
        >
          <span className="truncate">{label}</span>
          <ChevronsUpDown data-icon="inline-end" className="opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="start">
        <Command>
          <CommandInput placeholder={t("Search plants…")} />
          <CommandList>
            <CommandEmpty>{t("No plant found.")}</CommandEmpty>
            <CommandGroup>
              {plants.map((p) => {
                const located = plantLocated(p);
                const taken = takenIds?.has(p.plant_id) ?? false;
                return (
                  <CommandItem
                    key={p.plant_id}
                    value={`${p.name} ${p.city ?? ""} ${p.plant_id}`}
                    disabled={!located || taken}
                    onSelect={() => {
                      onPick(p.plant_id);
                      setOpen(false);
                    }}
                  >
                    <span className="min-w-0 flex-1 truncate">{p.name}</span>
                    <span className="ml-2 shrink-0 text-[11px] text-muted-foreground">
                      {!located ? t("No location") : taken ? t("In the route") : (p.city ?? `#${p.plant_id}`)}
                    </span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
};
