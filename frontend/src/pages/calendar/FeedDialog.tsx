/** Calendar Team: the user's read-only calendar subscription (ICS) for Google Calendar, Outlook or
 * Apple Calendar. The backend keeps only a hash of the secret, so the link is shown once, right
 * after "Make link"; a new link or "Turn off" stops the old one at once. */
import React, { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { api } from "../../api/client";
import type { OmFeedStatus } from "../../api/client";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-GB", { timeZone: "Asia/Bangkok", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";

export const FeedDialog: React.FC<{ open: boolean; onClose: () => void }> = ({ open, onClose }) => {
  const [status, setStatus] = useState<OmFeedStatus | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState<"link" | "off" | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setLink(null);
    setCopied(false);
    setError(null);
    setStatus(null);
    api.getOmFeed().then(setStatus).catch((e) => setError(errText(e)));
  }, [open]);

  const makeLink = async () => {
    setBusy("link");
    setError(null);
    setCopied(false);
    try {
      const r = await api.newOmFeedLink();
      setStatus(r);
      setLink(new URL(r.path, window.location.origin).href);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  };

  const turnOff = async () => {
    setBusy("off");
    setError(null);
    try {
      await api.deleteOmFeed();
      setLink(null);
      setStatus(await api.getOmFeed());
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  };

  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      setError("Could not copy: select the link and copy it by hand.");
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            Subscribe in your calendar app
            {status && <Badge variant={status.enabled ? "ok" : "neutral"}>{status.enabled ? "On" : "Off"}</Badge>}
          </DialogTitle>
          <DialogDescription>
            A read-only feed of your own work (tasks assigned to you or to a team you are in), from{" "}
            {status?.past_days ?? 30} days ago to {status?.ahead_days ?? 180} days ahead. Calendar apps re-read it every
            few hours; changes here are not instant there.
          </DialogDescription>
        </DialogHeader>

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {!status && !error ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Spinner className="size-3" /> Loading…
          </div>
        ) : link ? (
          <div className="flex flex-col gap-2 text-xs">
            <div className="flex gap-2">
              <Input readOnly value={link} onFocus={(e) => e.currentTarget.select()} className="font-mono text-[11px]" aria-label="Subscription link" />
              <Button variant="outline" size="sm" onClick={() => void copy()}>
                {copied ? <Check data-icon="inline-start" /> : <Copy data-icon="inline-start" />}
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
            <p className="callout-warn">
              Copy it now: it is shown only once. Anyone with this link can read your task list, so keep it to yourself.
            </p>
            <ul className="list-disc space-y-1 pl-4 text-muted-foreground">
              <li>Google Calendar (web): Other calendars → + → From URL → paste.</li>
              <li>Outlook: Add calendar → Subscribe from web → paste.</li>
              <li>iPhone / Mac: Settings → Calendar → Accounts → Add Subscribed Calendar → paste.</li>
            </ul>
          </div>
        ) : status?.enabled ? (
          <p className="text-xs text-muted-foreground">
            Your feed has been on since {when(status.created_at)}; last read by a calendar app: {when(status.last_used_at)}. The
            link was shown when it was made. Lost it? Make a new one (the old link stops working).
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">Your feed is off. Make a link to subscribe from Google Calendar, Outlook or Apple Calendar.</p>
        )}

        <DialogFooter>
          {status?.enabled && (
            <Button variant="ghost" size="sm" onClick={() => void turnOff()} disabled={busy !== null}>
              {busy === "off" && <Spinner data-icon="inline-start" className="size-3" />}
              Turn off
            </Button>
          )}
          <Button size="sm" onClick={() => void makeLink()} disabled={busy !== null || (!status && !error)}>
            {busy === "link" && <Spinner data-icon="inline-start" className="size-3" />}
            {status?.enabled ? "Make a new link" : "Make link"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
