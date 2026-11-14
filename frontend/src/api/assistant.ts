/**
 * Streaming client of `POST /assistant/chat` (server-sent events). EventSource can't POST or send
 * the JWT header, so this reads the `fetch` body stream. Abort with the signal to stop an answer.
 *
 * In production the chat goes straight to Cloud Run (`VITE_ASSISTANT_API_BASE_URL`, set by
 * `deploy/gcp.sh frontend`): Firebase Hosting's `/api` rewrite holds the stream until it ends and
 * cuts requests at 60 s. Cloud Run allows the app's origin (CORS_ORIGINS). Empty = same as the API.
 */
import { API_BASE, ApiError, AUTH_EXPIRED_EVENT, clearAuthSession, getStoredToken } from "./client";
import type { AssistantChatRequest, AssistantEvent } from "./types/assistant";

const CHAT_BASE = import.meta.env.VITE_ASSISTANT_API_BASE_URL || API_BASE;
const EVENTS = new Set(["text", "tool", "error", "done"]);

function parseBlock(block: string): AssistantEvent | null {
  let name = "message";
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) name = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  if (!EVENTS.has(name) || !data.length) return null;
  try {
    return { event: name, data: JSON.parse(data.join("\n")) } as AssistantEvent;
  } catch {
    return null;
  }
}

/** Send the thread and call `onEvent` for each event until the stream ends. Throws `ApiError` when
 * the request is refused before streaming (403 role, 429 budget / daily limit, 503 not configured). */
export async function streamAssistantChat(
  body: AssistantChatRequest,
  onEvent: (ev: AssistantEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  const token = getStoredToken();
  const res = await fetch(`${CHAT_BASE}/assistant/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal,
  });
  if (res.status === 401) {
    clearAuthSession();
    window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT));
  }
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const j = await res.json();
      if (typeof j.detail === "string") detail = j.detail;
    } catch {
      /* not JSON */
    }
    throw new ApiError(detail, res.status);
  }
  if (!res.body || !(res.headers.get("Content-Type") || "").includes("event-stream")) {
    throw new Error("The API server is not reachable. Please try again later or contact your administrator.");
  }

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value.replace(/\r\n/g, "\n");
    let cut: number;
    while ((cut = buf.indexOf("\n\n")) >= 0) {
      const ev = parseBlock(buf.slice(0, cut));
      buf = buf.slice(cut + 2);
      if (ev) onEvent(ev);
    }
  }
  const tail = parseBlock(buf.trim());
  if (tail) onEvent(tail);
}
