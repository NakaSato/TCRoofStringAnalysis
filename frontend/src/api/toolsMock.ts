/**
 * MOCK of the Measuring Tools API (`/tools*`) until the backend exists (docs/plans/measuring-tools.md).
 * Same signatures as the `api.*Instrument*` methods. State lives in this tab's memory only: a reload
 * starts over and nothing is saved anywhere. The page shows a "Mock data" banner while this is on.
 *
 * On in dev (`bun run dev`) or when built with `VITE_TOOLS_MOCK=1`. Delete this file and
 * `TOOLS_MOCK` once the backend answers `/tools`.
 */
import type {
  Checkout,
  CheckoutBody,
  DueBody,
  DueItem,
  DueKind,
  DueRecord,
  DueState,
  Instrument,
  InstrumentBody,
  InstrumentCategory,
  InstrumentDetail,
  InstrumentList,
  ReturnBody,
  UserProfile,
} from "./client";
import { ApiError, getStoredUser } from "./client";

export const TOOLS_MOCK: boolean = import.meta.env.DEV || import.meta.env.VITE_TOOLS_MOCK === "1";

const DUE_SOON_DAYS = 30;
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Bangkok" });
const addDays = (day: string, n: number) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const addMonths = (day: string, n: number) => {
  const [y, m, d] = day.split("-").map(Number);
  const last = new Date(Date.UTC(y, m - 1 + n + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m - 1 + n, Math.min(d, last))).toISOString().slice(0, 10);
};
const nowIso = () => new Date().toISOString().slice(0, 19).replace("T", " ");
const delay = <T,>(v: T): Promise<T> => new Promise((r) => setTimeout(() => r(structuredClone(v)), 250));

const DRONE_DOCS: DueKind[] = ["caat", "nbtc", "insurance"];
const kindsOf = (c: InstrumentCategory): DueKind[] => (c === "drone" ? DRONE_DOCS : ["calibration"]);

interface Row {
  base: Omit<Instrument, "due" | "next_due" | "due_state" | "open_checkout" | "holder" | "checkout_count">;
  history: DueRecord[];
  checkouts: Checkout[];
}

let rows: Row[] | null = null;
let nextId = 1000;
let plantIds: number[] = [];

const me = (): { id: number; name: string } => {
  const u: UserProfile | null = getStoredUser();
  return { id: u?.id ?? 0, name: u?.full_name || u?.username || u?.email || "me" };
};

function stateOf(next: string | null, t: string): DueState {
  if (!next) return "none";
  if (next < t) return "overdue";
  return next <= addDays(t, DUE_SOON_DAYS) ? "due_soon" : "ok";
}

const RANK: Record<DueState, number> = { overdue: 0, due_soon: 1, none: 2, ok: 3 };

function view(r: Row): Instrument {
  const t = today();
  const due: DueItem[] = kindsOf(r.base.category).map((kind) => {
    const last = r.history.filter((h) => h.kind === kind).sort((a, b) => b.day.localeCompare(a.day))[0];
    const next = last?.next_due ?? null;
    return { kind, last_day: last?.day ?? null, next_due: next, state: stateOf(next, t), number: last?.number ?? null, issuer: last?.issuer ?? null };
  });
  const dated = due.filter((d) => d.next_due).map((d) => d.next_due!) as string[];
  const open = r.checkouts.find((c) => !c.returned_at) ?? null;
  if (open) open.overdue = open.due_back < t;
  return {
    ...r.base,
    due,
    next_due: dated.length ? dated.sort()[0] : null,
    due_state: due.reduce<DueState>((w, d) => (RANK[d.state] < RANK[w] ? d.state : w), "ok" as DueState),
    open_checkout: open,
    holder: open?.holder ?? null,
    checkout_count: r.checkouts.length,
  };
}

