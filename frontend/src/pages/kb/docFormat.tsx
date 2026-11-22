/** Knowledge Base library helpers: document types, disciplines, statuses (icon + label, never
 * colour alone), text (OCR) states, paths, sizes and the signed file URL. docs/plans/kb-documents.md. */
import React from "react";
import {
  Ban,
  BookOpen,
  CheckCircle2,
  ClipboardCheck,
  ClipboardList,
  FileBadge,
  FileCog,
  FileSpreadsheet,
  FileText,
  FlaskConical,
  ListChecks,
  NotebookText,
  PencilLine,
  Ruler,
  XCircle,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { API_BASE } from "../../api/client";
import type { KbDiscipline, KbDocFileLink, KbDocLanguage, KbDocStatus, KbDocSummary, KbDocType, KbTextStatus } from "../../api/client";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { translate, useI18n } from "../../i18n";
import type { Lang } from "../../i18n";

export const DOC_TYPES: { value: KbDocType; label: string; prefix: string; icon: LucideIcon }[] = [
  { value: "manual", label: "Manual", prefix: "MAN", icon: BookOpen },
  { value: "datasheet", label: "Datasheet", prefix: "DS", icon: FileSpreadsheet },
  { value: "sop", label: "SOP", prefix: "SOP", icon: ListChecks },
  { value: "work_instruction", label: "Work instruction", prefix: "WI", icon: ClipboardList },
  { value: "method_statement", label: "Method statement", prefix: "MS", icon: FileCog },
  { value: "checklist", label: "Checklist / form", prefix: "CHK", icon: ClipboardCheck },
  { value: "report", label: "Report", prefix: "RPT", icon: NotebookText },
  { value: "drawing", label: "Drawing", prefix: "DWG", icon: Ruler },
  { value: "certificate", label: "Certificate", prefix: "CERT", icon: FileBadge },
  { value: "technical_note", label: "Technical note", prefix: "TN", icon: FlaskConical },
  { value: "other", label: "Other", prefix: "DOC", icon: FileText },
];
export const DOC_TYPE_KEYS = DOC_TYPES.map((x) => x.value);
export const docTypeOf = (v: KbDocType) => DOC_TYPES.find((x) => x.value === v) ?? DOC_TYPES[DOC_TYPES.length - 1];

export const DISCIPLINES: { value: KbDiscipline; label: string }[] = [
  { value: "OM", label: "O&M" },
  { value: "ENG", label: "Engineering" },
  { value: "INV", label: "Inverter" },
  { value: "MOD", label: "PV module" },
  { value: "ELE", label: "Electrical" },
  { value: "INS", label: "Inspection" },
  { value: "SAF", label: "Safety" },
  { value: "GEN", label: "General" },
];
export const disciplineLabel = (v: KbDiscipline) => DISCIPLINES.find((x) => x.value === v)?.label ?? v;

export const LANGUAGES: { value: KbDocLanguage; label: string }[] = [
  { value: "en", label: "English" },
  { value: "th", label: "Thai" },
  { value: "both", label: "Thai + English" },
];
export const languageLabel = (v: KbDocLanguage) => LANGUAGES.find((x) => x.value === v)?.label ?? v;

export const DOC_STATUS_KEYS: KbDocStatus[] = ["released", "draft", "superseded", "withdrawn"];
export const DOC_STATUS: Record<KbDocStatus, { label: string; icon: LucideIcon; variant: "ok" | "neutral" | "warn" | "crit" }> = {
  released: { label: "Released", icon: CheckCircle2, variant: "ok" },
  draft: { label: "Draft", icon: PencilLine, variant: "neutral" },
  superseded: { label: "Superseded", icon: Ban, variant: "neutral" },
  withdrawn: { label: "Withdrawn", icon: XCircle, variant: "crit" },
};

/** Status chip: icon + label, superseded struck through (spec §4.1). */
export const DocStatusBadge: React.FC<{ status: KbDocStatus; className?: string }> = ({ status, className }) => {
  const { t } = useI18n();
  const s = DOC_STATUS[status];
  return (
    <Badge variant={s.variant} className={cn(status === "superseded" && "line-through decoration-slate-500", className)}>
      <s.icon data-icon="inline-start" aria-hidden />
      {t(s.label)}
    </Badge>
  );
};

export const TEXT_STATUS: Record<KbTextStatus, { label: string; hint: string; variant: "ok" | "neutral" | "warn" | "info" }> = {
  ok: { label: "Searchable", hint: "Every page has text, so the search finds words on any page.", variant: "ok" },
  ocr_pending: { label: "Waiting for OCR", hint: "Some pages are scans without text. The worker reads them with OCR; until then those pages are not searchable.", variant: "info" },
  partial: { label: "Partly searchable", hint: "Some pages have no text, also after OCR (drawings, photos, or OCR not installed).", variant: "warn" },
  no_text: { label: "Not searchable", hint: "No page has text, also after OCR (a drawing or photo, or OCR not installed).", variant: "warn" },
  failed: { label: "Unreadable", hint: "The file could not be read.", variant: "warn" },
};

/** The title in the UI language when the document has one, else the other. */
export const docTitle = (d: Pick<KbDocSummary, "title_en" | "title_th" | "number">, lang: Lang): string =>
  (lang === "th" ? d.title_th || d.title_en : d.title_en || d.title_th) || d.number;

/** The other-language title, shown under the main one when both exist. */
export const docSubtitle = (d: Pick<KbDocSummary, "title_en" | "title_th">, lang: Lang): string | null => {
  if (!d.title_en || !d.title_th) return null;
  return lang === "th" ? d.title_en : d.title_th;
};

export const docPath = (id: number) => `/kb/doc/${id}`;

/** The viewer at a page (deep-linkable, also from QR labels); `q` highlights words; `rev` an older file. */
export const viewPath = (id: number, opts: { page?: number | null; q?: string | null; rev?: number | null } = {}) => {
  const p = new URLSearchParams();
  if (opts.page != null && opts.page > 1) p.set("page", String(opts.page));
  if (opts.q) p.set("q", opts.q);
  if (opts.rev != null) p.set("rev", String(opts.rev));
  const qs = p.toString();
  return `/kb/doc/${id}/view${qs ? `?${qs}` : ""}`;
};

export const searchPath = (q: string) => `/kb/search?q=${encodeURIComponent(q)}`;

/** the file link as the browser fetches it */
export const fileHref = (link: KbDocFileLink) => (link.api ? `${API_BASE}${link.url}` : link.url);

export const fmtBytes = (n: number | null | undefined): string => {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} kB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
};

/** "Rev 2 · v1.2" */
export const revText = (r: { rev_no: number; label: string | null } | null | undefined): string => {
  if (!r) return "—";
  return r.label ? translate("Rev {n} · {label}", { n: r.rev_no, label: r.label }) : translate("Rev {n}", { n: r.rev_no });
};

/** "Error:203" → "Error 203" */
export const faultLabel = (key: string) => key.replace(":", " ");

export const pageText = (page: number | null | undefined) => (page != null ? translate("p.{n}", { n: page }) : null);
