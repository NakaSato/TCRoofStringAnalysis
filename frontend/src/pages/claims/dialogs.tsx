/** Claims dialogs: create / edit (prefilled from Issues, Inverters or an I-V sweep), change status
 * (admin), add a note / message / shipment, edit an evidence item, link a record. */
import React, { useEffect, useMemo, useState } from "react";
import { api } from "../../api/client";
import type { Claim, ClaimBody, ClaimCause, ClaimEvidence, ClaimLinkBody, ClaimLinkKind, ClaimStatus, ClaimType, Issue } from "../../api/client";
import { useAppContext } from "../../context/AppContext";
import { plantToday } from "../../context/alarmLogStore";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { DayInput, Field, Footer, useSubmit } from "../tools/dialogs";
import { claimsApi } from "./useClaims";
import { CAUSE, CAUSE_KEYS, LINK_KIND, STATUS, TRANSITIONS, TRANSITION_LABEL, TYPE, TYPE_KEYS, isOpen } from "./format";
import type { Prefill } from "./format";

const str = (s: string) => (s.trim() ? s.trim() : null);
const issueLabel = (i: Issue) => `#${i.id} ${i.rule} ${i.name}${i.string_no != null ? ` · PV${i.string_no}` : ""} (${i.status})`;

/* ------------------------------------------------------------------ create / edit */

interface Draft {
  type: ClaimType;
  cause: ClaimCause;
  plant_id: string;
  device_sn: string;
  strings: string;
  serials: string;
  device_label: string;
  counterparty: string;
  counterparty_ref: string;
  description: string;
  incident_day: string | null;
  discovered_day: string | null;
  warranty_end_day: string | null;
}

const blank = (): Draft => ({
  type: "inverter_warranty",
  cause: "unknown",
  plant_id: "",
  device_sn: "",
  strings: "",
  serials: "",
  device_label: "",
  counterparty: "Growatt",
  counterparty_ref: "",
  description: "",
  incident_day: null,
  discovered_day: plantToday(),
  warranty_end_day: null,
});

const fromClaim = (c: Claim): Draft => ({
  type: c.type,
  cause: c.cause,
  plant_id: String(c.plant_id),
  device_sn: c.device_sn ?? "",
  strings: c.string_nos.join(", "),
  serials: c.module_serials.join("\n"),
  device_label: c.device_label ?? "",
  counterparty: c.counterparty,
  counterparty_ref: c.counterparty_ref ?? "",
  description: c.description ?? "",
  incident_day: c.incident_day,
  discovered_day: c.discovered_day,
  warranty_end_day: c.warranty_end_day,
});

const needsInverter = (t: ClaimType) => t === "inverter_warranty" || t === "module_warranty";

