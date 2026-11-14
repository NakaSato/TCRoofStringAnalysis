/**
 * The assistant's thread: kept in this tab's sessionStorage per user (never on the server; the
 * backend stores only token counts), streamed turn by turn from `POST /assistant/chat`.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { streamAssistantChat } from "../../api/assistant";
import { ApiError } from "../../api/client";
import type { AssistantChatMessage, AssistantPageContext } from "../../api/client";

export interface ToolStep {
  name: string;
  status: "running" | "done" | "error";
}

export type Turn =
  | { id: string; role: "user"; content: string }
  | {
      id: string;
      role: "assistant";
      /** text the model wrote before a data lookup ("let me check…"): shown dimmed, not resent */
      notes: string[];
      /** text after the last lookup: the answer */
      answer: string;
      tools: ToolStep[];
      status: "streaming" | "done" | "stopped" | "failed";
      error?: string;
    };

const KEY_PREFIX = "tcroof.assistant.";
const MAX_STORED_TURNS = 60;

/** Drop every stored thread (logout: the next user must not see it). */
export function clearAssistantThreads(): void {
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const k = sessionStorage.key(i);
      if (k?.startsWith(KEY_PREFIX)) sessionStorage.removeItem(k);
    }
  } catch {
    /* storage blocked: nothing was stored */
  }
}

function load(key: string): Turn[] {
  try {
    const raw = sessionStorage.getItem(key);
    const turns = raw ? (JSON.parse(raw) as Turn[]) : [];
    // a turn still "streaming" was cut off by a reload
    return Array.isArray(turns)
      ? turns.map((t) => (t.role === "assistant" && t.status === "streaming" ? { ...t, status: "stopped" as const } : t))
      : [];
  } catch {
    return [];
  }
}

function save(key: string, turns: Turn[]): void {
  try {
    if (turns.length) sessionStorage.setItem(key, JSON.stringify(turns.slice(-MAX_STORED_TURNS)));
    else sessionStorage.removeItem(key);
  } catch {
    /* storage blocked or full: the thread lasts while the drawer is mounted */
  }
}

/** Only answered questions go back to the model: a failed or stopped turn drops with its question. */
function toMessages(turns: Turn[]): AssistantChatMessage[] {
  const out: AssistantChatMessage[] = [];
  for (let i = 0; i + 1 < turns.length; i++) {
    const q = turns[i];
    const a = turns[i + 1];
    if (q.role === "user" && a.role === "assistant" && a.status === "done" && a.answer.trim()) {
      out.push({ role: "user", content: q.content }, { role: "assistant", content: a.answer.trim() });
      i++;
    }
  }
  return out;
}

const newId = () => Math.random().toString(36).slice(2, 10);

export function useAssistantChat(userId: number | null) {
  const key = `${KEY_PREFIX}${userId ?? "anon"}`;
  const [turns, setTurns] = useState<Turn[]>(() => load(key));
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setTurns(load(key));
  }, [key]);

  useEffect(() => {
    if (!busy) save(key, turns);
  }, [key, turns, busy]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const patchLast = useCallback((fn: (t: Extract<Turn, { role: "assistant" }>) => Extract<Turn, { role: "assistant" }>) => {
    setTurns((prev) => {
      const last = prev[prev.length - 1];
      if (!last || last.role !== "assistant") return prev;
      return [...prev.slice(0, -1), fn(last)];
    });
  }, []);

  const send = useCallback(
    async (question: string, context: AssistantPageContext | null) => {
      const q = question.trim();
      if (!q || busy) return;
      const history = toMessages(turns);
      setTurns((prev) => [
        ...prev,
        { id: newId(), role: "user", content: q },
        { id: newId(), role: "assistant", notes: [], answer: "", tools: [], status: "streaming" },
      ]);
      setBusy(true);
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      let ended = false;
      try {
        await streamAssistantChat(
          { messages: [...history, { role: "user", content: q }], context },
          (ev) => {
            if (ev.event === "text") patchLast((t) => ({ ...t, answer: t.answer + ev.data.text }));
            else if (ev.event === "tool")
              patchLast((t) => {
                if (ev.data.status === "running") {
                  const notes = t.answer.trim() ? [...t.notes, t.answer.trim()] : t.notes;
                  return { ...t, notes, answer: "", tools: [...t.tools, { name: ev.data.name, status: "running" }] };
                }
                const tools = [...t.tools];
                const i = tools.map((s) => s.name).lastIndexOf(ev.data.name);
                if (i >= 0) tools[i] = { name: ev.data.name, status: ev.data.status };
                return { ...t, tools };
              });
            else if (ev.event === "error") patchLast((t) => ({ ...t, error: ev.data.message }));
            else if (ev.event === "done") {
              ended = true;
              patchLast((t) => ({ ...t, status: ev.data.status === "ok" && !t.error ? "done" : "failed" }));
            }
          },
          ctrl.signal
        );
        if (!ended) patchLast((t) => ({ ...t, status: "failed", error: t.error ?? "The answer stopped before it finished. Try again." }));
      } catch (e) {
        if (ctrl.signal.aborted) patchLast((t) => ({ ...t, status: "stopped" }));
        else {
          const msg =
            e instanceof ApiError ? e.message : "Can't reach the assistant. Check your connection and try again.";
          patchLast((t) => ({ ...t, status: "failed", error: msg }));
        }
      } finally {
        abortRef.current = null;
        setBusy(false);
      }
    },
    [busy, turns, patchLast]
  );

  const stop = useCallback(() => abortRef.current?.abort(), []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setTurns([]);
    save(key, []);
  }, [key]);

  return { turns, busy, send, stop, reset };
}
