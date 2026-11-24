/** Claims: the list table. Rows come filtered, sorted and paged from the page; this only renders. */
import React from "react";
import { Link } from "react-router-dom";
import { ArrowDown, ArrowUp } from "lucide-react";
import type { Claim } from "../../api/client";
import { plantPath } from "../../context/routes";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useI18n } from "../../i18n";
import { CAUSE, STATUS, TYPE, ageStart, daysBetween, fmtDay, isOpen, relDays, whatText } from "./format";

export type SortKey = "next" | "number" | "age";
export const SORT_KEYS: readonly SortKey[] = ["next", "number", "age"];

const SortHead: React.FC<{ k: SortKey; label: string; sort: SortKey; desc: boolean; onSort: (k: SortKey) => void; className?: string }> = ({
  k,
  label,
  sort,
  desc,
  onSort,
  className,
}) => (
  <TableHead className={className} aria-sort={sort === k ? (desc ? "descending" : "ascending") : undefined}>
    <Button type="button" variant="ghost" size="xs" onClick={() => onSort(k)} className="h-auto gap-1 rounded-none p-0 text-[length:inherit] font-[inherit] text-current hover:bg-transparent hover:text-foreground">
      {label}
      {sort === k && (desc ? <ArrowDown className="size-3" /> : <ArrowUp className="size-3" />)}
    </Button>
  </TableHead>
);

export const StatusBadge: React.FC<{ c: Claim }> = ({ c }) => {
  const { t } = useI18n();
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <Badge variant={STATUS[c.status].variant}>{t(STATUS[c.status].label)}</Badge>
    </span>
  );
};

export const WaitingText: React.FC<{ c: Claim }> = ({ c }) => {
  const { t } = useI18n();
  return c.waiting_on ? (
    <span className={cn("text-[11px]", c.waiting_on === "us" ? "text-amber-300" : "text-muted-foreground")}>
      {c.waiting_on === "us" ? t("Waiting on us") : t("Waiting on {name}", { name: c.counterparty })}
    </span>
  ) : null;
};

export const ClaimTable: React.FC<{
  rows: Claim[];
  sort: SortKey;
  desc: boolean;
  onSort: (k: SortKey) => void;
  today: string;
  plantName: (id: number) => string;
  onOpen: (c: Claim) => void;
  actions: (c: Claim) => React.ReactNode;
}> = ({ rows, sort, desc, onSort, today, plantName, onOpen, actions }) => {
  const { t } = useI18n();
  return (
  <Table>
    <TableHeader>
      <TableRow>
        <SortHead k="number" label={t("Claim")} sort={sort} desc={desc} onSort={onSort} />
        <TableHead>{t("Plant")}</TableHead>
        <TableHead>{t("What")}</TableHead>
        <TableHead>{t("With")}</TableHead>
        <TableHead>{t("Status")}</TableHead>
        <SortHead k="age" label={t("Age")} sort={sort} desc={desc} onSort={onSort} />
        <SortHead k="next" label={t("Next action")} sort={sort} desc={desc} onSort={onSort} />
        <TableHead className="text-right">{t("Actions")}</TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      {rows.map((c) => {
        const start = ageStart(c);
        const end = c.closed_day ?? today;
        return (
          <TableRow key={c.id} className={cn(!isOpen(c) && "opacity-70")}>
            <TableCell className="whitespace-nowrap">
              <button type="button" onClick={() => onOpen(c)} className="text-left hover:text-solar-400">
                <span className="num block">{c.number}</span>
                <span className="block text-[11px] text-muted-foreground">{t(TYPE[c.type].label)}</span>
              </button>
            </TableCell>
            <TableCell className="max-w-[200px]">
              <Link to={plantPath(c.plant_id)} className="block truncate hover:text-solar-400">
                {c.plant_name ?? plantName(c.plant_id)}
              </Link>
            </TableCell>
            <TableCell className="max-w-[240px]">
              <span className="num block truncate">{whatText(c)}</span>
              <span className="block truncate text-[11px] text-muted-foreground">{t(CAUSE[c.cause])}</span>
            </TableCell>
            <TableCell className="max-w-[180px]">
              <span className="block truncate">{c.counterparty}</span>
              <span className="num block truncate text-[11px] text-muted-foreground">{c.counterparty_ref ?? t("No reference yet")}</span>
            </TableCell>
            <TableCell>
              <StatusBadge c={c} />
              <div>
                <WaitingText c={c} />
              </div>
            </TableCell>
            <TableCell
              className="num whitespace-nowrap"
              title={
                start
                  ? `${t(c.submitted_day ? "Since submitted {day}" : "Since created {day}", { day: fmtDay(start) })}${c.closed_day ? t(", closed {day}", { day: fmtDay(c.closed_day) }) : ""}`
                  : undefined
              }
            >
              {start ? t("{n} d", { n: Math.max(0, daysBetween(start, end)) }) : "—"}
            </TableCell>
            <TableCell className="whitespace-nowrap">
              {c.next_action_day && isOpen(c) ? (
                <>
                  <span className={cn("num", c.followup_overdue && "text-red-300")}>{fmtDay(c.next_action_day)}</span>
                  <span className={cn("ml-1.5 text-[11px]", c.followup_overdue ? "text-red-300" : "text-muted-foreground")}>{relDays(c.next_action_day, today)}</span>
                  {c.followup_overdue && (
                    <Badge variant="crit" className="ml-1.5">
                      {t("Follow up")}
                    </Badge>
                  )}
                </>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </TableCell>
            <TableCell className="text-right whitespace-nowrap">{actions(c)}</TableCell>
          </TableRow>
        );
      })}
    </TableBody>
  </Table>
  );
};
