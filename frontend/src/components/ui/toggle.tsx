import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"
import { Toggle as TogglePrimitive } from "radix-ui"

const toggleVariants = cva(
  "group/toggle inline-flex shrink-0 cursor-pointer items-center justify-center gap-1 rounded-lg border border-transparent text-xs font-medium whitespace-nowrap text-slate-400 transition-all outline-none select-none hover:bg-white/5 hover:text-slate-100 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive data-[state=on]:border-white/10 data-[state=on]:bg-secondary data-[state=on]:font-semibold data-[state=on]:text-secondary-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
  {
    variants: {
      variant: {
        /** ghost when off, the secondary button look when on */
        default: "",
        outline: "border-white/10 text-slate-200 hover:border-white/20",
        /** cyan energy fill when on (multi-select chips, e.g. weekdays) */
        accent:
          "border-white/10 text-slate-200 hover:border-white/20 data-[state=on]:border-energy-400/40 data-[state=on]:bg-energy-500/15 data-[state=on]:text-energy-300",
      },
      size: {
        default: "h-8 min-w-8 px-3 has-data-[icon=inline-end]:pr-2.5 has-data-[icon=inline-start]:pl-2.5",
        xs: "h-6 min-w-6 gap-1 px-2 text-[10px] [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 min-w-7 px-2.5 text-[11px] [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-7",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Toggle({
  className,
  variant = "default",
  size = "default",
  ...props
}: React.ComponentProps<typeof TogglePrimitive.Root> &
  VariantProps<typeof toggleVariants>) {
  return (
    <TogglePrimitive.Root
      data-slot="toggle"
      className={cn(toggleVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Toggle, toggleVariants }
