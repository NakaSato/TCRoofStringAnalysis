/**
 * Issues (fleet-wide): decision-rule issues of the plants the user can see, safety first, then
 * tier and estimated THB/day (docs/plans/decision-rules.md §4.3). DB only (`/growatt/issues`),
 * computed by the worker's `rules_*` jobs. Filters in the URL: `status`, `tier`, `rule`, `plant`,
 * and for admins `view=shadow` (issues of rules still in shadow mode, for calibration).
 * kWh and baht are estimates.
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ListChecks, RefreshCw } from "lucide-react";
import { api } from "../api/client";
import type { Issue, IssueActionName, IssueList, IssueStatusFilter, IssueTier } from "../api/client";
import { useAppContext } from "../context/AppContext";
import { isAdmin } from "../auth/access";
import { pick, useUrlState } from "../lib/useUrlState";
import { plantPath } from "../context/routes";
import { EmptyState, KpiTile, LoadingState, PageHeader, fmt, fmtInt } from "../components/ui";
import {
  EntityLink,
  IssueActionDialog,
  IssueActions,
  StatusBadgeIssue,
  TIERS,
  TIER_HINT,
  TierBadge,
  evidenceText,
  thb,
} from "../components/issues";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

const ALL = "all";
const STATUSES = ["active", "closed", "all"] as const;
const STATUS_TAB: Record<(typeof STATUSES)[number], string> = { active: "Open", closed: "Closed", all: "All" };
const RULES = ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8", "R9", "R10", "R11", "R16", "R17", "R18"] as const;
const PAGE = 100;

export const IssuesPage: React.FC = () => {
  const { user } = useAppContext();
  const admin = isAdmin(user);
  const [params, set] = useUrlState();
  const status = pick(params.get("status"), STATUSES, "active");
  const tier = pick(params.get("tier"), [ALL, ...TIERS] as const, ALL);
  const rule = pick(params.get("rule"), [ALL, ...RULES] as const, ALL);
  const plantParam = params.get("plant");
  const plant = plantParam && /^\d+$/.test(plantParam) ? Number(plantParam) : null;
  const shadowView = admin && params.get("view") === "shadow";

  const [data, setData] = useState<IssueList | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState(PAGE);
  const [dialog, setDialog] = useState<{ issue: Issue; action: Exclude<IssueActionName, "note"> } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(
        await api.listIssues({
          status: status as IssueStatusFilter,
          tier: tier === ALL ? undefined : (tier as IssueTier),
          rule: rule === ALL ? undefined : rule,
          plant_id: plant ?? undefined,
          shadow: shadowView || undefined,
        })
      );
      setError(null);
      setShown(PAGE);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [status, tier, rule, plant, shadowView]);

  useEffect(() => {
    void load();
  }, [load]);

  const onDone = (i: Issue) =>
    setData((d) => (d ? { ...d, issues: d.issues.map((x) => (x.id === i.id ? i : x)) } : d));

  const plants = useMemo(() => {
    const m = new Map<number, string>();
    for (const i of data?.issues ?? []) m.set(i.plant_id, i.plant_name ?? String(i.plant_id));
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [data]);

  const s = data?.summary;
  const refresh = (
    <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
      {loading ? <Spinner data-icon="inline-start" className="size-3" /> : <RefreshCw data-icon="inline-start" className="size-3" />}
      Refresh
    </Button>
  );

  return (
    <div className="space-y-4">
      <PageHeader
        icon={ListChecks}
        eyebrow="Operations"
        title={shadowView ? "Issues · shadow mode" : "Issues"}
        description={
          shadowView
            ? "Issues of rules still in shadow mode: recorded for calibration, not shown to engineers."
            : "What to fix first: rule findings from stored history, ranked by estimated baht lost per day."
        }
        actions={
          <>
            {admin && (
              <Button variant={shadowView ? "accent" : "outline"} size="sm" onClick={() => set({ view: shadowView ? null : "shadow" })}>
                {shadowView ? "Show live issues" : "Shadow issues"}
              </Button>
            )}
            {admin && (
              <Button asChild variant="ghost" size="sm">
                <Link to="/rules">Rule review</Link>
              </Button>
            )}
            {refresh}
          </>
        }
      />
      {error && <div className="callout-crit">{error}</div>}

      {s && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <KpiTile label="Open issues" value={fmtInt(s.active)} accentBar={false} hint={s.safety ? `${s.safety} safety` : undefined} hintTone={s.safety ? "crit" : "neutral"} />
          <KpiTile label="Est. loss / day" value={thb(s.thb_per_day_est)} hint="open issues, mean of last 3 days" accentBar={false} />
          <Card className="col-span-2 gap-2 p-4">
            <div className="eyebrow">By tier (open)</div>
            <div className="flex flex-wrap gap-2">
              {TIERS.map((t) => (
                <button
                  key={t}
                  type="button"
                  title={TIER_HINT[t]}
                  onClick={() => set({ tier: tier === t ? null : t })}
                  className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs ${tier === t ? "border-solar-400/60 bg-solar-500/10" : "border-white/10"}`}
                >
                  <TierBadge tier={t} />
                  <span className="num text-white">{fmtInt(s.by_tier[t] ?? 0)}</span>
                </button>
              ))}
            </div>
          </Card>
        </div>
      )}

      <Card>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Tabs value={status} onValueChange={(v) => set({ status: v === "active" ? null : v })}>
              <TabsList variant="line" className="border-0 p-0">
                {STATUSES.map((st) => (
                  <TabsTrigger key={st} value={st} className="px-3 py-2 text-sm">
                    {STATUS_TAB[st]}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
            <div className="ml-auto flex flex-wrap gap-2">
              <Select value={rule} onValueChange={(v) => set({ rule: v === ALL ? null : v })}>
                <SelectTrigger size="sm" className="w-44" aria-label="Rule">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value={ALL}>All rules</SelectItem>
                    {RULES.map((r) => (
                      <SelectItem key={r} value={r}>
                        {r} ({fmtInt(s?.by_rule[r] ?? 0)})
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <Select value={plant != null ? String(plant) : ALL} onValueChange={(v) => set({ plant: v === ALL ? null : v })}>
                <SelectTrigger size="sm" className="w-52" aria-label="Plant">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value={ALL}>All plants</SelectItem>
                    {plant != null && !plants.some(([id]) => id === plant) && <SelectItem value={String(plant)}>Plant {plant}</SelectItem>}
                    {plants.map(([id, name]) => (
                      <SelectItem key={id} value={String(id)}>
                        {name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
          </div>

          {!data ? (
            <LoadingState label="Loading issues…" shape="table" />
          ) : data.issues.length === 0 ? (
            <EmptyState
              title={status === "active" ? "No open issues" : "No issues"}
              description={
                shadowView
                  ? "No shadow issues match. They appear after the worker's rules jobs run."
                  : "Nothing matches these filters. Rules still in shadow mode are not shown here."
              }
            />
          ) : (
            <Table containerClassName="table-wrap">
              <TableHeader>
                <TableRow>
                  <TableHead>Tier</TableHead>
                  <TableHead>Rule · evidence (last day)</TableHead>
                  <TableHead>Plant</TableHead>
                  <TableHead>Where</TableHead>
                  <TableHead>Since</TableHead>
                  <TableHead className="text-right" title="Estimated: lost kWh priced with the tariff, mean of the last 3 days it fired">
                    ฿ / day (est.)
                  </TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.issues.slice(0, shown).map((i) => (
                  <TableRow key={i.id}>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <TierBadge tier={i.tier} />
                        {i.safety && <Badge variant="crit">Safety</Badge>}
                      </div>
                    </TableCell>
                    <TableCell className="max-w-sm whitespace-normal">
                      <div className="whitespace-nowrap">
                        <span className="num text-slate-400">{i.rule}</span> {i.name}
                      </div>
                      <div className="text-[11px] text-slate-400">{evidenceText(i)}</div>
                      {i.note && <div className="mt-0.5 text-[11px] text-slate-300">“{i.note}”</div>}
                    </TableCell>
                    <TableCell className="max-w-48 whitespace-normal">
                      <Link to={plantPath(i.plant_id)} className="hover:underline">
                        {i.plant_name ?? i.plant_id}
                      </Link>
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      <EntityLink issue={i} />
                      {i.parent_id != null && (
                        <span className="ml-1 text-[11px] text-slate-500" title={`Its inverter has issue #${i.parent_id}`}>
                          ↳ #{i.parent_id}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs">
                      {i.opened_day}
                      <div className="text-slate-500">
                        {i.days_seen} day{i.days_seen === 1 ? "" : "s"} · last {i.last_seen_day}
                      </div>
                    </TableCell>
                    <TableCell className="num text-right" title={i.lost_kwh_est != null ? `≈ ${fmt(i.lost_kwh_est, 1)} kWh/day; total ${thb(i.thb_total_est)}` : undefined}>
                      {thb(i.thb_per_day_est)}
                    </TableCell>
                    <TableCell>
                      <StatusBadgeIssue issue={i} />
                      {i.ack_by && i.status === "acknowledged" && <div className="text-[11px] text-slate-500">{i.ack_by}</div>}
                    </TableCell>
                    <TableCell className="text-right">
                      <IssueActions issue={i} onAction={(action) => setDialog({ issue: i, action })} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {data && data.issues.length > shown && (
            <div className="flex items-center gap-3 text-xs text-slate-500">
              Showing {fmtInt(shown)} of {fmtInt(data.total)}.
              <Button variant="outline" size="xs" onClick={() => setShown((n) => n + PAGE)}>
                Show {fmtInt(Math.min(PAGE, data.issues.length - shown))} more
              </Button>
            </div>
          )}
          {data && data.issues.length <= shown && data.total > data.issues.length && (
            <div className="text-xs text-slate-500">
              Showing the first {fmtInt(data.issues.length)} of {fmtInt(data.total)}. Filter by plant or rule to see the rest.
            </div>
          )}
        </CardContent>
      </Card>

      <IssueActionDialog issue={dialog?.issue ?? null} action={dialog?.action ?? null} onClose={() => setDialog(null)} onDone={onDone} />
    </div>
  );
};
