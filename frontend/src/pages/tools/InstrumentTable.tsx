/** Measuring Tools: the three tab tables (Register, Checked out, Due dates). Rows come filtered,
 * sorted and paged from the page; these only render. */
import React from "react";
import { Link } from "react-router-dom";
import { ArrowDown, ArrowUp } from "lucide-react";
import type { DueItem, Instrument } from "../../api/client";
import { plantPath } from "../../context/routes";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useI18n } from "../../i18n";
import { DUE_KIND, DUE_STATE, STATUS, categoryOf, fmtDay, keySpec, missingPvRating, relDays } from "./format";

export type SortKey = "tag" | "name" | "category" | "status" | "due";
export const SORT_KEYS: readonly SortKey[] = ["tag", "name", "category", "status", "due"];

const SortHead: React.FC<{ k: SortKey; label: string; sort: SortKey; desc: boolean; onSort: (k: SortKey) => void; className?: string }> = ({
  k,
  label,
  sort,
  desc,
  onSort,
  className,
}) => (
  <TableHead className={className} aria-sort={sort === k ? (desc ? "descending" : "ascending") : undefined}>
    <Button type="button" onClick={() => onSort(k)} variant="ghost" size="xs" className="h-auto gap-1 rounded-none p-0 font-semibold tracking-[inherit] text-inherit hover:bg-transparent hover:text-foreground">
      {label}
      {sort === k && (desc ? <ArrowDown className="size-3" /> : <ArrowUp className="size-3" />)}
    </Button>
  </TableHead>
);

/** name, with make / model under it */
const NameCell: React.FC<{ i: Instrument; onOpen: () => void }> = ({ i, onOpen }) => {
  const def = categoryOf(i.category);
  const mm = [i.make, i.model].filter(Boolean).join(" ");
  return (
    <TableCell className="max-w-[260px]">
      <button type="button" onClick={onOpen} className="flex max-w-full items-center gap-2 text-left hover:text-solar-400">
        <def.icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0">
          <span className="block truncate">{i.name}</span>
          <span className="block truncate text-[11px] text-muted-foreground">{mm || "—"}</span>
        </span>
      </button>
    </TableCell>
  );
};

/** the instrument's next due date as a badge; tooltip lists every due item */
export const DueBadge: React.FC<{ i: Instrument; today: string }> = ({ i, today }) => {
  const { t } = useI18n();
  const s = DUE_STATE[i.due_state];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex items-center gap-1.5">
          <span className="num whitespace-nowrap">{i.next_due ? fmtDay(i.next_due) : "—"}</span>
          {i.due_state !== "ok" && <Badge variant={s.variant}>{t(s.label)}</Badge>}
        </span>
      </TooltipTrigger>
      <TooltipContent>
        {i.due.map((d) => (
          <p key={d.kind}>
            {t(DUE_KIND[d.kind])}: {d.next_due ? `${fmtDay(d.next_due)} (${relDays(d.next_due, today)})` : t("No date entered")}
          </p>
        ))}
      </TooltipContent>
    </Tooltip>
  );
};

const WhereCell: React.FC<{ i: Instrument; plantName: (id: number) => string }> = ({ i, plantName }) => {
  const { t } = useI18n();
  const c = i.open_checkout;
  if (!c) return <TableCell className="text-muted-foreground">{i.status === "at_calibration" ? t("Calibration lab") : t("Store")}</TableCell>;
  return (
    <TableCell className="max-w-[220px]">
      <span className="block truncate">{c.holder?.name ?? "—"}</span>
      {c.plant_id != null && (
        <Link to={plantPath(c.plant_id, "maintenance")} className="block truncate text-[11px] text-muted-foreground hover:text-solar-400">
          {c.plant_name ?? plantName(c.plant_id)}
        </Link>
      )}
    </TableCell>
  );
};

interface Common {
  today: string;
  plantName: (id: number) => string;
  onOpen: (i: Instrument) => void;
  actions: (i: Instrument) => React.ReactNode;
}

export const RegisterTable: React.FC<Common & { rows: Instrument[]; sort: SortKey; desc: boolean; onSort: (k: SortKey) => void }> = ({
  rows,
  sort,
  desc,
  onSort,
  today,
  plantName,
  onOpen,
  actions,
}) => {
  const { t } = useI18n();
  return (
  <Table>
    <TableHeader>
      <TableRow>
        <SortHead k="tag" label={t("Tag")} sort={sort} desc={desc} onSort={onSort} />
        <SortHead k="name" label={t("Instrument")} sort={sort} desc={desc} onSort={onSort} />
        <SortHead k="category" label={t("Category")} sort={sort} desc={desc} onSort={onSort} />
        <TableHead>{t("Key spec")}</TableHead>
        <SortHead k="status" label={t("Status")} sort={sort} desc={desc} onSort={onSort} />
        <TableHead>{t("Holder / place")}</TableHead>
        <SortHead k="due" label={t("Next due")} sort={sort} desc={desc} onSort={onSort} />
        <TableHead className="text-right">{t("Actions")}</TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      {rows.map((i) => {
        const missing = missingPvRating(i);
        return (
          <TableRow key={i.id} className={cn(i.status === "retired" && "opacity-60")}>
            <TableCell className="num whitespace-nowrap">{i.asset_tag}</TableCell>
            <NameCell i={i} onOpen={() => onOpen(i)} />
            <TableCell className="whitespace-nowrap text-muted-foreground">{t(categoryOf(i.category).label)}</TableCell>
            <TableCell className="max-w-[220px]">
              <span className="block truncate">{keySpec(i)}</span>
              {missing.length > 0 && (
                <Badge variant="warn" title={t("Not entered: {list}. Check it before use on PV strings.", { list: missing.map((m) => t(m)).join(", ") })}>
                  {t("Rating not entered")}
                </Badge>
              )}
            </TableCell>
            <TableCell>
              <Badge variant={STATUS[i.status].variant}>{t(STATUS[i.status].label)}</Badge>
              {i.open_checkout?.overdue && (
                <Badge variant="crit" className="ml-1">
                  {t("Late")}
                </Badge>
              )}
            </TableCell>
            <WhereCell i={i} plantName={plantName} />
            <TableCell>
              <DueBadge i={i} today={today} />
            </TableCell>
            <TableCell className="text-right whitespace-nowrap">{actions(i)}</TableCell>
          </TableRow>
        );
      })}
    </TableBody>
  </Table>
  );
};