function seed(): Row[] {
  const t = today();
  const plant = (i: number) => (plantIds.length ? plantIds[i % plantIds.length] : null);
  const base = (
    id: number,
    asset_tag: string,
    name: string,
    category: InstrumentCategory,
    make: string | null,
    model: string | null,
    specs: Instrument["specs"],
    interval: number | null,
    extra: Partial<Row["base"]> = {}
  ): Row["base"] => ({
    id,
    asset_tag,
    name,
    category,
    make,
    model,
    serial_no: `MOCK-${String(id).padStart(4, "0")}`,
    status: "available",
    specs,
    calibration_interval_months: interval,
    purchase_day: null,
    cost_thb: null,
    note: null,
    created_by: "admin",
    updated_by: null,
    created_at: null,
    updated_at: null,
    ...extra,
  });
  let hid = 1;
  const rec = (kind: DueKind, day: string, next_due: string | null, issuer: string | null, number: string | null = null): DueRecord => ({
    id: hid++,
    kind,
    day,
    next_due,
    number,
    issuer,
    cost_thb: null,
    url: null,
    note: null,
    created_by: "admin",
    created_at: null,
  });
  let cid = 1;
  const out = (instrument_id: number, holder: string, plant_id: number | null, outDays: number, backDays: number, returned = false): Checkout => ({
    id: cid++,
    instrument_id,
    holder: { id: 2, name: holder },
    plant_id,
    plant_name: null,
    out_at: `${addDays(t, -outDays)} 08:30:00`,
    due_back: addDays(t, backDays),
    overdue: false,
    returned_at: returned ? `${addDays(t, backDays)} 17:00:00` : null,
    condition: returned ? "ok" : null,
    note: null,
    return_note: null,
    ack_warnings: [],
    created_by: holder,
  });

  return [
    {
      base: base(1, "MT-001", "Thermal inspection drone", "drone", "DJI", "Mavic 3T", { thermal_resolution: "640×512", camera: "48 MP", batteries: 4 }, null),
      history: [
        rec("caat", addDays(t, -300), addDays(t, 65), "CAAT", "UAS-MOCK-001"),
        rec("nbtc", addDays(t, -300), addDays(t, 430), "NBTC", "NBTC-MOCK-001"),
        rec("insurance", addDays(t, -350), addDays(t, 15), "Mock Insurance Co."),
      ],
      checkouts: [out(1, "engineer", plant(0), 1, 2)],
    },
    {
      base: base(2, "MT-002", "Thermal drone (spare)", "drone", "DJI", "Matrice 30T", { thermal_resolution: "640×512", camera: null, batteries: 2 }, null),
      history: [rec("caat", addDays(t, -400), addDays(t, -35), "CAAT", "UAS-MOCK-002"), rec("insurance", addDays(t, -200), addDays(t, 165), "Mock Insurance Co.")],
      checkouts: [],
    },
    {
      base: base(3, "MT-003", "Handheld IR camera", "thermal_camera", "FLIR", "E8-XT", { resolution: "320×240", temp_range: "−20 … 550 °C" }, 12),
      history: [rec("calibration", addDays(t, -200), addDays(t, 165), "Mock Cal Lab", "CAL-3001")],
      checkouts: [out(3, "engineer", plant(1), 10, -3)],
    },
    {
      base: base(4, "MT-004", "I-V curve tracer", "iv_tracer", "Seaward", "PV200", { max_v: 1000, max_a: 15 }, 12),
      history: [rec("calibration", addDays(t, -350), addDays(t, 15), "Mock Cal Lab", "CAL-3002")],
      checkouts: [out(4, "engineer", plant(2), 40, -38, true)],
    },
    {
      base: base(5, "MT-005", "Insulation tester", "insulation_tester", "Megger", "MIT430", { test_voltages: "50 … 1000 V", cat_rating: "CAT IV 600 V" }, 12),
      history: [rec("calibration", addDays(t, -400), addDays(t, -35), "Mock Cal Lab", "CAL-3003")],
      checkouts: [],
    },
    {
      base: base(6, "MT-006", "DC clamp meter", "clamp_meter", "Fluke", "393 FC", { cat_rating: "CAT III 1500 V DC", max_dc_v: 1500, max_a: 999 }, 12),
      history: [rec("calibration", addDays(t, -100), addDays(t, 265), "Mock Cal Lab", "CAL-3004")],
      checkouts: [],
    },
    {
      base: base(7, "MT-007", "Clamp meter (old)", "clamp_meter", null, null, { cat_rating: null, max_dc_v: null, max_a: 400 }, null, {
        note: "Rating label worn off",
      }),
      history: [],
      checkouts: [],
    },
    {
      base: base(8, "MT-008", "Multimeter", "multimeter", "Fluke", "87V", { cat_rating: "CAT III 1000 V", max_dc_v: 1000 }, 12),
      history: [rec("calibration", addDays(t, -60), addDays(t, 305), "Mock Cal Lab", "CAL-3005")],
      checkouts: [out(8, "admin", null, 0, 5)],
    },
    {
      base: base(9, "MT-009", "Irradiance meter", "irradiance_meter", null, null, { range_wm2: "0 … 1,500 W/m²" }, 24, { status: "at_calibration" }),
      history: [rec("calibration", addDays(t, -740), addDays(t, -10), "Mock Cal Lab")],
      checkouts: [],
    },
    {
      base: base(10, "MT-010", "Earth resistance tester", "earth_tester", "Kyoritsu", "4105A", { method: "3-pole" }, 12, { status: "repair", note: "Display faulty" }),
      history: [rec("calibration", addDays(t, -150), addDays(t, 215), "Mock Cal Lab")],
      checkouts: [],
    },
    {
      base: base(11, "MT-011", "Power quality analyser", "power_analyser", null, null, { channels: 4 }, null),
      history: [],
      checkouts: [],
    },
  ];
}

function load(): Row[] {
  if (!rows) rows = seed();
  return rows;
}
const find = (id: number): Row => {
  const r = load().find((x) => x.base.id === id);
  if (!r) throw new ApiError("Instrument not found", 404);
  return r;
};

