/** "Manual p.37 · SOP-OM-007": released Knowledge Base documents linked to an alarm's fault code,
 * each opening the viewer at the linked page (spec §8.1). Shows nothing until the links load, when
 * there are none, or when the request failed (a convenience, never an error). */
import React from "react";
import { Link } from "react-router-dom";
import { BookOpen } from "lucide-react";
import type { KbContextDoc } from "../api/client";
import { faultKey, modelKey, useKbContext } from "../context/kbContextStore";
import { useI18n } from "../i18n";
import { cn } from "@/lib/utils";

const MAX_SHOWN = 3;

const viewHref = (d: KbContextDoc) => `/kb/doc/${d.doc_id}/view${d.page != null && d.page > 1 ? `?page=${d.page}` : ""}`;

export const KbLinkList: React.FC<{ docs: KbContextDoc[]; className?: string; label?: string }> = ({ docs, className, label }) => {
  const { t } = useI18n();
  if (docs.length === 0) return null;
  const shown = docs.slice(0, MAX_SHOWN);
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px]", className)}>
      <BookOpen className="size-3.5 shrink-0 text-sky-300" aria-label={label ?? t("Manuals")} />
      {shown.map((d, i) => (
        <React.Fragment key={`${d.doc_id}-${d.page ?? 0}`}>
          {i > 0 && <span className="text-slate-600" aria-hidden>·</span>}
          <Link
            to={viewHref(d)}
            className="relative z-10 text-sky-300 underline-offset-2 hover:text-sky-200 hover:underline"
            title={d.page != null ? t("{doc}, page {page}", { doc: `${d.number} ${d.title}`, page: d.page }) : `${d.number} ${d.title}`}
            onClick={(e) => e.stopPropagation()}
          >
            {d.doc_type === "manual" || d.doc_type === "datasheet" ? t("Manual") : d.number}
            {d.page != null && ` ${t("p.{n}", { n: d.page })}`}
          </Link>
        </React.Fragment>
      ))}
      {docs.length > MAX_SHOWN && <span className="text-slate-500">+{docs.length - MAX_SHOWN}</span>}
    </span>
  );
};

/** Documents linked to an alarm's fault code (Growatt `fault_type` + `alarm_code`). */
export const FaultManualLinks: React.FC<{ faultType: string | null | undefined; code: number | string | null | undefined; className?: string }> = ({
  faultType,
  code,
  className,
}) => {
  const ctx = useKbContext();
  const key = faultKey(faultType, code);
  const docs = (key && ctx?.fault_codes[key]) || [];
  return <KbLinkList docs={docs} className={className} />;
};

/** Documents linked to an inverter model (e.g. "MAX 125KTL3-X LV"). */
export const ModelManualLinks: React.FC<{ model: string | null | undefined; className?: string }> = ({ model, className }) => {
  const { t } = useI18n();
  const ctx = useKbContext(!!model);
  const docs = (model && ctx?.equipment[modelKey(model)]) || [];
  return <KbLinkList docs={docs} className={className} label={t("Manuals for {model}", { model: model ?? "" })} />;
};
