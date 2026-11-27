/** Field faults: one fault (URL `fault=<id>`): what was found, linked records, the timeline and
 * the restore time, with the actions the workflow allows. */
import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { FaultDetail as Detail, FaultStatus } from "../../api/client";
import { MethodBadge } from "../../components/scan/ScanDialog";
import { plantPath } from "../../context/routes";
import { LoadingState } from "../../components/ui";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { safeHref } from "@/lib/safeUrl";
import { useI18n } from "../../i18n";
import { faultsApi } from "./useFaults";
import { FaultStatusBadge, SeverityBadge, WaitingOn } from "./FaultTable";
import {
  CAUSE,
  DECISION,
  HOW_FOUND,
  KIND,
  LINK_KIND,
  SUB_KIND,
  WAITING_REASON,
  canDecide,
  canMove,
  eventTitle,
  fmtDay,
  fmtLocal,
  linkHref,
  positionText,
  relDays,
  restoreText,
} from "./format";

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

export interface FaultActions {
  status: (to?: FaultStatus) => void;
  decide: () => void;
  edit: () => void;
  note: () => void;
  unlink: (linkId: number) => Promise<void>;
}

export const FaultDetail: React.FC<{
  id: number | null;
  /** changes after any edit on the page, so the dialog re-reads */
  version: number;
  today: string;
  plantName: (id: number) => string;
  onClose: () => void;
  actions: FaultActions;
  /** the open fault as read, for the page's action dialogs */
  onLoaded?: (d: Detail | null) => void;
}> = ({ id, version, today, plantName, onClose, actions, onLoaded }) => {
  const { t } = useI18n();
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyLink, setBusyLink] = useState<number | null>(null);

  useEffect(() => {
    if (id == null) return;
    let live = true;
    setError(null);
    faultsApi.getFault(id).then(
      (x) => {
        if (!live) return;
        setD(x);
        onLoaded?.(x);
      },
      (e) => live && setError(e instanceof Error ? e.message : String(e))
    );
    return () => {
      live = false;
    };
  }, [id, version]);
  useEffect(() => {
    if (id == null) setD(null);
  }, [id]);

  const f = d && d.id === id ? d : null;
  const pos = f ? positionText(f.position) : null;

  return (
    <Dialog open={id != null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{f ? `${f.no} · ${t(KIND[f.kind])}${f.sub_kind ? ` · ${t(SUB_KIND[f.sub_kind])}` : ""}` : t("Fault #{id}", { id })}</DialogTitle>
          <DialogDescription>{f ? [f.plant_name ?? plantName(f.plant_id), f.device_label].filter(Boolean).join(" · ") : " "}</DialogDescription>
        </DialogHeader>
        {!f ? (
          error ? <div className="callout-crit text-xs">{error}</div> : <LoadingState shape="lines" />
        ) : (
          <div className="flex flex-col gap-5">
            <div className="flex flex-wrap items-center gap-2">
              <SeverityBadge f={f} />
              <FaultStatusBadge f={f} />
              <WaitingOn f={f} />
              {f.next_action_day && f.active && (
                <span className={cn("text-xs", f.followup_overdue ? "text-red-300" : "text-muted-foreground")}>
                  {t("Next action {day} ({rel})", { day: fmtDay(f.next_action_day), rel: relDays(f.next_action_day, today) })}
                </span>
              )}
              {f.followup_overdue && <Badge variant="crit">{t("Follow up")}</Badge>}
              <div className="ml-auto flex flex-wrap gap-1">
                <Button size="xs" onClick={() => actions.status()}>
                  {t("Change status")}
                </Button>
                {canDecide(f.status) && (
                  <Button size="xs" variant="outline" onClick={actions.decide}>
                    {t("Decide")}
                  </Button>
                )}
                <Button size="xs" variant="outline" onClick={actions.note}>
                  {t("Add note")}
                </Button>
                <Button size="xs" variant="ghost" onClick={actions.edit}>
                  {t("Edit")}
                </Button>
                {canMove(f.status, "cancelled") && (
                  <Button size="xs" variant="ghost" className="text-red-300" onClick={() => actions.status("cancelled")}>
                    {t("Cancel fault")}
                  </Button>
                )}
                {canMove(f.status, "open") && (
                  <Button size="xs" variant="outline" onClick={() => actions.status("open")}>
                    {t("Reopen")}
                  </Button>
                )}
              </div>
            </div>

            <div className="grid gap-5 sm:grid-cols-2">
              <Section title={t("What was found")}>
                <Row label={t("Plant")}>
                  <Link to={plantPath(f.plant_id)} className="hover:text-solar-400">
                    {f.plant_name ?? plantName(f.plant_id)}
                  </Link>
                </Row>
                <Row label={t("Device")}>
                  {f.inverter_sn ? (
                    <Link to={`${plantPath(f.plant_id, "inverters")}?sn=${encodeURIComponent(f.inverter_sn)}`} className="hover:text-solar-400">
                      {f.device_label ?? f.inverter_sn}
                    </Link>
                  ) : (
                    (f.device_label ?? <span className="text-muted-foreground">—</span>)
                  )}
                </Row>
                <Row label={t("Serial")}>
                  {f.serial ? (
                    <>
                      <span className="num">{f.serial}</span>
                      {f.serial_input === "register" ? (
                        <span className="ml-1.5 text-[11px] text-muted-foreground">{t("from the register")}</span>
                      ) : (
                        f.serial_input && (
                          <span className="ml-1.5 inline-flex align-middle" title={f.serial_raw ? t("Read as: {raw}", { raw: f.serial_raw }) : undefined}>
                            <MethodBadge method={f.serial_input} />
                          </span>
                        )
                      )}
                    </>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </Row>
                {pos && <Row label={t("Position")}>{<span className="num">{pos}</span>}</Row>}
                <Row label={t("How found")}>{t(HOW_FOUND[f.how_found])}</Row>
                <Row label={t("Found")}>
                  <span className="num">{fmtLocal(f.found_at)}</span>
                  {f.found_by && <span className="ml-1.5 text-[11px] text-muted-foreground">{f.found_by}</span>}
                </Row>
                <Row label={t("Cause")}>{f.cause ? t(CAUSE[f.cause]) : <span className="text-muted-foreground">{t("Not known yet")}</span>}</Row>
                {f.reference && <Row label={t("Reference")}>{<span className="num">{f.reference}</span>}</Row>}
                <Row label={t("Owner")}>{f.owner ? (f.owner.full_name || f.owner.username) : <span className="text-muted-foreground">—</span>}</Row>
                <p className="mt-2 text-xs whitespace-pre-wrap text-slate-300">{f.symptom}</p>
                {f.evidence_urls.length > 0 && (
                  <div className="mt-2 flex flex-col gap-0.5 text-xs">
                    <span className="eyebrow">{t("Evidence")}</span>
                    {f.evidence_urls.map((u) =>
                      safeHref(u) ? (
                        <a key={u} href={safeHref(u)} target="_blank" rel="noreferrer" className="truncate hover:text-solar-400">
                          {u}
                        </a>
                      ) : (
                        <span key={u} className="truncate">
                          {u}
                        </span>
                      )
                    )}
                  </div>
                )}
              </Section>

              <div className="flex flex-col gap-5">
                <Section title={t("Decision and restore")}>
                  <Row label={t("Decision")}>{f.decision ? t(DECISION[f.decision]) : <span className="text-muted-foreground">{t("Not decided yet")}</span>}</Row>
                  {f.decision_reason && <p className="py-1 text-xs whitespace-pre-wrap text-slate-300">{f.decision_reason}</p>}
                  {f.status === "waiting" && f.waiting_reason && <Row label={t("Waiting for")}>{t(WAITING_REASON[f.waiting_reason])}</Row>}
                  <Row label={t("Restored")}>
                    <span className="num">{fmtLocal(f.restored_at)}</span>
                  </Row>
                  <Row label={t("Restore time")}>
                    <span className="num" title={t("Found → restored, from the fault's own times")}>
                      {restoreText(f.restore_hours)}
                    </span>
                  </Row>
                  {f.closed_at && (
                    <Row label={t("Closed")}>
                      <span className="num">{fmtLocal(f.closed_at)}</span>
                      {f.closed_by && <span className="ml-1.5 text-[11px] text-muted-foreground">{f.closed_by}</span>}
                    </Row>
                  )}
                  {f.close_note && <p className="py-1 text-xs whitespace-pre-wrap text-slate-300">{f.close_note}</p>}
                </Section>

                <Section title={t("Linked records")}>
                  {f.link_list.length === 0 ? (
                    <p className="text-xs text-muted-foreground">{t("None yet.")}</p>
                  ) : (
                    f.link_list.map((l) => {
                      const href = linkHref(l, f);
                      const text = l.label ?? (l.ref_id != null ? `#${l.ref_id} ${t("(gone)")}` : (l.ref_key ?? "—"));
                      return (
                        <Row key={l.id} label={t(LINK_KIND[l.kind])}>
                          {href ? (
                            <Link to={href} className="hover:text-solar-400">
                              {text}
                            </Link>
                          ) : (
                            text
                          )}
                          <Button
                            size="xs"
                            variant="ghost"
                            className="ml-1"
                            disabled={busyLink === l.id}
                            onClick={() => {
                              setBusyLink(l.id);
                              void actions.unlink(l.id).finally(() => setBusyLink(null));
                            }}
                            aria-label={t("Unlink")}
                          >
                            ×
                          </Button>
                        </Row>
                      );
                    })
                  )}
                </Section>
              </div>
            </div>

            <Section title={t("Timeline")}>
              <ol className="flex flex-col">
                {f.events.map((e) => {
                  const title = eventTitle(e.kind, e.from, e.to);
                  const vars = title.vars ? Object.fromEntries(Object.entries(title.vars).map(([k, v]) => [k, t(v)])) : undefined;
                  return (
                    <li key={e.id} className="grid grid-cols-[8.5rem_1fr] gap-3 border-b border-white/[0.05] py-2 text-xs last:border-0">
                      <span className="num text-muted-foreground">
                        {fmtLocal(e.at)}
                        <span className="block text-[11px] text-slate-500">{e.by ?? ""}</span>
                      </span>
                      <span className="min-w-0">
                        <span className="font-medium">{t(title.text, vars)}</span>
                        {e.text && e.kind !== "created" && <span className="block whitespace-pre-wrap text-slate-300">{e.text}</span>}
                      </span>
                    </li>
                  );
                })}
              </ol>
            </Section>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};
