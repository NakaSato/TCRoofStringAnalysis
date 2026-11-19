/** Claims: one claim (URL `claim=<id>`): what failed, linked records, evidence checklist and the
 * timeline. */
import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { ClaimDetail as Detail, ClaimEvent, ClaimEvidence } from "../../api/client";
import { plantPath } from "../../context/routes";
import { LoadingState } from "../../components/ui";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { claimsApi } from "./useClaims";
import { StatusBadge, WaitingText } from "./ClaimTable";
import { CAUSE, LINK_KIND, STATUS, TYPE, evidenceHref, fmtDay, inverterHref, isOpen, linkHref, relDays, stringHref } from "./format";

const Row: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="flex justify-between gap-3 border-b border-white/[0.05] py-1.5 text-xs last:border-0">
    <span className="shrink-0 text-muted-foreground">{label}</span>
    <span className="min-w-0 text-right break-words">{children}</span>
  </div>
);

const Section: React.FC<{ title: string; right?: React.ReactNode; children: React.ReactNode }> = ({ title, right, children }) => (
  <section>
    <div className="mb-1 flex items-center justify-between gap-2">
      <div className="eyebrow">{title}</div>
      {right}
    </div>
    {children}
  </section>
);

const eventText = (e: ClaimEvent, counterparty: string): string => {
  switch (e.kind) {
    case "created":
      return "Created";
    case "edit":
      return "Edited";
    case "status":
      return `${e.from_status ? STATUS[e.from_status].label : "—"} → ${e.to_status ? STATUS[e.to_status].label : "—"}`;
    case "note":
      return "Note";
    case "message":
      return e.direction === "in" ? `Message from ${counterparty}` : `Message to ${counterparty}`;
    case "shipment":
      return e.direction === "in" ? "Parcel to us" : `Parcel to ${counterparty}`;
  }
};

export interface DetailActions {
  status?: () => void;
  edit?: () => void;
  event: (kind: "note" | "message" | "shipment") => void;
  evidence: (item: ClaimEvidence) => void;
  toggleEvidence: (item: ClaimEvidence) => Promise<void>;
  link: () => void;
  unlink: (linkId: number) => Promise<void>;
}

