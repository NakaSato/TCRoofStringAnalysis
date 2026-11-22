/* Why a plant needs a visit, as small badges: kind (+ P1 / P2), and the estimated baht per day of an
   issue. The tooltip has the backend's label (translated where the wording is known) and its detail as sent. */
import React from "react";
import type { RouteReason } from "../../api/client";
import { useI18n } from "../../i18n";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { REASON_LABEL, reasonGroup } from "./mapUtils";
import { fmtThb, reasonLabel } from "./format";

const VARIANT = { fault: "crit", task: "info", claim: "default", due: "warn", other: "neutral" } as const;

export const ReasonBadge: React.FC<{ r: RouteReason }> = ({ r }) => {
  const { t } = useI18n();
  const kind = REASON_LABEL[r.kind] ? t(REASON_LABEL[r.kind]) : r.kind;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant={VARIANT[reasonGroup(r.kind)]} className="cursor-default" tabIndex={0}>
          {r.priority && <span className="num">{r.priority}</span>}
          {kind}
          {r.thb_per_day != null && <span className="num font-normal opacity-80">{fmtThb(r.thb_per_day)}{t("/day")} {t("est.")}</span>}
        </Badge>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-72">
        <div className="flex flex-col gap-0.5">
          <span className="font-semibold">{reasonLabel(r.label)}</span>
          {r.detail && <span>{r.detail}</span>}
          {r.since && <span className="text-muted-foreground">{t("Since {when}", { when: r.since.replace("T", " ").slice(0, 16) })}</span>}
          {r.thb_per_day != null && (
            <span className="text-muted-foreground">{t("≈ {thb} per day lost (estimated)", { thb: fmtThb(r.thb_per_day) })}</span>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  );
};

export const ReasonBadges: React.FC<{ reasons: RouteReason[] | undefined; max?: number }> = ({ reasons, max = 4 }) => {
  const { t } = useI18n();
  if (!reasons?.length) return null;
  const shown = reasons.slice(0, max);
  return (
    <span className="flex flex-wrap items-center gap-1">
      {shown.map((r, i) => (
        <ReasonBadge key={`${r.kind}-${r.task_id ?? r.issue_id ?? r.claim_id ?? i}`} r={r} />
      ))}
      {reasons.length > max && <span className="text-[10px] text-muted-foreground">{t("+{n} more", { n: reasons.length - max })}</span>}
    </span>
  );
};