export const ClaimDialog: React.FC<{
  open: boolean;
  editing: Claim | null;
  prefill: Prefill | null;
  /** every claim the page has, for the "already open" check */
  existing: Claim[];
  counterparties: string[];
  onClose: () => void;
  onSaved: (c: Claim) => void;
  onOpenExisting: (id: number) => void;
}> = ({ open, editing, prefill, existing, counterparties, onClose, onSaved, onOpenExisting }) => {
  const { growattPlants } = useAppContext();
  const [d, setD] = useState<Draft>(blank);
  const [links, setLinks] = useState<ClaimLinkBody[]>([]);
  const [linkNote, setLinkNote] = useState<string | null>(null);
  // run() reports errors; success is handled inside submit (it needs the saved claim)
  const { busy, error, setError, run } = useSubmit(() => undefined);

  // fill the form when it opens
  useEffect(() => {
    if (!open) return;
    setError(null);
    setLinkNote(null);
    if (editing) {
      setD(fromClaim(editing));
      setLinks([]);
      return;
    }
    const base = blank();
    const p = prefill;
    if (!p || p.from === "blank") {
      setD(base);
      setLinks([]);
      return;
    }
    const module = p.from === "sweep" || (p.from === "issue" && p.string_no != null);
    setD({
      ...base,
      type: module ? "module_warranty" : "inverter_warranty",
      cause: module ? "degradation" : "unknown",
      counterparty: module ? "" : "Growatt",
      plant_id: p.plant_id != null ? String(p.plant_id) : "",
      device_sn: p.device_sn ?? "",
      strings: p.string_no != null ? String(p.string_no) : "",
    });
    setLinks(p.ref != null && (p.from === "issue" || p.from === "sweep") ? [{ kind: p.from === "issue" ? "issue" : "iv_sweep", ref_id: p.ref }] : []);
    if (p.from === "sweep" && p.ref != null) setLinkNote(`I-V sweep #${p.ref} is linked.`);
    // an issue: read it for the description, first day and its estimate (the backend links it)
    if (p.from === "issue" && p.ref != null && p.plant_id != null) {
      let live = true;
      api
        .listIssues({ plant_id: p.plant_id, status: "all" })
        .then((list) => {
          const i = list.issues.find((x) => x.id === p.ref);
          if (!live || !i) return;
          setD((x) => ({
            ...x,
            description: x.description || `${i.rule} ${i.name}${i.note ? `: ${i.note}` : ""}`,
            incident_day: x.incident_day ?? i.opened_day,
            device_sn: x.device_sn || i.device_sn || "",
          }));
          setLinkNote(`Issue #${i.id} (${i.rule} ${i.name}) is linked.`);
        })
        .catch(() => live && setLinkNote(`Issue #${p.ref} is linked.`));
      return () => {
        live = false;
      };
    }
  }, [open, editing, prefill, setError]);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const setType = (t: ClaimType) =>
    setD((x) => ({
      ...x,
      type: t,
      // Growatt is the inverter maker for the whole fleet; others are entered
      counterparty: t === "inverter_warranty" && !x.counterparty ? "Growatt" : x.type === "inverter_warranty" && x.counterparty === "Growatt" && t !== "equipment_warranty" ? "" : x.counterparty,
    }));

  const stringNos = useMemo(
    () =>
      d.strings
        .split(/[,\s]+/)
        .filter(Boolean)
        .map(Number),
    [d.strings]
  );
  const plantId = /^\d+$/.test(d.plant_id) ? Number(d.plant_id) : null;

  const already = useMemo(() => {
    if (editing || !plantId || !d.device_sn.trim()) return [];
    const sn = d.device_sn.trim();
    return existing.filter(
      (c) =>
        isOpen(c) &&
        c.plant_id === plantId &&
        c.device_sn === sn &&
        c.type === d.type &&
        (d.type !== "module_warranty" || !c.string_nos.length || !stringNos.length || c.string_nos.some((n) => stringNos.includes(n)))
    );
  }, [editing, existing, plantId, d.device_sn, d.type, stringNos]);

  const problems: string[] = [];
  if (!plantId) problems.push("Pick the plant");
  if (!d.counterparty.trim()) problems.push("Who is the claim with?");
  if (needsInverter(d.type) && !d.device_sn.trim()) problems.push("Enter the inverter SN");
  if (d.type === "module_warranty" && !stringNos.length) problems.push("Enter the string number(s)");
  if (stringNos.some((n) => !Number.isInteger(n) || n < 1)) problems.push("String numbers are whole numbers, e.g. 3, 4");
  if (!needsInverter(d.type) && !d.device_label.trim() && !d.description.trim()) problems.push("Say what was damaged");

  const submit = () =>
    run(async () => {
      const body: ClaimBody = {
        type: d.type,
        cause: d.cause,
        plant_id: plantId!,
        device_sn: str(d.device_sn),
        string_nos: stringNos,
        module_serials: d.type === "module_warranty" ? d.serials.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean) : [],
        device_label: str(d.device_label),
        counterparty: d.counterparty.trim(),
        counterparty_ref: str(d.counterparty_ref),
        description: str(d.description),
        incident_day: d.incident_day,
        discovered_day: d.discovered_day,
        warranty_end_day: d.warranty_end_day,
      };
      const c = editing ? await claimsApi.patchClaim(editing.id, body) : await claimsApi.createClaim({ ...body, links });
      onSaved(c);
      onClose();
    });

  const today = plantToday();
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{editing ? `Edit ${editing.number}` : "New claim"}</DialogTitle>
          <DialogDescription>
            {editing ? "Changes are added to the claim's timeline." : "Starts as a draft. Add the evidence, then an admin submits it."}
          </DialogDescription>
        </DialogHeader>

        {already.length > 0 && (
          <Alert variant="warn">
            <AlertTitle>Already open for this {d.type === "module_warranty" ? "string" : "inverter"}</AlertTitle>
            <AlertDescription className="flex flex-wrap items-center gap-2">
              {already.map((c) => (
                <Button key={c.id} size="xs" variant="outline" onClick={() => onOpenExisting(c.id)}>
                  Open {c.number} ({STATUS[c.status].label})
                </Button>
              ))}
            </AlertDescription>
          </Alert>
        )}
        {linkNote && <p className="text-xs text-muted-foreground">{linkNote}</p>}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field id="c-type" label="Type" hint={TYPE[d.type].hint}>
            <Select value={d.type} onValueChange={(v) => setType(v as ClaimType)}>
              <SelectTrigger id="c-type" size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TYPE_KEYS.map((t) => (
                  <SelectItem key={t} value={t}>
                    {TYPE[t].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field id="c-cause" label="Cause">
            <Select value={d.cause} onValueChange={(v) => set("cause", v as ClaimCause)}>
              <SelectTrigger id="c-cause" size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CAUSE_KEYS.map((k) => (
                  <SelectItem key={k} value={k}>
                    {CAUSE[k]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field id="c-plant" label="Plant" wide>
            <Select value={d.plant_id} onValueChange={(v) => set("plant_id", v)} disabled={editing != null}>
              <SelectTrigger id="c-plant" size="sm" className="w-full">
                <SelectValue placeholder="Pick a plant" />
              </SelectTrigger>
              <SelectContent>
                {growattPlants.map((p) => (
                  <SelectItem key={p.plant_id} value={String(p.plant_id)}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          {needsInverter(d.type) && (
            <Field id="c-sn" label="Inverter SN">
              <Input id="c-sn" className="num h-8" value={d.device_sn} onChange={(e) => set("device_sn", e.target.value)} />
            </Field>
          )}
          {d.type === "module_warranty" && (
            <Field id="c-strings" label="String(s)" hint="e.g. 3, 4">
              <Input id="c-strings" className="num h-8" value={d.strings} onChange={(e) => set("strings", e.target.value)} />
            </Field>
          )}
          {d.type === "module_warranty" && (
            <Field id="c-serials" label="Module serial numbers" hint="One per line" wide>
              <Textarea id="c-serials" className="num min-h-16" value={d.serials} onChange={(e) => set("serials", e.target.value)} />
            </Field>
          )}
          {!needsInverter(d.type) && (
            <Field id="c-device" label="What was damaged" hint="Device and its SN, or the part of the array" wide>
              <Input id="c-device" className="h-8" value={d.device_label} onChange={(e) => set("device_label", e.target.value)} />
            </Field>
          )}

          <Field id="c-with" label="Claim with">
            <Input id="c-with" className="h-8" list="claim-counterparties" value={d.counterparty} onChange={(e) => set("counterparty", e.target.value)} />
            <datalist id="claim-counterparties">
              {counterparties.map((x) => (
                <option key={x} value={x} />
              ))}
            </datalist>
          </Field>
          <Field id="c-ref" label="Their reference" hint="Case / RMA / claim number, when you have it">
            <Input id="c-ref" className="num h-8" value={d.counterparty_ref} onChange={(e) => set("counterparty_ref", e.target.value)} />
          </Field>

          <Field id="c-incident" label="Incident day" hint="When it failed or happened, if known">
            <DayInput id="c-incident" value={d.incident_day} onChange={(v) => set("incident_day", v)} max={today} clearable placeholder="Not known" />
          </Field>
          <Field id="c-found" label="Found on">
            <DayInput id="c-found" value={d.discovered_day} onChange={(v) => set("discovered_day", v)} min={d.incident_day ?? undefined} max={today} clearable />
          </Field>
          {d.type !== "insurance" && (
            <Field id="c-warranty" label="Warranty ends" hint="Only from the warranty card or contract">
              <DayInput id="c-warranty" value={d.warranty_end_day} onChange={(v) => set("warranty_end_day", v)} clearable placeholder="Not entered" />
            </Field>
          )}

          <Field id="c-desc" label="Description" wide>
            <Textarea id="c-desc" className="min-h-20" value={d.description} onChange={(e) => set("description", e.target.value)} />
          </Field>

        </div>

        {problems.length > 0 && <p className="text-[11px] text-muted-foreground">{problems.join(" · ")}</p>}
        <Footer busy={busy} error={error} onClose={onClose} onSubmit={() => void submit()} label={editing ? "Save" : "Create draft"} disabled={problems.length > 0} />
      </DialogContent>
    </Dialog>
  );
};

/* ------------------------------------------------------------------ status (admin) */

export const StatusDialog: React.FC<{ claim: Claim | null; onClose: () => void; onDone: () => void }> = ({ claim, onClose, onDone }) => {
  const [to, setTo] = useState<ClaimStatus | "">("");
  const [note, setNote] = useState("");
  const [next, setNext] = useState<string | null>(null);
  const [newSn, setNewSn] = useState("");
  const [ack, setAck] = useState(false);
  const { busy, error, setError, run } = useSubmit(() => {
    onDone();
    onClose();
  });

  useEffect(() => {
    if (!claim) return;
    setTo(TRANSITIONS[claim.status][0] ?? "");
    setNote("");
    setNext(claim.next_action_day);
    setNewSn("");
    setAck(false);
    setError(null);
  }, [claim, setError]);

  if (!claim) return null;
  const closing = to === "closed" || to === "withdrawn";
  const missing = claim.evidence_required - claim.evidence_done;
  const askEvidence = to === "submitted" && missing > 0;
  const askNewSn = to === "fulfilled" && claim.type === "inverter_warranty";
  const problems = [
    !to && "Pick the new status",
    !note.trim() && "Add a note",
    askEvidence && !ack && "Confirm submitting with evidence missing",
  ].filter(Boolean) as string[];

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Change status · {claim.number}</DialogTitle>
          <DialogDescription>
            Now {STATUS[claim.status].label}. The note goes on the timeline.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <Field id="s-to" label="New status">
            <Select value={to} onValueChange={(v) => setTo(v as ClaimStatus)}>
              <SelectTrigger id="s-to" size="sm" className="w-full">
                <SelectValue placeholder="Pick" />
              </SelectTrigger>
              <SelectContent>
                {TRANSITIONS[claim.status].map((s) => (
                  <SelectItem key={s} value={s}>
                    {TRANSITION_LABEL[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {askEvidence && (
            <Alert variant="warn">
              <AlertTitle>
                {missing} required evidence item{missing === 1 ? "" : "s"} not ticked
              </AlertTitle>
              <AlertDescription>
                <label className="mt-1 flex items-center gap-2">
                  <Checkbox checked={ack} onCheckedChange={(v) => setAck(v === true)} />
                  Submit anyway
                </label>
              </AlertDescription>
            </Alert>
          )}
          <Field id="s-note" label="Note" hint={to === "submitted" ? "e.g. how it was sent and what they said about response time" : undefined}>
            <Textarea id="s-note" className="min-h-16" value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          {!closing && (
            <Field id="s-next" label="Next action by" hint="Past this day the claim shows Follow up. Leave empty if nobody gave a date.">
              <DayInput id="s-next" value={next} onChange={setNext} clearable placeholder="No date" />
            </Field>
          )}
          {askNewSn && (
            <Field id="s-sn" label="New inverter SN" hint={`Replaces ${claim.old_sn ?? claim.device_sn ?? "—"}. The registry picks it up from Growatt on the next fleet sync.`}>
              <Input id="s-sn" className="num h-8" value={newSn} onChange={(e) => setNewSn(e.target.value)} />
            </Field>
          )}
        </div>
        {problems.length > 0 && <p className="text-[11px] text-muted-foreground">{problems.join(" · ")}</p>}
        <Footer
          busy={busy}
          error={error}
          onClose={onClose}
          label={to ? TRANSITION_LABEL[to].split(" (")[0] : "Save"}
          destructive={to === "withdrawn" || to === "rejected"}
          disabled={problems.length > 0}
          onSubmit={() =>
            void run(() =>
              claimsApi.setClaimStatus(claim.id, {
                status: to as ClaimStatus,
                note: note.trim(),
                next_action_day: closing ? null : next,
                ...(askNewSn && newSn.trim() ? { new_sn: newSn.trim() } : {}),
              })
            )
          }
        />
      </DialogContent>
    </Dialog>
  );
};

/* ------------------------------------------------------------------ note / message / shipment */

export type EventKind = "note" | "message" | "shipment";

export const EventDialog: React.FC<{ target: { claim: Claim; kind: EventKind } | null; onClose: () => void; onDone: () => void }> = ({ target, onClose, onDone }) => {
  const [kind, setKind] = useState<EventKind>("note");
  const [day, setDay] = useState<string | null>(plantToday());
  const [dir, setDir] = useState<"out" | "in">("out");
  const [summary, setSummary] = useState("");
  const [carrier, setCarrier] = useState("");
  const [tracking, setTracking] = useState("");
  const [sn, setSn] = useState("");
  const { busy, error, setError, run } = useSubmit(() => {
    onDone();
    onClose();
  });

  useEffect(() => {
    if (!target) return;
    setKind(target.kind);
    setDay(plantToday());
    setDir(target.kind === "shipment" && target.claim.status === "approved" ? "in" : "out");
    setSummary("");
    setCarrier("");
    setTracking("");
    setSn("");
    setError(null);
  }, [target, setError]);

  if (!target) return null;
  const c = target.claim;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add to timeline · {c.number}</DialogTitle>
          <DialogDescription>A note, a message sent or received, or a parcel.</DialogDescription>
        </DialogHeader>
        <Tabs value={kind} onValueChange={(v) => setKind(v as EventKind)}>
          <TabsList variant="line" className="border-0 p-0">
            <TabsTrigger value="note">Note</TabsTrigger>
            <TabsTrigger value="message">Message</TabsTrigger>
            <TabsTrigger value="shipment">Shipment</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="grid gap-3 sm:grid-cols-2">
          {kind !== "note" && (
            <>
              <Field id="e-dir" label={kind === "message" ? "Direction" : "Going"}>
                <Select value={dir} onValueChange={(v) => setDir(v as "out" | "in")}>
                  <SelectTrigger id="e-dir" size="sm" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="out">{kind === "message" ? `Sent to ${c.counterparty}` : `To ${c.counterparty}`}</SelectItem>
                    <SelectItem value="in">{kind === "message" ? `Received from ${c.counterparty}` : "To us"}</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field id="e-day" label="Day">
                <DayInput id="e-day" value={day} onChange={setDay} max={plantToday()} />
              </Field>
            </>
          )}
          <Field id="e-sum" label={kind === "note" ? "Note" : kind === "message" ? "What was said" : "What is in it"} wide>
            <Textarea id="e-sum" className="min-h-16" value={summary} onChange={(e) => setSummary(e.target.value)} />
          </Field>
          {kind === "shipment" && (
            <>
              <Field id="e-carrier" label="Carrier">
                <Input id="e-carrier" className="h-8" value={carrier} onChange={(e) => setCarrier(e.target.value)} />
              </Field>
              <Field id="e-track" label="Tracking number">
                <Input id="e-track" className="num h-8" value={tracking} onChange={(e) => setTracking(e.target.value)} />
              </Field>
              <Field id="e-sn" label="Unit SN" hint="The serial of the unit in the parcel">
                <Input id="e-sn" className="num h-8" value={sn} onChange={(e) => setSn(e.target.value)} />
              </Field>
            </>
          )}
        </div>
        <Footer
          busy={busy}
          error={error}
          onClose={onClose}
          label="Add"
          disabled={!summary.trim()}
          onSubmit={() =>
            void run(() =>
              claimsApi.addClaimEvent(c.id, {
                kind,
                day: kind === "note" ? null : day,
                direction: kind === "note" ? null : dir,
                summary: summary.trim(),
                ...(kind === "shipment" ? { carrier: str(carrier), tracking_no: str(tracking), sn: str(sn) } : {}),
              })
            )
          }
        />
      </DialogContent>
    </Dialog>
  );
};

/* ------------------------------------------------------------------ evidence item */

export const EvidenceDialog: React.FC<{ target: { claim: Claim; item: ClaimEvidence } | null; onClose: () => void; onDone: () => void }> = ({
  target,
  onClose,
  onDone,
}) => {
  const [done, setDone] = useState(false);
  const [url, setUrl] = useState("");
  const [note, setNote] = useState("");
  const { busy, error, setError, run } = useSubmit(() => {
    onDone();
    onClose();
  });
  useEffect(() => {
    if (!target) return;
    setDone(target.item.done || !target.item.url);
    setUrl(target.item.url ?? "");
    setNote(target.item.note ?? "");
    setError(null);
  }, [target, setError]);
  if (!target) return null;
  const badUrl = url.trim() !== "" && !/^https?:\/\//i.test(url.trim());
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{target.item.label}</DialogTitle>
          <DialogDescription>{target.claim.number} · a link to where the file is (e.g. the claim's Drive folder), and a note.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <label className="flex items-center gap-2 text-xs">
            <Checkbox checked={done} onCheckedChange={(v) => setDone(v === true)} />
            Done: we have it
          </label>
          <Field id="ev-url" label="Link" hint={badUrl ? "Starts with https://" : undefined}>
            <Input id="ev-url" className="h-8" placeholder="https://" value={url} onChange={(e) => setUrl(e.target.value)} />
          </Field>
          <Field id="ev-note" label="Note">
            <Textarea id="ev-note" className="min-h-14" value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
        </div>
        <Footer
          busy={busy}
          error={error}
          onClose={onClose}
          label="Save"
          disabled={badUrl}
          onSubmit={() => void run(() => claimsApi.setClaimEvidence(target.claim.id, target.item.key, { done, url: str(url), note: str(note) }))}
        />
      </DialogContent>
    </Dialog>
  );
};

/* ------------------------------------------------------------------ link a record */

export const LinkDialog: React.FC<{ claim: Claim | null; onClose: () => void; onDone: () => void }> = ({ claim, onClose, onDone }) => {
  const [kind, setKind] = useState<ClaimLinkKind>("issue");
  const [ref, setRef] = useState("");
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const { busy, error, setError, run } = useSubmit(() => {
    onDone();
    onClose();
  });
  useEffect(() => {
    if (!claim) return;
    setKind("issue");
    setRef("");
    setError(null);
    setIssues(null);
    let live = true;
    api
      .listIssues({ plant_id: claim.plant_id, status: "all" })
      .then((l) => live && setIssues(l.issues.filter((i) => !claim.device_sn || i.device_sn === claim.device_sn || i.device_sn == null)))
      .catch(() => live && setIssues([]));
    return () => {
      live = false;
    };
  }, [claim, setError]);
  if (!claim) return null;
  const id = /^\d+$/.test(ref) ? Number(ref) : null;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Link a record · {claim.number}</DialogTitle>
          <DialogDescription>An issue, I-V sweep or site log entry of {claim.plant_name ?? `plant ${claim.plant_id}`}.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <Field id="l-kind" label="Kind">
            <Select
              value={kind}
              onValueChange={(v) => {
                setKind(v as ClaimLinkKind);
                setRef("");
              }}
            >
              <SelectTrigger id="l-kind" size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(LINK_KIND) as ClaimLinkKind[]).map((k) => (
                  <SelectItem key={k} value={k}>
                    {LINK_KIND[k]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {kind === "issue" ? (
            <Field id="l-issue" label="Issue" hint={issues && !issues.length ? "No issues for this plant / inverter" : claim.device_sn ? `Issues of ${claim.device_sn} and plant-wide ones` : undefined}>
              <Select value={ref} onValueChange={setRef} disabled={!issues?.length}>
                <SelectTrigger id="l-issue" size="sm" className="w-full">
                  <SelectValue placeholder={issues == null ? "Loading…" : "Pick an issue"} />
                </SelectTrigger>
                <SelectContent>
                  {(issues ?? []).map((i) => (
                    <SelectItem key={i.id} value={String(i.id)}>
                      {issueLabel(i)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          ) : (
            <div className="space-y-1.5">
              <Label htmlFor="l-id">{LINK_KIND[kind]} id</Label>
              <Input id="l-id" className="num h-8" inputMode="numeric" value={ref} onChange={(e) => setRef(e.target.value.trim())} />
            </div>
          )}
        </div>
        <Footer busy={busy} error={error} onClose={onClose} label="Link" disabled={id == null} onSubmit={() => void run(() => claimsApi.addClaimLink(claim.id, { kind, ref_id: id! }))} />
      </DialogContent>
    </Dialog>
  );
};
