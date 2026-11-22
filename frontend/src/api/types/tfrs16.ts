/** TFRS 16 lease model of the PWA contract (`/tfrs16/*`, admin only). Every figure is the model's
 * accounting, never measured; phases with `estimated` rest on an assumed start date. */

export interface Tfrs16Head {
  imported: boolean;
  source: string | null;
  imported_at: string | null;
  labels: Record<string, string>;
}

export interface Tfrs16Phase {
  phase: number;
  estimated: boolean;
  stations: number | null;
  kwp: number | null;
  start_day: string | null;
  end_day: string | null;
  discount_rate: number | null;
  min_fee_thb: number | null;
  kwh_20y: number | null;
  rou_initial_thb: number | null;
  deferred_interest_thb: number | null;
}

export interface Tfrs16Period {
  period: number;
  /** YYYY-MM */
  month: string;
  /** Thai fiscal year, B.E. (1 Oct – 30 Sep) */
  fiscal_year: number;
  contract_year: number | null;
  min_fee_thb: number | null;
  kwh: number | null;
  opening_thb: number | null;
  interest_thb: number | null;
  /** positive */
  payment_thb: number | null;
  /** payment − interest */
  principal_thb: number | null;
  closing_thb: number | null;
  depreciation_thb: number | null;
  rou_net_thb: number | null;
}

export interface Tfrs16Schedule extends Tfrs16Head {
  phases: Array<Tfrs16Phase & { periods: Tfrs16Period[] }>;
  /** per month, summed over the phases whose lease has started (`phases`) */
  total: Array<{ month: string; liability_thb: number | null; rou_net_thb: number | null; phases: number[] }>;
  fiscal_years: Array<{
    fiscal_year: number;
    interest_thb: number | null;
    principal_thb: number | null;
    depreciation_thb: number | null;
    min_fee_thb: number | null;
    expense_thb: number | null;
    months_by_phase: Record<string, number>;
    /** some phase has fewer than 12 months in this fiscal year */
    partial: boolean;
  }>;
}

export interface Tfrs16Remeasurement {
  phase: number;
  assessed_on: string | null;
  book_liability_thb: number | null;
  remaining_fee_thb: number | null;
  old_deferred_interest_thb: number | null;
  production_share: number | null;
  revised_fee_thb: number | null;
  new_liability_thb: number | null;
  new_deferred_interest_thb: number | null;
  /** book − remeasured (positive = the liability falls) */
  difference_thb: number | null;
  difference_share: number | null;
  threshold_share: number | null;
  /** the sheet's own wording (Thai) */
  decision: string | null;
  account: string | null;
  sheet: string;
}

export interface Tfrs16FunnelCounts {
  stations: number;
  fee_paid: number;
  interconnected: number;
  first_sync: number;
}

export interface Tfrs16Summary extends Tfrs16Head {
  phases: Tfrs16Phase[];
  min_fee_total_thb: number | null;
  project_budget_thb: number | null;
  warnings: string[];
  remeasurements: Tfrs16Remeasurement[];
  revenue: {
    case: string | null;
    price_thb_kwh: number | null;
    /** calendar months (1–12) in contract-year order, October first */
    months: number[];
    phases: Array<{ phase: number; revenue_thb: Array<number | null>; total_thb: number | null }>;
  };
  rollout: {
    note: string | null;
    total: Tfrs16FunnelCounts;
    phases: Array<Tfrs16FunnelCounts & { phase: number }>;
    statuses: Array<{ status: string; stations: number }>;
  };
}

export interface Tfrs16RolloutStation {
  phase: number;
  seq: number;
  name: string;
  kwp: number | null;
  interconnect_status: string | null;
  fee_thb: number | null;
  fee_paid: boolean;
  interconnected: boolean;
  first_sync: string | null;
}

export interface Tfrs16Rollout extends Tfrs16Head {
  stations: Tfrs16RolloutStation[];
}
