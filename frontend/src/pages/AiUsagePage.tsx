/**
 * System → AI Usage (admin): this Bangkok month's AI Assistant spend against the hard cap, answer
 * outcomes, and questions / cost per user. Read from SQL `ai_usage` (token counts and cost only;
 * no question or answer text is stored anywhere).
 */
import React, { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { api } from "../api/client";
import type { AssistantUsage } from "../api/client";
import { Meter, SkeletonKpis, Suspended, fmt, fmtInt } from "../components/ui";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { StatTile } from "./overview/StatTile";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useI18n } from "../i18n";

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
  const { t } = useI18n();
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
      {t("Refresh")}
    </Button>
  );

  const header = (subtitle: string) => (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex flex-col">
        <h1 className="text-lg font-semibold">{t("AI Usage")}</h1>
        <p className="text-xs text-muted-foreground">{subtitle}</p>
      </div>
      {refresh}
    </div>
  );

  if (!data) {
    return (
      <div className="flex flex-col gap-4">
        {header(t("AI Assistant spend against the monthly cap"))}
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : (
          <SkeletonKpis count={3} />
        )}
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
    <div className="flex flex-col gap-4">
      {header(t("{month} (Bangkok) · {model} · resets on {day}", { month: data.month, model: data.model, day: data.resets_on }))}
      <Suspended busy={loading} label={t("Loading AI usage…")} contentClassName="flex flex-col gap-4">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{t("Refresh failed: {error}", { error })}</AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <div className="col-span-2 lg:col-span-1">
          <StatTile
            label={t("Spent this month")}
            tag={pct == null ? t("no cap") : t("{pct} % of cap", { pct: fmt(pct, 0) })}
            tagWarn={tone === "warn" || tone === "crit"}
            value={usd(data.spent_usd, 3)}
            unit={t("of {total}", { total: usd(data.budget_usd) })}
            tone={tone === "crit" ? "text-red-300" : tone === "warn" ? "text-amber-300" : undefined}
            meter={<Meter value={data.spent_usd} max={data.budget_usd} tone={tone === "neutral" ? "solar" : tone} />}
            footer={t('At the cap the assistant answers "budget used up" until {day}.', { day: data.resets_on })}
          />
        </div>
        <StatTile label={t("Questions")} value={fmtInt(data.questions)} footer={t("≈ {cost} each", { cost: usd(avg, 4) })} />
        <StatTile
          label={t("Not answered")}
          value={fmtInt(failed)}
          unit={data.questions ? `${fmt((failed / data.questions) * 100, 0)} %` : undefined}
          tone={failed ? "text-amber-300" : undefined}
          footer={t("errors, time-outs, stopped")}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>{t("By user")}</CardTitle>
          </CardHeader>
          <CardContent>
            {data.users.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>{t("No questions this month")}</EmptyTitle>
                  <EmptyDescription>{t("Usage appears here after the first question.")}</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <Table containerClassName="table-wrap">
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("User")}</TableHead>
                    <TableHead className="text-right">{t("Questions")}</TableHead>
                    <TableHead className="text-right">{t("Cost")}</TableHead>
                    <TableHead className="text-right">{t("Input tokens")}</TableHead>
                    <TableHead className="text-right">{t("Cached")}</TableHead>
                    <TableHead className="text-right">{t("Output tokens")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.users.map((u) => (
                    <TableRow key={u.user_id}>
                      <TableCell>{u.username ?? t("user {id}", { id: u.user_id })}</TableCell>
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
            <CardTitle>{t("Limits")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-xs">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
              <dt className="text-muted-foreground">{t("Monthly cap")}</dt>
              <dd className="num text-right">{usd(data.budget_usd)}</dd>
              <dt className="text-muted-foreground">{t("Per user per day")}</dt>
              <dd className="num text-right">{t("{n} questions (admins exempt)", { n: fmtInt(data.user_daily_questions) })}</dd>
              <dt className="text-muted-foreground">{t("Enabled for")}</dt>
              <dd className="text-right">{data.enabled_roles.map((r) => t(r)).join(", ") || t("nobody")}</dd>
            </dl>
            <div className="border-t border-white/[0.06] pt-3">
              <div className="eyebrow mb-2">{t("Outcomes")}</div>
              {Object.keys(data.by_status).length === 0 ? (
                <div className="text-muted-foreground">—</div>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {Object.entries(data.by_status)
                    .sort((a, b) => b[1] - a[1])
                    .map(([s, n]) => (
                      <Badge key={s} variant={s === "ok" ? "ok" : s === "cancelled" ? "neutral" : "warn"}>
                        {STATUS_LABEL[s] ? t(STATUS_LABEL[s]) : s} · {fmtInt(n)}
                      </Badge>
                    ))}
                </div>
              )}
            </div>
            <p className="text-[11px] text-muted-foreground">
              {t("Only token counts and cost are stored; no question or answer text. Set a spending limit in the Qwen Model Studio console as well.")}
            </p>
          </CardContent>
        </Card>
      </div>
      </Suspended>
    </div>
  );
};
