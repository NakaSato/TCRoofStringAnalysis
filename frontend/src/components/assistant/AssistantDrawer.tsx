/**
 * AI Assistant drawer (docs/plans/ai-assistant.md §4.7): opened from the top bar or Ctrl/⌘ + J.
 * On desktop it sits beside the page without a backdrop, so the user can keep reading the page the
 * question is about; on phones it covers the screen. Answers stream from `POST /assistant/chat`,
 * which reads stored data only through read-only tools.
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { ArrowUp, Check, CircleAlert, Sparkles, SquarePen, Square, X } from "lucide-react";
import type { AssistantPageContext } from "../../api/client";
import { parsePlantPath } from "../../context/routes";
import type { PlantPage } from "../../context/routes";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Markdown } from "./Markdown";
import { useAssistantChat, type Turn } from "./useAssistantChat";
import { useI18n } from "../../i18n";

const TOOL_LABEL: Record<string, string> = {
  list_plants: "Finding plants",
  plant_overview: "Reading plant day",
  alarms: "Reading alarm log",
  fleet_ranking: "Ranking the fleet",
  inverter_daily: "Reading inverter trend",
  inverter_day_profile: "Reading inverter day",
  string_detail: "Analysing string",
  weather_sensors: "Checking weather sensors",
  plant_weather: "Reading plant weather",
  om_dashboard: "Reading O&M dashboard",
};

// keyed by every plant page, so a renamed or added tab fails the type check instead of becoming "plant page"
const PAGE_NAME: Record<PlantPage, string> = {
  "": "plant overview",
  performance: "plant generation & PR",
  inverters: "plant inverters",
  sensors: "plant weather sensors",
  strings: "plant string diagnostics",
  string: "one string in detail",
  "string-layout": "plant string layout",
  maintenance: "plant maintenance",
  documents: "plant documents",
  billing: "plant energy & billing",
};

/** What the user is looking at, from the URL only (the plant and day live there). */
export function pageContext(pathname: string, search: string): AssistantPageContext {
  const day = new URLSearchParams(search).get("day");
  const ctx: AssistantPageContext = { day: day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null };
  const plant = parsePlantPath(pathname);
  if (plant && Number.isFinite(plant.plantId)) {
    ctx.plant_id = plant.plantId;
    ctx.page = plant.page == null ? "plant page" : PAGE_NAME[plant.page];
    return ctx;
  }
  const first = pathname.split("/")[1] ?? "";
  ctx.page =
    ({ "": "plant directory", map: "plant map", alarms: "active alarm", sensors: "weather sensors" } as Record<string, string>)[first] ??
    (first || "plant directory");
  return ctx;
}

function suggestions(ctx: AssistantPageContext): string[] {
  if (ctx.plant_id != null)
    return ["สรุปโรงไฟฟ้าโซลาร์นี้วันนี้ มีอะไรผิดปกติไหม", "สตริงไหนมีปัญหา และน่าจะเกิดจากอะไร", "วันนี้โรงไฟฟ้าโซลาร์นี้มี alarm อะไรบ้าง"];
  if (ctx.page === "active alarm")
    return ["สรุป alarm ที่ยังเปิดอยู่วันนี้ เรียงตามความสำคัญ", "โรงไฟฟ้าโซลาร์ไหนมี alarm มากที่สุดวันนี้", "มี PV isolation fault ที่ไหนบ้าง"];
  return ["5 โรงไฟฟ้าโซลาร์ที่ specific yield ต่ำสุดเมื่อวาน", "โรงไฟฟ้าโซลาร์ไหนผลิตได้ดีที่สุดเมื่อวาน", "วันนี้มี alarm อะไรที่ต้องรีบดู"];
}

const ToolChip: React.FC<{ name: string; status: "running" | "done" | "error" }> = ({ name, status }) => {
  const { t } = useI18n();
  return (
  <span className="inline-flex items-center gap-1 rounded-full border border-white/[0.08] bg-white/[0.03] px-2 py-0.5 text-[11px] text-slate-400">
    {status === "running" ? (
      <Spinner className="size-3" />
    ) : status === "error" ? (
      <CircleAlert className="size-3 text-amber-400" />
    ) : (
      <Check className="size-3 text-emerald-400" />
    )}
    {TOOL_LABEL[name] ? t(TOOL_LABEL[name]) : name}
  </span>
  );
};

