/** Plant Overview: compact icon + number tiles. The label lives in the tooltip (and for screen readers), not on the page. */
import React from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { AnimatedNumber } from "@/components/ui/animated-number";
import { fmt } from "../../components/ui";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export const IconStat: React.FC<{
  icon: LucideIcon;
  /** what the number is; shown on hover / focus */
  label: string;
  /** formatted value; or pass `num` instead for a live reading that eases between polls */
  value?: string;
  num?: number | null;
  /** decimals of `num` */
  digits?: number;
  unit?: string;
  /** extra line in the tooltip (source, time, "modelled"…) */
  hint?: string;
  tone?: string;
  className?: string;
}> = ({ icon: Icon, label, value: text, num, digits = 1, unit, hint, tone, className }) => {
  const value = num !== undefined ? fmt(num, digits) : (text ?? "—");
  return (
  <Tooltip>
    <TooltipTrigger asChild>
      <div
        tabIndex={0}
        aria-label={`${label}: ${value}${value !== "—" && unit ? ` ${unit}` : ""}`}
        className={cn(
          "flex min-w-0 items-center gap-2 rounded-md bg-white/[0.025] px-2.5 py-2 outline-none focus-visible:ring-1 focus-visible:ring-white/20",
          className
        )}
      >
        <Icon className="size-4 shrink-0 text-slate-500" aria-hidden />
        <span className="num truncate">
          <span className={cn("text-sm font-semibold text-slate-100", tone)}>
            {num !== undefined ? <AnimatedNumber value={num} digits={digits} /> : value}
          </span>
          {value !== "—" && unit && <span className="ml-1 text-[11px] text-muted-foreground">{unit}</span>}
        </span>
      </div>
    </TooltipTrigger>
    <TooltipContent>
      <span className="flex flex-col">
        <span className="font-medium">{label}</span>
        {hint && <span className="text-muted-foreground">{hint}</span>}
      </span>
    </TooltipContent>
  </Tooltip>
  );
};

/** Grid of IconStats. */
export const IconStats: React.FC<{ children: React.ReactNode; cols?: string }> = ({ children, cols = "grid-cols-2 sm:grid-cols-3" }) => (
  <div className={cn("grid gap-1.5", cols)}>{children}</div>
);
