/**
 * MOCK of the Claims API (`/claims*`) until the backend exists (docs/plans/claims.md). Same
 * signatures as the `api.*Claim*` methods. State lives in this tab's memory only: a reload starts
 * over and nothing is saved anywhere. The page shows a "Mock data" banner while this is on. Serials
 * are `MOCK-…`, references are examples.
 *
 * On in dev (`bun run dev`) or when built with `VITE_CLAIMS_MOCK=1`. Delete this file and
 * `CLAIMS_MOCK` once the backend answers `/claims`.
 *
 * What the backend will own and this file stands in for: claim numbers, the evidence checklist per
 * type, allowed status changes (409 otherwise), `waiting_on`, `followup_overdue`, the summary, and
 * admin-only actions (status changes, delete).
 */
import type {
  Claim,
  ClaimBody,
  ClaimCause,
  ClaimDetail,
  ClaimEvent,
  ClaimEventBody,
  ClaimEvidence,
  ClaimEvidenceBody,
  ClaimLink,
  ClaimLinkBody,
  ClaimList,
  ClaimStatus,
  ClaimStatusBody,
  ClaimType,
  ClaimWaiting,
  UserProfile,
} from "./client";
import { ApiError, api, getStoredUser } from "./client";
import { CLAIMS_MOCK, onMockReset } from "./mockFlags";

export { CLAIMS_MOCK };

const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Bangkok" });
const addDays = (day: string, n: number) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const nowIso = () => new Date().toISOString().slice(0, 19).replace("T", " ");
const delay = <T,>(v: T): Promise<T> => new Promise((r) => setTimeout(() => r(structuredClone(v)), 250));

/** allowed next statuses (the backend answers 409 for anything else) */
export const MOCK_TRANSITIONS: Record<ClaimStatus, ClaimStatus[]> = {
  draft: ["submitted", "withdrawn"],
  submitted: ["under_review", "info_requested", "approved", "rejected", "withdrawn"],
  under_review: ["info_requested", "approved", "rejected", "withdrawn"],
  info_requested: ["under_review", "withdrawn"],
  approved: ["fulfilled", "withdrawn"],
  rejected: ["under_review", "closed"],
  fulfilled: ["closed"],
  closed: ["under_review"],
  withdrawn: ["draft"],
};

const WAITING: Record<ClaimStatus, ClaimWaiting | null> = {
  draft: "us",
  submitted: "them",
  under_review: "them",
  info_requested: "us",
  approved: "them",
  rejected: "us",
  fulfilled: "us",
  closed: null,
  withdrawn: null,
};

const CLOSED: ReadonlySet<ClaimStatus> = new Set<ClaimStatus>(["closed", "withdrawn"]);

/** evidence checklist per type: [key, label, required] */
const EVIDENCE: Record<ClaimType, Array<[string, string, boolean]>> = {
  inverter_warranty: [
    ["alarm_log", "Alarm / fault log extract", true],
    ["photos", "Photos of the display and nameplate", true],
    ["site_log", "Site log entry of the failure", false],
    ["case_no", "Manufacturer case number", true],
  ],
  module_warranty: [
    ["iv_sweep", "I-V sweep at STC (module test candidate)", true],
    ["second_source", "Second source: IR flight or time-series issue", true],
    ["plr", "PLR analysis (≥ 2 years of data)", false],
    ["serials", "Module serial numbers", true],
    ["photos", "Photos", true],
  ],
  equipment_warranty: [
    ["device_sn", "Device serial number", true],
    ["fault", "Fault description", true],
    ["photos", "Photos", true],
  ],
  insurance: [
    ["incident_report", "Incident report", true],
    ["photos", "Photos of the damage", true],
    ["weather", "Weather on the day (radar / Google Weather)", false],
    ["quotation", "Repair quotation", true],
    ["police_report", "Police report (theft)", false],
  ],
  workmanship: [
    ["defect", "Defect description", true],
    ["photos", "Photos", true],
    ["contract", "Contract / warranty reference", true],
  ],
};