const AssistantTurn: React.FC<{ turn: Extract<Turn, { role: "assistant" }>; onNavigate: () => void }> = ({ turn, onNavigate }) => {
  const { t } = useI18n();
  const waiting = turn.status === "streaming" && !turn.answer && !turn.tools.some((x) => x.status === "running");
  return (
    <div className="space-y-2">
      {(turn.tools.length > 0 || turn.notes.length > 0) && (
        <div className="space-y-1.5">
          {turn.notes.map((n, i) => (
            <p key={i} className="text-xs italic text-slate-500">{n}</p>
          ))}
          {turn.tools.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {turn.tools.map((tool, i) => (
                <ToolChip key={i} name={tool.name} status={tool.status} />
              ))}
            </div>
          )}
        </div>
      )}
      {turn.answer && <Markdown text={turn.answer} onNavigate={onNavigate} />}
      {waiting && (
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <Spinner className="size-3" /> {t("Thinking…")}
        </div>
      )}
      {turn.status === "stopped" && <p className="text-xs text-slate-500">{t("Stopped.")}</p>}
      {turn.error && (
        <div className="callout-warn flex items-start gap-2 text-xs">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
          {/* the two frontend messages are translated; API error text passes through unchanged */}
          <span>{t(turn.error)}</span>
        </div>
      )}
    </div>
  );
};

export const AssistantDrawer: React.FC<{ open: boolean; onClose: () => void; userId: number | null; model?: string }> = ({
  open,
  onClose,
  userId,
  model,
}) => {
  const location = useLocation();
  const { t } = useI18n();
  const ctx = useMemo(() => pageContext(location.pathname, location.search), [location.pathname, location.search]);
  const { turns, busy, send, stop, reset } = useAssistantChat(userId);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [turns, open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const submit = (text: string) => {
    if (!text.trim() || busy) return;
    void send(text, ctx);
    setDraft("");
  };
  // on phones the drawer covers the page: close it when a link opens a page
  const onNavigate = () => {
    if (!window.matchMedia("(min-width: 1024px)").matches) onClose();
  };

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex justify-end lg:pointer-events-none">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm lg:hidden" onClick={onClose} />
      <aside
        className="pointer-events-auto relative flex h-full w-full flex-col border-l border-white/10 bg-ink-900 shadow-2xl lg:max-w-md"
        aria-label={t("AI Assistant")}
      >
        <header className="flex items-center gap-2 border-b border-white/[0.06] px-4 py-3">
          <Sparkles className="size-4 text-solar-400" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-slate-100">{t("AI Assistant")}</div>
            <div className="truncate text-[11px] text-slate-500">{t("Reads stored data only")}{model ? ` · ${model}` : ""}</div>
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" onClick={reset} disabled={!turns.length} aria-label={t("New chat")}>
                <SquarePen className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("New chat")}</TooltipContent>
          </Tooltip>
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label={t("Close assistant")}>
            <X className="size-4" />
          </Button>
        </header>

        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
          {turns.length === 0 ? (
            <div className="space-y-3 pt-2">
              <p className="text-xs text-slate-400">
                {ctx.plant_id != null
                  ? t("Ask about plants, yield, strings or alarms. Answers come from the stored Growatt history, and know which plant you are looking at.")
                  : t("Ask about plants, yield, strings or alarms. Answers come from the stored Growatt history.")}
              </p>
              <div className="flex flex-col gap-1.5">
                {suggestions(ctx).map((s) => (
                  <button
                    key={s}
                    onClick={() => submit(s)}
                    className="cursor-pointer rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-2 text-left text-xs text-slate-300 transition hover:border-solar-400/40 hover:text-slate-100"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            turns.map((tn) =>
              tn.role === "user" ? (
                <div key={tn.id} className="flex justify-end">
                  <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-solar-400/10 px-3 py-2 text-[13px] text-slate-100">
                    {tn.content}
                  </div>
                </div>
              ) : (
                <AssistantTurn key={tn.id} turn={tn} onNavigate={onNavigate} />
              )
            )
          )}
          <div ref={endRef} />
        </div>

        <footer className="border-t border-white/[0.06] px-4 pb-3 pt-3">
          <form
            className="flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              submit(draft);
            }}
          >
            <Textarea
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  submit(draft);
                }
              }}
              maxLength={4000}
              rows={1}
              placeholder={t("Ask a question…")}
              className="max-h-40 min-h-9 resize-none text-[13px]"
              aria-label={t("Question")}
            />
            {busy ? (
              <Button type="button" size="icon" variant="outline" onClick={stop} aria-label={t("Stop answer")}>
                <Square className="size-3.5 fill-current" />
              </Button>
            ) : (
              <Button type="submit" size="icon" disabled={!draft.trim()} aria-label={t("Send question")}>
                <ArrowUp className="size-4" />
              </Button>
            )}
          </form>
          <p className="mt-2 text-[11px] text-slate-500">{t("Answers come from stored data; check them before acting.")}</p>
        </footer>
      </aside>
    </div>
  );
};
