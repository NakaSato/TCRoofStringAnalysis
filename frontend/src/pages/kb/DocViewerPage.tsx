/**
 * Knowledge Base PDF viewer (`/kb/doc/:docId/view`, spec §5.2, view mode): the stored file as it
 * was uploaded, never changed. pdf.js renders only the pages near the screen (canvas + text layer
 * for selection, find and screen readers) and frees the others. The page stays white (paper) in
 * the dark theme; only the chrome is dark.
 *
 * URL: `page` (1-based; deep link and QR target), `rev` (an older revision, read only, with a
 * banner), `q` (words to highlight, e.g. from the search results).
 * Keys: ← / → or PageUp / PageDown page, + / − zoom, 0 fit width, Ctrl/⌘ + F find.
 */
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, ChevronLeft, ChevronRight, Download, FileText, Info, Link2, ListTree, Maximize2, Minus, Plus, Search, X } from "lucide-react";
import type { KbDocDetail } from "../../api/client";
import { api } from "../../api/client";
import { useI18n } from "../../i18n";
import { useUrlState } from "@/lib/useUrlState";
import { cn } from "@/lib/utils";
import { notify } from "@/lib/notify";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { EmptyState, LoadingState } from "../../components/ui";
import { DocStatusBadge, TEXT_STATUS, docPath, docTitle, faultLabel, fileHref, fmtBytes, revText } from "./docFormat";
import { useLoad } from "./useDocs";
import { errText } from "./format";
import { openPdf, pdfjs } from "./pdf";
import type { PDFDocumentProxy } from "./pdf";
import "./pdfViewer.css";

const ZOOMS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 3];
/** pages rendered while within this distance of the screen; the rest are freed */
const RENDER_MARGIN = "1200px 0px";
const THUMB_W = 96;

type Zoom = "fit" | number;
interface Size {
  w: number;
  h: number;
}

const pickInt = (v: string | null, min: number, max = Number.MAX_SAFE_INTEGER): number | null => {
  if (v == null || !/^\d{1,6}$/.test(v)) return null;
  const n = Number(v);
  return n >= min && n <= max ? n : null;
};

const isCancel = (e: unknown) => e instanceof pdfjs.RenderingCancelledException || (e as { name?: string })?.name === "RenderingCancelledException";

/** words to highlight: the search words (lower case), at least 2 characters */
const hitWords = (q: string) => [...new Set(q.toLowerCase().split(/\s+/).filter((w) => w.length >= 2))];

// --------------------------------------------------------------------------- one page

interface PageProps {
  pdf: PDFDocumentProxy;
  n: number;
  scale: number;
  size: Size;
  render: boolean;
  words: string[];
  current: boolean;
  onSize: (n: number, s: Size) => void;
  register: (n: number, el: HTMLDivElement | null) => void;
  label: string;
}

