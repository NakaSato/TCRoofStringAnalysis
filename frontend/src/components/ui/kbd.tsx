import { cn } from "@/lib/utils"

/** Keyboard key hint (restyled to the control-room theme: compact, mono digits, hairline border). */
function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "num pointer-events-none inline-flex h-5 w-fit min-w-5 items-center justify-center gap-1 rounded border border-white/10 bg-ink-850 px-1.5 text-[10px] font-medium text-slate-400 select-none [&_svg:not([class*='size-'])]:size-3",
        className
      )}
      {...props}
    />
  )
}

function KbdGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <kbd
      data-slot="kbd-group"
      className={cn("inline-flex items-center gap-1", className)}
      {...props}
    />
  )
}

export { Kbd, KbdGroup }
