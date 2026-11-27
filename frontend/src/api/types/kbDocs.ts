/** API types: Knowledge Base library, PDF documents (`/kb`, `/kb/doc/:id`, `/kb/search`). Vendor
 * manuals, datasheets, SOPs, drawings and reports as uploaded PDFs: the file is never changed (a new
 * file is a new revision, SHA-256 kept), its text is kept per page for the search (OCR'd by the
 * worker when a page has no text layer). DB + object storage only. docs/plans/kb-documents.md. */

export type KbDocType =
  | "manual"
  | "datasheet"
  | "sop"
  | "work_instruction"
  | "method_statement"
  | "checklist"
  | "report"
  | "drawing"
  | "certificate"
  | "technical_note"
  | "other";

export type KbDiscipline = "OM" | "ENG" | "INV" | "MOD" | "ELE" | "INS" | "SAF" | "GEN";
export type KbDocLanguage = "en" | "th" | "both";
export type KbDocStatus = "draft" | "released" | "superseded" | "withdrawn";
/** ok = every page has text; ocr_pending = pages wait for the worker's OCR; partial / no_text =
 * some / all pages have no text (also after OCR); failed = the file could not be read */
export type KbTextStatus = "ok" | "ocr_pending" | "partial" | "no_text" | "failed";
export type KbLinkType = "fault_code" | "equipment" | "plant";

export interface KbDocLink {
  target_type: KbLinkType;
  /** fault_code "Error:203"; equipment a model key (spaces dropped, upper case); plant an id */
  target_id: string;
  /** the page the link concerns (1-based), null = the whole document */
  page: number | null;
  /** equipment: the model as entered; plant: the plant's name */
  label: string | null;
}

export interface KbDocLinkInput {
  target_type: KbLinkType;
  target_id: string;
  page?: number | null;
  label?: string | null;
}

export interface KbDocSummary {
  id: number;
  /** `{TYPE}-{DISCIPLINE}-{SEQ:3}`, e.g. MAN-INV-001 */
  number: string;
  kind: "imported";
  doc_type: KbDocType;
  discipline: KbDiscipline;
  /** title_en, else title_th, else the number */
  title: string;
  title_en: string;
  title_th: string;
  language: KbDocLanguage;
  tags: string[];
  /** visible to everyone; false = only to users who may see one of its linked plants */
  general: boolean;
  status: KbDocStatus;
  owner: string | null;
  updated_at: string | null;
  released_at: string | null;
  revision: { rev_no: number; label: string | null; page_count: number; text_status: KbTextStatus; bytes: number } | null;
  pinned: boolean;
  can_edit: boolean;
}

export interface KbDocRevision {
  id: number;
  rev_no: number;
  /** the source's own version ("v1.2") */
  label: string | null;
  change_note: string | null;
  original_name: string | null;
  bytes: number;
  sha256: string;
  page_count: number;
  text_status: KbTextStatus;
  ocr_pending_pages: number;
  /** tesseract languages used ("tha+eng"); null = not OCR'd */
  ocr_langs: string | null;
  uploaded_by: string | null;
  created_at: string;
  is_current: boolean;
}

export interface KbDocDetail extends KbDocSummary {
  status_note: string | null;
  superseded_by: { id: number; number: string; title: string } | null;
  created_by: string | null;
  created_at: string;
  updated_by: string | null;
  released_by: string | null;
  current_revision: KbDocRevision | null;
  /** newest first */
  revisions: KbDocRevision[];
  links: KbDocLink[];
  can_release: boolean;
}

export interface KbDocList {
  items: KbDocSummary[];
  total: number;
  facets: { tags: string[]; owners: string[]; equipment: { key: string; label: string; count: number }[] };
}

export interface KbDocQuery {
  type?: KbDocType;
  status?: KbDocStatus;
  language?: KbDocLanguage;
  equipment?: string;
  plant_id?: number;
  /** "Error:203", or a bare code (any fault type) */
  fault?: string;
  tag?: string;
  owner?: string;
  /** words in the metadata (the page text is searched by `searchKb`) */
  q?: string;
  sort?: "updated" | "number" | "title";
  limit?: number;
  offset?: number;
}

export interface KbDocHome {
  pinned: KbDocSummary[];
  /** engineers: released documents linked to their plants or their plants' inverter models */
  for_plants: KbDocSummary[];
  recent: KbDocSummary[];
  total: number;
}

export interface KbSearchPageHit {
  page_no: number;
  snippet: string;
}

export interface KbSearchDoc extends KbDocSummary {
  /** title = every word in the metadata; pages = found on pages */
  match: "title" | "pages";
  page_hits: number;
  /** at most three, best first */
  pages: KbSearchPageHit[];
}

export interface KbSearchResult {
  words: string[];
  /** fault-code links matching numbers in the query ("growatt 203"), first */
  faults: { key: string; links: { doc: KbDocSummary; page: number | null; label: string | null }[] }[];
  documents: KbSearchDoc[];
  total: number;
}

export interface KbContextDoc {
  doc_id: number;
  number: string;
  title: string;
  doc_type: KbDocType;
  page: number | null;
}

/** released documents by fault code ("Error:203") and by inverter model key */
export interface KbDocContext {
  fault_codes: Record<string, KbContextDoc[]>;
  equipment: Record<string, KbContextDoc[]>;
}

export interface KbDocCatalog {
  /** codes the alarm log has seen, most frequent first */
  fault_codes: { key: string; fault_type: string; code: string; message: string | null; records: number }[];
  equipment: { key: string; model: string; inverters: number }[];
  doc_types: Record<KbDocType, string>;
  disciplines: KbDiscipline[];
  /** tesseract languages the worker used in its newest finished `kb_ocr` run (null = none
   *  installed there, or no run yet: `checked_at` null); the API itself has no tesseract */
  ocr: { langs: string | null; checked_at: string | null };
  max_upload_mb: number;
}

export interface KbDocCreateMeta {
  doc_type: KbDocType;
  discipline: KbDiscipline;
  title_en: string;
  title_th: string;
  language: KbDocLanguage;
  tags: string[];
  general: boolean;
  /** admins only; otherwise the next free number */
  number?: string | null;
  label?: string | null;
  change_note?: string | null;
  links?: KbDocLinkInput[];
}

export type KbDocPatch = Partial<Pick<KbDocCreateMeta, "doc_type" | "discipline" | "title_en" | "title_th" | "language" | "tags" | "general" | "number">>;

/** where the browser GETs the file: `api` = a signed API path (prefix API_BASE), else a signed URL */
export interface KbDocFileLink {
  url: string;
  api: boolean;
  /** unix seconds */
  expires_at: number;
  filename: string;
  bytes: number;
  sha256: string;
}

export interface KbPlantDocuments {
  plant_id: number;
  linked: (KbDocSummary & { pages: number[] })[];
  equipment: { model_key: string; model: string; inverters: number; documents: (KbDocSummary & { pages: number[] })[] }[];
  procedures: (KbDocSummary & { pages: number[] })[];
  /** the plant's Google Drive links (Settings → Plant documents) */
  drive: Record<string, { kind: string; url: string; title: string | null; revision: string | null }>;
}
