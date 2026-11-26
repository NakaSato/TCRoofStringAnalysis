/** API types: Users, roles and the signed-in profile. */

export interface UserProfile {
  id: number;
  username: string | null;
  email: string;
  full_name: string;
  role: UserRole;
  is_active: boolean;
  /** Spares: may receive, correct and edit the catalogue / locations (admins always may) */
  store_keeper: boolean;
  /** Growatt plants this user may see: null = every plant (admin), else the ids an admin assigned. */
  plant_ids: number[] | null;
}

export type UserRole = "admin" | "engineer";

export interface UserCreate {
  username: string;
  email?: string | null;
  full_name: string;
  password: string;
  role: UserRole;
  plant_ids: number[];
}

export type UserUpdate = Partial<Pick<UserCreate, "email" | "full_name" | "password" | "role">> & { is_active?: boolean; store_keeper?: boolean };
