import type { UserProfile } from "../api/client";

/**
 * Two roles (enforced by the backend; the UI only hides what would answer 403/404):
 * - admin: everything.
 * - engineer: only the Growatt plants an admin assigned (`user.plant_ids`).
 */
export const isAdmin = (user: UserProfile | null | undefined): boolean => user?.role === "admin";

/** Pages on the legacy O&M modules or user management: admin only. */
export const ADMIN_ONLY_PATHS = ["/maintenance", "/she", "/users"];

export const canAccessPath = (user: UserProfile | null | undefined, path: string): boolean =>
  isAdmin(user) || !ADMIN_ONLY_PATHS.some((p) => path === p || path.startsWith(`${p}/`));
