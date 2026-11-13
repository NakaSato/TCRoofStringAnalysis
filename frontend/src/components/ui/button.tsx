import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"
import { Slot } from "radix-ui"

const buttonVariants = cva(
  "group/button inline-flex shrink-0 cursor-pointer items-center justify-center rounded-lg border border-transparent bg-clip-padding text-xs font-semibold whitespace-nowrap transition-all outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
  {
    variants: {
      variant: {
        /** solar call-to-action (was .btn-primary) */
        default: "border-solar-400/40 bg-primary font-bold text-primary-foreground hover:bg-solar-400",
        /** neutral control (was .btn) */
        secondary: "border-white/10 bg-secondary text-secondary-foreground hover:border-white/20 hover:bg-ink-750",
        outline: "border-white/10 bg-transparent text-slate-200 hover:border-white/20 hover:bg-white/5",
        /** cyan energy action (was .btn-accent) */
        accent: "border-energy-400/40 bg-energy-500/15 text-energy-300 hover:bg-energy-500/25",
        /** (was .btn-danger) */
        destructive: "border-red-500/30 bg-red-500/10 text-red-300 hover:bg-red-500/20 focus-visible:ring-destructive/20",
        /** (was .btn-ghost) */
        ghost: "font-medium text-slate-400 hover:bg-white/5 hover:text-slate-100 aria-expanded:bg-white/5",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-8 gap-1.5 px-3.5",
        xs: "h-6 gap-1 px-2 text-[10px] [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1 px-2.5 text-[11px] [&_svg:not([class*='size-'])]:size-3",
        lg: "h-9 gap-1.5 px-4",
        icon: "size-8",
        "icon-xs": "size-6 [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-7",
        "icon-lg": "size-9",
      },
    },
    defaultVariants: {
      variant: "secondary",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "secondary",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