const PdfPage = memo(function PdfPage({ pdf, n, scale, size, render, words, current, onSize, register, label }: PageProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">("idle");

  useEffect(() => {
    if (!render) return;
    let cancelled = false;
    let task: { cancel: () => void; promise: Promise<unknown> } | null = null;
    let layer: InstanceType<typeof pdfjs.TextLayer> | null = null;
    setState("busy");
    (async () => {
      const page = await pdf.getPage(n);
      if (cancelled) return;
      const base = page.getViewport({ scale: 1 });
      onSize(n, { w: base.width, h: base.height });
      const vp = page.getViewport({ scale });
      const canvas = canvasRef.current;
      const text = textRef.current;
      if (!canvas || !text) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(vp.width * dpr);
      canvas.height = Math.floor(vp.height * dpr);
      canvas.style.width = `${Math.floor(vp.width)}px`;
      canvas.style.height = `${Math.floor(vp.height)}px`;
      task = page.render({ canvas, viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined });
      await task.promise;
      if (cancelled) return;
      const content = await page.getTextContent();
      if (cancelled) return;
      text.replaceChildren();
      layer = new pdfjs.TextLayer({ textContentSource: content, container: text, viewport: vp });
      await layer.render();
      if (!cancelled) setState("done");
    })().catch((e) => {
      if (!cancelled && !isCancel(e)) setState("error");
    });
    return () => {
      cancelled = true;
      task?.cancel();
      layer?.cancel();
      // free the page's memory when it leaves the screen (or before a re-render at a new zoom)
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
      }
      textRef.current?.replaceChildren();
    };
  }, [pdf, n, scale, render, onSize]);

  // highlight the search / find words on the rendered text layer
  useEffect(() => {
    const el = textRef.current;
    if (!el || state !== "done") return;
    el.querySelectorAll("span.kb-hit").forEach((s) => s.classList.remove("kb-hit", "kb-hit-current"));
    if (words.length === 0) return;
    el.querySelectorAll<HTMLSpanElement>("span").forEach((s) => {
      const t = (s.textContent ?? "").toLowerCase();
      if (t && words.some((w) => t.includes(w))) s.classList.add("kb-hit");
    });
  }, [words, state]);

  const w = Math.floor(size.w * scale);
  const h = Math.floor(size.h * scale);
  return (
    <div
      ref={(el) => register(n, el)}
      data-page={n}
      role="region"
      aria-label={label}
      className={cn("kb-page relative mx-auto shrink-0 bg-white shadow-lg shadow-black/40 ring-1", current ? "ring-solar-400/60" : "ring-black/20")}
      style={{ width: w, height: h, ["--total-scale-factor" as string]: scale } as React.CSSProperties}
    >
      <canvas ref={canvasRef} className="absolute inset-0 block" aria-hidden />
      <div ref={textRef} className="textLayer" />
      {state !== "done" && render && (
        <div className="absolute inset-0 grid place-items-center text-slate-400">
          {state === "error" ? <FileText className="size-6" aria-hidden /> : <Spinner className="size-5 text-slate-400" />}
        </div>
      )}
    </div>
  );
});

// --------------------------------------------------------------------------- thumbnails

