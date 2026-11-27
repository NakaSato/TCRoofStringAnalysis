/** Field faults dialogs: change status (waiting reason / restore time / note as the backend needs
 * them), decide (decision + reason), add a note, edit the fields. Each answers the fault's new
 * detail; the page re-reads. */
import React, { useEffect, useState } from "react";
import { api } from "../../api/client";
import type { Fault, FaultCause, FaultDecisionKind, FaultPatchBody, FaultPosition, FaultSeverity, FaultStatus, FaultSubKind, FaultWaitingReason, OmPerson } from "../../api/client";
import { plantToday } from "../../context/alarmLogStore";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { DayInput, Field, Footer, useSubmit } from "../tools/dialogs";
import { faultsApi } from "./useFaults";
import {
  CAUSE,
  CAUSE_KEYS,
  DECISION,
  LOCATION_KINDS,
  POSITION_KINDS,
  SEVERITY,
  SEVERITY_KEYS,
  STATUS,
  SUB_KIND,
  SUB_KIND_KEYS,
  TRANSITION_LABEL,
  WAITING_REASON,
  WAITING_REASON_KEYS,
  decisionsFor,
  isEvidenceUrl,
  nextStatuses,
  parseUrls,
  plantNowLocal,
  statusNeeds,
  toLocalInput,
} from "./format";
import { useI18n } from "../../i18n";

const NONE = "__none";
const str = (s: string) => (s.trim() ? s.trim() : null);

/* ------------------------------------------------------------------ status */

