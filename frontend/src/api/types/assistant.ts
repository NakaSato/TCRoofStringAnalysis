/** AI Assistant (`/assistant/*`, docs/plans/ai-assistant.md). */

export interface AssistantStatus {
  /** false = no key on the backend or the user's role is not enabled: hide the button */
  enabled: boolean;
  model: string;
}

export interface AssistantChatMessage {
  role: "user" | "assistant";
  content: string;
}

/** What the user is looking at; the backend names the plant only when the user may see it. */
export interface AssistantPageContext {
  plant_id?: number | null;
  page?: string | null;
  /** YYYY-MM-DD */
  day?: string | null;
}

export interface AssistantChatRequest {
  messages: AssistantChatMessage[];
  context?: AssistantPageContext | null;
}

export type AssistantErrorCode =
  | "timeout"
  | "too_many_steps"
  | "truncated"
  | "refused"
  | "not_configured"
  | "busy"
  | "provider_error"
  | "unreachable";

export interface AssistantDone {
  answer: string;
  status: "ok" | "refused" | "error" | "timeout" | "cancelled";
  rounds: number;
  tools: string[];
  usage: { input_tokens: number; cached_tokens: number; output_tokens: number };
}

/** One server-sent event of `POST /assistant/chat`. */
export type AssistantEvent =
  | { event: "text"; data: { text: string } }
  | { event: "tool"; data: { name: string; status: "running" | "done" | "error" } }
  | { event: "error"; data: { code: AssistantErrorCode; message: string } }
  | { event: "done"; data: AssistantDone };
