/** API types: Measuring Tools (Operations → Measuring Tools, `/tools`). The O&M team's measuring
 * instruments (drones, thermal cameras, clamp meters, I-V tracers, …): who holds them, where, and
 * when calibration or documents run out. DB only; every spec, date and cost is entered by people,
 * so any of them can be null ("—"). docs/plans/measuring-tools.md. */

export type InstrumentCategory =
  | "drone"
  | "thermal_camera"
  | "iv_tracer"
  | "insulation_tester"
  | "clamp_meter"
  | "multimeter"
  | "irradiance_meter"
  | "earth_tester"
  | "power_analyser"
  | "other";

export type InstrumentStatus = "available" | "checked_out" | "at_calibration" | "repair" | "retired";

/** what runs out: calibration, or a drone's documents */
export type DueKind = "calibration" | "caat" | "nbtc" | "insurance" | "pilot_licence" | "other";

/** `none` = no date entered (never shown as ok) */
export type DueState = "overdue" | "due_soon" | "ok" | "none";

export type CheckoutCondition = "ok" | "damaged" | "lost";

/** spec values by key (keys per category, see `pages/tools/format.ts`); null = not entered */
export type InstrumentSpecs = Record<string, number | string | null>;

export interface DueItem {
  kind: DueKind;
  /** last calibration / renewal day; null = none recorded */
  last_day: string | null;
  /** null = no date entered */
  next_due: string | null;
  state: DueState;
  number: string | null;
  issuer: string | null;
}

/** one recorded calibration or document renewal */
export interface DueRecord {
  id: number;
  kind: DueKind;
  day: string;
  next_due: string | null;
  number: string | null;
  issuer: string | null;
  cost_thb: number | null;
  url: string | null;
  note: string | null;
  created_by: string | null;
  created_at: string | null;
}

export interface UserRef {
  id: number;
  name: string;
}

export interface Checkout {
  id: number;
  instrument_id: number;
  holder: UserRef | null;
  /** plant it went to; null = not to a plant (office, lab, …) */
  plant_id: number | null;
  plant_name: string | null;
  out_at: string;
  /** plant-local day it should be back */
  due_back: string;
  /** open check-out past `due_back` */
  overdue: boolean;
  returned_at: string | null;
  condition: CheckoutCondition | null;
  note: string | null;
  return_note: string | null;
  /** warnings the person acknowledged at check-out ("calibration_overdue", "drone_documents_expired") */
  ack_warnings: string[];
  created_by: string | null;
}

export interface Instrument {
  id: number;
  asset_tag: string;
  name: string;
  category: InstrumentCategory;
  make: string | null;
  model: string | null;
  serial_no: string | null;
  status: InstrumentStatus;
  holder: UserRef | null;
  open_checkout: Checkout | null;
  specs: InstrumentSpecs;
  due: DueItem[];
  /** earliest `due[].next_due`; null = no date entered */
  next_due: string | null;
  /** worst `due[].state` */
  due_state: DueState;
  calibration_interval_months: number | null;
  purchase_day: string | null;
  cost_thb: number | null;
  note: string | null;
  /** number of check-outs ever (a tool that was never checked out may be deleted) */
  checkout_count: number;
  created_by: string | null;
  updated_by: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface InstrumentDetail extends Instrument {
  due_history: DueRecord[];
  checkouts: Checkout[];
}

export interface InstrumentList {
  instruments: Instrument[];
  summary: {
    total: number;
    available: number;
    checked_out: number;
    overdue_back: number;
    due_soon: number;
    overdue: number;
  };
  meta: {
    source: "db";
    /** due soon = next due within this many days */
    due_soon_days: number;
    /** plant-local today the states were judged on */
    today: string;
  };
}

export interface InstrumentBody {
  asset_tag: string;
  name: string;
  category: InstrumentCategory;
  make?: string | null;
  model?: string | null;
  serial_no?: string | null;
  specs?: InstrumentSpecs;
  calibration_interval_months?: number | null;
  purchase_day?: string | null;
  cost_thb?: number | null;
  note?: string | null;
  /** PATCH only: available / at_calibration / repair / retired (check-out has its own call) */
  status?: InstrumentStatus;
}

export interface CheckoutBody {
  /** omitted = the signed-in user (engineers can check out only to themselves) */
  holder_user_id?: number | null;
  plant_id?: number | null;
  due_back: string;
  note?: string | null;
  /** warnings shown in the dialog and acknowledged */
  ack_warnings: string[];
}

export interface ReturnBody {
  condition: CheckoutCondition;
  note?: string | null;
}

export interface DueBody {
  kind: DueKind;
  day: string;
  /** omitted for calibration = day + the instrument's interval (if one is entered) */
  next_due?: string | null;
  number?: string | null;
  issuer?: string | null;
  cost_thb?: number | null;
  url?: string | null;
  note?: string | null;
}