const Thumb = memo(function Thumb({ pdf, n, size, active, onPick }: { pdf: PDFDocumentProxy; n: number; size: Size; active: boolean; onPick: (n: number) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLButtonElement>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setNear(e.isIntersecting), { rootMargin: "400px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  useEffect(() => {
    if (!near) return;
    let cancelled = false;
    let task: { cancel: () => void; promise: Promise<unknown> } | null = null;
    pdf
      .getPage(n)
      .then((page) => {
        if (cancelled || !ref.current) return;
        const vp = page.getViewport({ scale: (THUMB_W * Math.min(window.devicePixelRatio || 1, 2)) / page.getViewport({ scale: 1 }).width });
        ref.current.width = Math.floor(vp.width);
        ref.current.height = Math.floor(vp.height);
        task = page.render({ canvas: ref.current, viewport: vp });
        return task.promise;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [pdf, n, near]);
  const h = Math.round((THUMB_W * size.h) / size.w);
  return (
    <button
      ref={box}
      type="button"
      onClick={() => onPick(n)}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group flex flex-col items-center gap-1 rounded-md p-1.5 outline-none focus-visible:ring-2 focus-visible:ring-solar-400",
        active ? "bg-solar-400/10" : "hover:bg-white/5"
      )}
    >
      <canvas ref={ref} className={cn("block bg-white ring-1", active ? "ring-solar-400" : "ring-black/30")} style={{ width: THUMB_W, height: h }} aria-hidden />
      <span className={cn("num text-[10px]", active ? "text-solar-200" : "text-slate-500")}>{n}</span>
    </button>
  );
});

// --------------------------------------------------------------------------- outline / find

interface OutlineItem {
  title: string;
  dest: string | unknown[] | null;
  items: OutlineItem[];
}

const OutlineTree: React.FC<{ items: OutlineItem[]; onPick: (dest: OutlineItem["dest"]) => void; depth?: number }> = ({ items, onPick, depth = 0 }) => (
  <ul className={cn("flex flex-col", depth > 0 && "ml-3 border-l border-white/[0.06] pl-2")}>
    {items.map((it, i) => (
      <li key={`${depth}-${i}`}>
        <button
          type="button"
          onClick={() => onPick(it.dest)}
          disabled={it.dest == null}
          className="w-full rounded px-1.5 py-1 text-left text-xs text-slate-300 hover:bg-white/5 hover:text-slate-100 disabled:cursor-default disabled:text-slate-500"
        >
          {it.title}
        </button>
        {it.items?.length > 0 && <OutlineTree items={it.items} onPick={onPick} depth={depth + 1} />}
      </li>
    ))}
  </ul>
);

interface FindHit {
  page: number;
  count: number;
  snippet: string;
}

// --------------------------------------------------------------------------- page

export const KbDocViewerPage: React.FC = () => {
  const { t, lang } = useI18n();
  const navigate = useNavigate();
  const { docId } = useParams();
  const id = docId && /^\d+$/.test(docId) ? Number(docId) : null;
  const [url, setUrl] = useUrlState();
  const rev = pickInt(url.get("rev"), 1);
  const qWords = url.get("q") ?? "";

  const doc = useLoad<KbDocDetail>(id != null ? `doc:${id}` : null, () => api.getKbDoc(id!), { keepOnKeyChange: false });
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [baseSize, setBaseSize] = useState<Size | null>(null);
  const [sizes, setSizes] = useState<Record<number, Size>>({});

  // the file: a short-lived signed link, opened with range requests
  useEffect(() => {
    if (id == null) return;
    let cancelled = false;
    let task: ReturnType<typeof openPdf> | null = null;
    setPdf(null);
    setPdfError(null);
    setBaseSize(null);
    setSizes({});
    api
      .getKbDocFile(id, { rev })
      .then(async (link) => {
        if (cancelled) return;
        task = openPdf(fileHref(link));
        const p = await task.promise;
        if (cancelled) return;
        const first = await p.getPage(1);
        const vp = first.getViewport({ scale: 1 });
        if (cancelled) return;
        setBaseSize({ w: vp.width, h: vp.height });
        setPdf(p);
      })
      .catch((e) => {
        if (!cancelled) setPdfError(errText(e));
      });
    return () => {
      cancelled = true;
      void task?.destroy();
    };
  }, [id, rev]);

  const numPages = pdf?.numPages ?? 0;
  const pageParam = pickInt(url.get("page"), 1) ?? 1;

  // ---- zoom
  const [zoom, setZoom] = useState<Zoom>("fit");
  const scroller = useRef<HTMLDivElement>(null);
  const [boxWidth, setBoxWidth] = useState(0);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setBoxWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, [pdf]);
  const fitScale = baseSize && boxWidth > 0 ? Math.max(0.25, Math.min(4, (boxWidth - 32) / baseSize.w)) : 1;
  const scale = zoom === "fit" ? fitScale : zoom;
  const zoomBy = useCallback(
    (dir: 1 | -1) =>
      setZoom((z) => {
        const cur = z === "fit" ? fitScale : z;
        const next = dir > 0 ? ZOOMS.find((x) => x > cur + 0.01) : [...ZOOMS].reverse().find((x) => x < cur - 0.01);
        return next ?? cur;
      }),
    [fitScale]
  );

  // ---- which pages are near the screen (rendered) and which one is current
  const els = useRef(new Map<number, HTMLDivElement>());
  const [near, setNear] = useState<Set<number>>(new Set());
  const [current, setCurrent] = useState(1);
  const currentRef = useRef(1);
  const ratios = useRef(new Map<number, number>());
  const nearIo = useRef<IntersectionObserver | null>(null);
  const curIo = useRef<IntersectionObserver | null>(null);

  useEffect(() => {
    const root = scroller.current;
    if (!root || !pdf) return;
    nearIo.current = new IntersectionObserver(
      (entries) =>
        setNear((prev) => {
          const next = new Set(prev);
          for (const e of entries) {
            const n = Number((e.target as HTMLElement).dataset.page);
            if (e.isIntersecting) next.add(n);
            else next.delete(n);
          }
          return next;
        }),
      { root, rootMargin: RENDER_MARGIN }
    );
    curIo.current = new IntersectionObserver(
      (entries) => {
        for (const e of entries) ratios.current.set(Number((e.target as HTMLElement).dataset.page), e.intersectionRatio);
        let best = currentRef.current;
        let bestR = -1;
        ratios.current.forEach((r, n) => {
          if (r > bestR + 0.001 || (Math.abs(r - bestR) <= 0.001 && n < best)) {
            best = n;
            bestR = r;
          }
        });
        if (bestR > 0 && best !== currentRef.current) {
          currentRef.current = best;
          setCurrent(best);
        }
      },
      { root, threshold: [0, 0.1, 0.25, 0.5, 0.75, 1] }
    );
    els.current.forEach((el) => {
      nearIo.current!.observe(el);
      curIo.current!.observe(el);
    });
    return () => {
      nearIo.current?.disconnect();
      curIo.current?.disconnect();
      nearIo.current = null;
      curIo.current = null;
    };
  }, [pdf]);

  const register = useCallback((n: number, el: HTMLDivElement | null) => {
    const prev = els.current.get(n);
    if (prev === el) return;
    if (prev) {
      nearIo.current?.unobserve(prev);
      curIo.current?.unobserve(prev);
    }
    if (el) {
      els.current.set(n, el);
      nearIo.current?.observe(el);
      curIo.current?.observe(el);
    } else els.current.delete(n);
  }, []);

  const onSize = useCallback((n: number, s: Size) => {
    setSizes((prev) => (prev[n] && prev[n].w === s.w && prev[n].h === s.h ? prev : { ...prev, [n]: s }));
  }, []);

  // ---- jump to a page (URL, buttons, outline, links, find)
  const jumpTo = useCallback(
    (n: number, smooth = false) => {
      if (!numPages) return;
      const p = Math.max(1, Math.min(numPages, Math.round(n)));
      currentRef.current = p;
      setCurrent(p);
      els.current.get(p)?.scrollIntoView({ block: "start", behavior: smooth ? "smooth" : "auto" });
      setUrl({ page: p > 1 ? p : null });
    },
    [numPages, setUrl]
  );

  // first open, and a page change from outside (a link to this viewer at another page)
  const opened = useRef<number | null>(null);
  useEffect(() => {
    if (!pdf || !numPages || boxWidth === 0) return;
    if (opened.current !== null && pageParam === currentRef.current) return;
    opened.current = pageParam;
    requestAnimationFrame(() => jumpTo(pageParam));
  }, [pdf, numPages, boxWidth, pageParam, jumpTo]);

  // the current page goes into the URL (replaced, debounced), so a copied link opens it
  useEffect(() => {
    if (!pdf) return;
    const h = window.setTimeout(() => {
      if (current !== pageParam) setUrl({ page: current > 1 ? current : null });
    }, 400);
    return () => window.clearTimeout(h);
  }, [current, pdf, pageParam, setUrl]);

  // keep the current page in view when the zoom changes
  const prevScale = useRef(scale);
  useEffect(() => {
    if (prevScale.current === scale) return;
    prevScale.current = scale;
    els.current.get(currentRef.current)?.scrollIntoView({ block: "start" });
  }, [scale]);

  // ---- outline
  const [outline, setOutline] = useState<OutlineItem[] | null>(null);
  useEffect(() => {
    if (!pdf) return;
    let cancelled = false;
    pdf
      .getOutline()
      .then((o) => !cancelled && setOutline((o as OutlineItem[] | null) ?? []))
      .catch(() => !cancelled && setOutline([]));
    return () => {
      cancelled = true;
    };
  }, [pdf]);
  const goDest = useCallback(
    async (dest: OutlineItem["dest"]) => {
      if (!pdf || dest == null) return;
      try {
        const explicit = typeof dest === "string" ? await pdf.getDestination(dest) : dest;
        if (!explicit || !explicit[0]) return;
        const ref = explicit[0];
        const idx = typeof ref === "number" ? ref : await pdf.getPageIndex(ref as Parameters<PDFDocumentProxy["getPageIndex"]>[0]);
        jumpTo(idx + 1, true);
      } catch {
        /* a broken outline entry: stay */
      }
    },
    [pdf, jumpTo]
  );

  // ---- find (client side, over pdf.js text)
  const [findText, setFindText] = useState(qWords);
  const [findQuery, setFindQuery] = useState(qWords);
  const [hits, setHits] = useState<FindHit[] | null>(null);
  const [finding, setFinding] = useState(false);
  const findRef = useRef<HTMLInputElement>(null);
  const textCache = useRef(new Map<number, string>());
  const [panel, setPanel] = useState<string>(qWords ? "find" : "info");
  useEffect(() => {
    textCache.current = new Map();
  }, [pdf]);
  useEffect(() => {
    if (!pdf || !findQuery.trim()) {
      setHits(null);
      return;
    }
    let cancelled = false;
    const words = hitWords(findQuery);
    setFinding(true);
    (async () => {
      const out: FindHit[] = [];
      for (let n = 1; n <= pdf.numPages; n++) {
        let text = textCache.current.get(n);
        if (text == null) {
          const page = await pdf.getPage(n);
          const tc = await page.getTextContent();
          text = tc.items.map((it) => ("str" in it ? it.str : "")).join(" ").replace(/\s+/g, " ");
          textCache.current.set(n, text);
        }
        if (cancelled) return;
        const low = text.toLowerCase();
        if (words.length && words.every((w) => low.includes(w))) {
          let count = 0;
          for (const w of words) for (let i = low.indexOf(w); i >= 0; i = low.indexOf(w, i + w.length)) count++;
          const at = Math.min(...words.map((w) => low.indexOf(w)));
          const a = Math.max(0, at - 60);
          out.push({ page: n, count, snippet: (a > 0 ? "…" : "") + text.slice(a, at + 100).trim() + (at + 100 < text.length ? "…" : "") });
        }
        if (n % 20 === 0) setHits([...out]);
      }
      if (!cancelled) setHits(out);
    })()
      .catch(() => !cancelled && setHits([]))
      .finally(() => !cancelled && setFinding(false));
    return () => {
      cancelled = true;
    };
  }, [pdf, findQuery]);
  const words = useMemo(() => hitWords(findQuery), [findQuery]);
  const runFind = () => {
    setFindQuery(findText.trim());
    setPanel("find");
  };
  const nextHit = (dir: 1 | -1) => {
    if (!hits || hits.length === 0) return;
    const list = dir > 0 ? hits : [...hits].reverse();
    const h = list.find((x) => (dir > 0 ? x.page > current : x.page < current)) ?? list[0];
    jumpTo(h.page, true);
  };

  // ---- keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setPanel("find");
        requestAnimationFrame(() => findRef.current?.focus());
        return;
      }
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "ArrowRight" || e.key === "PageDown") {
        e.preventDefault();
        jumpTo(currentRef.current + 1);
      } else if (e.key === "ArrowLeft" || e.key === "PageUp") {
        e.preventDefault();
        jumpTo(currentRef.current - 1);
      } else if (e.key === "+" || e.key === "=") zoomBy(1);
      else if (e.key === "-") zoomBy(-1);
      else if (e.key === "0") setZoom("fit");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [jumpTo, zoomBy]);

  // ---- page box input
  const [pageBox, setPageBox] = useState(String(current));
  useEffect(() => setPageBox(String(current)), [current]);

  const download = async () => {
    if (id == null) return;
    try {
      const link = await api.getKbDocFile(id, { rev, download: true });
      const a = document.createElement("a");
      a.href = fileHref(link);
      a.download = link.filename;
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (e) {
      notify("crit", t("Download failed: {error}", { error: errText(e) }));
    }
  };

  if (id == null) return <EmptyState icon={FileText} title={t("Document not found")} />;
  if (doc.error?.status === 404) {
    return (
      <EmptyState
        icon={FileText}
        title={t("Document not found")}
        description={t("It does not exist, it was withdrawn, or it belongs to plants not assigned to you.")}
      />
    );
  }
  const d = doc.data;
  const shownRev = d ? (rev != null ? d.revisions.find((r) => r.rev_no === rev) : d.current_revision) : null;
  const isOldRev = !!(d && rev != null && shownRev && !shownRev.is_current);
  const pages = Array.from({ length: numPages }, (_, i) => i + 1);
  const sizeOf = (n: number): Size => sizes[n] ?? baseSize ?? { w: 595, h: 842 };

  return (
    <div className="-mx-1 flex h-[calc(100dvh-7.5rem)] min-h-[520px] flex-col gap-2 sm:mx-0">
      {/* ---- title bar */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-white/[0.07] bg-ink-900/70 px-2 py-1.5">
        <Button variant="ghost" size="icon-sm" asChild>
          <Link to={docPath(id)} aria-label={t("Back to the document")}>
            <ArrowLeft />
          </Link>
        </Button>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-w-0 items-center gap-2">
            <span className="num shrink-0 text-xs font-semibold text-solar-200">{d?.number ?? "…"}</span>
            <span className="truncate text-sm font-semibold text-slate-100">{d ? docTitle(d, lang) : t("Loading…")}</span>
            {d && <DocStatusBadge status={d.status} />}
          </div>
          <span className="truncate text-[11px] text-muted-foreground">
            {shownRev ? revText(shownRev) : "—"}
            {shownRev && ` · ${t("{n} pages", { n: shownRev.page_count })} · ${fmtBytes(shownRev.bytes)}`}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon-sm" onClick={() => jumpTo(current - 1)} disabled={!numPages || current <= 1} aria-label={t("Previous page")}>
            <ChevronLeft />
          </Button>
          <form
            className="flex items-center gap-1 text-xs text-muted-foreground"
            onSubmit={(e) => {
              e.preventDefault();
              const n = pickInt(pageBox, 1, numPages || 1);
              if (n != null) jumpTo(n);
              else setPageBox(String(current));
            }}
          >
            <Input
              value={pageBox}
              onChange={(e) => setPageBox(e.target.value.replace(/\D/g, "").slice(0, 6))}
              onBlur={() => setPageBox(String(current))}
              inputMode="numeric"
              className="num h-7 w-12 px-1 text-center text-xs"
              aria-label={t("Page")}
            />
            <span className="num">/ {numPages || "—"}</span>
          </form>
          <Button variant="ghost" size="icon-sm" onClick={() => jumpTo(current + 1)} disabled={!numPages || current >= numPages} aria-label={t("Next page")}>
            <ChevronRight />
          </Button>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon-sm" onClick={() => zoomBy(-1)} disabled={!pdf} aria-label={t("Zoom out")}>
            <Minus />
          </Button>
          <span className="num w-11 text-center text-xs text-slate-300">{Math.round(scale * 100)}%</span>
          <Button variant="ghost" size="icon-sm" onClick={() => zoomBy(1)} disabled={!pdf} aria-label={t("Zoom in")}>
            <Plus />
          </Button>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant={zoom === "fit" ? "secondary" : "ghost"} size="icon-sm" onClick={() => setZoom("fit")} disabled={!pdf} aria-label={t("Fit width")}>
                <Maximize2 />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("Fit width")} (0)</TooltipContent>
          </Tooltip>
        </div>
        <Button variant="ghost" size="sm" onClick={() => { setPanel("find"); requestAnimationFrame(() => findRef.current?.focus()); }} disabled={!pdf}>
          <Search data-icon="inline-start" />
          {t("Find")}
        </Button>
        <Button variant="outline" size="sm" onClick={download} disabled={!d}>
          <Download data-icon="inline-start" />
          {t("Download")}
        </Button>
      </div>

      {d?.status === "superseded" && (
        <Alert className="py-2">
          <AlertTitle className="text-xs">{t("Superseded")}</AlertTitle>
          <AlertDescription className="text-xs">
            {d.superseded_by ? (
              <>
                {t("Replaced by {doc}.", { doc: `${d.superseded_by.number} ${d.superseded_by.title}` })}{" "}
                <Link to={docPath(d.superseded_by.id)} className="text-solar-200 underline">{t("Open current")}</Link>
              </>
            ) : (
              t("This document is no longer current.")
            )}
          </AlertDescription>
        </Alert>
      )}
      {isOldRev && d && (
        <Alert className="py-2">
          <AlertTitle className="text-xs">{t("Older revision")}</AlertTitle>
          <AlertDescription className="text-xs">
            {t("You are reading {rev}; the current one is {cur}.", { rev: revText(shownRev), cur: revText(d.current_revision) })}{" "}
            <Button type="button" variant="link" size="xs" className="h-auto rounded-none p-0 align-baseline text-[length:inherit] font-normal text-solar-200 underline" onClick={() => navigate(`/kb/doc/${id}/view`)}>
              {t("Open current")}
            </Button>
          </AlertDescription>
        </Alert>
      )}

      <div className="flex min-h-0 flex-1 gap-2">
        {/* ---- page rail */}
        <nav aria-label={t("Pages")} className="hidden w-[124px] shrink-0 overflow-y-auto rounded-lg border border-white/[0.07] bg-ink-950/60 p-1 lg:block">
          {pdf && baseSize ? (
            <div className="flex flex-col items-center">
              {pages.map((n) => (
                <Thumb key={n} pdf={pdf} n={n} size={sizeOf(n)} active={n === current} onPick={(p) => jumpTo(p, true)} />
              ))}
            </div>
          ) : (
            <div className="grid h-full place-items-center">
              <Spinner className="size-4" />
            </div>
          )}
        </nav>

        {/* ---- pages */}
        <div ref={scroller} className="relative min-w-0 flex-1 overflow-auto rounded-lg border border-white/[0.07] bg-ink-950" tabIndex={-1}>
          {pdfError ? (
            <div className="p-6">
              <Alert variant="destructive">
                <AlertTitle>{t("Could not open the PDF")}</AlertTitle>
                <AlertDescription>{pdfError}</AlertDescription>
              </Alert>
            </div>
          ) : !pdf || !baseSize ? (
            <LoadingState label={t("Opening the document…")} shape="page" />
          ) : (
            <div className="flex min-w-fit flex-col items-center gap-4 px-4 py-4">
              {pages.map((n) => (
                <PdfPage
                  key={n}
                  pdf={pdf}
                  n={n}
                  scale={scale}
                  size={sizeOf(n)}
                  render={near.has(n)}
                  words={words}
                  current={n === current}
                  onSize={onSize}
                  register={register}
                  label={t("Page {n} of {total}", { n, total: numPages })}
                />
              ))}
            </div>
          )}
        </div>

        {/* ---- side panel */}
        <aside className="hidden w-72 shrink-0 flex-col overflow-hidden rounded-lg border border-white/[0.07] bg-ink-900/60 md:flex">
          <Tabs value={panel} onValueChange={setPanel} className="flex min-h-0 flex-1 flex-col gap-0">
            <TabsList variant="line" className="w-full justify-start border-0 border-b border-white/[0.06] px-1">
              <TabsTrigger value="info" aria-label={t("Info")}>
                <Info data-icon="inline-start" />
                {t("Info")}
              </TabsTrigger>
              <TabsTrigger value="outline" aria-label={t("Outline")}>
                <ListTree data-icon="inline-start" />
                {t("Outline")}
              </TabsTrigger>
              <TabsTrigger value="links" aria-label={t("Links")}>
                <Link2 data-icon="inline-start" />
                {t("Links")}
              </TabsTrigger>
              <TabsTrigger value="find" aria-label={t("Find")}>
                <Search />
              </TabsTrigger>
            </TabsList>
            <TabsContent value="info" className="min-h-0 flex-1 overflow-y-auto p-3 text-xs">
              {d && shownRev ? (
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
                  <dt className="text-muted-foreground">{t("Number")}</dt>
                  <dd className="num text-slate-200">{d.number}</dd>
                  <dt className="text-muted-foreground">{t("Revision")}</dt>
                  <dd className="text-slate-200">{revText(shownRev)}</dd>
                  <dt className="text-muted-foreground">{t("Pages")}</dt>
                  <dd className="num text-slate-200">{shownRev.page_count}</dd>
                  <dt className="text-muted-foreground">{t("Text")}</dt>
                  <dd className="text-slate-200" title={t(TEXT_STATUS[shownRev.text_status].hint)}>
                    {t(TEXT_STATUS[shownRev.text_status].label)}
                  </dd>
                  <dt className="text-muted-foreground">{t("File")}</dt>
                  <dd className="break-all text-slate-200">{shownRev.original_name ?? "—"}</dd>
                  <dt className="text-muted-foreground">SHA-256</dt>
                  <dd className="num break-all text-[10px] text-slate-400" title={t("Checksum of the stored file; the original is never changed")}>
                    {shownRev.sha256}
                  </dd>
                </dl>
              ) : (
                <Spinner className="size-4" />
              )}
            </TabsContent>
            <TabsContent value="outline" className="min-h-0 flex-1 overflow-y-auto p-2">
              {outline == null ? (
                <Spinner className="size-4" />
              ) : outline.length === 0 ? (
                <p className="p-1 text-xs text-muted-foreground">{t("The PDF has no outline (bookmarks).")}</p>
              ) : (
                <OutlineTree items={outline} onPick={goDest} />
              )}
            </TabsContent>
            <TabsContent value="links" className="min-h-0 flex-1 overflow-y-auto p-2 text-xs">
              {!d || d.links.length === 0 ? (
                <p className="p-1 text-muted-foreground">{t("No links yet.")}</p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {d.links.map((l, i) => (
                    <li key={i}>
                      <button
                        type="button"
                        disabled={l.page == null}
                        onClick={() => l.page != null && jumpTo(l.page, true)}
                        className="flex w-full items-center justify-between gap-2 rounded px-1.5 py-1 text-left hover:bg-white/5 disabled:cursor-default disabled:hover:bg-transparent"
                      >
                        <span className="min-w-0 truncate text-slate-200">
                          {l.target_type === "fault_code" ? faultLabel(l.target_id) : l.label ?? l.target_id}
                        </span>
                        {l.page != null && <span className="num shrink-0 text-solar-200">{t("p.{n}", { n: l.page })}</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </TabsContent>
            <TabsContent value="find" className="flex min-h-0 flex-1 flex-col">
              <form
                className="flex items-center gap-1 border-b border-white/[0.06] p-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  runFind();
                }}
              >
                <Input
                  ref={findRef}
                  value={findText}
                  onChange={(e) => setFindText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      setFindText("");
                      setFindQuery("");
                    }
                  }}
                  placeholder={t("Find in this document")}
                  className="h-7 text-xs"
                  aria-label={t("Find in this document")}
                />
                {findQuery && (
                  <Button type="button" variant="ghost" size="icon-sm" aria-label={t("Clear")} onClick={() => { setFindText(""); setFindQuery(""); }}>
                    <X />
                  </Button>
                )}
              </form>
              <div className="flex items-center justify-between gap-2 px-2 py-1.5 text-[11px] text-muted-foreground">
                <span>
                  {finding && <Spinner className="mr-1 inline size-3" />}
                  {hits == null ? t("Every word must be on the page.") : t("{n} pages", { n: hits.length })}
                </span>
                <span className="flex gap-0.5">
                  <Button variant="ghost" size="icon-sm" onClick={() => nextHit(-1)} disabled={!hits?.length} aria-label={t("Previous match")}>
                    <ChevronLeft />
                  </Button>
                  <Button variant="ghost" size="icon-sm" onClick={() => nextHit(1)} disabled={!hits?.length} aria-label={t("Next match")}>
                    <ChevronRight />
                  </Button>
                </span>
              </div>
              <ul className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
                {hits?.map((h) => (
                  <li key={h.page}>
                    <button
                      type="button"
                      onClick={() => jumpTo(h.page, true)}
                      className={cn("flex w-full flex-col gap-0.5 rounded px-2 py-1.5 text-left hover:bg-white/5", h.page === current && "bg-solar-400/10")}
                    >
                      <span className="num text-[11px] font-semibold text-solar-200">
                        {t("Page {n}", { n: h.page })} · {h.count}×
                      </span>
                      <span className="line-clamp-2 text-[11px] text-slate-400">{h.snippet}</span>
                    </button>
                  </li>
                ))}
                {hits && hits.length === 0 && !finding && (
                  <li className="px-2 py-1 text-[11px] text-muted-foreground">
                    {t("No page has every word.")} {shownRev && shownRev.text_status !== "ok" && t(TEXT_STATUS[shownRev.text_status].hint)}
                  </li>
                )}
              </ul>
            </TabsContent>
          </Tabs>
        </aside>
      </div>
    </div>
  );
};

export default KbDocViewerPage;