export const ClaimDetail: React.FC<{
  id: number | null;
  /** changes after any edit on the page, so the dialog re-reads */
  version: number;
  today: string;
  plantName: (id: number) => string;
  onClose: () => void;
  actions: (d: Detail) => DetailActions;
}> = ({ id, version, today, plantName, onClose, actions }) => {
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  useEffect(() => {
    if (id == null) return;
    let live = true;
    setError(null);
    claimsApi.getClaim(id).then(
      (x) => live && setD(x),
      (e) => live && setError(e instanceof Error ? e.message : String(e))
    );
    return () => {
      live = false;
    };
  }, [id, version]);
  useEffect(() => {
    if (id == null) setD(null);
  }, [id]);

  const c = d && d.id === id ? d : null;
  const act = c ? actions(c) : null;
  const busy = async (key: string, fn: () => Promise<void>) => {
    setBusyKey(key);
    try {
      await fn();
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <Dialog open={id != null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{c ? `${c.number} · ${TYPE[c.type].label}` : `Claim #${id}`}</DialogTitle>
          <DialogDescription>
            {c ? [c.plant_name ?? plantName(c.plant_id), `with ${c.counterparty}`, c.counterparty_ref && `ref ${c.counterparty_ref}`].filter(Boolean).join(" · ") : " "}
          </DialogDescription>
        </DialogHeader>
        {!c || !act ? (
          error ? <div className="callout-crit text-xs">{error}</div> : <LoadingState shape="lines" />
        ) : (
          <div className="flex flex-col gap-5">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge c={c} />
              <WaitingText c={c} />
              {c.next_action_day && isOpen(c) && (
                <span className={cn("text-xs", c.followup_overdue ? "text-red-300" : "text-muted-foreground")}>
                  Next action {fmtDay(c.next_action_day)} ({relDays(c.next_action_day, today)})
                </span>
              )}
              {c.followup_overdue && <Badge variant="crit">Follow up</Badge>}
              <div className="ml-auto flex flex-wrap gap-1">
                {act.status && (
                  <Button size="xs" onClick={act.status}>
                    Change status
                  </Button>
                )}
                <Button size="xs" variant="outline" onClick={() => act.event("note")}>
                  Add note
                </Button>
                <Button size="xs" variant="outline" onClick={() => act.event("message")}>
                  Message
                </Button>
                <Button size="xs" variant="outline" onClick={() => act.event("shipment")}>
                  Shipment
                </Button>
                {act.edit && (
                  <Button size="xs" variant="ghost" onClick={act.edit}>
                    Edit
                  </Button>
                )}
              </div>
            </div>

            <div className="grid gap-5 sm:grid-cols-2">
              <Section title="What failed">
                <Row label="Plant">
                  <Link to={plantPath(c.plant_id)} className="hover:text-solar-400">
                    {c.plant_name ?? plantName(c.plant_id)}
                  </Link>
                </Row>
                {c.device_sn && (
                  <Row label="Inverter">
                    <Link to={inverterHref(c.plant_id, c.device_sn)} className="num hover:text-solar-400">
                      {c.device_sn}
                    </Link>
                  </Row>
                )}
                {c.string_nos.length > 0 && (
                  <Row label="String(s)">
                    {c.string_nos.map((n, k) => (
                      <React.Fragment key={n}>
                        {k > 0 && ", "}
                        {c.device_sn ? (
                          <Link to={stringHref(c.plant_id, c.device_sn, n)} className="num hover:text-solar-400">
                            PV{n}
                          </Link>
                        ) : (
                          <span className="num">PV{n}</span>
                        )}
                      </React.Fragment>
                    ))}
                  </Row>
                )}
                {c.module_serials.length > 0 && <Row label={`Modules (${c.module_serials.length})`}>{<span className="num">{c.module_serials.join(", ")}</span>}</Row>}
                {c.device_label && <Row label="Damaged">{c.device_label}</Row>}
                <Row label="Cause">{CAUSE[c.cause]}</Row>
                <Row label="Incident">{fmtDay(c.incident_day)}</Row>
                <Row label="Found">{fmtDay(c.discovered_day)}</Row>
                <Row label="Submitted">{fmtDay(c.submitted_day)}</Row>
                {c.closed_day && <Row label="Closed">{fmtDay(c.closed_day)}</Row>}
                {c.type !== "insurance" && (
                  <Row label="Warranty ends">
                    {c.warranty_end_day ? fmtDay(c.warranty_end_day) : <span className="text-muted-foreground" title="Not entered on the claim">—</span>}
                  </Row>
                )}
                {(c.old_sn || c.new_sn) && c.type === "inverter_warranty" && (
                  <Row label="Swap">
                    <span className="num">
                      {c.old_sn ?? "—"} → {c.new_sn ?? "not yet"}
                    </span>
                  </Row>
                )}
                {c.new_sn && c.type !== "inverter_warranty" && (
                  <Row label="Replacement SN">
                    <span className="num">{c.new_sn}</span>
                  </Row>
                )}
                {c.description && <p className="mt-2 text-xs whitespace-pre-wrap text-slate-300">{c.description}</p>}
              </Section>

              <div className="flex flex-col gap-5">
                <Section
                  title="Linked records"
                  right={
                    <Button size="xs" variant="ghost" onClick={act.link}>
                      Link…
                    </Button>
                  }
                >
                  {c.links.length === 0 ? (
                    <p className="text-xs text-muted-foreground">None. Link the issue, I-V sweep or site log entry this claim is about.</p>
                  ) : (
                    c.links.map((l) => (
                      <Row key={l.id} label={LINK_KIND[l.kind]}>
                        <Link to={linkHref(l.kind, c)} className="hover:text-solar-400">
                          #{l.ref_id}
                          {l.label ? ` ${l.label}` : ""}
                        </Link>
                        <Button
                          size="xs"
                          variant="ghost"
                          className="ml-1"
                          disabled={busyKey === `l${l.id}`}
                          onClick={() => void busy(`l${l.id}`, () => act.unlink(l.id))}
                          aria-label="Unlink"
                        >
                          ×
                        </Button>
                      </Row>
                    ))
                  )}
                </Section>
              </div>
            </div>

            <Section
              title={`Evidence · ${c.evidence_done} of ${c.evidence_required} required`}
              right={
                c.evidence_done >= c.evidence_required ? (
                  <Badge variant="ok">Ready to submit</Badge>
                ) : (
                  <Badge variant="warn">{c.evidence_required - c.evidence_done} missing</Badge>
                )
              }
            >
              <div className="flex flex-col">
                {c.evidence.map((e) => {
                  const app = evidenceHref(e.key, c);
                  return (
                    <div key={e.key} className="flex flex-wrap items-center gap-2 border-b border-white/[0.05] py-1.5 text-xs last:border-0">
                      <Checkbox
                        checked={e.done}
                        disabled={busyKey === e.key}
                        onCheckedChange={() => void busy(e.key, () => act.toggleEvidence(e))}
                        aria-label={`${e.label}: done`}
                      />
                      <span className={cn("min-w-0 flex-1", e.done && "text-muted-foreground")}>
                        {e.label}
                        {e.required ? "" : <span className="ml-1 text-[11px] text-muted-foreground">(optional)</span>}
                        {e.note && <span className="block text-[11px] text-muted-foreground">{e.note}</span>}
                        {e.done && e.by && <span className="block text-[11px] text-slate-500">{[e.by, e.at?.slice(0, 16)].filter(Boolean).join(" · ")}</span>}
                      </span>
                      {e.url && (
                        <a href={e.url} target="_blank" rel="noreferrer" className="hover:text-solar-400">
                          File
                        </a>
                      )}
                      {app && (
                        <Link to={app.href} className="text-muted-foreground hover:text-solar-400" title="Where the app has it">
                          {app.label}
                        </Link>
                      )}
                      <Button size="xs" variant="ghost" onClick={() => act.evidence(e)}>
                        Edit
                      </Button>
                    </div>
                  );
                })}
              </div>
            </Section>

            <Section title="Timeline">
              <ol className="flex flex-col">
                {c.events.map((e) => (
                  <li key={e.id} className="grid grid-cols-[7.5rem_1fr] gap-3 border-b border-white/[0.05] py-2 text-xs last:border-0">
                    <span className="num text-muted-foreground">
                      {fmtDay(e.day ?? e.at.slice(0, 10))}
                      <span className="block text-[11px] text-slate-500">{e.by ?? ""}</span>
                    </span>
                    <span className="min-w-0">
                      <span className="font-medium">{eventText(e, c.counterparty)}</span>
                      {e.summary && e.kind !== "created" && e.kind !== "edit" && <span className="block whitespace-pre-wrap text-slate-300">{e.summary}</span>}
                      {(e.carrier || e.tracking_no || e.sn) && (
                        <span className="num block text-[11px] text-muted-foreground">
                          {[e.carrier, e.tracking_no && `#${e.tracking_no}`, e.sn && `SN ${e.sn}`].filter(Boolean).join(" · ")}
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ol>
            </Section>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};