export const StatusDialog: React.FC<{ fault: Fault | null; to?: FaultStatus | null; onClose: () => void; onDone: () => void }> = ({ fault, to: preset, onClose, onDone }) => {
  const { t } = useI18n();
  const [to, setTo] = useState<FaultStatus | "">("");
  const [reason, setReason] = useState<FaultWaitingReason | "">("");
  const [restoredAt, setRestoredAt] = useState("");
  const [note, setNote] = useState("");
  const { busy, error, setError, run } = useSubmit(() => {
    onDone();
    onClose();
  });

  useEffect(() => {
    if (!fault) return;
    const options = nextStatuses(fault.status);
    setTo(preset && options.includes(preset) ? preset : (options[0] ?? ""));
    setReason("");
    setRestoredAt(plantNowLocal());
    setNote("");
    setError(null);
  }, [fault, preset, setError]);

  if (!fault) return null;
  const options = nextStatuses(fault.status);
  const needs = to ? statusNeeds(fault.status, to) : { reason: false, restoredAt: false, note: false };
  const now = plantNowLocal();
  const found = toLocalInput(fault.found_at);
  const problems = [
    !to && t("Pick the new status"),
    needs.reason && !reason && t("Pick what it is waiting for"),
    needs.reason && fault.status === "waiting" && reason === fault.waiting_reason && t("It is already waiting for that"),
    needs.restoredAt && !restoredAt && t("Enter when it worked again"),
    needs.restoredAt && restoredAt > now && t("The restore time is in the future"),
    needs.restoredAt && found && restoredAt && restoredAt < found && t("The restore time is before the fault was found"),
    needs.note && !note.trim() && (to === "cancelled" ? t("Say why it is cancelled") : t("Closing from {status} needs a note", { status: t(STATUS[fault.status].label) })),
  ].filter(Boolean) as string[];

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("Change status · {name}", { name: fault.no })}</DialogTitle>
          <DialogDescription>{t("Now {status}. The change and the note go on the timeline.", { status: t(STATUS[fault.status].label) })}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <Field id="fs-to" label={t("New status")}>
            <Select value={to} onValueChange={(v) => setTo(v as FaultStatus)}>
              <SelectTrigger id="fs-to" size="sm" className="w-full">
                <SelectValue placeholder={t("Pick")} />
              </SelectTrigger>
              <SelectContent>
                {options.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s === "waiting" && fault.status === "waiting" ? t("Waiting for something else") : t(TRANSITION_LABEL[s])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {needs.reason && (
            <Field id="fs-reason" label={t("Waiting for")}>
              <Select value={reason} onValueChange={(v) => setReason(v as FaultWaitingReason)}>
                <SelectTrigger id="fs-reason" size="sm" className="w-full">
                  <SelectValue placeholder={t("Pick")} />
                </SelectTrigger>
                <SelectContent>
                  {WAITING_REASON_KEYS.map((k) => (
                    <SelectItem key={k} value={k}>
                      {t(WAITING_REASON[k])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
          {needs.restoredAt && (
            <Field id="fs-restored" label={t("Working again at")} hint={t("Plant time. Not before the fault was found ({found}), not in the future.", { found: found.replace("T", " ") || "—" })}>
              <Input id="fs-restored" type="datetime-local" className="num h-8" value={restoredAt} min={found || undefined} max={now} onChange={(e) => setRestoredAt(e.target.value)} />
            </Field>
          )}
          {to === "open" && fault.restored_at && (
            <Alert variant="warn">
              <AlertDescription>{t("Reopening clears the restore time and the close.")}</AlertDescription>
            </Alert>
          )}
          <Field id="fs-note" label={needs.note ? t("Note") : t("Note (optional)")}>
            <Textarea id="fs-note" className="min-h-16" value={note} onChange={(e) => setNote(e.target.value)} maxLength={4000} />
          </Field>
        </div>
        {problems.length > 0 && <p className="text-[11px] text-muted-foreground">{problems.join(" · ")}</p>}
        <Footer
          busy={busy}
          error={error}
          onClose={onClose}
          label={to === "cancelled" ? t("Cancel fault") : to ? t(TRANSITION_LABEL[to].split(" (")[0]) : t("Save")}
          destructive={to === "cancelled"}
          disabled={problems.length > 0}
          onSubmit={() =>
            void run(() =>
              faultsApi.setFaultStatus(fault.id, {
                status: to as FaultStatus,
                waiting_reason: needs.reason ? (reason as FaultWaitingReason) : null,
                restored_at: needs.restoredAt ? restoredAt : null,
                note: str(note),
              })
            )
          }
        />
      </DialogContent>
    </Dialog>
  );
};

/* ------------------------------------------------------------------ decision */

export const DecisionDialog: React.FC<{ fault: Fault | null; onClose: () => void; onDone: () => void }> = ({ fault, onClose, onDone }) => {
  const { t } = useI18n();
  const [decision, setDecision] = useState<FaultDecisionKind | "">("");
  const [reason, setReason] = useState("");
  const { busy, error, setError, run } = useSubmit(() => {
    onDone();
    onClose();
  });
  useEffect(() => {
    if (!fault) return;
    setDecision(fault.decision ?? "");
    setReason(fault.decision_reason ?? "");
    setError(null);
  }, [fault, setError]);
  if (!fault) return null;
  const unchanged = decision === fault.decision && reason.trim() === (fault.decision_reason ?? "");
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("Decide · {name}", { name: fault.no })}</DialogTitle>
          <DialogDescription>{t("What will be done, and why. A decision can change later; each change is on the timeline.")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <Field id="fd-decision" label={t("Decision")}>
            <Select value={decision} onValueChange={(v) => setDecision(v as FaultDecisionKind)}>
              <SelectTrigger id="fd-decision" size="sm" className="w-full">
                <SelectValue placeholder={t("Pick")} />
              </SelectTrigger>
              <SelectContent>
                {decisionsFor(fault.kind).map((k) => (
                  <SelectItem key={k} value={k}>
                    {t(DECISION[k])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field id="fd-reason" label={t("Reason")}>
            <Textarea id="fd-reason" className="min-h-16" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={4000} />
          </Field>
        </div>
        <Footer
          busy={busy}
          error={error}
          onClose={onClose}
          label={t("Save")}
          disabled={!decision || !reason.trim() || unchanged}
          onSubmit={() => void run(() => faultsApi.setFaultDecision(fault.id, { decision: decision as FaultDecisionKind, reason: reason.trim() }))}
        />
      </DialogContent>
    </Dialog>
  );
};

/* ------------------------------------------------------------------ note */

export const NoteDialog: React.FC<{ fault: Fault | null; onClose: () => void; onDone: () => void }> = ({ fault, onClose, onDone }) => {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const { busy, error, setError, run } = useSubmit(() => {
    onDone();
    onClose();
  });
  useEffect(() => {
    if (!fault) return;
    setText("");
    setError(null);
  }, [fault, setError]);
  if (!fault) return null;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("Add note · {name}", { name: fault.no })}</DialogTitle>
          <DialogDescription>{t("Goes on the fault's timeline. No passwords, keys or VPN config text.")}</DialogDescription>
        </DialogHeader>
        <Field id="fn-text" label={t("Note")}>
          <Textarea id="fn-text" className="min-h-20" value={text} onChange={(e) => setText(e.target.value)} maxLength={4000} />
        </Field>
        <Footer busy={busy} error={error} onClose={onClose} label={t("Add")} disabled={!text.trim()} onSubmit={() => void run(() => faultsApi.addFaultNote(fault.id, text.trim()))} />
      </DialogContent>
    </Dialog>
  );
};

/* ------------------------------------------------------------------ owner picker (shared with Record fault) */

/** people who may own a fault of the plant (admins and engineers assigned to it) */
export function usePlantPeople(plantId: number | null): OmPerson[] | null {
  const [people, setPeople] = useState<OmPerson[] | null>(null);
  useEffect(() => {
    setPeople(null);
    if (plantId == null) return;
    let live = true;
    api
      .listOmAssignees(plantId)
      .then((a) => live && setPeople(a.users))
      .catch(() => live && setPeople([]));
    return () => {
      live = false;
    };
  }, [plantId]);
  return people;
}

export const OwnerSelect: React.FC<{ id: string; people: OmPerson[] | null; value: number | null; onChange: (v: number | null) => void; current?: Fault["owner"] }> = ({
  id,
  people,
  value,
  onChange,
  current,
}) => {
  const { t } = useI18n();
  const list = [...(people ?? [])];
  if (current && !list.some((p) => p.id === current.id)) list.push({ id: current.id, username: current.username, full_name: current.full_name ?? current.username ?? "", role: "engineer" });
  return (
    <Select value={value != null ? String(value) : NONE} onValueChange={(v) => onChange(v === NONE ? null : Number(v))}>
      <SelectTrigger id={id} size="sm" className="w-full">
        <SelectValue placeholder={people == null ? t("Reading…") : t("No owner")} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>{t("No owner")}</SelectItem>
        <SelectSeparator />
        {list.map((p) => (
          <SelectItem key={p.id} value={String(p.id)}>
            {p.full_name || p.username}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
};

/* ------------------------------------------------------------------ edit */

interface EditDraft {
  symptom: string;
  cause: FaultCause | null;
  severity: FaultSeverity;
  owner: number | null;
  next: string | null;
  urls: string;
  reference: string;
  sub_kind: FaultSubKind | null;
  found_at: string;
  mppt: string;
  string_no: string;
  module_no: string;
  location: string;
}

const toDraft = (f: Fault): EditDraft => ({
  symptom: f.symptom,
  cause: f.cause,
  severity: f.severity,
  owner: f.owner?.id ?? null,
  next: f.next_action_day,
  urls: f.evidence_urls.join("\n"),
  reference: f.reference ?? "",
  sub_kind: f.sub_kind,
  found_at: toLocalInput(f.found_at),
  mppt: f.position?.mppt != null ? String(f.position.mppt) : "",
  string_no: f.position?.string_no != null ? String(f.position.string_no) : "",
  module_no: f.position?.module_no != null ? String(f.position.module_no) : "",
  location: f.position?.location ?? "",
});

/** position from the form; undefined = a number field is not 1–999 */
export function readPosition(p: { mppt: string; string_no: string; module_no: string; location: string }, withNumbers: boolean): FaultPosition | null | undefined {
  const out: FaultPosition = {};
  if (withNumbers) {
    for (const k of ["mppt", "string_no", "module_no"] as const) {
      const v = p[k].trim();
      if (!v) continue;
      if (!/^\d+$/.test(v) || Number(v) < 1 || Number(v) > 999) return undefined;
      out[k] = Number(v);
    }
  }
  if (p.location.trim()) out.location = p.location.trim().slice(0, 200);
  return Object.keys(out).length ? out : null;
}

export const PositionFields: React.FC<{
  idPrefix: string;
  value: { mppt: string; string_no: string; module_no: string; location: string };
  onChange: (k: "mppt" | "string_no" | "module_no" | "location", v: string) => void;
  numbers: boolean;
}> = ({ idPrefix, value, onChange, numbers }) => {
  const { t } = useI18n();
  return (
    <>
      {numbers && (
        <div className="grid grid-cols-3 gap-2 sm:col-span-2">
          <Field id={`${idPrefix}-mppt`} label={t("MPPT")}>
            <Input id={`${idPrefix}-mppt`} className="num h-8" inputMode="numeric" value={value.mppt} onChange={(e) => onChange("mppt", e.target.value)} />
          </Field>
          <Field id={`${idPrefix}-string`} label={t("String")}>
            <Input id={`${idPrefix}-string`} className="num h-8" inputMode="numeric" value={value.string_no} onChange={(e) => onChange("string_no", e.target.value)} />
          </Field>
          <Field id={`${idPrefix}-module`} label={t("Module no.")}>
            <Input id={`${idPrefix}-module`} className="num h-8" inputMode="numeric" value={value.module_no} onChange={(e) => onChange("module_no", e.target.value)} />
          </Field>
        </div>
      )}
      <Field id={`${idPrefix}-loc`} label={t("Location")} hint={t("Where on site, e.g. combiner box 2, MDB feeder 3, east roof row 4")} wide>
        <Input id={`${idPrefix}-loc`} className="h-8" maxLength={200} value={value.location} onChange={(e) => onChange("location", e.target.value)} />
      </Field>
    </>
  );
};

const posEqual = (a: FaultPosition | null | undefined, b: FaultPosition | null | undefined) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export const EditDialog: React.FC<{ fault: Fault | null; onClose: () => void; onDone: () => void }> = ({ fault, onClose, onDone }) => {
  const { t } = useI18n();
  const [d, setD] = useState<EditDraft | null>(null);
  const people = usePlantPeople(fault?.plant_id ?? null);
  const { busy, error, setError, run } = useSubmit(() => {
    onDone();
    onClose();
  });
  useEffect(() => {
    if (!fault) return;
    setD(toDraft(fault));
    setError(null);
  }, [fault, setError]);
  if (!fault || !d) return null;
  const set = <K extends keyof EditDraft>(k: K, v: EditDraft[K]) => setD((x) => (x ? { ...x, [k]: v } : x));
  const numbers = POSITION_KINDS.includes(fault.kind);
  const withLocation = LOCATION_KINDS.includes(fault.kind) || !!fault.position?.location;
  const position = readPosition(d, numbers);
  const urls = parseUrls(d.urls);
  const now = plantNowLocal();
  const restored = toLocalInput(fault.restored_at);

  // only the fields that changed are sent (null clears an optional one)
  const body: FaultPatchBody = {};
  if (d.symptom.trim() !== fault.symptom) body.symptom = d.symptom.trim();
  if (d.cause !== fault.cause) body.cause = d.cause;
  if (d.severity !== fault.severity) body.severity = d.severity;
  if (d.owner !== (fault.owner?.id ?? null)) body.owner_user_id = d.owner;
  if (d.next !== fault.next_action_day) body.next_action_day = d.next;
  if (JSON.stringify(urls) !== JSON.stringify(fault.evidence_urls)) body.evidence_urls = urls;
  if ((str(d.reference) ?? null) !== fault.reference) body.reference = str(d.reference);
  if (fault.kind === "service" && d.sub_kind && d.sub_kind !== fault.sub_kind) body.sub_kind = d.sub_kind;
  if (d.found_at && d.found_at !== toLocalInput(fault.found_at)) body.found_at = d.found_at;
  if (position !== undefined && (numbers || withLocation) && !posEqual(position, fault.position)) body.position = position;

  const problems = [
    !d.symptom.trim() && t("Say what is wrong"),
    urls.some((u) => !isEvidenceUrl(u)) && t("Evidence links start with https://"),
    urls.length > 20 && t("At most 20 evidence links"),
    position === undefined && t("MPPT, string and module numbers are whole numbers 1–999"),
    d.found_at > now && t("Found time is in the future"),
    restored && d.found_at && d.found_at > restored && t("Found time is after the restore time"),
  ].filter(Boolean) as string[];

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("Edit {name}", { name: fault.no })}</DialogTitle>
          <DialogDescription>{t("Changes are added to the fault's timeline. Plant, kind and device stay as recorded.")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id="fe-sev" label={t("Severity")} hint={t(SEVERITY[d.severity].hint)}>
            <Select value={d.severity} onValueChange={(v) => set("severity", v as FaultSeverity)}>
              <SelectTrigger id="fe-sev" size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SEVERITY_KEYS.map((k) => (
                  <SelectItem key={k} value={k}>
                    {t(SEVERITY[k].label)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field id="fe-cause" label={t("Cause")}>
            <Select value={d.cause ?? NONE} onValueChange={(v) => set("cause", v === NONE ? null : (v as FaultCause))}>
              <SelectTrigger id="fe-cause" size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>{t("Not known yet")}</SelectItem>
                <SelectSeparator />
                {CAUSE_KEYS.map((k) => (
                  <SelectItem key={k} value={k}>
                    {t(CAUSE[k])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {fault.kind === "service" && (
            <Field id="fe-sub" label={t("What failed")}>
              <Select value={d.sub_kind ?? ""} onValueChange={(v) => set("sub_kind", v as FaultSubKind)}>
                <SelectTrigger id="fe-sub" size="sm" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SUB_KIND_KEYS.map((k) => (
                    <SelectItem key={k} value={k}>
                      {t(SUB_KIND[k])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
          <Field id="fe-found" label={t("Found at")} hint={t("Plant time")}>
            <Input id="fe-found" type="datetime-local" className="num h-8" value={d.found_at} max={restored || now} onChange={(e) => set("found_at", e.target.value)} />
          </Field>
          <Field id="fe-symptom" label={t("Symptom")} wide>
            <Textarea id="fe-symptom" className="min-h-16" value={d.symptom} onChange={(e) => set("symptom", e.target.value)} maxLength={4000} />
          </Field>
          {(numbers || withLocation) && <PositionFields idPrefix="fe" value={d} onChange={(k, v) => set(k, v)} numbers={numbers} />}
          <Field id="fe-owner" label={t("Owner")}>
            <OwnerSelect id="fe-owner" people={people} value={d.owner} onChange={(v) => set("owner", v)} current={fault.owner} />
          </Field>
          <Field id="fe-next" label={t("Next action by")} hint={t("Past this day the fault shows Follow up. Empty = nothing is flagged.")}>
            <DayInput id="fe-next" value={d.next} onChange={(v) => set("next", v)} min={plantToday()} clearable placeholder={t("No date")} />
          </Field>
          <Field id="fe-ref" label={t("Reference")} hint={t("Carrier ticket no., config version, …")}>
            <Input id="fe-ref" className="num h-8" maxLength={120} value={d.reference} onChange={(e) => set("reference", e.target.value)} />
          </Field>
          <Field id="fe-urls" label={t("Evidence links")} hint={t("One https:// link per line (Drive folder, photo, KB page)")} wide>
            <Textarea id="fe-urls" className="min-h-14 font-mono text-xs" value={d.urls} onChange={(e) => set("urls", e.target.value)} />
          </Field>
        </div>
        {problems.length > 0 && <p className="text-[11px] text-muted-foreground">{problems.join(" · ")}</p>}
        <Footer
          busy={busy}
          error={error}
          onClose={onClose}
          label={t("Save")}
          disabled={problems.length > 0 || Object.keys(body).length === 0}
          onSubmit={() => void run(() => faultsApi.patchFault(fault.id, body))}
        />
      </DialogContent>
    </Dialog>
  );
};
