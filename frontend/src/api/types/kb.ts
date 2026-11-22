/** API types: Knowledge Base (Operations → Knowledge Base, `/kb`). O&M manuals written by the team
 * as Markdown (SOPs, troubleshooting, alarm codes, equipment, safety). DB only; every save is a
 * revision. Phase 1 = text articles only. docs/plans/knowledge-base.md. */

export type KbCategory = "sop" | "troubleshooting" | "alarm_code" | "equipment" | "safety" | "other";

export type KbStatus = "draft" | "published" | "archived";

/** fields of an article shared by the list and the detail */
export interface KbArticleBase {
  id: number;
  /** fixed at creation (a rename keeps it), so links stay valid */
  slug: string;
  title: string;
  category: KbCategory;
  tags: string[];
  status: KbStatus;
  /** 1 at creation, +1 on every saved change (edit, restore); publish / archive leave it */
  version: number;
  created_by: string | null;
  /** ISO, UTC */
  created_at: string;
  updated_by: string | null;
  updated_at: string | null;
  published_by: string | null;
  published_at: string | null;
  /** the caller may edit / restore it */
  can_edit: boolean;
  /** the caller may publish / archive it (admins) */
  can_publish: boolean;
}

export interface KbArticle extends KbArticleBase {
  body_md: string;
}

export interface KbArticleListItem extends KbArticleBase {
  /** first ~200 chars of the body, Markdown stripped */
  excerpt: string;
}

export interface KbArticleList {
  items: KbArticleListItem[];
  total: number;
  /** every tag over the non-archived articles the caller may see, sorted */
  tags: string[];
}

export interface KbArticleQuery {
  /** words joined by spaces; every word must appear (the browser pre-splits Thai) */
  q?: string;
  category?: KbCategory;
  tag?: string;
  /** none = published + the drafts the caller may see; `archived` works for admins only */
  status?: KbStatus;
  limit?: number;
  offset?: number;
}

export interface KbArticleBody {
  title: string;
  category: KbCategory;
  tags: string[];
  body_md: string;
  /** change note of this revision */
  note?: string;
}

export interface KbArticlePatch extends Partial<KbArticleBody> {
  /** the version the edit started from; a stale one answers 409 with the current article */
  base_version: number;
}

export interface KbRevisionItem {
  rev_no: number;
  title: string;
  category: KbCategory;
  tags: string[];
  author: string | null;
  note: string | null;
  created_at: string;
}

export interface KbRevision extends KbRevisionItem {
  body_md: string;
}

export interface KbRevisionList {
  /** newest first */
  items: KbRevisionItem[];
}

/** DELETE: a never-published draft is deleted, anything else is archived */
export interface KbDeleteResult {
  result: "deleted" | "archived";
}

/** `detail` of a 409 from PATCH / restore (someone saved a newer version) */
export interface KbConflictDetail {
  message: string;
  current: KbArticle;
}
