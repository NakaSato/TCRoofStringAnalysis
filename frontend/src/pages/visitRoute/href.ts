/** Links into the Visit Route page: `/route?d=YYYY-MM-DD&team=<id>&user=<id>&add=<plantId>,<plantId>`.
 * Every param is optional; empty ones are left out. The page adds the `add` plants as stops, loads
 * candidates for `d` / `team` / `user`, then drops `add` from the URL. */
export interface RouteHrefParams {
  day?: string | null;
  teamId?: number | null;
  userId?: number | null;
  plantIds?: readonly number[] | null;
}

export const routeHref = ({ day, teamId, userId, plantIds }: RouteHrefParams = {}): string => {
  const q = new URLSearchParams();
  if (day) q.set("d", day);
  if (teamId != null) q.set("team", String(teamId));
  if (userId != null) q.set("user", String(userId));
  const add = [...new Set(plantIds ?? [])];
  if (add.length) q.set("add", add.join(","));
  // commas are fine in a query string: keep `add` readable instead of `%2C`
  const s = q.toString().replace(/%2C/gi, ",");
  return s ? `/route?${s}` : "/route";
};
