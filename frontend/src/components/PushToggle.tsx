import React, { useEffect, useState } from "react";
import { BellOff, BellRing } from "lucide-react";
import { api, type PushStatus, type UserProfile } from "../api/client";
import { enablePush, pushBlocked, pushOn, pushSupport, refreshPush, releasePush } from "../lib/push";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useI18n } from "../i18n";

/** Error text for the popover. Messages raised in `lib/push.ts` are English keys, translated here
 * (the component re-renders on a language switch); other errors (API, browser) are shown as they come. */
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Top-bar switch for alarm push notifications on this browser. Rendered only when the backend
 * has push configured (`/push/status`). Notifications are per device and per user.
 */
export const PushToggle: React.FC<{ user: UserProfile }> = ({ user }) => {
  const [status, setStatus] = useState<PushStatus | null>(null);
  const { t } = useI18n();
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState<"toggle" | "test" | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let alive = true;
    setStatus(null);
    setOn(false);
    setNote(null);
    api
      .getPushStatus()
      .then(async (s) => {
        if (!alive) return;
        setStatus(s);
        if (!s.enabled) return;
        const isOn = await refreshPush(s, user.id);
        if (alive) setOn(isOn);
      })
      .catch(() => alive && setStatus(null));
    return () => {
      alive = false;
    };
  }, [user.id]);

  if (!status?.enabled) return null;

  const support = pushSupport();
  const blocked = pushBlocked();
  const levels = status.levels.map((l) => t(l)).join(t(" or ")) || t("alarm");
  const scope = user.role === "admin" ? t("any plant") : t("one of your plants");

  const toggle = async () => {
    setBusy("toggle");
    setNote(null);
    try {
      if (on) {
        await releasePush(true);
        setOn(false);
      } else {
        await enablePush(status, user.id);
        setOn(pushOn(user.id));
      }
    } catch (e) {
      setNote({ ok: false, text: t(errText(e)) });
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    setBusy("test");
    setNote(null);
    try {
      await api.sendPushTest();
      setNote({ ok: true, text: t("Test queued. It should arrive within about a minute.") });
    } catch (e) {
      setNote({ ok: false, text: t(errText(e)) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label={on ? t("Alarm and calendar notifications on this device: on") : t("Alarm and calendar notifications on this device: off")}
              className={on ? "text-solar-300" : undefined}
            >
              {on ? <BellRing className="size-4" /> : <BellOff className="size-4" />}
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{t("Alarm and calendar notifications on this device")}</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-80 text-xs">
        <PopoverHeader>
          <PopoverTitle className="flex items-center justify-between gap-2 text-sm">
            {t("Notifications")}
            <Badge variant={on ? "ok" : "neutral"}>{on ? t("On") : t("Off")}</Badge>
          </PopoverTitle>
          <PopoverDescription>
            {t(
              "This device is notified when an inverter at {scope} reports a new {levels}. Alarms come from Growatt's alarm log, read between 05:00 and 20:00, so a notification can arrive a few minutes to an hour after the alarm starts. It also gets your Calendar reminders: work starting tomorrow (at 18:00) and your week on Monday at 07:30.",
              { scope, levels }
            )}
          </PopoverDescription>
        </PopoverHeader>

        {support === "ios-install" ? (
          <p className="callout-warn">
            {t("On iPhone and iPad, add this app to the Home Screen first (Share, then Add to Home Screen), open it from there, and turn notifications on.")}
          </p>
        ) : support === "unsupported" ? (
          <p className="callout-warn">{t("This browser does not support push notifications.")}</p>
        ) : blocked ? (
          <p className="callout-warn">
            {t("Notifications are blocked for this site. Allow them in the browser's site settings, then reload.")}
          </p>
        ) : (
          <div className="flex items-center gap-2">
            <Button variant={on ? "outline" : "default"} size="sm" onClick={toggle} disabled={busy !== null}>
              {busy === "toggle" && <Spinner data-icon="inline-start" className="size-3" />}
              {on ? t("Turn off") : t("Turn on")}
            </Button>
            {on && (
              <Button variant="secondary" size="sm" onClick={test} disabled={busy !== null}>
                {busy === "test" && <Spinner data-icon="inline-start" className="size-3" />}
                {t("Send test")}
              </Button>
            )}
          </div>
        )}
        {note && <p className={note.ok ? "text-emerald-300" : "text-red-300"}>{note.text}</p>}
      </PopoverContent>
    </Popover>
  );
};
