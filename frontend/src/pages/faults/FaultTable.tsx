/** Field faults: the list table (plan §7 columns). Rows come filtered, sorted and paged from the
 * page; this only renders. */
import React from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, ArrowDown, ArrowUp, Boxes, CalendarDays, FileWarning, Link2 } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { Fault, FaultLinkKind } from "../../api/client";
import { plantPath } from "../../context/routes";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useI18n } from "../../i18n";
import { DECISION, KIND, LINK_KIND, SEVERITY, STATUS, SUB_KIND, WAITING_SHORT, deviceText, fmtDay, fmtLocal, relDays } from "./format";

export type SortKey = "found" | "no" | "severity" | "next";
export const SORT_KEYS: readonly SortKey[] = ["found", "no", "severity", "next"];

const SortHead: React.FC<{ k: SortKey; label: string; sort: SortKey; desc: boolean; onSort: (k: SortKey) => void; className?: string }> = ({ k, label, sort, desc, onSort, className }) => (
  <TableHead className={className} aria-sort={sort === k ? (desc ? "descending" : "ascending") : undefined}>
    <Button
      type="button"
      variant="ghost"
      size="xs"
      onClick={() => onSort(k)}
      className="h-auto gap-1 rounded-none p-0 text-[length:inherit] font-[inherit] text-current hover:bg-transparent hover:text-foreground"
    >
      {label}
      {sort === k && (desc ? <ArrowDown className="size-3" /> : <ArrowUp className="size-3" />)}
    </Button>
  </TableHead>
);

export const SeverityBadge: React.FC<{ f: Pick<Fault, "severity"> }> = ({ f }) => {
  const { t } = useI18n();
  return (
    <Badge variant={SEVERITY[f.severity].variant} title={t(SEVERITY[f.severity].hint)}>
      {f.severity}
    </Badge>
  );
};

export const FaultStatusBadge: React.FC<{ f: Pick<Fault, "status" | "waiting_reason" | "waiting_on"> }> = ({ f }) => {
  const { t } = useI18n();
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <Badge variant={STATUS[f.status].variant}>{t(STATUS[f.status].label)}</Badge>
      {f.status === "waiting" && f.waiting_reason && <span className="text-[11px] text-muted-foreground">{t(WAITING_SHORT[f.waiting_reason])}</span>}
    </span>
  );
};

export const WaitingOn: React.FC<{ f: Pick<Fault, "waiting_on"> }> = ({ f }) => {
  const { t } = useI18n();
  if (!f.waiting_on) return null;
  return <span className={cn("text-[11px]", f.waiting_on === "us" ? "text-amber-300" : "text-muted-foreground")}>{f.waiting_on === "us" ? t("Waiting on us") : t("Waiting on others")}</span>;
};

/** linked-record icons with counts: issue, claim, replacement (failed unit / batch), task, other */
const LINK_ICONS: Array<{ kinds: FaultLinkKind[]; icon: LucideIcon; label: string }> = [
  { kinds: ["issue"], icon: AlertTriangle, label: "Issue" },
  { kinds: ["claim"], icon: FileWarning, label: "Claim" },
  { kinds: ["failed_unit", "stock_batch"], icon: Boxes, label: "Replacement" },
  { kinds: ["om_task"], icon: CalendarDays, label: "Calendar task" },
  { kinds: ["alarm", "device_check", "site_event", "kb"], icon: Link2, label: "Other links" },
];

export const LinkIcons: React.FC<{ f: Fault }> = ({ f }) => {
  const { t } = useI18n();
  const items = LINK_ICONS.map((g) => ({ ...g, n: g.kinds.reduce((a, k) => a + (f.links[k] ?? 0), 0) })).filter((g) => g.n > 0);
  if (!items.length) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="inline-flex items-center gap-2">
      {items.map(({ icon: Icon, label, kinds, n }) => (
        <span
          key={label}
          className="inline-flex items-center gap-0.5 text-muted-foreground"
          title={kinds
            .filter((k) => f.links[k])
            .map((k) => `${t(LINK_KIND[k])}: ${f.links[k]}`)
            .join(", ")}
        >
          <Icon className="size-3.5" />
          <span className="num text-[11px]">{n}</span>
        </span>
      ))}
    </span>
  );
};

