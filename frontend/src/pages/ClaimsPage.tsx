/**
 * Operations → Claims (`/claims`, everyone, scoped to the user's plants): warranty and insurance
 * claims for plant equipment: what failed, who the claim is with, the evidence and where it stands.
 * DB only; dates and serials as entered. Engineers create drafts, add evidence
 * and timeline entries; admins also change status and delete drafts. Pieces in
 * `pages/claims/`; docs/plans/claims.md.
 *
 * URL: `tab` (open | closed | all), `q`, `type`, `status`, `with`, `plant`, `wait` (us | them |
 * followup), `sort`, `desc`, `claim` (detail dialog open), and `new` (blank | issue | inverter |
 * sweep) with `p`, `sn`, `no`, `ref` for the prefilled create dialog other pages link to.
 */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { MoreHorizontal, Plus } from "lucide-react";
import type { Claim, ClaimEvidence } from "../api/client";
import { useAppContext } from "../context/AppContext";
import { isAdmin } from "../auth/access";
import { plantToday } from "../context/alarmLogStore";
import { pick, useUrlState } from "@/lib/useUrlState";
import { cn } from "@/lib/utils";
import { SkeletonRows, fmtInt } from "../components/ui";
import { TablePager, pageBounds } from "../components/TablePager";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ConfirmDialog } from "./tools/dialogs";
import { claimsApi, useClaims } from "./claims/useClaims";
import { ClaimTable, SORT_KEYS } from "./claims/ClaimTable";
import type { SortKey } from "./claims/ClaimTable";
import { ClaimDetail } from "./claims/ClaimDetail";
import { ClaimDialog, EventDialog, EvidenceDialog, LinkDialog, StatusDialog } from "./claims/dialogs";
import type { EventKind } from "./claims/dialogs";
import {
  CAUSE,
  PREFILL_KEYS,
  STATUS,
  STATUS_KEYS,
  TRANSITIONS,
  TYPE,
  TYPE_KEYS,
  WAIT,
  ageStart,
  daysBetween,
  downloadCsv,
  isOpen,
  readPrefill,
} from "./claims/format";

const TABS = ["open", "closed", "all"] as const;
const ALL = "all";
const PAGER_H = 52;
const BOTTOM_GAP = 24;

const Stat: React.FC<{ label: string; value: number | null; tone?: string; active?: boolean; onClick?: () => void; title?: string }> = ({
  label,
  value,
  tone,
  active,
  onClick,
  title,
}) => (
  <button
    type="button"
    onClick={onClick}
    title={title}
    disabled={!onClick}
    className={cn("flex flex-col gap-1 px-5 py-4 text-left transition-colors enabled:hover:bg-muted", active && "bg-muted")}
  >
    <span className="eyebrow">{label}</span>
    <span className={cn("num text-3xl font-bold tracking-tight", value ? tone : "text-muted-foreground")}>{value == null ? "—" : fmtInt(value)}</span>
  </button>
);

