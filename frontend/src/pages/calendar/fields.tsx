/** Calendar Team form fields: a day picker (future allowed, unlike the Site log's), a searchable plant picker and a multi-plant picker. */
import React, { useMemo, useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import type { GrowattPlant } from "../../api/client";
import { dayLabel, fromDate, toDate } from "@/lib/day";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export const DayPicker: React.FC<{
  id: string;
  label: string;
  value: string | null;
  onChange: (d: string) => void;
  min?: string;
  max?: string;
  disabled?: boolean;
}> = ({ id, label, value, onChange, min, max, disabled }) => {
  const [open, setOpen] = useState(false);
  const off = [...(min ? [{ before: toDate(min) }] : []), ...(max ? [{ after: toDate(max) }] : [])];
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button id={id} variant="outline" size="sm" className="num w-full justify-start" disabled={disabled}>
            {value ? dayLabel(value) : <span className="text-slate-500">Pick a day</span>}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            mode="single"
            weekStartsOn={1}
            selected={value ? toDate(value) : undefined}
            defaultMonth={value ? toDate(value) : undefined}
            disabled={off}
            onSelect={(d) => {
              if (!d) return;
              onChange(fromDate(d));
              setOpen(false);
            }}
          />
        </PopoverContent>
      </Popover>
    </div>
  );
};

/** Pick one of the plants the user can see (search by name, city or id). */
export const PlantPicker: React.FC<{
  id: string;
  plants: GrowattPlant[];
  value: number | null;
  onChange: (id: number | null) => void;
  placeholder?: string;
  allowAll?: boolean;
  className?: string;
}> = ({ id, plants, value, onChange, placeholder = "Pick a plant", allowAll, className }) => {
  const [open, setOpen] = useState(false);
  const current = plants.find((p) => p.plant_id === value);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button id={id} variant="outline" size="sm" role="combobox" aria-expanded={open} className={className ?? "w-full justify-between"}>
          <span className="truncate">{current ? current.name : value != null ? `Plant ${value}` : placeholder}</span>
          <ChevronsUpDown data-icon="inline-end" className="opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start">
        <Command>
          <CommandInput placeholder="Search plants…" />
          <CommandList>
            <CommandEmpty>No plant found.</CommandEmpty>
            <CommandGroup>
              {allowAll && (
                <CommandItem
                  value="__all all plants"
                  onSelect={() => {
                    onChange(null);
                    setOpen(false);
                  }}
                >
                  All plants
                </CommandItem>
              )}
              {plants.map((p) => (
                <CommandItem
                  key={p.plant_id}
                  value={`${p.name} ${p.city ?? ""} ${p.plant_id}`}
                  onSelect={() => {
                    onChange(p.plant_id);
                    setOpen(false);
                  }}
                >
                  <span className="truncate">{p.name}</span>
                  <span className="ml-auto text-[11px] text-muted-foreground">{p.city ?? `#${p.plant_id}`}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
};

/** Pick several plants: search, tick, or add / remove a whole phase at once. */
export const PlantMultiPicker: React.FC<{
  id: string;
  plants: GrowattPlant[];
  value: number[];
  onChange: (ids: number[]) => void;
  disabled?: boolean;
}> = ({ id, plants, value, onChange, disabled }) => {
  const [open, setOpen] = useState(false);
  const chosen = useMemo(() => new Set(value), [value]);
  const phases = useMemo(() => [...new Set(plants.map((p) => p.phase).filter((x): x is number => x != null))].sort((a, b) => a - b), [plants]);
  const toggle = (pid: number) => onChange(chosen.has(pid) ? value.filter((x) => x !== pid) : [...value, pid]);
  const setPhase = (ph: number, on: boolean) => {
    const ids = plants.filter((p) => p.phase === ph).map((p) => p.plant_id);
    onChange(on ? [...new Set([...value, ...ids])] : value.filter((x) => !ids.includes(x)));
  };
  const label = value.length === 0 ? "Pick plants" : value.length === 1 ? (plants.find((p) => p.plant_id === value[0])?.name ?? `Plant ${value[0]}`) : `${value.length} plants`;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button id={id} variant="outline" size="sm" role="combobox" aria-expanded={open} className="w-full justify-between" disabled={disabled}>
          <span className="truncate">{label}</span>
          <ChevronsUpDown data-icon="inline-end" className="opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="start">
        {phases.length > 0 && (
          <div className="flex flex-wrap items-center gap-1 border-b border-white/[0.06] p-2">
            {phases.map((ph) => {
              const all = plants.filter((p) => p.phase === ph).every((p) => chosen.has(p.plant_id));
              return (
                <Button key={ph} variant={all ? "secondary" : "outline"} size="xs" onClick={() => setPhase(ph, !all)}>
                  {all ? "−" : "+"} Phase {ph}
                </Button>
              );
            })}
            {value.length > 0 && (
              <Button variant="ghost" size="xs" className="ml-auto" onClick={() => onChange([])}>
                Clear
              </Button>
            )}
          </div>
        )}
        <Command>
          <CommandInput placeholder="Search plants…" />
          <CommandList>
            <CommandEmpty>No plant found.</CommandEmpty>
            <CommandGroup>
              {plants.map((p) => (
                <CommandItem key={p.plant_id} value={`${p.name} ${p.city ?? ""} ${p.plant_id}`} onSelect={() => toggle(p.plant_id)}>
                  <Check className={chosen.has(p.plant_id) ? "opacity-100" : "opacity-0"} />
                  <span className="truncate">{p.name}</span>
                  <span className="ml-auto text-[11px] text-muted-foreground">{p.city ?? `#${p.plant_id}`}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
};
