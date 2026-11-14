/**
 * System → AI Usage (admin): this Bangkok month's AI Assistant spend against the hard cap, answer
 * outcomes, and questions / cost per user. Read from SQL `ai_usage` (token counts and cost only;
 * no question or answer text is stored anywhere).
 */
import React, { useCallback, useEffect, useState } from "react";
import { RefreshCw, Sparkles } from "lucide-react";
import { api } from "../api/client";
import type { AssistantUsage } from "../api/client";
import { EmptyState, KpiTile, LoadingState, Meter, PageHeader, fmt, fmtInt } from "../components/ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const STATUS_LABEL: Record<string, string> = {
  ok: "Answered",
  error: "Error",
  timeout: "Timed out",
  refused: "Refused",
  cancelled: "Stopped",
};

const usd = (v: number | null | undefined, digits = 2) => (v == null ? "—" : `$${fmt(v, digits)}`);

export const AiUsagePage: React.FC = () => {
  const [data, setData] = useState<AssistantUsage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.getAssistantUsage());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = (
    <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
      {loading ? <Spinner data-icon="inline-start" className="size-3" /> : <RefreshCw data-icon="inline-start" className="size-3" />}
      Refresh
    </Button>
  );

  if (!data) {
    return (
      <div className="space-y-4">
        <PageHeader icon={Sparkles} eyebrow="System" title="AI Usage" actions={refresh} />
        {error ? <div className="callout-crit">{error}</div> : <LoadingState label="Loading AI usage…" shape="kpis" />}
      </div>
    );
  }

  const pct = data.budget_usd > 0 ? (data.spent_usd / data.budget_usd) * 100 : null;
  const tone = pct == null ? "neutral" : pct >= 100 ? "crit" : pct >= 80 ? "warn" : "ok";
  const failed = Object.entries(data.by_status)
    .filter(([s]) => s !== "ok")
    .reduce((a, [, n]) => a + n, 0);
  const avg = data.questions ? data.spent_usd / data.questions : null;

  return (
    <div className="space-y-4">
      <PageHeader
        icon={Sparkles}
        eyebrow="System"
        title="AI Usage"
        description={`${data.month} (Bangkok) · ${data.model} · resets on ${data.resets_on}`}
        actions={refresh}
      />
      {error && <div className="callout-warn">Refresh failed: {error}</div>}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card className="col-span-2 gap-2 p-4">
          <div className="flex items-baseline justify-between gap-2">
            <div className="eyebrow">Spent this month</div>
            <Badge variant={tone === "neutral" ? "neutral" : tone}>{pct == null ? "no cap" : `${fmt(pct, 0)} % of cap`}</Badge>
          </div>
          <div className="flex items-baseline gap-1.5">
            <span className="num text-2xl font-bold text-white">{usd(data.spent_usd, 3)}</span>
            <span className="text-xs text-slate-500">of {usd(data.budget_usd)}</span>
          </div>
          <Meter value={data.spent_usd} max={data.budget_usd} tone={tone === "neutral" ? "solar" : tone} />
          <div className="text-[11px] text-slate-500">
            At the cap the assistant answers "budget used up" until {data.resets_on}.
          </div>
        </Card>
        <KpiTile label="Questions" value={fmtInt(data.questions)} hint={`≈ ${usd(avg, 4)} each`} accentBar={false} />
        <KpiTile
          label="Not answered"
          value={fmtInt(failed)}
          unit={data.questions ? `${fmt((failed / data.questions) * 100, 0)} %` : undefined}
          hint="errors, time-outs, stopped"
          hintTone={failed ? "warn" : "neutral"}
          tone={failed ? "warn" : "neutral"}
          accentBar={false}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>By user</CardTitle>
          </CardHeader>
          <CardContent>
            {data.users.length === 0 ? (
              <EmptyState title="No questions this month" description="Usage appears here after the first question." />
            ) : (
              <Table containerClassName="table-wrap">
                <TableHeader>
                  <TableRow>
                    <TableHead>User</TableHead>
                    <TableHead className="text-right">Questions</TableHead>
                    <TableHead className="text-right">Cost</TableHead>
                    <TableHead className="text-right">Input tokens</TableHead>
                    <TableHead className="text-right">Cached</TableHead>
                    <TableHead className="text-right">Output tokens</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.users.map((u) => (
                    <TableRow key={u.user_id}>
                      <TableCell>{u.username ?? `user ${u.user_id}`}</TableCell>
                      <TableCell className="num text-right">{fmtInt(u.questions)}</TableCell>
                      <TableCell className="num text-right">{usd(u.cost_usd, 3)}</TableCell>
                      <TableCell className="num text-right">{fmtInt(u.input_tokens)}</TableCell>
                      <TableCell className="num text-right">
                        {u.input_tokens ? `${fmt((u.cached_tokens / u.input_tokens) * 100, 0)} %` : "—"}
                      </TableCell>
                      <TableCell className="num text-right">{fmtInt(u.output_tokens)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Limits</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-xs">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
              <dt className="text-slate-500">Monthly cap</dt>
              <dd className="num text-right text-slate-200">{usd(data.budget_usd)}</dd>
              <dt className="text-slate-500">Per user per day</dt>
              <dd className="num text-right text-slate-200">{fmtInt(data.user_daily_questions)} questions (admins exempt)</dd>
              <dt className="text-slate-500">Enabled for</dt>
              <dd className="text-right text-slate-200">{data.enabled_roles.join(", ") || "nobody"}</dd>
            </dl>
            <div className="border-t border-white/[0.06] pt-3">
              <div className="eyebrow mb-2">Outcomes</div>
              {Object.keys(data.by_status).length === 0 ? (
                <div className="text-slate-500">—</div>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {Object.entries(data.by_status)
                    .sort((a, b) => b[1] - a[1])
                    .map(([s, n]) => (
                      <Badge key={s} variant={s === "ok" ? "ok" : s === "cancelled" ? "neutral" : "warn"}>
                        {STATUS_LABEL[s] ?? s} · {fmtInt(n)}
                      </Badge>
                    ))}
                </div>
              )}
            </div>
            <p className="text-[11px] text-slate-500">
              Only token counts and cost are stored; no question or answer text. Set a spending limit in the Qwen
              Model Studio console as well.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};