export const ClaimsPage: React.FC = () => {
  const { user, growattPlants } = useAppContext();
  const admin = isAdmin(user);
  const [url, setUrl] = useUrlState();
  const tab = pick(url.get("tab"), TABS, "open");
  const query = url.get("q") ?? "";
  const type = pick(url.get("type"), [ALL, ...TYPE_KEYS] as const, ALL);
  const status = pick(url.get("status"), [ALL, ...STATUS_KEYS] as const, ALL);
  const withParam = url.get("with") ?? ALL;
  const plantParam = /^\d+$/.test(url.get("plant") ?? "") ? Number(url.get("plant")) : null;
  const wait = pick(url.get("wait"), [ALL, ...WAIT] as const, ALL);
  const sort = pick(url.get("sort"), SORT_KEYS, "next");
  const desc = url.get("desc") === "1";
  const claimId = /^\d+$/.test(url.get("claim") ?? "") ? Number(url.get("claim")) : null;
  const prefill = useMemo(() => readPrefill(url), [url]);

  const { data, loading, error, reload } = useClaims();
  const [version, setVersion] = useState(0);
  const changed = useCallback(() => {
    setVersion((v) => v + 1);
    void reload();
  }, [reload]);

  const today = data?.meta.today ?? plantToday();
  const plantNames = useMemo(() => new Map(growattPlants.map((p) => [p.plant_id, p.name])), [growattPlants]);
  const plantName = useCallback((id: number) => plantNames.get(id) ?? `Plant ${id}`, [plantNames]);

  const all = useMemo(() => data?.claims ?? [], [data]);
  const counterparties = useMemo(() => [...new Set(["Growatt", ...all.map((c) => c.counterparty)])].filter((x) => x && x !== "—").sort(), [all]);
  const plantsInUse = useMemo(() => [...new Set(all.map((c) => c.plant_id))].sort((a, b) => plantName(a).localeCompare(plantName(b))), [all, plantName]);

  // dialogs
  const [editing, setEditing] = useState<Claim | null>(null);
  const [statusOf, setStatusOf] = useState<Claim | null>(null);
  const [eventOf, setEventOf] = useState<{ claim: Claim; kind: EventKind } | null>(null);
  const [evidenceOf, setEvidenceOf] = useState<{ claim: Claim; item: ClaimEvidence } | null>(null);
  const [linkOf, setLinkOf] = useState<Claim | null>(null);
  const [confirm, setConfirm] = useState<{ title: string; text: string; label: string; run: () => Promise<unknown> } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const creating = prefill != null;

  const guard = async (what: string, fn: () => Promise<unknown>) => {
    setActionError(null);
    try {
      await fn();
      changed();
    } catch (e) {
      setActionError(`${what}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // ---- filtering
  const rows = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const out = all.filter((c) => {
      if (tab === "open" && !isOpen(c)) return false;
      if (tab === "closed" && isOpen(c)) return false;
      if (type !== ALL && c.type !== type) return false;
      if (status !== ALL && c.status !== status) return false;
      if (withParam !== ALL && c.counterparty !== withParam) return false;
      if (plantParam != null && c.plant_id !== plantParam) return false;
      if (wait === "us" && c.waiting_on !== "us") return false;
      if (wait === "them" && c.waiting_on !== "them") return false;
      if (wait === "followup" && !c.followup_overdue) return false;
      if (!words.length) return true;
      const text = [
        c.number,
        c.plant_name ?? plantName(c.plant_id),
        c.device_sn,
        c.old_sn,
        c.new_sn,
        c.device_label,
        c.counterparty,
        c.counterparty_ref,
        c.description,
        ...c.module_serials,
        TYPE[c.type].label,
        CAUSE[c.cause],
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return words.every((w) => text.includes(w));
    });
    const age = (c: Claim) => {
      const s = ageStart(c);
      return s ? daysBetween(s, c.closed_day ?? today) : -1;
    };
    const cmp = (a: Claim, b: Claim): number => {
      switch (sort) {
        case "number":
          return a.number.localeCompare(b.number, undefined, { numeric: true });
        case "age":
          return age(a) - age(b);
        case "next": {
          // follow-up overdue, then waiting on us, then by next action day (none last), open before closed
          const rank = (c: Claim) => (!isOpen(c) ? 3 : c.followup_overdue ? 0 : c.waiting_on === "us" ? 1 : 2);
          return rank(a) - rank(b) || (a.next_action_day ?? "9999").localeCompare(b.next_action_day ?? "9999") || b.number.localeCompare(a.number, undefined, { numeric: true });
        }
      }
    };
    return out.sort((a, b) => (desc ? -cmp(a, b) : cmp(a, b)));
  }, [all, tab, type, status, withParam, plantParam, wait, query, sort, desc, today, plantName]);

  // ---- the table ends at the bottom of the screen (as on Active Alarm)
  const tableRef = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState<{ height: number; pageSize: number }>({ height: 480, pageSize: 10 });
  const [page, setPage] = useState(0);
  const firstRead = loading && !data;
  useLayoutEffect(() => {
    const measure = () => {
      const el = tableRef.current;
      if (!el) return;
      const top = el.getBoundingClientRect().top + window.scrollY;
      const height = Math.max(300, window.innerHeight - top - PAGER_H - BOTTOM_GAP);
      const headH = el.querySelector("thead")?.getBoundingClientRect().height || 36;
      const rowH = el.querySelector("tbody tr")?.getBoundingClientRect().height || 52;
      const pageSize = Math.max(5, Math.floor((height - headH) / rowH));
      setFit((f) => (f.height === height && f.pageSize === pageSize ? f : { height, pageSize }));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [rows.length > 0, firstRead, actionError]);
  useEffect(() => setPage(0), [tab, query, type, status, withParam, plantParam, wait, sort, desc]);
  const { pageNo } = pageBounds(rows.length, fit.pageSize, page);
  const shown = rows.slice(pageNo * fit.pageSize, (pageNo + 1) * fit.pageSize);

  // ---- actions
  const open = (c: Claim | number) => setUrl({ claim: typeof c === "number" ? c : c.id, ...PREFILL_KEYS });
  const canEdit = (c: Claim) => admin || isOpen(c);

  const actions = (c: Claim) => (
    <div className="inline-flex items-center gap-1">
      {admin && TRANSITIONS[c.status].length > 0 && (
        <Button size="xs" variant="outline" onClick={() => setStatusOf(c)}>
          Status
        </Button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="icon-xs" variant="ghost" aria-label={`More for ${c.number}`}>
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem onSelect={() => open(c)}>Open</DropdownMenuItem>
          {canEdit(c) && <DropdownMenuItem onSelect={() => setEditing(c)}>Edit</DropdownMenuItem>}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setEventOf({ claim: c, kind: "note" })}>Add note</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setEventOf({ claim: c, kind: "message" })}>Add message</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setEventOf({ claim: c, kind: "shipment" })}>Add shipment</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setLinkOf(c)}>Link a record</DropdownMenuItem>
          {admin && c.status === "draft" && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onSelect={() =>
                  setConfirm({
                    title: `Delete ${c.number}`,
                    text: "The draft, its evidence ticks and its timeline are deleted. Only a draft can be deleted; withdraw a submitted claim instead.",
                    label: "Delete",
                    run: () => claimsApi.deleteClaim(c.id),
                  })
                }
              >
                Delete draft
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );

  const exportCsv = () =>
    downloadCsv(
      `claims-${tab}-${today}.csv`,
      [
        "number",
        "type",
        "status",
        "waiting_on",
        "plant",
        "inverter_sn",
        "strings",
        "device",
        "cause",
        "counterparty",
        "their_ref",
        "incident_day",
        "submitted_day",
        "closed_day",
        "next_action_day",
        "old_sn",
        "new_sn",
        "evidence",
      ],
      rows.map((c) => [
        c.number,
        TYPE[c.type].label,
        STATUS[c.status].label,
        c.waiting_on,
        c.plant_name ?? plantName(c.plant_id),
        c.device_sn,
        c.string_nos.join(" "),
        c.device_label,
        CAUSE[c.cause],
        c.counterparty,
        c.counterparty_ref,
        c.incident_day,
        c.submitted_day,
        c.closed_day,
        c.next_action_day,
        c.old_sn,
        c.new_sn,
        `${c.evidence_done}/${c.evidence_required}`,
      ])
    );

  const s = data?.summary;
  const anyFilter = query.trim() !== "" || type !== ALL || status !== ALL || withParam !== ALL || plantParam != null || wait !== ALL;
  const clearFilters = () => setUrl({ q: null, type: null, status: null, with: null, plant: null, wait: null });
  const pickWait = (w: (typeof WAIT)[number]) => setUrl({ tab: null, status: null, wait: wait === w ? null : w });
  const count = (f: (c: Claim) => boolean) => (data ? fmtInt(all.filter(f).length) : "—"); // not read yet ≠ none

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col">
          <h1 className="text-lg font-semibold">Claims</h1>
          <p className="text-xs text-muted-foreground">Warranty & insurance claims: what failed, who has the claim, the evidence, and where each claim stands</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void reload()} disabled={loading}>
            {loading && <Spinner data-icon="inline-start" className="size-3" />}
            {loading ? "Refreshing…" : "Refresh"}
          </Button>
          <Button size="sm" onClick={() => setUrl({ new: "blank", claim: null })}>
            <Plus data-icon="inline-start" />
            New claim
          </Button>
        </div>
      </div>

      {error && !data && (
        <Alert variant="destructive">
          <AlertTitle>Could not load the claims</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {actionError && (
        <Alert variant="destructive">
          <AlertDescription className="flex items-center justify-between gap-2">
            {actionError}
            <Button size="xs" variant="ghost" onClick={() => setActionError(null)}>
              Dismiss
            </Button>
          </AlertDescription>
        </Alert>
      )}

      <Card className="py-0">
        <CardContent className="grid grid-cols-2 divide-white/[0.06] px-0 lg:grid-cols-4 lg:divide-x">
          <Stat label="Open" value={s?.open ?? null} tone="text-foreground" active={tab === "open" && wait === ALL} onClick={() => setUrl({ tab: null, wait: null, status: null })} />
          <Stat
            label="Waiting on us"
            value={s?.waiting_us ?? null}
            tone="text-amber-300"
            active={wait === "us"}
            onClick={() => pickWait("us")}
            title="Drafts, info requested, rejected (decide: appeal or close), fulfilled (close it)"
          />
          <Stat label="Waiting on them" value={s?.waiting_them ?? null} tone="text-sky-300" active={wait === "them"} onClick={() => pickWait("them")} />
          <Stat
            label="Follow up"
            value={s?.followup_overdue ?? null}
            tone="text-red-300"
            active={wait === "followup"}
            onClick={() => pickWait("followup")}
            title="Next action day has passed"
          />
        </CardContent>
      </Card>

      <Card className="gap-0 py-0">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 pt-2 sm:px-5">
          <Tabs value={tab} onValueChange={(v) => setUrl({ tab: v === "open" ? null : v, wait: v === "closed" ? null : wait })}>
            <TabsList variant="line" className="border-0 p-0">
              <TabsTrigger value="open" className="px-3 py-2.5 text-sm">
                Open <span className="num text-muted-foreground">{count(isOpen)}</span>
              </TabsTrigger>
              <TabsTrigger value="closed" className="px-3 py-2.5 text-sm">
                Closed <span className="num text-muted-foreground">{count((c) => !isOpen(c))}</span>
              </TabsTrigger>
              <TabsTrigger value="all" className="px-3 py-2.5 text-sm">
                All <span className="num text-muted-foreground">{count(() => true)}</span>
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="flex items-center gap-2 pb-2">
            <Input className="h-8 w-64" placeholder="Search no., plant, SN, reference" value={query} onChange={(e) => setUrl({ q: e.target.value })} aria-label="Search claims" />
            <Button variant="outline" size="sm" onClick={exportCsv} disabled={!rows.length}>
              Export CSV
            </Button>
          </div>
        </div>

        <CardContent className="flex flex-wrap items-center gap-2 border-b py-3">
          <Select value={type} onValueChange={(v) => setUrl({ type: v === ALL ? null : v })}>
            <SelectTrigger size="sm" className="w-44" aria-label="Type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value={ALL}>All types</SelectItem>
              </SelectGroup>
              <SelectSeparator />
              {TYPE_KEYS.map((t) => (
                <SelectItem key={t} value={t}>
                  {TYPE[t].label} ({all.filter((c) => c.type === t).length})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={status} onValueChange={(v) => setUrl({ status: v === ALL ? null : v, tab: v !== ALL ? "all" : null })}>
            <SelectTrigger size="sm" className="w-40" aria-label="Status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All statuses</SelectItem>
              <SelectSeparator />
              {STATUS_KEYS.map((k) => (
                <SelectItem key={k} value={k}>
                  {STATUS[k].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={counterparties.includes(withParam) ? withParam : ALL} onValueChange={(v) => setUrl({ with: v === ALL ? null : v })}>
            <SelectTrigger size="sm" className="w-48" aria-label="Claim with">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Anyone</SelectItem>
              <SelectSeparator />
              {counterparties.map((x) => (
                <SelectItem key={x} value={x}>
                  {x}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={plantParam != null ? String(plantParam) : ALL} onValueChange={(v) => setUrl({ plant: v === ALL ? null : v })}>
            <SelectTrigger size="sm" className="w-56" aria-label="Plant">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All plants</SelectItem>
              <SelectSeparator />
              {plantsInUse.map((id) => (
                <SelectItem key={id} value={String(id)}>
                  {plantName(id)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {anyFilter && (
            <Button variant="ghost" size="sm" onClick={clearFilters} className="ml-auto">
              Clear
            </Button>
          )}
        </CardContent>

        <CardContent ref={tableRef} className="overflow-x-auto overflow-y-hidden px-0" style={{ height: fit.height }}>
          {rows.length === 0 ? (
            firstRead ? (
              <SkeletonRows rows={8} className="p-4" />
            ) : (
              <Empty className="h-full">
                <EmptyHeader>
                  <EmptyTitle>{!data ? "Claims unavailable" : anyFilter ? "No matching claims" : tab === "closed" ? "No closed claims" : "No open claims"}</EmptyTitle>
                  {!data && error && <EmptyDescription>{error}</EmptyDescription>}
                  {data && !anyFilter && tab !== "closed" && <EmptyDescription>Start one with “New claim”, or from an issue or inverter.</EmptyDescription>}
                </EmptyHeader>
              </Empty>
            )
          ) : (
            <ClaimTable
              rows={shown}
              sort={sort}
              desc={desc}
              onSort={(k: SortKey) => setUrl({ sort: k === "next" ? null : k, desc: k === sort ? !desc : false })}
              today={today}
              plantName={plantName}
              onOpen={open}
              actions={actions}
            />
          )}
        </CardContent>
        <CardContent className="border-t py-2.5">
          <TablePager rows={rows.length} pageSize={fit.pageSize} pageNo={pageNo} onPage={setPage} />
        </CardContent>
      </Card>

      <ClaimDetail
        id={claimId}
        version={version}
        today={today}
        plantName={plantName}
        onClose={() => setUrl({ claim: null })}
        actions={(d) => ({
          status: admin && TRANSITIONS[d.status].length ? () => setStatusOf(d) : undefined,
          edit: canEdit(d) ? () => setEditing(d) : undefined,
          event: (kind) => setEventOf({ claim: d, kind }),
          evidence: (item) => setEvidenceOf({ claim: d, item }),
          toggleEvidence: (item) => guard(item.label, () => claimsApi.setClaimEvidence(d.id, item.key, { done: !item.done })),
          link: () => setLinkOf(d),
          unlink: (linkId) => guard("Unlink", () => claimsApi.deleteClaimLink(d.id, linkId)),
        })}
      />
      <ClaimDialog
        open={creating || editing != null}
        editing={editing}
        prefill={prefill}
        existing={all}
        counterparties={counterparties}
        onClose={() => {
          setEditing(null);
          if (creating) setUrl(PREFILL_KEYS);
        }}
        onSaved={(c) => {
          changed();
          if (!editing) setUrl({ ...PREFILL_KEYS, claim: c.id, tab: null });
        }}
        onOpenExisting={(id) => {
          setEditing(null);
          open(id);
        }}
      />
      <StatusDialog claim={statusOf} onClose={() => setStatusOf(null)} onDone={changed} />
      <EventDialog target={eventOf} onClose={() => setEventOf(null)} onDone={changed} />
      <EvidenceDialog target={evidenceOf} onClose={() => setEvidenceOf(null)} onDone={changed} />
      <LinkDialog claim={linkOf} onClose={() => setLinkOf(null)} onDone={changed} />
      <ConfirmDialog
        open={confirm != null}
        title={confirm?.title ?? ""}
        text={confirm?.text ?? ""}
        label={confirm?.label ?? ""}
        onClose={() => setConfirm(null)}
        onConfirm={() => confirm!.run()}
        onDone={() => {
          changed();
          setUrl({ claim: null });
        }}
      />
    </div>
  );
};

export default ClaimsPage;
