import { toast } from "@/components/ui/toast";

export type NotifyTone = "ok" | "warn" | "crit";

const TYPE = { ok: "success", warn: "warning", crit: "error" } as const;

/**
 * The outcome of a save as a toast (`<Toaster>` is mounted in `App`). Warnings and failures stay
 * longer, and a failure is announced to screen readers at once.
 */
export const notify = (tone: NotifyTone, text: string) =>
  toast.add({
    title: text,
    type: TYPE[tone],
    timeout: tone === "ok" ? 5000 : 10000,
    priority: tone === "crit" ? "high" : "low",
  });
