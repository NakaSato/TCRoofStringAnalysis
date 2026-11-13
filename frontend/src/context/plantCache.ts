import type { GrowattPlantOverview } from "../api/client";

/* DB overviews of plants opened in this tab (memory only, never stored). Switching between a
 * plant's pages, or back to a plant opened a moment ago, reuses it instead of fetching again.
 * Cleared on logout: the next user may not see the same plants. */
export const overviewCache = new Map<number, { ov: GrowattPlantOverview; at: number }>();
export const clearPlantCache = () => overviewCache.clear();
