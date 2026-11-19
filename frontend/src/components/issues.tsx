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

export const TierBadge: React.FC<{ tier: IssueTier }> = ({ tier }) => (
  <Badge variant={TIER_VARIANT[tier]} title={TIER_HINT[tier]}>
    {tier}
  </Badge>
);

export const STATUS_LABEL: Record<Issue["status"], string> = {
  open: "Open",
  acknowledged: "Acknowledged",
  resolved: "Resolved",
  dismissed: "Dismissed",
};

export const StatusBadgeIssue: React.FC<{ issue: Issue }> = ({ issue }) => {
  const label = issue.close_reason === "auto" ? "Closed (auto)" : STATUS_LABEL[issue.status];
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
  return inv || "Plant";
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
      return `${fmtInt(num(e.low_min))} min below 80 % of peers (median ratio ${fmt(num(e.ratio_median), 2)}), ${fmtInt(num(e.days_hit))} of ${fmtInt(num(e.days_judged))} days`;
    case "R2":
      return `${fmtInt(num(e.open_min))} min at ~0 A while its peers carried current`;
    case "R4":
      return `String voltage ${fmt(num(e.v_drop_pct), 2)} % below peer voltage for ${fmtInt(num(e.days))} days (per-string MPPT)`;
    case "R5":
      return `Median ratio ${fmt(num(e.ratio_median_window), 3)} over ${fmtInt(num(e.days))} days`;
    case "R6":
      return `Peer ratio falling ${fmt(num(e.drop_pct_per_month), 2)} %/month over ${fmtInt(num(e.days))} days (PID / rapid degradation)`;
    case "R7": {
      const p = Array.isArray(e.yf_vs_median_pct) ? (e.yf_vs_median_pct as number[]) : [];
      return `Specific yield vs the plant's other inverters: ${p.map((x) => `${fmt(x, 1)} %`).join(", ")}`;
    }
    case "R8":
      return `Down ${fmtInt((num(e.fault_min) ?? 0) + (num(e.off_min) ?? 0) + (num(e.standby_min) ?? 0))} min (fault ${fmtInt(num(e.fault_min))}, off ${fmtInt(num(e.off_min))}, standby ${fmtInt(num(e.standby_min))}) · ${fmt(num(e.kwp_share_pct), 0)} % of plant kWp`;
    case "R10":
      return `EPI ${fmt(num(e.epi), 3)} vs baseline μ=${fmt(num(e.epi_mu), 3)} (σ=${fmt(num(e.epi_sigma), 3)}, ${String(e.trigger ?? "")})`;
    case "R16": {
      const flags = Array.isArray(e.flags) ? (e.flags as string[]) : [];
      const parts = flags.map((f) =>
        f === "stale"
          ? `irradiance frozen ${fmtInt(num(e.stale_slots))} slots`
          : f === "above_clear_sky"
            ? `above clear sky ${fmtInt(num(e.high_slots))} slots`
            : f === "below_neighbours"
              ? `midday ${fmt(num(e.neighbour_ratio), 2)} × the ${fmtInt(num(e.neighbours))} nearby sensors (Google cloud ${fmt(num(e.cloud_midday_pct), 0)} %, modelled)`
              : f
      );
      return `Weather sensor: ${parts.join(" · ")} · PR / EPI not trustworthy that day`;
    }
    case "R11":
      return `Ya − Yf loss ${fmt(num(e.ya_minus_yf), 2)} h vs baseline ${fmt(num(e.baseline_ya_minus_yf), 2)} h (+${fmt(num(e.gap_increase_h), 2)} h for ${fmtInt(num(e.days))} days)`;
    case "R17":
      return `No data ${fmtInt(num(e.no_data_min))} of ${fmtInt(num(e.daylight_min))} daylight min`;
    case "R18":
      return `Power-limited ${fmtInt(num(e.limited_min))} min`;
    case "R3":
      return Array.isArray(e.alarms) ? (e.alarms as string[]).join(" · ") : "Safety alarm";
    case "R9":
      return `${fmtInt(num(e.events))} grid trips in ${fmtInt(num(e.window_days))} days`;
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

/** Acknowledge / resolve / dismiss / reopen with a note and (when closing) feedback for Rule review. */
export const IssueActionDialog: React.FC<{
  issue: Issue | null;
  action: Exclude<IssueActionName, "note"> | null;
  onClose: () => void;
  onDone: (i: Issue) => void;
}> = ({ issue, action, onClose, onDone }) => {
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
          <DialogTitle>{text?.title}</DialogTitle>
          <DialogDescription>
            {issue ? `${issue.rule} ${issue.name} · ${issue.plant_name ?? issue.plant_id} · ${entityLabel(issue)}` : ""}
            <span className="mt-1 block">{text?.description}</span>
          </DialogDescription>
        </DialogHeader>
        {closing && (
          <div className="space-y-1.5">
            <Label>Was it a real fault?</Label>
            <div className="flex gap-2">
              <Button size="sm" variant={feedback === "confirmed" ? "accent" : "outline"} onClick={() => setFeedback("confirmed")}>
                Yes, confirmed
              </Button>
              <Button size="sm" variant={feedback === "false_alarm" ? "accent" : "outline"} onClick={() => setFeedback("false_alarm")}>
                No, false alarm
              </Button>
            </div>
            <p className="text-[11px] text-slate-500">Rule review counts this to tune the rule.</p>
          </div>
        )}
        <div className="space-y-1.5">
          <Label htmlFor="issue-note">Note</Label>
          <Textarea id="issue-note" value={note} onChange={(e) => setNote(e.target.value)} rows={3} placeholder="What was found / done" />
        </div>
        {error && <div className="callout-crit text-xs">{error}</div>}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="default" onClick={() => void submit()} disabled={busy}>
            {busy && <Spinner data-icon="inline-start" className="size-3" />}
            {text?.button}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

/** Action buttons for one issue row (what its status allows). */
export const IssueActions: React.FC<{ issue: Issue; onAction: (a: Exclude<IssueActionName, "note">) => void }> = ({ issue, onAction }) => {
  const active = issue.status === "open" || issue.status === "acknowledged";
  if (!active)
    return (
      <Button size="xs" variant="ghost" onClick={() => onAction("reopen")}>
        Reopen
      </Button>
    );
  return (
    <div className="flex justify-end gap-1">
      {issue.status === "open" && (
        <Button size="xs" variant="outline" onClick={() => onAction("acknowledge")}>
          Ack
        </Button>
      )}
      <Button size="xs" variant="outline" onClick={() => onAction("resolve")}>
        Resolve
      </Button>
      <Button size="xs" variant="ghost" onClick={() => onAction("dismiss")}>
        Dismiss
      </Button>
      {issue.device_sn && (
        <Button size="xs" variant="ghost" asChild title="Open a warranty / insurance claim from this issue">
          <Link to={newClaimHref("issue", { plantId: issue.plant_id, sn: issue.device_sn, stringNo: issue.string_no, ref: issue.id })}>Claim</Link>
        </Button>
      )}
    </div>
  );
};