export const toolsMock = {
  /** mock only: plants the seeded check-outs may point at (the user's own plants) */
  setPlants(ids: number[]) {
    if (!rows && ids.length) plantIds = ids;
  },

  listInstruments: (includeRetired = false): Promise<InstrumentList> => {
    const all = load().map(view);
    const list = includeRetired ? all : all.filter((i) => i.status !== "retired");
    const active = all.filter((i) => i.status !== "retired");
    return delay({
      instruments: list,
      summary: {
        total: active.length,
        available: active.filter((i) => i.status === "available").length,
        checked_out: active.filter((i) => i.status === "checked_out").length,
        overdue_back: active.filter((i) => i.open_checkout?.overdue).length,
        due_soon: active.filter((i) => i.due.some((d) => d.state === "due_soon")).length,
        overdue: active.filter((i) => i.due.some((d) => d.state === "overdue")).length,
      },
      meta: { source: "mock" as const, due_soon_days: DUE_SOON_DAYS, today: today() },
    });
  },

  getInstrument: (id: number): Promise<InstrumentDetail> => {
    const r = find(id);
    return delay({
      ...view(r),
      due_history: [...r.history].sort((a, b) => b.day.localeCompare(a.day)),
      checkouts: [...r.checkouts].sort((a, b) => b.out_at.localeCompare(a.out_at)),
    });
  },

  createInstrument: (body: InstrumentBody): Promise<Instrument> => {
    if (load().some((r) => r.base.asset_tag === body.asset_tag)) return Promise.reject(new ApiError("Asset tag already used", 409));
    const id = nextId++;
    const r: Row = {
      base: {
        id,
        asset_tag: body.asset_tag,
        name: body.name,
        category: body.category,
        make: body.make ?? null,
        model: body.model ?? null,
        serial_no: body.serial_no ?? null,
        status: "available",
        specs: body.specs ?? {},
        calibration_interval_months: body.calibration_interval_months ?? null,
        purchase_day: body.purchase_day ?? null,
        cost_thb: body.cost_thb ?? null,
        note: body.note ?? null,
        created_by: me().name,
        updated_by: null,
        created_at: nowIso(),
        updated_at: null,
      },
      history: [],
      checkouts: [],
    };
    load().push(r);
    return delay(view(r));
  },

  patchInstrument: (id: number, body: Partial<InstrumentBody>): Promise<Instrument> => {
    const r = find(id);
    if (body.status === "checked_out") return Promise.reject(new ApiError("Use check-out", 400));
    if (body.status && r.checkouts.some((c) => !c.returned_at)) return Promise.reject(new ApiError("Check it in first", 409));
    if (body.asset_tag && load().some((x) => x !== r && x.base.asset_tag === body.asset_tag)) return Promise.reject(new ApiError("Asset tag already used", 409));
    Object.assign(r.base, body, { updated_by: me().name, updated_at: nowIso() });
    return delay(view(r));
  },

  deleteInstrument: (id: number): Promise<void> => {
    const r = find(id);
    if (r.checkouts.length) return Promise.reject(new ApiError("It has been checked out before: retire it instead", 409));
    rows = load().filter((x) => x !== r);
    return delay(undefined);
  },

  checkoutInstrument: (id: number, body: CheckoutBody): Promise<Checkout> => {
    const r = find(id);
    if (r.base.status !== "available") return Promise.reject(new ApiError(`Not available (${r.base.status})`, 409));
    const user = me();
    const c: Checkout = {
      id: nextId++,
      instrument_id: id,
      holder: body.holder_user_id != null && body.holder_user_id !== user.id ? { id: body.holder_user_id, name: `user ${body.holder_user_id}` } : user,
      plant_id: body.plant_id ?? null,
      plant_name: null,
      out_at: nowIso(),
      due_back: body.due_back,
      overdue: false,
      returned_at: null,
      condition: null,
      note: body.note ?? null,
      return_note: null,
      ack_warnings: body.ack_warnings,
      created_by: user.name,
    };
    r.checkouts.push(c);
    r.base.status = "checked_out";
    return delay(c);
  },

  returnInstrument: (id: number, body: ReturnBody): Promise<Checkout> => {
    const r = find(id);
    const c = r.checkouts.find((x) => !x.returned_at);
    if (!c) return Promise.reject(new ApiError("Not checked out", 409));
    c.returned_at = nowIso();
    c.condition = body.condition;
    c.return_note = body.note ?? null;
    c.overdue = false;
    r.base.status = body.condition === "ok" ? "available" : body.condition === "damaged" ? "repair" : "retired";
    return delay(c);
  },

  recordInstrumentDue: (id: number, body: DueBody): Promise<Instrument> => {
    const r = find(id);
    const interval = r.base.calibration_interval_months;
    const next = body.next_due ?? (body.kind === "calibration" && interval ? addMonths(body.day, interval) : null);
    r.history.push({
      id: nextId++,
      kind: body.kind,
      day: body.day,
      next_due: next,
      number: body.number ?? null,
      issuer: body.issuer ?? null,
      cost_thb: body.cost_thb ?? null,
      url: body.url ?? null,
      note: body.note ?? null,
      created_by: me().name,
      created_at: nowIso(),
    });
    if (body.kind === "calibration" && r.base.status === "at_calibration") r.base.status = "available";
    return delay(view(r));
  },
};
