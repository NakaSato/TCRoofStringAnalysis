/**
 * The small Markdown subset the assistant writes: paragraphs, `#` headings, `-` / `1.` lists,
 * pipe tables, **bold**, *italic*, `code` and [links](...). Built as React elements (never HTML
 * strings), so model text can't inject markup. App links (`/plant/<id>…`) use the router;
 * http(s) links open in a new tab; anything else renders as plain text.
 */
import React from "react";
import { Link } from "react-router-dom";

/** `/plant/123`, `plant/123/strings` → an app path; null when the target isn't an app or web link. */
export function appHref(href: string): { internal: boolean; to: string } | null {
  const h = href.trim();
  const plant = /^\/?(plant\/\d+(?:\/[\w-]+)?\/?(?:\?[^\s]*)?)$/.exec(h);
  if (plant) return { internal: true, to: `/${plant[1]}` };
  if (/^\/(?!\/)[\w\-/?=&.%]*$/.test(h)) return { internal: true, to: h };
  if (/^https?:\/\//i.test(h)) return { internal: false, to: h };
  return null;
}

const INLINE = /(\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|(?<![\w*])\*([^*\n]+)\*(?!\w))/g;

function inline(text: string, onNavigate?: () => void): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let last = 0;
  let k = 0;
  for (const m of text.matchAll(INLINE)) {
    const i = m.index ?? 0;
    if (i > last) out.push(text.slice(last, i));
    if (m[2] != null) out.push(<strong key={k++} className="font-semibold text-slate-100">{inline(m[2], onNavigate)}</strong>);
    else if (m[3] != null) out.push(<code key={k++} className="num rounded bg-white/[0.06] px-1 py-px text-[0.95em] text-solar-200">{m[3]}</code>);
    else if (m[4] != null) {
      const target = appHref(m[5]);
      if (!target) out.push(m[4]);
      else if (target.internal)
        out.push(
          <Link key={k++} to={target.to} onClick={onNavigate} className="text-solar-300 underline decoration-solar-400/40 underline-offset-2 hover:text-solar-200">
            {m[4]}
          </Link>
        );
      else
        out.push(
          <a key={k++} href={target.to} target="_blank" rel="noopener noreferrer" className="text-solar-300 underline decoration-solar-400/40 underline-offset-2 hover:text-solar-200">
            {m[4]}
          </a>
        );
    } else if (m[6] != null) out.push(<em key={k++}>{m[6]}</em>);
    last = i + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

type Block =
  | { kind: "h"; level: number; text: string }
  | { kind: "p"; text: string }
  | { kind: "ul" | "ol"; items: string[] }
  | { kind: "table"; head: string[]; rows: string[][] }
  | { kind: "code"; text: string };

const cells = (line: string) =>
  line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

function parse(src: string): Block[] {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    if (line.trim().startsWith("```")) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) body.push(lines[i++]);
      i++;
      blocks.push({ kind: "code", text: body.join("\n") });
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      blocks.push({ kind: "h", level: h[1].length, text: h[2] });
      i++;
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
      blocks.push({ kind: "table", head, rows });
      continue;
    }
    const ul = /^\s*[-*•]\s+/;
    const ol = /^\s*\d+[.)]\s+/;
    if (ul.test(line) || ol.test(line)) {
      const kind = ul.test(line) ? "ul" : "ol";
      const re = kind === "ul" ? ul : ol;
      const items: string[] = [];
      while (i < lines.length && (re.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
        if (re.test(lines[i])) items.push(lines[i].replace(re, ""));
        else items[items.length - 1] += " " + lines[i].trim();
        i++;
      }
      blocks.push({ kind, items });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|\s*[-*•]\s|\s*\d+[.)]\s|```|\s*\|)/.test(lines[i])) para.push(lines[i++]);
    if (!para.length) para.push(lines[i++]);
    blocks.push({ kind: "p", text: para.join("\n") });
  }
  return blocks;
}

export const Markdown: React.FC<{ text: string; onNavigate?: () => void }> = ({ text, onNavigate }) => {
  const blocks = React.useMemo(() => parse(text), [text]);
  return (
    <div className="space-y-2 text-[13px] leading-relaxed text-slate-200">
      {blocks.map((b, i) => {
        switch (b.kind) {
          case "h":
            return (
              <div key={i} className={b.level <= 2 ? "pt-1 text-sm font-semibold text-slate-100" : "pt-1 font-semibold text-slate-100"}>
                {inline(b.text, onNavigate)}
              </div>
            );
          case "ul":
          case "ol": {
            const List = b.kind === "ul" ? "ul" : "ol";
            return (
              <List key={i} className={`space-y-1 pl-5 ${b.kind === "ul" ? "list-disc" : "list-decimal"} marker:text-slate-500`}>
                {b.items.map((it, j) => (
                  <li key={j}>{inline(it, onNavigate)}</li>
                ))}
              </List>
            );
          }
          case "table":
            return (
              <div key={i} className="overflow-x-auto rounded-lg border border-white/[0.07]">
                <table className="w-full text-xs">
                  <thead className="bg-white/[0.03] text-slate-400">
                    <tr>
                      {b.head.map((c, j) => (
                        <th key={j} className="px-2 py-1.5 text-left font-medium">{inline(c, onNavigate)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r, j) => (
                      <tr key={j} className="border-t border-white/[0.05]">
                        {r.map((c, n) => (
                          <td key={n} className="num px-2 py-1.5">{inline(c, onNavigate)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case "code":
            return (
              <pre key={i} className="num overflow-x-auto rounded-lg bg-ink-950/70 p-2 text-xs text-slate-300">
                {b.text}
              </pre>
            );
          default:
            return (
              <p key={i} className="whitespace-pre-line">
                {inline(b.text, onNavigate)}
              </p>
            );
        }
      })}
    </div>
  );
};