interface Row {
  base: Omit<Claim, "plant_name" | "followup_overdue" | "waiting_on" | "evidence_done" | "evidence_required">;
  events: ClaimEvent[];
  evidence: ClaimEvidence[];
  links: ClaimLink[];
}

let rows: Row[] | null = null;
let nextId = 1000;
let plants: Array<{ id: number; name: string }> = [];
onMockReset(() => {
  rows = null;
  plants = [];
});

const me = (): { name: string; admin: boolean } => {
  const u: UserProfile | null = getStoredUser();
  return { name: u?.full_name || u?.username || u?.email || "me", admin: u?.role === "admin" };
};

function evidenceFor(type: ClaimType, cause: ClaimCause, done: string[] = []): ClaimEvidence[] {
  return EVIDENCE[type].map(([key, label, required]) => ({
    key,
    label,
    required: required || (key === "police_report" && cause === "theft"),
    done: done.includes(key),
    url: null,
    note: null,
    by: done.includes(key) ? "admin" : null,
    at: done.includes(key) ? nowIso() : null,
  }));
}

function view(r: Row): Claim {
  const t = today();
  const open = !CLOSED.has(r.base.status);
  return {
    ...r.base,
    plant_name: plants.find((p) => p.id === r.base.plant_id)?.name ?? null,
    followup_overdue: open && r.base.next_action_day != null && r.base.next_action_day < t,
    waiting_on: WAITING[r.base.status],
    evidence_done: r.evidence.filter((e) => e.required && e.done).length,
    evidence_required: r.evidence.filter((e) => e.required).length,
  };
}

