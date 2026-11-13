import type { UserProfile } from "../api/client";

/**
 * Two roles (enforced by the backend; the UI only hides what would answer 403/404):
 * - admin: everything.
 * - engineer: only the Growatt plants an admin assigned (`user.plant_ids`).
 */
export const isAdmin = (user: UserProfile | null | undefined): boolean => user?.role === "admin";

/** Pages on the legacy O&M modules or user management: admin only. */
export const ADMIN_ONLY_PATHS = ["/maintenance", "/she", "/users"];

/** Plant pages (`/plant/:id/<page>`) that are admin only. */
export const ADMIN_ONLY_PLANT_PAGES: readonly string[] = ["maintenance"];

export const canAccessPlantPage = (user: UserProfile | null | undefined, page: string): boolean =>
  isAdmin(user) || !ADMIN_ONLY_PLANT_PAGES.includes(page);

export const canAccessPath = (user: UserProfile | null | undefined, path: string): boolean => {
  if (isAdmin(user)) return true;
  const plantPage = /^\/plant\/[^/]+\/([^/]+)/.exec(path)?.[1];
  if (plantPage != null && !canAccessPlantPage(user, plantPage)) return false;
  return !ADMIN_ONLY_PATHS.some((p) => path === p || path.startsWith(`${p}/`));
};
