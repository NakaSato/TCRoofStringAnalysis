/** Plant-local days as "YYYY-MM-DD" strings, and the Date objects the Calendar needs. */

/** "2026-11-14" → local Date at midnight (for Calendar `selected` / `disabled`). */
export const toDate = (day: string) => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d);
};

/** Calendar Date → "YYYY-MM-DD" (local fields, no UTC shift). */
export const fromDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** "Sat, 14 Nov 2026" */
export const dayLabel = (day: string) =>
  toDate(day).toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short", year: "numeric" });
