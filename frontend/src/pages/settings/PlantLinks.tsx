import React from "react";
import { Link } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import { useAppContext, usePlantHref } from "../../context/AppContext";
import { isAdmin } from "../../auth/access";
import { Card } from "@/components/ui/card";
import { useI18n } from "../../i18n";
import { SectionHeader } from "./shared";

/** Settings that belong to one plant (or one user) live elsewhere; this lists where. */
export const PlantLinks: React.FC = () => {
  const { user, selectedGrowattPlantId } = useAppContext();
  const plantHref = usePlantHref();
  const { t } = useI18n();
  const items = [
    {
      to: plantHref("string-layout"),
      title: t("String Layout"),
      text: selectedGrowattPlantId
        ? t("Modules per string and module Wp of the selected plant. A blank Wp uses the fleet PV module.")
        : t("Modules per string and module Wp of one plant (open a plant first). A blank Wp uses the fleet PV module."),
    },
    { to: "/settings?tab=price", title: t("Flat rate"), text: t("A plant's own price per kWh (PPA / PWA contract) instead of the TOU tariff.") },
    { to: "/calendar?view=due", title: t("Cleaning crew-days and cost"), text: t("Entered per plant on the Calendar's Due view; used for cleaning rounds.") },
    ...(isAdmin(user) ? [{ to: "/users", title: t("Users & Access"), text: t("Which plants each engineer can see.") }] : []),
  ];
  return (
    <div className="space-y-4">
      <SectionHeader title={t("Per-plant settings")} description={t("Not global: these are set on a plant, or on another page.")} />
      <Card className="gap-0 divide-y divide-white/[0.06] py-0">
        {items.map((i) => (
          <Link key={i.title} to={i.to} className="group flex items-center gap-3 px-4 py-3 transition-colors hover:bg-white/[0.03]">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-white">{i.title}</div>
              <div className="text-xs text-muted-foreground">{i.text}</div>
            </div>
            <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
          </Link>
        ))}
      </Card>
    </div>
  );
};
