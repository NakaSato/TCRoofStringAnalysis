/**
 * An article's Markdown body: react-markdown + GFM (tables, task lists, strikethrough) +
 * rehype-sanitize with its default (GitHub) schema. No rehype-raw, so raw HTML in the text is never
 * rendered. Links go through `appHref()`: app paths use the router, http(s) opens a new tab,
 * anything else is plain text. Images are not part of phase 1: an image is shown as its alt text
 * (nothing is loaded from outside).
 */
import React from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import { Link } from "react-router-dom";
import { ImageOff } from "lucide-react";
import { appHref } from "../../components/assistant/Markdown";
import { cn } from "@/lib/utils";
import { useI18n } from "../../i18n";

const LINK = "text-solar-300 underline decoration-solar-400/40 underline-offset-2 hover:text-solar-200 break-words";

/** text of a node's children, to spot the "⚠️" warning callout */
const textOf = (node: React.ReactNode): string => {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (React.isValidElement<{ children?: React.ReactNode }>(node)) return textOf(node.props.children);
  return "";
};

const ImagePlaceholder: React.FC<{ alt?: string }> = ({ alt }) => {
  const { t } = useI18n();
  return (
    <span className="inline-flex items-center gap-1 rounded border border-dashed border-white/15 px-1.5 py-0.5 text-xs text-muted-foreground" title={t("Images are not shown yet")}>
      <ImageOff className="size-3" aria-hidden />
      {alt || t("Image")}
    </span>
  );
};

const components: Components = {
  h1: ({ node: _n, ...p }) => <h1 className="mt-6 mb-3 text-xl font-semibold text-slate-100 first:mt-0" {...p} />,
  h2: ({ node: _n, ...p }) => <h2 className="mt-6 mb-2 border-b border-white/[0.07] pb-1 text-lg font-semibold text-slate-100 first:mt-0" {...p} />,
  h3: ({ node: _n, ...p }) => <h3 className="mt-5 mb-2 text-base font-semibold text-slate-100 first:mt-0" {...p} />,
  h4: ({ node: _n, ...p }) => <h4 className="mt-4 mb-1.5 text-sm font-semibold text-slate-200" {...p} />,
  h5: ({ node: _n, ...p }) => <h5 className="mt-4 mb-1 text-sm font-semibold text-slate-300" {...p} />,
  h6: ({ node: _n, ...p }) => <h6 className="mt-4 mb-1 text-xs font-semibold uppercase text-slate-400" {...p} />,
  p: ({ node: _n, ...p }) => <p className="my-2.5 leading-relaxed" {...p} />,
  ul: ({ node: _n, className, ...p }) => (
    <ul className={cn("my-2.5 space-y-1 pl-5", className?.includes("contains-task-list") ? "list-none pl-1" : "list-disc", className)} {...p} />
  ),
  ol: ({ node: _n, className, ...p }) => <ol className={cn("my-2.5 list-decimal space-y-1 pl-5 marker:text-slate-500", className)} {...p} />,
  li: ({ node: _n, ...p }) => <li className="leading-relaxed [&>input]:mr-1.5 [&>input]:align-middle" {...p} />,
  strong: ({ node: _n, ...p }) => <strong className="font-semibold text-slate-100" {...p} />,
  hr: () => <hr className="my-5 border-white/[0.08]" />,
  blockquote: ({ node: _n, children, ...p }) => {
    const warn = textOf(children).trimStart().startsWith("⚠");
    return (
      <blockquote
        className={cn(
          "my-3 rounded-r-md border-l-4 px-3 py-1",
          warn ? "border-amber-400/70 bg-amber-400/[0.07] text-amber-100" : "border-white/15 bg-white/[0.03] text-slate-300"
        )}
        {...p}
      >
        {children}
      </blockquote>
    );
  },
  code: ({ node: _n, className, ...p }) => (
    <code className={cn(className ? "" : "num rounded bg-white/[0.06] px-1 py-px text-[0.92em] text-solar-200", className)} {...p} />
  ),
  pre: ({ node: _n, ...p }) => <pre className="num my-3 overflow-x-auto rounded-lg border border-white/[0.07] bg-ink-950/70 p-3 text-xs leading-relaxed" {...p} />,
  table: ({ node: _n, ...p }) => (
    <div className="table-wrap my-3 overflow-x-auto rounded-lg border border-white/[0.07]">
      <table className="w-full border-collapse text-sm" {...p} />
    </div>
  ),
  thead: ({ node: _n, ...p }) => <thead className="bg-white/[0.04]" {...p} />,
  th: ({ node: _n, style, ...p }) => <th className="border-b border-white/[0.08] px-3 py-2 text-left text-xs font-semibold text-slate-300" style={style} {...p} />,
  td: ({ node: _n, style, ...p }) => <td className="border-b border-white/[0.05] px-3 py-2 align-top" style={style} {...p} />,
  a: ({ node: _n, href, children }) => {
    const h = href ?? "";
    // in-page anchors (footnotes; sanitize prefixes their ids with "user-content-")
    if (h.startsWith("#")) return <a href={h} className={LINK}>{children}</a>;
    const target = appHref(h);
    if (!target) return <span>{children}</span>;
    if (target.internal)
      return (
        <Link to={target.to} className={LINK}>
          {children}
        </Link>
      );
    return (
      <a href={target.to} target="_blank" rel="noopener noreferrer" className={LINK}>
        {children}
      </a>
    );
  },
  img: ({ alt }) => <ImagePlaceholder alt={alt} />,
};

export const ArticleBody: React.FC<{ markdown: string; className?: string }> = ({ markdown, className }) => (
  <div className={cn("min-w-0 text-sm text-slate-300 break-words", className)}>
    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]} components={components}>
      {markdown}
    </ReactMarkdown>
  </div>
);