function seed(): Row[] {
  const t = today();
  const year = t.slice(0, 4);
  const plant = (i: number) => (plants.length ? plants[i % plants.length].id : 0);
  let n = 0;
  let eid = 1;
  const ev = (kind: ClaimEvent["kind"], daysAgo: number, summary: string, extra: Partial<ClaimEvent> = {}): ClaimEvent => ({
    id: eid++,
    kind,
    at: `${addDays(t, -daysAgo)} 09:00:00`,
    day: null,
    by: "admin",
    from_status: null,
    to_status: null,
    direction: null,
    summary,
    carrier: null,
    tracking_no: null,
    sn: null,
    ...extra,
  });
  const make = (
    type: ClaimType,
    status: ClaimStatus,
    cause: ClaimCause,
    p: number,
    fields: Partial<Row["base"]>,
    opts: { done?: string[]; events?: ClaimEvent[]; createdAgo: number }
  ): Row => {
    n += 1;
    const created = addDays(t, -opts.createdAgo);
    return {
      base: {
        id: n,
        number: `CL-${year}-${String(n).padStart(3, "0")}`,
        type,
        status,
        cause,
        plant_id: plant(p),
        device_sn: null,
        string_nos: [],
        module_serials: [],
        device_label: null,
        counterparty: type === "inverter_warranty" ? "Growatt" : "—",
        counterparty_ref: null,
        description: null,
        incident_day: null,
        discovered_day: null,
        submitted_day: null,
        closed_day: null,
        next_action_day: null,
        old_sn: null,
        new_sn: null,
        warranty_end_day: null,
        created_by: "admin",
        updated_by: null,
        created_at: `${created} 08:30:00`,
        updated_at: null,
        ...fields,
      },
      events: [ev("created", opts.createdAgo, "Claim created"), ...(opts.events ?? [])].sort((a, b) => b.at.localeCompare(a.at)),
      evidence: evidenceFor(type, cause, opts.done),
      links: [],
    };
  };
  const st = (from: ClaimStatus, to: ClaimStatus, daysAgo: number, note: string) => ev("status", daysAgo, note, { from_status: from, to_status: to });

  return [
    make(
      "inverter_warranty",
      "approved",
      "manufacturing_defect",
      0,
      {
        device_sn: "MOCK-INV-0101",
        old_sn: "MOCK-INV-0101",
        counterparty_ref: "GW-RMA-MOCK-2201",
        description: "Inverter stopped with an isolation fault every morning; reset did not clear it.",
        incident_day: addDays(t, -30),
        discovered_day: addDays(t, -29),
        submitted_day: addDays(t, -26),
        next_action_day: addDays(t, 4),
      },
      {
        createdAgo: 28,
        done: ["alarm_log", "photos", "case_no"],
        events: [
          st("draft", "submitted", 26, "Sent to Growatt service with the fault log"),
          ev("message", 20, "Growatt asked for the inverter's firmware version", { direction: "in", day: addDays(t, -20) }),
          st("submitted", "approved", 12, "Replacement approved; unit ships from Shenzhen"),
          ev("shipment", 6, "Replacement inverter shipped", { direction: "in", day: addDays(t, -6), carrier: "DHL", tracking_no: "MOCK-1234567890" }),
        ],
      }
    ),
    make(
      "inverter_warranty",
      "submitted",
      "unknown",
      1,
      {
        device_sn: "MOCK-INV-0207",
        counterparty_ref: "GW-RMA-MOCK-2245",
        description: "No AC output since the morning; display dark.",
        incident_day: addDays(t, -15),
        discovered_day: addDays(t, -15),
        submitted_day: addDays(t, -13),
        next_action_day: addDays(t, -3),
      },
      { createdAgo: 14, done: ["alarm_log", "photos", "case_no"], events: [st("draft", "submitted", 13, "Submitted; Growatt said 10 working days")] }
    ),
    make(
      "inverter_warranty",
      "draft",
      "unknown",
      2,
      { device_sn: "MOCK-INV-0312", description: "Fan noise and over-temperature derating.", incident_day: addDays(t, -3), discovered_day: addDays(t, -2) },
      { createdAgo: 2, done: ["alarm_log"] }
    ),
    make(
      "module_warranty",
      "info_requested",
      "degradation",
      3,
      {
        counterparty: "Module maker (example)",
        counterparty_ref: "MOD-MOCK-0091",
        device_sn: "MOCK-INV-0405",
        string_nos: [3, 4],
        module_serials: ["MOCK-MOD-000311", "MOCK-MOD-000312", "MOCK-MOD-000318"],
        description: "Strings 3 and 4 below warranted power; IR shows hot cells on three modules.",
        discovered_day: addDays(t, -60),
        submitted_day: addDays(t, -45),
        next_action_day: addDays(t, 2),
        warranty_end_day: addDays(t, 365 * 8),
      },
      {
        createdAgo: 50,
        done: ["iv_sweep", "second_source", "serials"],
        events: [
          st("draft", "submitted", 45, "Submitted with I-V and IR"),
          st("submitted", "under_review", 35, "Manufacturer reviewing"),
          st("under_review", "info_requested", 9, "They want flash-test results of the three modules"),
        ],
      }
    ),
    make(
      "module_warranty",
      "rejected",
      "installation",
      4,
      {
        counterparty: "Module maker (example)",
        counterparty_ref: "MOD-MOCK-0077",
        device_sn: "MOCK-INV-0501",
        string_nos: [1],
        module_serials: ["MOCK-MOD-000101"],
        description: "Cracked glass on one module.",
        discovered_day: addDays(t, -90),
        submitted_day: addDays(t, -85),
      },
      {
        createdAgo: 88,
        done: ["iv_sweep", "second_source", "serials", "photos"],
        events: [st("draft", "submitted", 85, "Submitted"), st("submitted", "rejected", 40, "Rejected: impact damage, not covered")],
      }
    ),
    make(
      "equipment_warranty",
      "under_review",
      "lightning",
      0,
      {
        counterparty: "Growatt",
        device_label: "Datalogger ShineMaster (MOCK-DL-01)",
        description: "Datalogger dead after a storm; no upload since.",
        incident_day: addDays(t, -20),
        discovered_day: addDays(t, -19),
        submitted_day: addDays(t, -17),
      },
      { createdAgo: 18, done: ["device_sn", "fault", "photos"], events: [st("draft", "submitted", 17, "Submitted"), st("submitted", "under_review", 10, "Under review")] }
    ),
    make(
      "insurance",
      "under_review",
      "storm_wind",
      1,
      {
        counterparty: "Insurer (example)",
        counterparty_ref: "INS-MOCK-55120",
        device_label: "Array B, 14 modules and rails",
        description: "Storm lifted part of array B; 14 modules broken.",
        incident_day: addDays(t, -40),
        discovered_day: addDays(t, -39),
        submitted_day: addDays(t, -35),
        next_action_day: addDays(t, -6),
      },
      {
        createdAgo: 38,
        done: ["incident_report", "photos", "weather", "quotation"],
        events: [
          st("draft", "submitted", 35, "Submitted to the insurer"),
          st("submitted", "under_review", 28, "Loss adjuster appointed"),
          ev("note", 20, "Loss adjuster visited the site"),
        ],
      }
    ),
    make(
      "insurance",
      "closed",
      "theft",
      2,
      {
        counterparty: "Insurer (example)",
        counterparty_ref: "INS-MOCK-41007",
        device_label: "DC cables, 120 m",
        description: "DC cable stolen from the roof.",
        incident_day: addDays(t, -150),
        discovered_day: addDays(t, -149),
        submitted_day: addDays(t, -145),
        closed_day: addDays(t, -70),
      },
      {
        createdAgo: 148,
        done: ["incident_report", "photos", "quotation", "police_report"],
        events: [
          st("draft", "submitted", 145, "Submitted"),
          st("submitted", "approved", 100, "Approved after the loss adjuster's report"),
          st("approved", "fulfilled", 80, "Paid"),
          st("fulfilled", "closed", 70, "Closed"),
        ],
      }
    ),
    make(
      "inverter_warranty",
      "closed",
      "manufacturing_defect",
      3,
      {
        device_sn: "MOCK-INV-0402",
        old_sn: "MOCK-INV-0402",
        new_sn: "MOCK-INV-0499",
        counterparty_ref: "GW-RMA-MOCK-1980",
        description: "Repeated grid-relay faults.",
        incident_day: addDays(t, -120),
        discovered_day: addDays(t, -120),
        submitted_day: addDays(t, -118),
        closed_day: addDays(t, -75),
      },
      {
        createdAgo: 119,
        done: ["alarm_log", "photos", "site_log", "case_no"],
        events: [
          st("draft", "submitted", 118, "Submitted"),
          st("submitted", "approved", 100, "Replacement approved"),
          ev("shipment", 90, "Replacement arrived", { direction: "in", day: addDays(t, -90), carrier: "Kerry", tracking_no: "MOCK-KE-77812", sn: "MOCK-INV-0499" }),
          st("approved", "fulfilled", 88, "Swapped on site"),
          ev("shipment", 85, "Failed unit sent back", { direction: "out", day: addDays(t, -85), carrier: "Kerry", tracking_no: "MOCK-KE-78100", sn: "MOCK-INV-0402" }),
          st("fulfilled", "closed", 75, "Closed"),
        ],
      }
    ),
    make(
      "workmanship",
      "submitted",
      "installation",
      4,
      {
        counterparty: "EPC (example)",
        device_label: "MC4 connectors, strings 5–6",
        description: "Burnt MC4 connectors; crimping not to spec.",
        incident_day: addDays(t, -10),
        discovered_day: addDays(t, -10),
        submitted_day: addDays(t, -8),
        next_action_day: addDays(t, 6),
      },
      { createdAgo: 9, done: ["defect", "photos"], events: [st("draft", "submitted", 8, "Sent to the EPC")] }
    ),
    make(
      "equipment_warranty",
      "fulfilled",
      "manufacturing_defect",
      0,
      {
        counterparty: "Meter supplier (example)",
        device_label: "Energy meter (MOCK-MTR-03)",
        description: "Meter reads zero import.",
        incident_day: addDays(t, -50),
        discovered_day: addDays(t, -48),
        submitted_day: addDays(t, -46),
        new_sn: "MOCK-MTR-09",
      },
      {
        createdAgo: 47,
        done: ["device_sn", "fault", "photos"],
        events: [st("draft", "submitted", 46, "Submitted"), st("submitted", "approved", 30, "Approved"), st("approved", "fulfilled", 5, "New meter installed")],
      }
    ),
    make(
      "insurance",
      "withdrawn",
      "flood",
      1,
      {
        counterparty: "Insurer (example)",
        device_label: "Combiner box",
        description: "Water in the combiner box; dried and working again.",
        incident_day: addDays(t, -70),
        discovered_day: addDays(t, -69),
        closed_day: addDays(t, -60),
      },
      { createdAgo: 69, done: ["photos"], events: [st("draft", "withdrawn", 60, "Working again after drying; claim not needed")] }
    ),
  ];
}

