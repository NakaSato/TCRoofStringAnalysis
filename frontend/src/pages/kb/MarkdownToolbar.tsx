/** Editor toolbar: buttons that insert Markdown into the textarea (heading, bold, list, numbered
 * steps, table, link, a "⚠️" warning callout). Uses `insertText` where the browser has it, so the
 * textarea's own undo keeps working; otherwise sets the value. */
import React from "react";
import { AlertTriangle, Bold, Heading2, Link2, List, ListOrdered, Table } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useI18n } from "../../i18n";

type Edit = { from: number; to: number; text: string; selStart: number; selEnd: number };
export type MdAction = "heading" | "bold" | "list" | "steps" | "table" | "link" | "warning";

const lineRange = (v: string, s: number, e: number) => {
  const from = v.lastIndexOf("\n", s - 1) + 1;
  const end = e > s && v[e - 1] === "\n" ? e - 1 : e;
  const nl = v.indexOf("\n", end);
  return { from, to: nl === -1 ? v.length : nl };
};

const prefixLines = (v: string, s: number, e: number, prefix: (i: number, line: string) => string): Edit => {
  const { from, to } = lineRange(v, s, e);
  const text = v
    .slice(from, to)
    .split("\n")
    .map((l, i) => prefix(i, l))
    .join("\n");
  return { from, to, text, selStart: s === e ? text.length : 0, selEnd: text.length };
};

/** a block on lines of its own: a blank line before (unless at the top) and after */
const block = (v: string, s: number, e: number, body: string): Edit => {
  const before = s === 0 ? "" : v.slice(Math.max(0, s - 2), s) === "\n\n" ? "" : v[s - 1] === "\n" ? "\n" : "\n\n";
  const after = v.slice(e, e + 1) === "\n" ? "\n" : "\n\n";
  const text = before + body + after;
  return { from: s, to: e, text, selStart: before.length, selEnd: before.length + body.length };
};

/** the edit an action makes for the selection `s`–`e` of `v` */
export const mdEdit = (action: MdAction, v: string, s: number, e: number): Edit => {
  const sel = v.slice(s, e);
  switch (action) {
    case "bold":
      // no placeholder word: the article's language is the author's
      return { from: s, to: e, text: `**${sel}**`, selStart: 2, selEnd: 2 + sel.length };
    case "link": {
      const text = `[${sel}](https://)`;
      // with a label, select the address to type over; without one, the cursor goes into the label
      return sel ? { from: s, to: e, text, selStart: sel.length + 3, selEnd: text.length - 1 } : { from: s, to: e, text, selStart: 1, selEnd: 1 };
    }
    case "heading":
      return prefixLines(v, s, e, (_i, l) => `## ${l.replace(/^#{1,6}\s*/, "")}`);
    case "list":
      return prefixLines(v, s, e, (_i, l) => `- ${l.replace(/^\s*(?:[-*+]|\d+\.)\s+/, "")}`);
    case "steps":
      return prefixLines(v, s, e, (i, l) => `${i + 1}. ${l.replace(/^\s*(?:[-*+]|\d+\.)\s+/, "")}`);
    case "warning":
      return prefixLines(v, s, e, (i, l) => (i === 0 ? `> ⚠️ ${l.replace(/^>\s*(?:⚠️\s*)?/, "")}` : `> ${l.replace(/^>\s*/, "")}`));
    case "table":
      return block(v, s, e, "| Column 1 | Column 2 |\n| --- | --- |\n|  |  |");
  }
};

/** apply an edit to the textarea; `setValue` is the fallback when `insertText` is unavailable */
export const applyEdit = (ta: HTMLTextAreaElement, edit: Edit, setValue: (v: string) => void) => {
  ta.focus();
  ta.setSelectionRange(edit.from, edit.to);
  let done = false;
  try {
    done = document.execCommand("insertText", false, edit.text);
  } catch {
    done = false;
  }
  if (!done || ta.value.slice(edit.from, edit.from + edit.text.length) !== edit.text) {
    const v = ta.value;
    setValue(v.slice(0, edit.from) + edit.text + v.slice(edit.to));
  }
  requestAnimationFrame(() => {
    ta.focus();
    ta.setSelectionRange(edit.from + edit.selStart, edit.from + edit.selEnd);
  });
};

const ACTIONS: { action: MdAction; label: string; icon: LucideIcon; keys?: string }[] = [
  { action: "heading", label: "Heading", icon: Heading2 },
  { action: "bold", label: "Bold", icon: Bold, keys: "Ctrl/⌘ B" },
  { action: "list", label: "List", icon: List },
  { action: "steps", label: "Numbered steps", icon: ListOrdered },
  { action: "table", label: "Table", icon: Table },
  { action: "link", label: "Link", icon: Link2 },
  { action: "warning", label: "Warning callout", icon: AlertTriangle },
];

export const MarkdownToolbar: React.FC<{ onAction: (a: MdAction) => void; disabled?: boolean }> = ({ onAction, disabled }) => {
  const { t } = useI18n();
  return (
    <div className="flex flex-wrap items-center gap-0.5" role="toolbar" aria-label={t("Formatting")}>
      {ACTIONS.map(({ action, label, icon: Icon, keys }) => (
        <Tooltip key={action}>
          <TooltipTrigger asChild>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label={t(label)}
              disabled={disabled}
              // keep the textarea's selection: the button must not take focus on press
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onAction(action)}
            >
              <Icon className={action === "warning" ? "text-amber-300" : undefined} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {t(label)}
            {keys && <span className="num ml-2 text-muted-foreground">{keys}</span>}
          </TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
};
