import React from "react";
import { Banknote, Cpu, Layers } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useAppContext } from "../context/AppContext";
import { isAdmin } from "../auth/access";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { pick, useUrlState } from "@/lib/useUrlState";
import { cn } from "@/lib/utils";
import { useI18n } from "../i18n";
import { ModuleSettings } from "./settings/ModuleSettings";
import { PriceSettings } from "./settings/PriceSettings";
import { PlantLinks } from "./settings/PlantLinks";

const SECTIONS = ["module", "price", "plant"] as const;
type Section = (typeof SECTIONS)[number];

const META: Record<Section, { label: string; hint: string; icon: LucideIcon }> = {
  module: { label: "PV module", hint: "Ratings every string uses", icon: Cpu },
  price: { label: "Price per kWh", hint: "TOU, Ft, flat rates, PWA", icon: Banknote },
  plant: { label: "Per-plant settings", hint: "Where they live", icon: Layers },
};

/**
 * Settings (`/settings?tab=module|price|plant`): fleet-wide settings, one section at a time.
 * Sections pick from a side menu on wide screens and from line tabs on phones. Each editable
 * section saves on its own (sticky bar while there are unsaved changes).
 */
export const PlantSettingsPage: React.FC = () => {
  const { user } = useAppContext();
  const { t } = useI18n();
  const [url, setUrl] = useUrlState();
  const tab = pick(url.get("tab"), SECTIONS, "module");
  const go = (s: string) => setUrl({ tab: s === "module" ? null : s });
  const admin = isAdmin(user);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col">
          <h1 className="text-lg font-semibold">{t("Settings")}</h1>
          <p className="text-xs text-muted-foreground">
            {t("Fleet-wide settings that apply to every Growatt plant. Settings that belong to one plant live on that plant's tabs.")}
          </p>
        </div>
        <Badge variant={admin ? "info" : "neutral"}>{admin ? t("Admin: can edit") : t("Read only")}</Badge>
      </div>

      {/* phones: line tabs */}
      <Tabs value={tab} onValueChange={go} className="lg:hidden">
        <TabsList variant="line" className="w-full justify-start overflow-x-auto">
          {SECTIONS.map((s) => (
            <TabsTrigger key={s} value={s}>
              {t(META[s].label)}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <div className="grid gap-6 lg:grid-cols-[13rem_minmax(0,1fr)]">
        {/* wide screens: side menu */}
        <nav aria-label={t("Settings sections")} className="hidden lg:block">
          <ul className="sticky top-4 space-y-1">
            {SECTIONS.map((s) => {
              const { icon: Icon, label, hint } = META[s];
              const active = s === tab;
              return (
                <li key={s}>
                  <button
                    type="button"
                    onClick={() => go(s)}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex w-full items-start gap-2.5 rounded-lg px-3 py-2 text-left transition-colors",
                      active ? "bg-white/[0.06] text-white" : "text-muted-foreground hover:bg-white/[0.03] hover:text-white"
                    )}
                  >
                    <Icon className={cn("mt-0.5 size-4 shrink-0", active && "text-solar-400")} />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium">{t(label)}</span>
                      <span className="block text-[11px] text-muted-foreground">{t(hint)}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="min-w-0">
          {tab === "module" && <ModuleSettings />}
          {tab === "price" && <PriceSettings />}
          {tab === "plant" && <PlantLinks />}
        </div>
      </div>
    </div>
  );
};