const load = () => (rows ??= seed());

function find(id: number): Row {
  const r = load().find((x) => x.base.id === id);
  if (!r) throw new ApiError("Claim not found", 404);
  return r;
}

const reject = (msg: string, status: number) => Promise.reject(new ApiError(msg, status));
const adminOnly = () => (me().admin ? null : reject("Admins only", 403));

function addEvent(r: Row, e: Omit<ClaimEvent, "id" | "at" | "by">) {
  r.events.unshift({ id: nextId++, at: nowIso(), by: me().name, ...e });
  r.base.updated_at = nowIso();
  r.base.updated_by = me().name;
}

const blankEvent = { day: null, from_status: null, to_status: null, direction: null, carrier: null, tracking_no: null, sn: null } as const;

/** the issue's own estimates, read from the real `/issues` API (only the plant's issues) */
async function issueLink(plantId: number, issueId: number, linkId: number): Promise<ClaimLink> {
  try {
    const list = await api.listIssues({ plant_id: plantId, status: "all" });
    const i = list.issues.find((x) => x.id === issueId);
    if (i)
      return {
        id: linkId,
        kind: "issue",
        ref_id: issueId,
        label: `${i.rule} ${i.name}`,
      };
  } catch {
    // not found / not allowed: keep the bare link
  }
  return { id: linkId, kind: "issue", ref_id: issueId, label: null };
}

