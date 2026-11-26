/**
 * Shared pieces of the Issues queue (decision rules, docs/plans/decision-rules.md): tier badge,
 * entity link, evidence line and the acknowledge / resolve / dismiss dialog. kWh and baht are
 * estimates and are labelled so ("est.").
 */
import React, { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import type { Issue, IssueActionName, IssueFeedback, IssueTier } from "../api/client";
import { plantPath } from "../context/routes";
import { newClaimHref } from "@/lib/claimLinks";
import { fmt, fmtInt } from "./ui";
import { translate, useI18n } from "../i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";

export const TIERS: IssueTier[] = ["P1", "P2", "P3", "P4", "Info"];

const TIER_VARIANT: Record<IssueTier, "crit" | "warn" | "info" | "neutral"> = {
  P1: "crit",
  P2: "warn",
  P3: "info",
  P4: "neutral",
  Info: "neutral",
};

export const TIER_HINT: Record<IssueTier, string> = {
  P1: "P1: act today",
  P2: "P2: this week",
  P3: "P3: next planned visit",
  P4: "P4: data / monitoring",
  Info: "Info: no fault, lost opportunity",
};

export const TierBadge: React.FC<{ tier: IssueTier }> = ({ tier }) => {
  const { t } = useI18n();
  return (
    <Badge variant={TIER_VARIANT[tier]} title={t(TIER_HINT[tier])}>
      {tier}
    </Badge>
  );
};

export const STATUS_LABEL: Record<Issue["status"], string> = {
  open: "Open",
  acknowledged: "Acknowledged",
  resolved: "Resolved",
  dismissed: "Dismissed",
};

export const StatusBadgeIssue: React.FC<{ issue: Issue }> = ({ issue }) => {
  const { t } = useI18n();
  const label = t(issue.close_reason === "auto" ? "Closed (auto)" : STATUS_LABEL[issue.status]);
  const variant = issue.status === "open" ? "warn" : issue.status === "acknowledged" ? "info" : "neutral";
  return <Badge variant={variant}>{label}</Badge>;
};

/** Where an issue points: the string page, the inverter, or the plant. */
export const issueHref = (i: Issue): string => {
  if (i.device_sn && i.string_no != null)
    return `${plantPath(i.plant_id, "string")}?sn=${encodeURIComponent(i.device_sn)}&no=${i.string_no}`;
  if (i.device_sn) return `${plantPath(i.plant_id, "inverters")}?sn=${encodeURIComponent(i.device_sn)}`;
  return plantPath(i.plant_id);
};

export const entityLabel = (i: Issue): string => {
  const inv = i.inverter_name || i.device_sn;
  if (inv && i.string_no != null) return `${inv} · PV${i.string_no}`;
  return inv || translate("Plant");
};

export const EntityLink: React.FC<{ issue: Issue }> = ({ issue }) => (
  <Link to={issueHref(issue)} className="text-solar-300 hover:underline">
    {entityLabel(issue)}
  </Link>
);

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** One line saying what the rule saw on the last day it fired. */
export const evidenceText = (i: Issue): string => {
  const e = i.evidence;
  switch (i.rule) {
    case "R1":
      return translate("{min} min below 80 % of peers (median ratio {r}), {hit} of {n} days", {
        min: fmtInt(num(e.low_min)),
        r: fmt(num(e.ratio_median), 2),
        hit: fmtInt(num(e.days_hit)),
        n: fmtInt(num(e.days_judged)),
      });
    case "R2":
      return translate("{min} min at ~0 A while its peers carried current", { min: fmtInt(num(e.open_min)) });
    case "R4":
      return translate("String voltage {v} % below peer voltage for {n} days (per-string MPPT)", { v: fmt(num(e.v_drop_pct), 2), n: fmtInt(num(e.days)) });
    case "R5":
      return translate("Median ratio {r} over {n} days", { r: fmt(num(e.ratio_median_window), 3), n: fmtInt(num(e.days)) });
    case "R6":
      return translate("Peer ratio falling {v} %/month over {n} days (PID / rapid degradation)", { v: fmt(num(e.drop_pct_per_month), 2), n: fmtInt(num(e.days)) });
    case "R7": {
      const p = Array.isArray(e.yf_vs_median_pct) ? (e.yf_vs_median_pct as number[]) : [];
      return translate("Specific yield vs the plant's other inverters: {list}", { list: p.map((x) => `${fmt(x, 1)} %`).join(", ") });
    }
    case "R8":
      return translate("Down {min} min (fault {fault}, off {off}, standby {standby}) · {share} % of plant kWp", {
        min: fmtInt((num(e.fault_min) ?? 0) + (num(e.off_min) ?? 0) + (num(e.standby_min) ?? 0)),
        fault: fmtInt(num(e.fault_min)),
        off: fmtInt(num(e.off_min)),
        standby: fmtInt(num(e.standby_min)),
        share: fmt(num(e.kwp_share_pct), 0),
      });
    case "R10":
      return `EPI ${fmt(num(e.epi), 3)} vs baseline μ=${fmt(num(e.epi_mu), 3)} (σ=${fmt(num(e.epi_sigma), 3)}, ${String(e.trigger ?? "")})`;
    case "R12":
      return translate("Lost to dirt ฿{w} since {by} {day} ({n} days, {r} %/day {basis}, est.) ≥ cleaning cost ฿{c} (entered)", {
        w: fmtInt(num(e.wallet_thb)),
        by: e.reset_by === "rain" ? translate("heavy rain") : translate("cleaning"),
        day: String(e.reset_day ?? "—"),
        n: fmtInt(num(e.days_since_reset)),
        r: fmt(num(e.rate_pct_per_day), 2),
        basis: e.rate_basis === "fleet" ? translate("fleet") : translate("this plant"),
        c: fmtInt(num(e.cost_thb)),
      });
    case "R16": {
      const flags = Array.isArray(e.flags) ? (e.flags as string[]) : [];
      const parts = flags.map((f) =>
        f === "stale"
          ? translate("irradiance frozen {n} slots", { n: fmtInt(num(e.stale_slots)) })
          : f === "above_clear_sky"
            ? translate("above clear sky {n} slots", { n: fmtInt(num(e.high_slots)) })
            : f === "below_neighbours"
              ? translate("midday {r} × the {n} nearby sensors (Google cloud {c} %, modelled)", {
                  r: fmt(num(e.neighbour_ratio), 2),
                  n: fmtInt(num(e.neighbours)),
                  c: fmt(num(e.cloud_midday_pct), 0),
                })
              : f
      );
      return translate("Weather sensor: {parts} · PR / EPI not trustworthy that day", { parts: parts.join(" · ") });
    }
    case "R11":
      return translate("Ya − Yf loss {v} h vs baseline {b} h (+{g} h for {n} days)", {
        v: fmt(num(e.ya_minus_yf), 2),
        b: fmt(num(e.baseline_ya_minus_yf), 2),
        g: fmt(num(e.gap_increase_h), 2),
        n: fmtInt(num(e.days)),
      });
    case "R17":
      return translate("No data {n} of {total} daylight min", { n: fmtInt(num(e.no_data_min)), total: fmtInt(num(e.daylight_min)) });
    case "R18":
      return translate("Power-limited {n} min", { n: fmtInt(num(e.limited_min)) });
    case "R3": {
      const alarms = Array.isArray(e.alarms) ? (e.alarms as string[]).join(" · ") : translate("Safety alarm");
      const peers = e.peers_first_power ? String(e.peers_first_power) : null;
      if (e.dawn)
        return translate("{alarms} at the dawn start-up check on {n} of {d} days (dew?); started on time", {
          alarms,
          n: fmtInt(num(e.days)),
          d: fmtInt(num(e.window_days)),
        });
      if (num(e.late_start_min) != null)
        return peers
          ? translate("{alarms}; first power {t}, {n} min after the plant's other inverters ({ref})", {
              alarms,
              t: String(e.first_power),
              n: fmtInt(num(e.late_start_min)),
              ref: peers,
            })
          : translate("{alarms}; first power {t}, {n} min after the alarm", { alarms, t: String(e.first_power), n: fmtInt(num(e.late_start_min)) });
      if (peers && !e.first_power)
        return translate("{alarms}; no power yet while the plant's other inverters started at {ref}", { alarms, ref: peers });
      return alarms;
    }
    case "R9":
      return translate("{n} grid trips in {d} days", { n: fmtInt(num(e.events)), d: fmtInt(num(e.window_days)) });
    default:
      return "";
  }
};

export const thb = (v: number | null | undefined): string => (v == null ? "—" : `฿${fmtInt(v)}`);

const ACTION_TEXT: Record<Exclude<IssueActionName, "note">, { title: string; button: string; description: string }> = {
  acknowledge: { title: "Acknowledge issue", button: "Acknowledge", description: "Someone is on it. It stays in the queue until resolved." },
  resolve: { title: "Resolve issue", button: "Resolve", description: "Fixed. If the rule fires again on a later day, a new issue opens." },
  dismiss: { title: "Dismiss issue", button: "Dismiss", description: "Not a real fault (false alarm) or not worth acting on." },
  reopen: { title: "Reopen issue", button: "Reopen", description: "Put it back in the queue." },
};

/** Acknowledge / resolve / dismiss / reopen with a note and (when closing) whether the issue was real. */
export const IssueActionDialog: React.FC<{
  issue: Issue | null;
  action: Exclude<IssueActionName, "note"> | null;
  onClose: () => void;
  onDone: (i: Issue) => void;
}> = ({ issue, action, onClose, onDone }) => {
  const { t } = useI18n();
  const [note, setNote] = useState("");
  const [feedback, setFeedback] = useState<IssueFeedback | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = issue != null && action != null;
  const closing = action === "resolve" || action === "dismiss";

  React.useEffect(() => {
    if (open) {
      setNote(issue?.note ?? "");
      setFeedback(action === "resolve" ? "confirmed" : action === "dismiss" ? "false_alarm" : null);
      setError(null);
    }
  }, [open, issue, action]);

  const submit = async () => {
    if (!issue || !action) return;
    setBusy(true);
    try {
      const out = await api.patchIssue(issue.id, { action, note, feedback: closing ? feedback : undefined });
      onDone(out);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const text = action ? ACTION_TEXT[action] : null;
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{text ? t(text.title) : null}</DialogTitle>
          <DialogDescription>
            {issue ? `${issue.rule} ${issue.name} · ${issue.plant_name ?? issue.plant_id} · ${entityLabel(issue)}` : ""}
            <span className="mt-1 block">{text ? t(text.description) : null}</span>
          </DialogDescription>
        </DialogHeader>
        {closing && (
          <div className="space-y-1.5">
            <Label>{t("Was it a real fault?")}</Label>
            <div className="flex gap-2">
              <Button size="sm" variant={feedback === "confirmed" ? "accent" : "outline"} onClick={() => setFeedback("confirmed")}>
                {t("Yes, confirmed")}
              </Button>
              <Button size="sm" variant={feedback === "false_alarm" ? "accent" : "outline"} onClick={() => setFeedback("false_alarm")}>
                {t("No, false alarm")}
              </Button>
            </div>
          </div>
        )}
        <div className="space-y-1.5">
          <Label htmlFor="issue-note">{t("Note")}</Label>
          <Textarea id="issue-note" value={note} onChange={(e) => setNote(e.target.value)} rows={3} placeholder={t("What was found / done")} />
        </div>
        {error && <div className="callout-crit text-xs">{error}</div>}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t("Cancel")}
          </Button>
          <Button variant="default" onClick={() => void submit()} disabled={busy}>
            {busy && <Spinner data-icon="inline-start" className="size-3" />}
            {text ? t(text.button) : null}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

/** Action buttons for one issue row (what its status allows). */
export const IssueActions: React.FC<{ issue: Issue; onAction: (a: Exclude<IssueActionName, "note">) => void }> = ({ issue, onAction }) => {
  const { t } = useI18n();
  const active = issue.status === "open" || issue.status === "acknowledged";
  if (!active)
    return (
      <Button size="xs" variant="ghost" onClick={() => onAction("reopen")}>
        {t("Reopen")}
      </Button>
    );
  return (
    <div className="flex justify-end gap-1">
      {issue.status === "open" && (
        <Button size="xs" variant="outline" onClick={() => onAction("acknowledge")}>
          {t("Ack")}
        </Button>
      )}
      <Button size="xs" variant="outline" onClick={() => onAction("resolve")}>
        {t("Resolve")}
      </Button>
      <Button size="xs" variant="ghost" onClick={() => onAction("dismiss")}>
        {t("Dismiss")}
      </Button>
      {issue.device_sn && (
        <Button size="xs" variant="ghost" asChild title={t("Open a warranty / insurance claim from this issue")}>
          <Link to={newClaimHref("issue", { plantId: issue.plant_id, sn: issue.device_sn, stringNo: issue.string_no, ref: issue.id })}>{t("Claim")}</Link>
        </Button>
      )}
    </div>
  );
};
