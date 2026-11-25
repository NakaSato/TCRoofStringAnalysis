/** Calendar Team Phase 4: data-driven cleaning suggestions (`/growatt/calendar/suggestions`).
 * A suggestion is a ghost chip, never a task: the plant's R12 soiling wallet (THB lost to dirt
 * since the last plant-wide cleaning or heavy rain, **estimated**) has reached its cleaning cost
 * (entered) outside the monsoon window. Admins accept it (a normal cleaning task is planned) or
 * dismiss it until the next cleaning; engineers get none while R12 is in shadow mode. */
import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api/client";
import type { OmCleaningSuggestion } from "../../api/client";
import { plantPath } from "../../context/routes";
import { fmt, fmtInt } from "../../components/ui";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { DayPicker } from "./fields";
import { shortDay } from "./format";

export const SUGGEST_CHIP = "border-dashed border-sky-400/50 bg-transparent text-sky-300/90";

const thb = (v: number | null | undefined) => (v == null ? "—" : `฿${fmtInt(v)}`);
const day = (v: string | null | undefined) => (v ? shortDay(v) : "—");

/** a dashed "ghost" chip on the month grid / week lane */
export const SuggestionChip: React.FC<{ s: OmCleaningSuggestion; onOpen: (s: OmCleaningSuggestion) => void; showPlant?: boolean }> = ({ s, onOpen, showPlant = true }) => {
  const { t } = useI18n();
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onOpen(s);
      }}
      title={t("Suggested cleaning (estimate): {wallet} lost to soiling vs {cost} cleaning cost", { wallet: thb(s.wallet_thb), cost: thb(s.cost_thb) })}
      className={cn("block w-full truncate rounded border px-1.5 py-0.5 text-left text-[11px] leading-4", SUGGEST_CHIP)}
    >
      {showPlant ? `${s.plant_name ?? `#${s.plant_id}`} · ` : ""}
      {t("Suggested (estimate)")}
    </button>
  );
};

const Row: React.FC<{ label: string; children: React.ReactNode; hint?: string }> = ({ label, children, hint }) => (
  <div className="flex items-baseline justify-between gap-3 border-b border-white/[0.06] py-1.5 text-xs last:border-0">
    <span className="text-muted-foreground">
      {label}
      {hint && <span className="ml-1 text-[10px] uppercase tracking-wide text-slate-500">{hint}</span>}
    </span>
    <span className="num text-right">{children}</span>
  </div>
);

/** the figures behind one suggestion, with Accept / Dismiss for admins */
export const SuggestionDialog: React.FC<{
  s: OmCleaningSuggestion | null;
  admin: boolean;
  shadow: boolean;
  onClose: () => void;
  onChanged: (msg: string) => void;
}> = ({ s, admin, shadow, onClose, onChanged }) => {
  const { t } = useI18n();
  const [start, setStart] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<"accept" | "dismiss" | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!s) return;
    setStart(s.suggested_day);
    setNote("");
    setError(null);
  }, [s]);

  const run = async (kind: "accept" | "dismiss") => {
    if (!s) return;
    setBusy(kind);
    try {
      if (kind === "accept") {
        const out = await api.acceptOmSuggestion(s.plant_id, { start_day: start ?? undefined, note: note.trim() || undefined });
        onChanged(t("Cleaning planned for {plant} on {day}.", { plant: s.plant_name ?? s.plant_id, day: shortDay(out.task.start_day) }));
      } else {
        await api.dismissOmSuggestion(s.plant_id);
        onChanged(t("Suggestion for {plant} dismissed until the next cleaning.", { plant: s.plant_name ?? s.plant_id }));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const costBasis = s?.cost_basis === "plant_setting" ? t("entered") : s?.cost_basis === "site_log" ? t("from the Site log") : undefined;
  return (
    <Dialog open={s != null} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {t("Suggested cleaning")}
            <Badge variant="info">{t("Estimate")}</Badge>
            {shadow && <Badge variant="neutral">{t("Shadow")}</Badge>}
          </DialogTitle>
          <DialogDescription>
            {s && (
              <>
                <Link to={plantPath(s.plant_id, "maintenance")} className="hover:underline">
                  {s.plant_name ?? `#${s.plant_id}`}
                </Link>
                {": "}
                {t("the soiling loss since the array was last clean has reached the cleaning cost. The loss is estimated from the measured soiling rate.")}
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        {s && (
          <div className="flex flex-col">
            <Row label={t("Lost to soiling since the reset")} hint={t("est.")}>
              {thb(s.wallet_thb)} <span className="text-muted-foreground">({fmt(s.wallet_kwh, 0)} kWh)</span>
            </Row>
            <Row label={t("Cleaning cost")} hint={costBasis}>{thb(s.cost_thb)}</Row>
            <Row label={t("Crossed the cost on")} hint={t("est.")}>{day(s.crossed_day)}</Row>
            <Row label={t("Last reset")}>
              {day(s.reset_day)}{" "}
              <span className="text-muted-foreground">
                ({s.reset_by === "rain" ? t("heavy rain") : s.reset_by === "cleaning" ? t("cleaning") : "—"}, {t("{n} d", { n: fmtInt(s.days_since_reset) })})
              </span>
            </Row>
            <Row label={t("Soiling rate")} hint={t("est.")}>
              {s.rate_pct_per_day == null ? "—" : `${fmt(s.rate_pct_per_day, 2)} %/d`}{" "}
              <span className="text-muted-foreground">({s.rate_basis === "fleet" ? t("fleet median") : s.rate_basis === "plant" ? t("this plant") : "—"})</span>
            </Row>
            <Row label={t("Soiling now")} hint={t("est.")}>{s.soiling_pct == null ? "—" : `${fmt(s.soiling_pct, 1)} %`}</Row>
            <Row label={t("Best interval")} hint={t("est.")}>{s.optimal_interval_days == null ? "—" : t("{n} d", { n: s.optimal_interval_days })}</Row>
            <Row label={t("Judged on")}>{day(s.day)}</Row>
          </div>
        )}
        {s && admin && s.suggested && (
          <div className="grid grid-cols-2 gap-3">
            <DayPicker id="om-suggest-start" label={t("Plan for")} value={start} onChange={setStart} min={s.suggested_day ?? undefined} />
            <div className="space-y-1.5">
              <Label htmlFor="om-suggest-note">{t("Note")}</Label>
              <Input id="om-suggest-note" value={note} maxLength={1500} onChange={(e) => setNote(e.target.value)} className="h-8" />
            </div>
          </div>
        )}
        {s && !s.suggested && s.reason && <p className="text-xs text-muted-foreground">{s.reason}</p>}
        {error && <p className="text-xs text-red-300">{error}</p>}
        {admin && s?.suggested && (
          <DialogFooter>
            <Button variant="outline" size="sm" disabled={busy != null} onClick={() => void run("dismiss")}>
              {busy === "dismiss" && <Spinner data-icon="inline-start" className="size-3" />}
              {t("Dismiss")}
            </Button>
            <Button size="sm" disabled={busy != null || !start} onClick={() => void run("accept")}>
              {busy === "accept" && <Spinner data-icon="inline-start" className="size-3" />}
              {t("Accept: plan cleaning")}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
};