const linkOf = async (r: Row, b: ClaimLinkBody): Promise<ClaimLink> =>
  b.kind === "issue"
    ? issueLink(r.base.plant_id, b.ref_id, nextId++)
    : { id: nextId++, kind: b.kind, ref_id: b.ref_id, label: null };

export const claimsMock = {
  /** mock only: seed claims on the user's own plants */
  setPlants(ps: Array<{ id: number; name: string }>) {
    if (!ps.length) return;
    // seeded before the plant list arrived: seed again on the real plants
    if (rows && !plants.length) rows = null;
    plants = ps;
  },

  listClaims: (): Promise<ClaimList> => {
    const t = today();
    const claims = load().map(view);
    const open = claims.filter((c) => !CLOSED.has(c.status));
    return delay({
      claims,
      summary: {
        open: open.length,
        waiting_us: open.filter((c) => c.waiting_on === "us").length,
        waiting_them: open.filter((c) => c.waiting_on === "them").length,
        followup_overdue: open.filter((c) => c.followup_overdue).length,
      },
      meta: { source: "mock", today: t },
    });
  },

  getClaim: (id: number): Promise<ClaimDetail> => {
    try {
      const r = find(id);
      return delay({ ...view(r), events: r.events, evidence: r.evidence, links: r.links });
    } catch (e) {
      return Promise.reject(e);
    }
  },

  createClaim: async (body: ClaimBody): Promise<Claim> => {
    const all = load();
    const year = today().slice(0, 4);
    const n = all.filter((r) => r.base.number.startsWith(`CL-${year}-`)).length + 1;
    const { links, ...fields } = body;
    const r: Row = {
      base: {
        id: nextId++,
        number: `CL-${year}-${String(n).padStart(3, "0")}`,
        status: "draft",
        submitted_day: null,
        closed_day: null,
        next_action_day: null,
        old_sn: body.type === "inverter_warranty" ? body.device_sn : null,
        new_sn: null,
        created_by: me().name,
        updated_by: null,
        created_at: nowIso(),
        updated_at: null,
        ...fields,
      },
      events: [],
      evidence: evidenceFor(body.type, body.cause),
      links: [],
    };
    for (const l of links ?? []) r.links.push(await linkOf(r, l));
    addEvent(r, { ...blankEvent, kind: "created", summary: "Claim created" });
    all.unshift(r);
    return delay(view(r));
  },

  patchClaim: (id: number, body: Partial<ClaimBody>): Promise<Claim> => {
    const r = find(id);
    if (CLOSED.has(r.base.status) && !me().admin) return reject("The claim is closed", 409);
    const { links: _links, ...fields } = body;
    void _links;
    const typeChanged = fields.type != null && fields.type !== r.base.type;
    Object.assign(r.base, fields);
    if (typeChanged) r.evidence = evidenceFor(r.base.type, r.base.cause);
    if (r.base.type === "inverter_warranty" && r.base.old_sn == null) r.base.old_sn = r.base.device_sn;
    addEvent(r, { ...blankEvent, kind: "edit", summary: "Details edited" });
    return delay(view(r));
  },

  deleteClaim: (id: number): Promise<void> => {
    const denied = adminOnly();
    if (denied) return denied;
    const r = find(id);
    if (r.base.status !== "draft") return reject("Only a draft can be deleted: withdraw it instead", 409);
    rows = load().filter((x) => x !== r);
    return delay(undefined);
  },

  setClaimStatus: (id: number, body: ClaimStatusBody): Promise<Claim> => {
    const denied = adminOnly();
    if (denied) return denied;
    const r = find(id);
    const from = r.base.status;
    if (!MOCK_TRANSITIONS[from].includes(body.status)) return reject(`Cannot go from ${from} to ${body.status}`, 409);
    if (!body.note.trim()) return reject("A note is required", 422);
    const t = today();
    r.base.status = body.status;
    if (body.status === "submitted" && !r.base.submitted_day) r.base.submitted_day = t;
    if (CLOSED.has(body.status)) r.base.closed_day = t;
    else r.base.closed_day = null;
    if (body.next_action_day !== undefined) r.base.next_action_day = body.next_action_day;
    if (CLOSED.has(body.status)) r.base.next_action_day = null;
    if (body.new_sn) {
      r.base.new_sn = body.new_sn;
      r.base.old_sn ??= r.base.device_sn;
    }
    addEvent(r, { ...blankEvent, kind: "status", from_status: from, to_status: body.status, summary: body.note.trim(), sn: body.new_sn ?? null });
    return delay(view(r));
  },

  addClaimEvent: (id: number, body: ClaimEventBody): Promise<ClaimEvent> => {
    const r = find(id);
    if (!body.summary.trim()) return reject("Say what happened", 422);
    addEvent(r, {
      kind: body.kind,
      day: body.day,
      from_status: null,
      to_status: null,
      direction: body.direction ?? null,
      summary: body.summary.trim(),
      carrier: body.carrier ?? null,
      tracking_no: body.tracking_no ?? null,
      sn: body.sn ?? null,
    });
    return delay(r.events[0]);
  },

  setClaimEvidence: (id: number, key: string, body: ClaimEvidenceBody): Promise<ClaimEvidence> => {
    const r = find(id);
    const e = r.evidence.find((x) => x.key === key);
    if (!e) return reject("No such evidence item", 404);
    e.done = body.done;
    if (body.url !== undefined) e.url = body.url;
    if (body.note !== undefined) e.note = body.note;
    e.by = me().name;
    e.at = nowIso();
    r.base.updated_at = nowIso();
    return delay(e);
  },

  addClaimLink: async (id: number, body: ClaimLinkBody): Promise<ClaimLink> => {
    const r = find(id);
    if (r.links.some((l) => l.kind === body.kind && l.ref_id === body.ref_id)) return reject("Already linked", 409);
    const l = await linkOf(r, body);
    r.links.push(l);
    return delay(l);
  },

  deleteClaimLink: (id: number, linkId: number): Promise<void> => {
    const r = find(id);
    r.links = r.links.filter((l) => l.id !== linkId);
    return delay(undefined);
  },
};
