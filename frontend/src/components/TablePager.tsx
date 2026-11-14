/** Footer pager for a client-side paged table: "1–25 of 104" and shadcn `Pagination` (Active Alarm, Strings). */
import React from "react";
import { cn } from "@/lib/utils";
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import { fmtInt } from "./ui";

/** Page numbers to show: first, last and the current one ± 1, with gaps as null. */
export const pageList = (page: number, count: number): Array<number | null> => {
  const keep = new Set([0, count - 1, page - 1, page, page + 1].filter((p) => p >= 0 && p < count));
  const out: Array<number | null> = [];
  [...keep].sort((a, b) => a - b).forEach((p, i, all) => {
    if (i > 0 && p - all[i - 1] > 1) out.push(null);
    out.push(p);
  });
  return out;
};

/** Page count and the current page clamped into range (0-based), for `rows` rows of `pageSize`. */
export const pageBounds = (rows: number, pageSize: number, page: number) => {
  const pageCount = Math.max(1, Math.ceil(rows / pageSize));
  return { pageCount, pageNo: Math.min(page, pageCount - 1) };
};

export const TablePager: React.FC<{
  rows: number;
  pageSize: number;
  /** 0-based, already clamped (see `pageBounds`) */
  pageNo: number;
  onPage: (page: number) => void;
  /** e.g. a rows-per-page Select, shown next to the range */
  extra?: React.ReactNode;
  className?: string;
}> = ({ rows, pageSize, pageNo, onPage, extra, className }) => {
  const pageCount = Math.max(1, Math.ceil(rows / pageSize));
  const go = (p: number) => (e: React.MouseEvent) => {
    e.preventDefault();
    onPage(p);
  };
  return (
    <div className={cn("flex flex-wrap items-center justify-between gap-3", className)}>
      <div className="flex items-center gap-3">
        <span className="num text-muted-foreground">
          {rows ? `${fmtInt(pageNo * pageSize + 1)}–${fmtInt(Math.min(rows, (pageNo + 1) * pageSize))} of ${fmtInt(rows)}` : "0 rows"}
        </span>
        {extra}
      </div>
      {pageCount > 1 && (
        <Pagination className="mx-0 w-auto">
          <PaginationContent>
            <PaginationItem>
              <PaginationPrevious
                href="#"
                aria-disabled={pageNo === 0}
                className={cn(pageNo === 0 && "pointer-events-none opacity-50")}
                onClick={go(Math.max(0, pageNo - 1))}
              />
            </PaginationItem>
            {pageList(pageNo, pageCount).map((p, i) =>
              p == null ? (
                <PaginationItem key={`gap-${i}`}>
                  <PaginationEllipsis />
                </PaginationItem>
              ) : (
                <PaginationItem key={p}>
                  <PaginationLink href="#" isActive={p === pageNo} className="num" onClick={go(p)}>
                    {p + 1}
                  </PaginationLink>
                </PaginationItem>
              )
            )}
            <PaginationItem>
              <PaginationNext
                href="#"
                aria-disabled={pageNo >= pageCount - 1}
                className={cn(pageNo >= pageCount - 1 && "pointer-events-none opacity-50")}
                onClick={go(Math.min(pageCount - 1, pageNo + 1))}
              />
            </PaginationItem>
          </PaginationContent>
        </Pagination>
      )}
    </div>
  );
};
