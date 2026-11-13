import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"
import { Slot } from "radix-ui"

const badgeVariants = cva(
  "group/badge inline-flex w-fit shrink-0 items-center justify-center gap-1 rounded-full border px-2 py-0.5 has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 text-[10px] font-semibold whitespace-nowrap transition-all focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 [&>svg]:pointer-events-none [&>svg]:size-3!",
  {
    variants: {
      variant: {
        default: "border-solar-400/30 bg-solar-500/15 text-solar-300",
        ok: "border-emerald-400/25 bg-emerald-400/10 text-emerald-300",
        warn: "border-amber-400/25 bg-amber-400/10 text-amber-300",
        crit: "border-red-400/30 bg-red-500/10 text-red-300",
        info: "border-sky-400/25 bg-sky-400/10 text-sky-300",
        neutral: "border-white/10 bg-white/5 text-slate-400",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        destructive: "border-red-400/30 bg-red-500/10 text-red-300",
        outline: "border-border text-foreground",
      },
    },
    defaultVariants: {
      variant: "neutral",
    },
  }
)

function Badge({
  className,
  variant = "neutral",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span"

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  )
}

export { Badge, badgeVariants }
