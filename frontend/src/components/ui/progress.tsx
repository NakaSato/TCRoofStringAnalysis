import * as React from "react"
import { cn } from "@/lib/utils"
import { Progress as ProgressPrimitive } from "radix-ui"

/** Determinate bar, 0–100. `indicatorClassName` sets the fill colour (default solar). */
function Progress({
  className,
  indicatorClassName,
  value,
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root> & { indicatorClassName?: string }) {
  const pct = Math.max(0, Math.min(100, value ?? 0))
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      value={value}
      className={cn(
        "relative flex h-1.5 w-full items-center overflow-hidden rounded-full bg-white/[0.06]",
        className
      )}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className={cn("size-full flex-1 rounded-full bg-solar-400 transition-all duration-700", indicatorClassName)}
        style={{ transform: `translateX(-${100 - pct}%)` }}
      />
    </ProgressPrimitive.Root>
  )
}

export { Progress }