export const FaultTable: React.FC<{
  rows: Fault[];
  sort: SortKey;
  desc: boolean;
  onSort: (k: SortKey) => void;
  today: string;
  plantName: (id: number) => string;
  onOpen: (f: Fault) => void;
  actions: (f: Fault) => React.ReactNode;
}> = ({ rows, sort, desc, onSort, today, plantName, onOpen, actions }) => {
  const { t } = useI18n();
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <SortHead k="no" label={t("No.")} sort={sort} desc={desc} onSort={onSort} />
          <TableHead>{t("Plant")}</TableHead>
          <TableHead>{t("Kind · device")}</TableHead>
          <SortHead k="severity" label={t("Severity")} sort={sort} desc={desc} onSort={onSort} />
          <TableHead>{t("Status")}</TableHead>
          <TableHead>{t("Decision")}</TableHead>
          <SortHead k="found" label={t("Found")} sort={sort} desc={desc} onSort={onSort} />
          <SortHead k="next" label={t("Next action")} sort={sort} desc={desc} onSort={onSort} />
          <TableHead>{t("Linked")}</TableHead>
          <TableHead className="text-right">{t("Actions")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((f) => (
          <TableRow key={f.id} className={cn(!f.active && "opacity-70")}>
            <TableCell className="whitespace-nowrap">
              <button type="button" onClick={() => onOpen(f)} className="num text-left hover:text-solar-400">
                {f.no}
              </button>
            </TableCell>
            <TableCell className="max-w-[200px]">
              <Link to={plantPath(f.plant_id)} className="block truncate hover:text-solar-400">
                {f.plant_name ?? plantName(f.plant_id)}
              </Link>
            </TableCell>
            <TableCell className="max-w-[260px]">
              <span className="block truncate">
                {t(KIND[f.kind])}
                {f.sub_kind && <span className="text-muted-foreground"> · {t(SUB_KIND[f.sub_kind])}</span>}
              </span>
              <span className="num block truncate text-[11px] text-muted-foreground" title={f.symptom}>
                {deviceText(f)}
              </span>
            </TableCell>
            <TableCell>
              <SeverityBadge f={f} />
            </TableCell>
            <TableCell>
              <FaultStatusBadge f={f} />
              <div>
                <WaitingOn f={f} />
              </div>
            </TableCell>
            <TableCell className="max-w-[160px]">
              {f.decision ? (
                <span className="block truncate" title={f.decision_reason ?? undefined}>
                  {t(DECISION[f.decision])}
                </span>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </TableCell>
            <TableCell className="whitespace-nowrap" title={fmtLocal(f.found_at)}>
              <span className="num">{fmtDay(f.found_at?.slice(0, 10) ?? null)}</span>
              {f.age_days != null && <span className="ml-1.5 text-[11px] text-muted-foreground">{t("{n} d", { n: f.age_days })}</span>}
            </TableCell>
            <TableCell className="whitespace-nowrap">
              {f.next_action_day && f.active ? (
                <>
                  <span className={cn("num", f.followup_overdue && "text-red-300")}>{fmtDay(f.next_action_day)}</span>
                  <span className={cn("ml-1.5 text-[11px]", f.followup_overdue ? "text-red-300" : "text-muted-foreground")}>{relDays(f.next_action_day, today)}</span>
                  {f.followup_overdue && (
                    <Badge variant="crit" className="ml-1.5">
                      {t("Follow up")}
                    </Badge>
                  )}
                </>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </TableCell>
            <TableCell>
              <LinkIcons f={f} />
            </TableCell>
            <TableCell className="text-right whitespace-nowrap">{actions(f)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
};
