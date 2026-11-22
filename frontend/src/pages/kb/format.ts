/** Knowledge Base helpers: categories, status badges, the Thai-aware search query, relative times,
 * the 409 conflict detail and the editor's unsent draft (localStorage, guarded). */
import { AlertTriangle, BookOpen, Cpu, FileQuestion, ListChecks, ShieldAlert, Wrench } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { ApiError } from "../../api/client";
import type { KbArticle, KbCategory, KbConflictDetail, KbStatus } from "../../api/client";
import { dateLocale, translate } from "../../i18n";

export const CATEGORIES: { value: KbCategory; label: string; icon: LucideIcon }[] = [
  { value: "sop", label: "SOP", icon: ListChecks },
  { value: "troubleshooting", label: "Troubleshooting", icon: Wrench },
  { value: "alarm_code", label: "Alarm code", icon: AlertTriangle },
  { value: "equipment", label: "Equipment", icon: Cpu },
  { value: "safety", label: "Safety", icon: ShieldAlert },
  { value: "other", label: "Other", icon: FileQuestion },
];
export const CATEGORY_KEYS = CATEGORIES.map((c) => c.value);
export const categoryOf = (c: KbCategory) => CATEGORIES.find((x) => x.value === c) ?? { value: c, label: c, icon: BookOpen };

export const STATUS_KEYS: KbStatus[] = ["published", "draft", "archived"];
export const STATUS: Record<KbStatus, { label: string; variant: "ok" | "warn" | "neutral" }> = {
  published: { label: "Published", variant: "ok" },
  draft: { label: "Draft", variant: "warn" },
  archived: { label: "Archived", variant: "neutral" },
};

/** Limits the backend checks (422); checked before saving so the message is clear. */
export const LIMITS = { title: 200, tags: 20, tag: 40, body: 200_000 };

/**
 * The search box's text as the `q` the backend wants: words joined by spaces. Thai has no spaces
 * between words, so it is split with `Intl.Segmenter` (word-like segments only); the backend then
 * needs every word to appear. Without `Intl.Segmenter`, whitespace only.
 */
export const searchWords = (text: string): string => {
  const s = text.trim();
  if (!s) return "";
  try {
    if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
      const seg = new Intl.Segmenter("th", { granularity: "word" });
      const words = [...seg.segment(s)].filter((x) => x.isWordLike).map((x) => x.segment.trim()).filter(Boolean);
      return words.join(" ");
    }
  } catch {
    /* fall through */
  }
  return s.split(/\s+/).join(" ");
};

/** "3 days ago" in the UI language (Intl.RelativeTimeFormat); "—" for a missing / bad time */
export const timeAgo = (iso: string | null | undefined, now = Date.now()): string => {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const s = Math.round((t - now) / 1000);
  const rtf = new Intl.RelativeTimeFormat(dateLocale(), { numeric: "auto" });
  const a = Math.abs(s);
  if (a < 45) return rtf.format(0, "second");
  if (a < 3600) return rtf.format(Math.round(s / 60), "minute");
  if (a < 86_400) return rtf.format(Math.round(s / 3600), "hour");
  if (a < 30 * 86_400) return rtf.format(Math.round(s / 86_400), "day");
  if (a < 365 * 86_400) return rtf.format(Math.round(s / (30 * 86_400)), "month");
  return rtf.format(Math.round(s / (365 * 86_400)), "year");
};

/** a full local date + time for tooltips and the meta panel */
export const fmtDateTime = (iso: string | null | undefined): string => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "—";
  return d.toLocaleString(dateLocale(), { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
};

/** "updated 3 days ago by admin" (falls back to created when never updated) */
export const updatedText = (a: { updated_at: string | null; updated_by: string | null; created_at: string; created_by: string | null }): string => {
  const at = a.updated_at ?? a.created_at;
  const by = (a.updated_at ? a.updated_by : a.created_by) ?? "—";
  return translate("updated {ago} by {name}", { ago: timeAgo(at), name: by });
};

export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** the newer article of a 409 from PATCH / restore; null for any other error */
export const kbConflict = (e: unknown): KbConflictDetail | null => {
  if (!(e instanceof ApiError) || e.status !== 409) return null;
  const d = e.detail as Partial<KbConflictDetail> | undefined;
  if (!d || typeof d !== "object" || !d.current || typeof d.current !== "object" || typeof d.current.version !== "number") return null;
  return { message: typeof d.message === "string" ? d.message : "", current: d.current as KbArticle };
};

export const articlePath = (slug: string) => `/kb/${encodeURIComponent(slug)}`;

/* ---- the editor's unsent draft: per user and article, so a dropped connection on site loses
 * nothing. Browser storage may be blocked or full: every access is guarded. */

export interface KbDraft {
  title: string;
  category: KbCategory;
  tags: string[];
  body_md: string;
  note: string;
  /** the version the edit started from (null = a new article) */
  base_version: number | null;
  /** "your version" kept beside the editor while merging a conflict by hand */
  merge_mine?: { title: string; body_md: string; version: number } | null;
  saved_at: string;
}

const draftKey = (userId: number | string | undefined, slug: string | null) => `tcroof.kb.draft.${userId ?? "anon"}.${slug ?? "new"}`;

export const loadDraft = (userId: number | string | undefined, slug: string | null): KbDraft | null => {
  try {
    const raw = localStorage.getItem(draftKey(userId, slug));
    if (!raw) return null;
    const d = JSON.parse(raw) as Partial<KbDraft>;
    if (typeof d.body_md !== "string" || typeof d.title !== "string") return null;
    return {
      title: d.title,
      category: CATEGORY_KEYS.includes(d.category as KbCategory) ? (d.category as KbCategory) : "other",
      tags: Array.isArray(d.tags) ? d.tags.filter((x): x is string => typeof x === "string") : [],
      body_md: d.body_md,
      note: typeof d.note === "string" ? d.note : "",
      base_version: typeof d.base_version === "number" ? d.base_version : null,
      merge_mine: d.merge_mine && typeof d.merge_mine.body_md === "string" ? d.merge_mine : null,
      saved_at: typeof d.saved_at === "string" ? d.saved_at : "",
    };
  } catch {
    return null;
  }
};

export const saveDraft = (userId: number | string | undefined, slug: string | null, d: KbDraft): void => {
  try {
    localStorage.setItem(draftKey(userId, slug), JSON.stringify(d));
  } catch {
    /* storage blocked or full: the draft lasts this page only */
  }
};

export const clearDraft = (userId: number | string | undefined, slug: string | null): void => {
  try {
    localStorage.removeItem(draftKey(userId, slug));
  } catch {
    /* ignore */
  }
};
