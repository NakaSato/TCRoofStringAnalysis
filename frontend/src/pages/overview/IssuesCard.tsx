/** Plant Overview: the plant's open issues (decision rules, live rules only): counts by tier,
 * estimated baht per day, the top three; links to `/issues?plant=`. DB only, read once per plant. */
import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { api } from "../../api/client";
import { useAppContext } from "../../context/AppContext";
import { isAdmin } from "../../auth/access";
import type { IssueList } from "../../api/client";
import { EntityLink, TIERS, TierBadge, thb } from "../../components/issues";
import { fmtInt } from "../../components/ui";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export const IssuesCard: React.FC<{ plantId: number }> = ({ plantId }) => {
  const [data, setData] = useState<IssueList | null>(null);
  const [failed, setFailed] = useState(false);
  const [shadow, setShadow] = useState<number | null>(null);
  const { user } = useAppContext();
  const admin = isAdmin(user);

  useEffect(() => {
    let live = true;
    setData(null);
    setFailed(false);
    api
      .listIssues({ plant_id: plantId })
      .then((d) => live && setData(d))
      .catch(() => live && setFailed(true));
    setShadow(null);
    if (admin)
      api
        .listIssues({ plant_id: plantId, shadow: true })
        .then((d) => live && setShadow(d.summary.active))
        .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [plantId, admin]);

  const href = `/issues?plant=${plantId}`;
  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle>Issues</CardTitle>
        <CardAction>
          <Button asChild variant="ghost" size="icon-sm" aria-label="All issues of this plant" title="All issues of this plant">
            <Link to={href}>
              <ArrowRight />
            </Link>
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-xs">
        {failed ? (
          <span className="text-muted-foreground">Issues unavailable</span>
        ) : !data ? (
          <Skeleton className="h-10 w-full" aria-label="Loading issues…" />
        ) : data.summary.active === 0 ? (
          <span className="text-muted-foreground">No open issues</span>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2" title="Estimated: lost kWh priced with the tariff, mean of the last 3 days">
              {TIERS.filter((t) => data.summary.by_tier[t]).map((t) => (
                <span key={t} className="flex items-center gap-1">
                  <TierBadge tier={t} />
                  <span className="num text-white">{fmtInt(data.summary.by_tier[t])}</span>
                </span>
              ))}
              <span className="num ml-auto text-sm text-white">
                {thb(data.summary.thb_per_day_est)}
                <span className="text-[11px] text-slate-500"> /day est.</span>
              </span>
            </div>
            {data.issues.slice(0, 3).map((i) => (
              <div key={i.id} className="flex items-center gap-2">
                <TierBadge tier={i.tier} />
                <span className="truncate">
                  {i.name} · <EntityLink issue={i} />
                </span>
                <span className="num ml-auto text-slate-400">{thb(i.thb_per_day_est)}</span>
              </div>
            ))}
          </>
        )}
        {admin && shadow ? (
          <Link to={`${href}&view=shadow`} className="text-[11px] text-slate-500 hover:underline" title="Rules still in shadow mode: engineers don't see these">
            {fmtInt(shadow)} more in shadow mode (admin only)
          </Link>
        ) : null}
      </CardContent>
    </Card>
  );
};