export const CheckedOutTable: React.FC<Common & { rows: Instrument[] }> = ({ rows, today, plantName, onOpen, actions }) => {
  const { t } = useI18n();
  return (
  <Table>
    <TableHeader>
      <TableRow>
        <TableHead>{t("Tag")}</TableHead>
        <TableHead>{t("Instrument")}</TableHead>
        <TableHead>{t("Holder")}</TableHead>
        <TableHead>{t("Plant")}</TableHead>
        <TableHead>{t("Out since")}</TableHead>
        <TableHead>{t("Due back")}</TableHead>
        <TableHead className="text-right">{t("Actions")}</TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      {rows.map((i) => {
        const c = i.open_checkout!;
        return (
          <TableRow key={i.id}>
            <TableCell className="num whitespace-nowrap">{i.asset_tag}</TableCell>
            <NameCell i={i} onOpen={() => onOpen(i)} />
            <TableCell>{c.holder?.name ?? "—"}</TableCell>
            <TableCell className="max-w-[240px]">
              {c.plant_id != null ? (
                <Link to={plantPath(c.plant_id, "maintenance")} className="block truncate hover:text-solar-400">
                  {c.plant_name ?? plantName(c.plant_id)}
                </Link>
              ) : (
                <span className="text-muted-foreground">{t("Not to a plant")}</span>
              )}
            </TableCell>
            <TableCell className="num whitespace-nowrap">{c.out_at.slice(0, 16)}</TableCell>
            <TableCell className="whitespace-nowrap">
              <span className={cn("num", c.overdue && "text-red-300")}>{fmtDay(c.due_back)}</span>
              <span className={cn("ml-1.5 text-[11px]", c.overdue ? "text-red-300" : "text-muted-foreground")}>{relDays(c.due_back, today)}</span>
            </TableCell>
            <TableCell className="text-right whitespace-nowrap">{actions(i)}</TableCell>
          </TableRow>
        );
      })}
    </TableBody>
  </Table>
  );
};

export interface DueRow {
  i: Instrument;
  d: DueItem;
}

export const DueTable: React.FC<Omit<Common, "plantName"> & { rows: DueRow[]; dueAction: (r: DueRow) => React.ReactNode }> = ({ rows, today, onOpen, dueAction }) => {
  const { t } = useI18n();
  return (
  <Table>
    <TableHeader>
      <TableRow>
        <TableHead>{t("Tag")}</TableHead>
        <TableHead>{t("Instrument")}</TableHead>
        <TableHead>{t("What")}</TableHead>
        <TableHead>{t("Last")}</TableHead>
        <TableHead>{t("Next due")}</TableHead>
        <TableHead>{t("State")}</TableHead>
        <TableHead>{t("Number")}</TableHead>
        <TableHead>{t("Lab / issuer")}</TableHead>
        <TableHead className="text-right">{t("Actions")}</TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      {rows.map(({ i, d }) => (
        <TableRow key={`${i.id}-${d.kind}`}>
          <TableCell className="num whitespace-nowrap">{i.asset_tag}</TableCell>
          <NameCell i={i} onOpen={() => onOpen(i)} />
          <TableCell className="whitespace-nowrap">{t(DUE_KIND[d.kind])}</TableCell>
          <TableCell className="num whitespace-nowrap">{fmtDay(d.last_day)}</TableCell>
          <TableCell className="whitespace-nowrap">
            <span className="num">{fmtDay(d.next_due)}</span>
            {d.next_due && <span className="ml-1.5 text-[11px] text-muted-foreground">{relDays(d.next_due, today)}</span>}
          </TableCell>
          <TableCell>
            <Badge variant={DUE_STATE[d.state].variant} title={d.state === "none" ? t("No date entered") : undefined}>
              {t(DUE_STATE[d.state].label)}
            </Badge>
          </TableCell>
          <TableCell className="num">{d.number ?? "—"}</TableCell>
          <TableCell>{d.issuer ?? "—"}</TableCell>
          <TableCell className="text-right whitespace-nowrap">{dueAction({ i, d })}</TableCell>
        </TableRow>
      ))}
    </TableBody>
  </Table>
  );
};
