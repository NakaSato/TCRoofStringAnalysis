/** Measuring Tools: one instrument (URL `tool=<id>`): specs, due items, calibration / renewal
 * history and check-out history. */
import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { InstrumentDetail as Detail } from "../../api/client";
import { plantPath } from "../../context/routes";
import { LoadingState } from "../../components/ui";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toolsApi } from "./useInstruments";
import { DUE_KIND, DUE_STATE, STATUS, categoryOf, fmtDay, missingPvRating, relDays, specValue, thb } from "./format";

const Row: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="flex justify-between gap-3 border-b border-white/[0.05] py-1.5 text-xs last:border-0">
    <span className="text-muted-foreground">{label}</span>
    <span className="text-right">{children}</span>
  </div>
);

export const InstrumentDetail: React.FC<{
  id: number | null;
  /** changes after any edit on the page, so the dialog re-reads */
  version: number;
  today: string;
  plantName: (id: number) => string;
  onClose: () => void;
  actions?: (d: Detail) => React.ReactNode;
}> = ({ id, version, today, plantName, onClose, actions }) => {
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (id == null) return;
    let live = true;
    setError(null);
    toolsApi.getInstrument(id).then(
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

  const shown = d && d.id === id ? d : null;
  const def = shown ? categoryOf(shown.category) : null;
  const missing = shown ? missingPvRating(shown) : [];

  return (
    <Dialog open={id != null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {def && <def.icon className="size-4 text-muted-foreground" />}
            {shown ? `${shown.asset_tag} · ${shown.name}` : `Instrument #${id}`}
          </DialogTitle>
          <DialogDescription>
            {shown ? [def?.label, [shown.make, shown.model].filter(Boolean).join(" "), shown.serial_no && `SN ${shown.serial_no}`].filter(Boolean).join(" · ") : " "}
          </DialogDescription>
        </DialogHeader>
        {!shown ? (
          error ? <div className="callout-crit text-xs">{error}</div> : <LoadingState shape="lines" />
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={STATUS[shown.status].variant}>{STATUS[shown.status].label}</Badge>
              {shown.open_checkout && (
                <span className="text-xs text-muted-foreground">
                  {shown.open_checkout.holder?.name ?? "—"}
                  {shown.open_checkout.plant_id != null && (
                    <>
                      {" · "}
                      <Link to={plantPath(shown.open_checkout.plant_id, "maintenance")} className="hover:text-solar-400">
                        {shown.open_checkout.plant_name ?? plantName(shown.open_checkout.plant_id)}
                      </Link>
                    </>
                  )}
                  {" · back "}
                  <span className={shown.open_checkout.overdue ? "text-red-300" : undefined}>{fmtDay(shown.open_checkout.due_back)}</span>
                </span>
              )}
              {missing.length > 0 && <Badge variant="warn">Not entered: {missing.join(", ")}</Badge>}
              <div className="ml-auto flex gap-1">{actions?.(shown)}</div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <section>
                <div className="eyebrow mb-1">Specs</div>
                {def!.specs.map((f) => (
                  <Row key={f.key} label={f.label}>
                    {specValue(shown, f)}
                  </Row>
                ))}
                <Row label="Calibration interval">{shown.calibration_interval_months != null ? `${shown.calibration_interval_months} months` : "—"}</Row>
                <Row label="Purchased">{fmtDay(shown.purchase_day)}</Row>
                <Row label="Cost">{thb(shown.cost_thb)}</Row>
              </section>
              <section>
                <div className="eyebrow mb-1">Due dates</div>
                {shown.due.map((x) => (
                  <Row key={x.kind} label={DUE_KIND[x.kind]}>
                    <span className="num">{fmtDay(x.next_due)}</span>{" "}
                    <Badge variant={DUE_STATE[x.state].variant} className="ml-1">
                      {x.next_due ? relDays(x.next_due, today) : DUE_STATE[x.state].label}
                    </Badge>
                  </Row>
                ))}
                {shown.note && (
                  <>
                    <div className="eyebrow mt-3 mb-1">Note</div>
                    <p className="text-xs whitespace-pre-wrap text-slate-300">{shown.note}</p>
                  </>
                )}
              </section>
            </div>

            <section>
              <div className="eyebrow mb-1">Calibration & renewals</div>
              {shown.due_history.length === 0 ? (
                <p className="text-xs text-muted-foreground">None recorded.</p>
              ) : (
                <Table containerClassName="table-wrap">
                  <TableHeader>
                    <TableRow>
                      <TableHead>What</TableHead>
                      <TableHead>Day</TableHead>
                      <TableHead>Next due</TableHead>
                      <TableHead>Number</TableHead>
                      <TableHead>Lab / issuer</TableHead>
                      <TableHead className="text-right">Cost</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {shown.due_history.map((h) => (
                      <TableRow key={h.id}>
                        <TableCell>{DUE_KIND[h.kind]}</TableCell>
                        <TableCell className="num whitespace-nowrap">{fmtDay(h.day)}</TableCell>
                        <TableCell className="num whitespace-nowrap">{fmtDay(h.next_due)}</TableCell>
                        <TableCell className="num">
                          {h.url ? (
                            <a href={h.url} target="_blank" rel="noreferrer" className="hover:text-solar-400">
                              {h.number ?? "Link"}
                            </a>
                          ) : (
                            (h.number ?? "—")
                          )}
                        </TableCell>
                        <TableCell>{h.issuer ?? "—"}</TableCell>
                        <TableCell className="num text-right">{thb(h.cost_thb)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </section>

            <section>
              <div className="eyebrow mb-1">Check-outs</div>
              {shown.checkouts.length === 0 ? (
                <p className="text-xs text-muted-foreground">Never checked out.</p>
              ) : (
                <Table containerClassName="table-wrap">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Holder</TableHead>
                      <TableHead>Plant</TableHead>
                      <TableHead>Out</TableHead>
                      <TableHead>Due back</TableHead>
                      <TableHead>Returned</TableHead>
                      <TableHead>Condition</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {shown.checkouts.map((c) => (
                      <TableRow key={c.id} title={[c.note, c.return_note].filter(Boolean).join(" · ") || undefined}>
                        <TableCell>{c.holder?.name ?? "—"}</TableCell>
                        <TableCell className="max-w-[180px] truncate">{c.plant_id != null ? (c.plant_name ?? plantName(c.plant_id)) : "—"}</TableCell>
                        <TableCell className="num whitespace-nowrap">{c.out_at.slice(0, 16)}</TableCell>
                        <TableCell className={c.overdue ? "num whitespace-nowrap text-red-300" : "num whitespace-nowrap"}>{fmtDay(c.due_back)}</TableCell>
                        <TableCell className="num whitespace-nowrap">{c.returned_at ? c.returned_at.slice(0, 16) : <Badge variant="info">Out</Badge>}</TableCell>
                        <TableCell>
                          {c.condition ? <Badge variant={c.condition === "ok" ? "ok" : "crit"}>{c.condition}</Badge> : "—"}
                          {c.ack_warnings.length > 0 && (
                            <Badge variant="warn" className="ml-1" title={c.ack_warnings.join(", ")}>
                              Warned
                            </Badge>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </section>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};
