/** Claims: the list table. Rows come filtered, sorted and paged from the page; this only renders. */
import React from "react";
import { Link } from "react-router-dom";
import { ArrowDown, ArrowUp } from "lucide-react";
import type { Claim } from "../../api/client";
import { plantPath } from "../../context/routes";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
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
    <button type="button" onClick={() => onSort(k)} className="inline-flex items-center gap-1 hover:text-foreground">
      {label}
      {sort === k && (desc ? <ArrowDown className="size-3" /> : <ArrowUp className="size-3" />)}
    </button>
  </TableHead>
);

export const StatusBadge: React.FC<{ c: Claim }> = ({ c }) => (
  <span className="inline-flex flex-wrap items-center gap-1">
    <Badge variant={STATUS[c.status].variant}>{STATUS[c.status].label}</Badge>
  </span>
);

export const WaitingText: React.FC<{ c: Claim }> = ({ c }) =>
  c.waiting_on ? (
    <span className={cn("text-[11px]", c.waiting_on === "us" ? "text-amber-300" : "text-muted-foreground")}>
      {c.waiting_on === "us" ? "Waiting on us" : `Waiting on ${c.counterparty}`}
    </span>
  ) : null;

export const ClaimTable: React.FC<{
  rows: Claim[];
  sort: SortKey;
  desc: boolean;
  onSort: (k: SortKey) => void;
  today: string;
  plantName: (id: number) => string;
  onOpen: (c: Claim) => void;
  actions: (c: Claim) => React.ReactNode;
}> = ({ rows, sort, desc, onSort, today, plantName, onOpen, actions }) => (
  <Table>
    <TableHeader>
      <TableRow>
        <SortHead k="number" label="Claim" sort={sort} desc={desc} onSort={onSort} />
        <TableHead>Plant</TableHead>
        <TableHead>What</TableHead>
        <TableHead>With</TableHead>
        <TableHead>Status</TableHead>
        <SortHead k="age" label="Age" sort={sort} desc={desc} onSort={onSort} />
        <SortHead k="next" label="Next action" sort={sort} desc={desc} onSort={onSort} />
        <TableHead className="text-right">Actions</TableHead>
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
                <span className="block text-[11px] text-muted-foreground">{TYPE[c.type].label}</span>
              </button>
            </TableCell>
            <TableCell className="max-w-[200px]">
              <Link to={plantPath(c.plant_id)} className="block truncate hover:text-solar-400">
                {c.plant_name ?? plantName(c.plant_id)}
              </Link>
            </TableCell>
            <TableCell className="max-w-[240px]">
              <span className="num block truncate">{whatText(c)}</span>
              <span className="block truncate text-[11px] text-muted-foreground">{CAUSE[c.cause]}</span>
            </TableCell>
            <TableCell className="max-w-[180px]">
              <span className="block truncate">{c.counterparty}</span>
              <span className="num block truncate text-[11px] text-muted-foreground">{c.counterparty_ref ?? "No reference yet"}</span>
            </TableCell>
            <TableCell>
              <StatusBadge c={c} />
              <div>
                <WaitingText c={c} />
              </div>
            </TableCell>
            <TableCell
              className="num whitespace-nowrap"
              title={start ? `${c.submitted_day ? "Since submitted" : "Since created"} ${fmtDay(start)}${c.closed_day ? `, closed ${fmtDay(c.closed_day)}` : ""}` : undefined}
            >
              {start ? `${Math.max(0, daysBetween(start, end))} d` : "—"}
            </TableCell>
            <TableCell className="whitespace-nowrap">
              {c.next_action_day && isOpen(c) ? (
                <>
                  <span className={cn("num", c.followup_overdue && "text-red-300")}>{fmtDay(c.next_action_day)}</span>
                  <span className={cn("ml-1.5 text-[11px]", c.followup_overdue ? "text-red-300" : "text-muted-foreground")}>{relDays(c.next_action_day, today)}</span>
                  {c.followup_overdue && (
                    <Badge variant="crit" className="ml-1.5">
                      Follow up
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
