import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Search,
  X,
  LayoutDashboard,
  TrendingUp,
  Activity,
  Wrench,
  ShieldAlert,
  Settings,
  LogOut,
  Cpu,
  Bell,
  CheckCircle2,
  ArrowRight,
  CornerDownLeft,
  CheckCheck,
} from "lucide-react";
import { useAppContext, usePlantHref } from "../context/AppContext";
import { canAccessPath } from "../auth/access";
import { StatusBadge, Led, statusLevel, fmt } from "./ui";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

/* -------------------------------------------------------------------------- */
/* Command Palette Modal (⌘K / Ctrl+K)                                        */
/* -------------------------------------------------------------------------- */
interface CommandItem {
  id: string;
  category: "Navigation" | "PV Strings" | "Active Alarms" | "Quick Actions";
  title: string;
  subtitle: string;
  badge?: string;
  icon: React.ElementType;
  onSelect: () => void;
  /** route it opens (navigation items): hidden when the user's role cannot open it */
  path?: string;
}

export const CommandPaletteModal: React.FC<{
  open: boolean;
  onClose: () => void;
  onOpenAlarms: () => void;
  onSignOut: () => void;
}> = ({ open, onClose, onOpenAlarms, onSignOut }) => {
  const { analysisRun, setInspectedStringId, user } = useAppContext();
  const navigate = useNavigate();
  const plantHref = usePlantHref();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  const items = useMemo<CommandItem[]>(() => {
    const go = (path: string) => () => {
      navigate(path);
      onClose();
    };

    const navItems: CommandItem[] = [
      {
        id: "nav-overview",
        category: "Navigation",
        title: "Plant Overview",
        subtitle: "Live plant status, PR ring gauge, Digital Twin & string matrix",
        icon: LayoutDashboard,
        onSelect: go(plantHref("")),
        path: plantHref(""),
      },
      {
        id: "nav-generation",
        category: "Navigation",
        title: "Generation & PR",
        subtitle: "Daily/monthly yield, IEC 61724 PR & energy loss waterfall",
        icon: TrendingUp,
        onSelect: go(plantHref("generation")),
        path: plantHref("generation"),
      },
      {
        id: "nav-strings",
        category: "Navigation",
        title: "String Diagnostics & I-V Curves",
        subtitle: "Peer deviation heatmap, timeseries & single-diode I-V envelope",
        icon: Activity,
        onSelect: go(plantHref("strings")),
        path: plantHref("strings"),
      },
      {
        id: "nav-maintenance",
        category: "Navigation",
        title: "Maintenance & RCA",
        subtitle: "PM optimization schedule, CM work orders & 5-Why / Fishbone RCA",
        icon: Wrench,
        onSelect: go(plantHref("maintenance")),
        path: plantHref("maintenance"),
      },
      {
        id: "nav-she",
        category: "Navigation",
        title: "Safety, Health & Environment (SH&E)",
        subtitle: "Permit-to-work, LOTO isolation & ISO 45001 compliance",
        icon: ShieldAlert,
        onSelect: go("/she"),
        path: "/she",
      },
      {
        id: "nav-settings",
        category: "Navigation",
        title: "Global Settings",
        subtitle: "Fleet module & settings that apply to every plant",
        icon: Settings,
        onSelect: go("/settings"),
        path: "/settings",
      },
    ];

    const stringItems: CommandItem[] = (analysisRun?.string_summary_json || []).map((s) => ({
      id: `str-${s.string_id}`,
      category: "PV Strings" as const,
      title: `${s.string_id} · ${s.inverter_id} / ${s.mppt_id}`,
      subtitle: `PR ${fmt(s.pr_pct, 1)}% · Peer ${Number(s.peer_gap_pct) >= 0 ? "+" : ""}${fmt(s.peer_gap_pct, 1)}%${s.primary_diagnosis ? ` · ${s.primary_diagnosis}` : ""}`,
      badge: String(s.status),
      icon: Cpu,
      onSelect: () => {
        onClose();
        setInspectedStringId(String(s.string_id));
      },
    }));

    const alarmItems: CommandItem[] = (analysisRun?.anomalies_json || []).slice(0, 8).map((a, idx) => ({
      id: `alarm-${idx}`,
      category: "Active Alarms" as const,
      title: `${a.string_id} — ${a.fault_type}`,
      subtitle: `${String(a.date)} ${a.start_time}–${a.end_time} · −${fmt(a.estimated_loss_kwh, 2)} kWh`,
      badge: String(a.severity),
      icon: Bell,
      onSelect: () => {
        onClose();
        setInspectedStringId(String(a.string_id));
      },
    }));

    const actionItems: CommandItem[] = [
      {
        id: "act-alarms",
        category: "Quick Actions",
        title: "Open Alarm Center Drawer",
        subtitle: "Triage active string fault episodes by severity",
        icon: Bell,
        onSelect: () => {
          onClose();
          onOpenAlarms();
        },
      },
      {
        id: "act-signout",
        category: "Quick Actions",
        title: "Sign Out",
        subtitle: "End this session and return to the login page",
        icon: LogOut,
        onSelect: () => {
          onClose();
          onSignOut();
        },
      },
    ];

    const allowedNav = navItems.filter((n) => !n.path || canAccessPath(user, n.path));
    return [...stringItems, ...allowedNav, ...alarmItems, ...actionItems];
  }, [analysisRun, navigate, onClose, onOpenAlarms, onSignOut, setInspectedStringId, user, plantHref]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (i) =>
        i.title.toLowerCase().includes(q) ||
        i.subtitle.toLowerCase().includes(q) ||
        i.category.toLowerCase().includes(q) ||
        (i.badge && i.badge.toLowerCase().includes(q))
    );
  }, [items, query]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query, open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      // Escape and outside clicks are handled by the Dialog (onOpenChange → onClose).
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((prev) => (filtered.length > 0 ? (prev + 1) % filtered.length : 0));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((prev) =>
          filtered.length > 0 ? (prev - 1 + filtered.length) % filtered.length : 0
        );
      } else if (e.key === "Enter" && filtered[activeIndex]) {
        e.preventDefault();
        filtered[activeIndex].onSelect();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, filtered, activeIndex, onClose]);

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        className="top-20 max-w-2xl translate-y-0 gap-0 overflow-hidden border-white/15 bg-ink-900 p-0 shadow-2xl sm:max-w-2xl"
      >
        <DialogTitle className="sr-only">Command Palette</DialogTitle>
        {/* Search Bar */}
        <div className="flex items-center gap-3 border-b border-white/[0.08] px-4 py-3.5">
          <Search className="h-4 w-4 text-solar-400" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Jump to any PV string (STR-06), inverter, alarm, or module…"
            className="w-full bg-transparent text-xs text-slate-100 placeholder:text-slate-500 outline-none"
          />
          <kbd className="num rounded border border-white/10 bg-ink-850 px-1.5 py-0.5 text-[11px] text-slate-400">
            ESC
          </kbd>
        </div>

        {/* Results */}
        <div className="max-h-[420px] overflow-y-auto p-2">
          {filtered.length === 0 ? (
            <div className="py-10 text-center text-xs text-slate-500">
              No matching strings, alarms, or modules for "{query}"
            </div>
          ) : (
            <div className="space-y-1">
              {filtered.map((item, idx) => {
                const Icon = item.icon;
                const active = idx === activeIndex;
                return (
                  <button
                    key={item.id}
                    onMouseEnter={() => setActiveIndex(idx)}
                    onClick={item.onSelect}
                    className={`flex w-full cursor-pointer items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-left transition ${
                      active ? "bg-solar-500/15 text-white" : "text-slate-300 hover:bg-white/[0.04]"
                    }`}
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <div
                        className={`rounded-lg p-2 ${
                          active
                            ? "bg-solar-500/20 text-solar-300"
                            : "bg-ink-850 text-slate-400"
                        }`}
                      >
                        <Icon className="h-4 w-4" />
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-xs font-semibold text-slate-100">
                            {item.title}
                          </span>
                          <span className="text-[11px] uppercase tracking-wider text-slate-500">
                            {item.category}
                          </span>
                        </div>
                        <div className="truncate text-[11px] text-slate-400">{item.subtitle}</div>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {item.badge && <StatusBadge status={item.badge} dot={false} />}
                      {active && <CornerDownLeft className="h-3.5 w-3.5 text-solar-400" />}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer hint */}
        <div className="flex items-center justify-between border-t border-white/[0.06] bg-ink-950/60 px-4 py-2 text-[11px] text-slate-500">
          <span>Use ↑↓ arrows to navigate, Enter to select</span>
          <span className="num">⌘K / Ctrl+K</span>
        </div>
      </DialogContent>
    </Dialog>
  );
};

/* -------------------------------------------------------------------------- */
/* Alarm Center Slide-Over Drawer                                             */
/* -------------------------------------------------------------------------- */
export const AlarmCenterDrawer: React.FC<{
  open: boolean;
  onClose: () => void;
}> = ({ open, onClose }) => {
  const { analysisRun, setInspectedStringId } = useAppContext();
  const navigate = useNavigate();
  const plantHref = usePlantHref();
  const [filter, setFilter] = useState<"all" | "Critical" | "High" | "Medium">("all");
  const [ackedIds, setAckedIds] = useState<Record<number, boolean>>({});

  if (!open) return null;

  const anomalies: Record<string, any>[] = analysisRun?.anomalies_json || [];
  const criticalCount = anomalies.filter((a) => String(a.severity) === "Critical").length;
  const highCount = anomalies.filter((a) => String(a.severity) === "High").length;
  const mediumCount = anomalies.filter((a) => String(a.severity) === "Medium").length;
  const totalFaultLossKwh = anomalies.reduce(
    (acc, a) => acc + Number(a.estimated_loss_kwh || 0),
    0
  );

  const visible: Record<string, any>[] = anomalies
    .map((a, idx): Record<string, any> => ({ ...a, _idx: idx }))
    .filter((a) => (filter === "all" ? true : String(a.severity) === filter));

  const ackAll = () => {
    const next: Record<number, boolean> = {};
    anomalies.forEach((_, idx) => {
      next[idx] = true;
    });
    setAckedIds(next);
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/65 backdrop-blur-sm" onClick={onClose} />
      <aside className="relative flex h-full w-full max-w-lg flex-col border-l border-white/10 bg-ink-900 shadow-2xl">
        {/* Header */}
        <div className="border-b border-white/[0.07] bg-ink-950/60 px-5 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="rounded-lg bg-red-500/15 p-2 text-red-400 ring-1 ring-red-400/30">
                <Bell className="h-4 w-4" />
              </div>
              <div>
                <h3 className="text-sm font-bold text-white">SCADA Alarm Center</h3>
                <p className="text-[11px] text-slate-400">
                  {anomalies.length} fault episodes · −{fmt(totalFaultLossKwh, 1)} kWh total loss
                </p>
              </div>
            </div>
            <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close alarm center">
              <X className="size-4" />
            </Button>
          </div>

          {/* Severity filter tabs + Ack All */}
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <Tabs value={filter} onValueChange={(v) => setFilter(v as typeof filter)}>
              <TabsList>
                <TabsTrigger value="all">All ({anomalies.length})</TabsTrigger>
                <TabsTrigger value="Critical">Critical ({criticalCount})</TabsTrigger>
                <TabsTrigger value="High">High ({highCount})</TabsTrigger>
                <TabsTrigger value="Medium">Medium ({mediumCount})</TabsTrigger>
              </TabsList>
            </Tabs>
            <Button variant="ghost" size="sm" onClick={ackAll}>
              <CheckCheck className="size-3.5 text-emerald-400" />
              Ack All
            </Button>
          </div>
        </div>

        {/* Alarm Feed */}
        <div className="flex-1 divide-y divide-white/[0.06] overflow-y-auto">
          {visible.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
              <CheckCircle2 className="h-6 w-6 text-emerald-400" />
              <div className="text-xs font-medium text-slate-300">No alarms in this severity filter</div>
            </div>
          ) : (
            visible.map((a) => {
              const lvl = statusLevel(a.severity);
              const acked = Boolean(ackedIds[a._idx]);
              return (
                <div
                  key={a._idx}
                  className={`p-4 transition ${
                    acked ? "opacity-55 hover:opacity-90" : "hover:bg-white/[0.025]"
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <Led
                        level={lvl === "info" || lvl === "neutral" ? "warn" : lvl}
                        pulse={lvl === "crit" && !acked}
                      />
                      <span className="num font-bold text-solar-400">{a.string_id}</span>
                      <span className="num text-[11px] text-slate-500">
                        {a.inverter_id} / {a.mppt_id}
                      </span>
                    </div>
                    <StatusBadge status={acked ? "Acknowledged" : a.severity} dot={false} />
                  </div>

                  <div className="mt-1.5 text-xs font-semibold text-slate-100">{a.fault_type}</div>

                  <div className="num mt-1.5 grid grid-cols-3 gap-2 rounded-lg border border-white/[0.05] bg-ink-950/60 p-2 text-[11px]">
                    <div>
                      <span className="text-slate-500">Window</span>
                      <div className="text-slate-200">
                        {String(a.date)} {a.start_time}–{a.end_time}
                      </div>
                    </div>
                    <div>
                      <span className="text-slate-500">Operating V / I</span>
                      <div className="text-slate-200">
                        {fmt(a.avg_voltage_v, 0)}V · {fmt(a.avg_current_a, 2)}A
                      </div>
                    </div>
                    <div>
                      <span className="text-slate-500">Yield Loss</span>
                      <div className="font-bold text-red-400">−{fmt(a.estimated_loss_kwh, 2)} kWh</div>
                    </div>
                  </div>

                  <div className="mt-2.5 flex items-center justify-between gap-2">
                    <button
                      onClick={() =>
                        setAckedIds((prev) => ({ ...prev, [a._idx]: !prev[a._idx] }))
                      }
                      className="text-[11px] font-medium text-slate-400 hover:text-slate-200 cursor-pointer"
                    >
                      {acked ? "Unacknowledge" : "✓ Acknowledge"}
                    </button>
                    <div className="flex items-center gap-1.5">
                      <Button
                        size="sm"
                        onClick={() => {
                          onClose();
                          setInspectedStringId(String(a.string_id));
                        }}
                      >
                        Inspect {a.string_id}
                      </Button>
                      <Button
                        variant="accent"
                        size="sm"
                        onClick={() => {
                          onClose();
                          navigate(plantHref("maintenance"));
                        }}
                      >
                        CM / RCA <ArrowRight className="size-3" />
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </aside>
    </div>
  );
};
