/**
 * Knowledge Base editor (`/kb/new`, `/kb/:slug/edit`; admins and engineers): title, category,
 * tags, a Markdown textarea with a toolbar and a live preview (side by side from `lg`, Edit /
 * Preview tabs on a phone), and a change note. The unsent text is kept in localStorage per user
 * and article (guarded) until it is saved, so a dropped connection on site loses nothing. A save
 * against an older version (409) opens `ConflictDialog`.
 */
import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Copy, X } from "lucide-react";
import { api } from "../../api/client";
import type { KbArticle, KbCategory } from "../../api/client";
import { useAppContext } from "../../context/AppContext";
import { notify } from "@/lib/notify";
import { cn } from "@/lib/utils";
import { LoadingState, fmtInt } from "../../components/ui";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useI18n } from "../../i18n";
import { ArticleBody } from "./ArticleBody";
import { ConflictDialog } from "./ConflictDialog";
import { DiffView } from "./DiffView";
import { MarkdownToolbar, applyEdit, mdEdit } from "./MarkdownToolbar";
import type { MdAction } from "./MarkdownToolbar";
import { CATEGORIES, LIMITS, articlePath, clearDraft, errText, fmtDateTime, kbConflict, loadDraft, saveDraft, timeAgo } from "./format";
import type { KbDraft } from "./format";
import { useArticle } from "./useKb";

interface Form {
  title: string;
  category: KbCategory;
  tags: string[];
  body_md: string;
  note: string;
}

const EMPTY: Form = { title: "", category: "sop", tags: [], body_md: "", note: "" };
const DRAFT_DEBOUNCE_MS = 400;

const fromArticle = (a: KbArticle): Form => ({ title: a.title, category: a.category, tags: [...a.tags], body_md: a.body_md, note: "" });
const sameForm = (x: Form, y: Form) =>
  x.title === y.title && x.category === y.category && x.body_md === y.body_md && x.note === y.note && x.tags.join("\u0000") === y.tags.join("\u0000");

/** trimmed, ≤ 40 chars, de-duplicated case-insensitively (as the backend does) */
const addTags = (tags: string[], raw: string): string[] => {
  const out = [...tags];
  for (const part of raw.split(",")) {
    const tag = part.trim().slice(0, LIMITS.tag);
    if (tag && !out.some((x) => x.toLowerCase() === tag.toLowerCase())) out.push(tag);
  }
  return out;
};

const TagsInput: React.FC<{ id: string; tags: string[]; onChange: (t: string[]) => void; suggestions: string[] }> = ({ id, tags, onChange, suggestions }) => {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const commit = () => {
    if (!text.trim()) return;
    onChange(addTags(tags, text));
    setText("");
  };
  const full = tags.length >= LIMITS.tags;
  return (
    <div className="flex min-h-8 flex-wrap items-center gap-1 rounded-md border border-input bg-transparent px-1.5 py-1 focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50">
      {tags.map((tag) => (
        <span key={tag} className="inline-flex items-center gap-0.5 rounded-full border border-white/10 bg-white/5 py-px pr-0.5 pl-2 text-[11px] text-slate-200">
          #{tag}
          <button
            type="button"
            className="rounded-full p-0.5 text-slate-500 hover:bg-white/10 hover:text-slate-200"
            aria-label={t("Remove tag {tag}", { tag })}
            onClick={() => onChange(tags.filter((x) => x !== tag))}
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      <input
        id={id}
        list={`${id}-list`}
        className="min-w-24 flex-1 bg-transparent px-1 text-sm outline-none placeholder:text-muted-foreground disabled:opacity-50"
        placeholder={full ? t("At most {n} tags", { n: LIMITS.tags }) : tags.length ? "" : t("Add tags (Enter or comma)")}
        value={text}
        disabled={full}
        maxLength={LIMITS.tag * 2}
        onChange={(e) => {
          const v = e.target.value;
          if (v.includes(",")) {
            onChange(addTags(tags, v));
            setText("");
          } else setText(v);
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Backspace" && !text && tags.length) onChange(tags.slice(0, -1));
        }}
        onBlur={commit}
      />
      <datalist id={`${id}-list`}>
        {suggestions
          .filter((s) => !tags.some((x) => x.toLowerCase() === s.toLowerCase()))
          .map((s) => (
            <option key={s} value={s} />
          ))}
      </datalist>
    </div>
  );
};

/** the user's version kept beside the editor while merging a conflict by hand */
const MergePanel: React.FC<{ editor: string; mine: { title: string; body_md: string; version: number }; onDone: () => void }> = ({ editor, mine, onDone }) => {
  const { t } = useI18n();
  const [view, setView] = useState<"diff" | "text">("diff");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(mine.body_md);
      notify("ok", t("Your text was copied"));
    } catch {
      notify("warn", t("Could not copy; select the text and copy it."));
    }
  };
  return (
    <Card className="gap-3 border-amber-400/25 py-4">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 px-4">
        <div className="flex flex-col gap-0.5">
          <CardTitle className="text-sm">{t("Merging by hand")}</CardTitle>
          <p className="text-xs text-muted-foreground">
            {t("The editor now holds version {v} (theirs). Bring your changes over from your version below, then save.", { v: mine.version })}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => void copy()}>
            <Copy data-icon="inline-start" />
            {t("Copy your text")}
          </Button>
          <Button size="sm" variant="ghost" onClick={onDone}>
            {t("Done merging")}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 px-4">
        <Tabs value={view} onValueChange={(v) => setView(v as "diff" | "text")}>
          <TabsList variant="line" className="border-0 p-0">
            <TabsTrigger value="diff" className="px-3 py-2 text-sm">
              {t("Differences")}
            </TabsTrigger>
            <TabsTrigger value="text" className="px-3 py-2 text-sm">
              {t("Your version")}
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="max-h-80 overflow-y-auto">
          {view === "diff" ? (
            <DiffView a={editor} b={mine.body_md} delLabel={t("Only in the editor")} addLabel={t("Only in your version")} />
          ) : (
            <>
              {mine.title && <p className="mb-1 text-xs text-muted-foreground">{t("Your title: {v}", { v: mine.title })}</p>}
              <Textarea readOnly value={mine.body_md} className="min-h-60 text-sm" aria-label={t("Your version")} />
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
};

/** keyed by the article, so another article never inherits this one's form or draft */
export const KbEditorPage: React.FC = () => {
  const { slug } = useParams();
  return <Editor key={slug ?? "new"} slug={slug ?? null} />;
};

const Editor: React.FC<{ slug: string | null }> = ({ slug }) => {
  const { user } = useAppContext();
  const userId = user?.id;
  const { t } = useI18n();
  const navigate = useNavigate();
  const { article, setArticle, loading, error } = useArticle(slug);

  const [form, setForm] = useState<Form | null>(null);
  const [baseVersion, setBaseVersion] = useState<number | null>(null);
  const [mergeMine, setMergeMine] = useState<KbDraft["merge_mine"]>(null);
  const [restored, setRestored] = useState<KbDraft | null>(null);
  const [draftAt, setDraftAt] = useState<string | null>(null);
  const [pane, setPane] = useState<"edit" | "preview">("edit");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ current: KbArticle; message: string } | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const done = useRef(false);
  const initFor = useRef<string | null>(null);

  // the starting point: the article (or empty), replaced by an unsent draft when there is one
  const pristine = useMemo<Form>(() => (article ? fromArticle(article) : EMPTY), [article]);
  useEffect(() => {
    const key = slug ?? "new";
    if (initFor.current === key) return;
    if (slug != null && !article) return;
    initFor.current = key;
    const draft = loadDraft(userId, slug);
    const start = article ? fromArticle(article) : EMPTY;
    if (draft) {
      const f: Form = { title: draft.title, category: draft.category, tags: draft.tags, body_md: draft.body_md, note: draft.note };
      if (!sameForm(f, start) || draft.merge_mine) {
        setForm(f);
        setBaseVersion(article ? (draft.base_version ?? article.version) : null);
        setMergeMine(draft.merge_mine ?? null);
        setRestored(draft);
        setDraftAt(draft.saved_at || null);
        return;
      }
      clearDraft(userId, slug);
    }
    setForm(start);
    setBaseVersion(article?.version ?? null);
  }, [slug, article, userId]);

  // tag suggestions: the tags already in use
  useEffect(() => {
    let live = true;
    api
      .listKbArticles({ limit: 1 })
      .then((r) => live && setSuggestions(r.tags))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  // keep the unsent text (debounced; flushed when leaving the page)
  const pending = useRef<KbDraft | null>(null);
  const dirty = form != null && (!sameForm(form, pristine) || mergeMine != null);
  useEffect(() => {
    if (!form || done.current) return;
    if (!dirty) {
      pending.current = null;
      clearDraft(userId, slug);
      setDraftAt(null);
      return;
    }
    const d: KbDraft = { ...form, base_version: baseVersion, merge_mine: mergeMine, saved_at: new Date().toISOString() };
    pending.current = d;
    const h = setTimeout(() => {
      if (done.current) return;
      saveDraft(userId, slug, d);
      pending.current = null;
      setDraftAt(d.saved_at);
    }, DRAFT_DEBOUNCE_MS);
    return () => clearTimeout(h);
  }, [form, dirty, baseVersion, mergeMine, userId, slug]);
  useEffect(
    () => () => {
      if (!done.current && pending.current) saveDraft(userId, slug, pending.current);
    },
    [userId, slug]
  );

  const deferredBody = useDeferredValue(form?.body_md ?? "");
  const set = useCallback((patch: Partial<Form>) => setForm((f) => (f ? { ...f, ...patch } : f)), []);

  const problems = useMemo(() => {
    if (!form) return [];
    const out: string[] = [];
    const title = form.title.trim();
    if (!title) out.push(t("Give the article a title."));
    else if (title.length > LIMITS.title) out.push(t("The title is longer than {n} characters.", { n: LIMITS.title }));
    if (form.tags.length > LIMITS.tags) out.push(t("At most {n} tags.", { n: LIMITS.tags }));
    if (form.body_md.length > LIMITS.body) out.push(t("The text is longer than {n} characters.", { n: fmtInt(LIMITS.body) }));
    return out;
  }, [form, t]);

  const save = async (base: number | null = baseVersion, f: Form | null = form) => {
    if (!f || problems.length) return;
    setSaving(true);
    setSaveError(null);
    const note = f.note.trim() || undefined;
    const body = { title: f.title.trim(), category: f.category, tags: f.tags, body_md: f.body_md, note };
    try {
      const saved = article ? await api.patchKbArticle(article.id, { base_version: base ?? article.version, ...body }) : await api.createKbArticle(body);
      done.current = true;
      pending.current = null;
      clearDraft(userId, slug);
      notify("ok", article ? t("Saved as version {v}", { v: saved.version }) : t("Article created as a draft"));
      navigate(articlePath(saved.slug), { replace: true });
    } catch (e) {
      const c = kbConflict(e);
      if (c) setConflict(c);
      else setSaveError(errText(e));
    } finally {
      setSaving(false);
    }
  };

  const onAction = (a: MdAction) => {
    const ta = taRef.current;
    if (!ta) return;
    applyEdit(ta, mdEdit(a, ta.value, ta.selectionStart, ta.selectionEnd), (v) => set({ body_md: v }));
  };

  // ---- conflict choices
  const keepMine = () => {
    if (!conflict) return;
    const v = conflict.current.version;
    setBaseVersion(v);
    setConflict(null);
    void save(v);
  };
  const takeTheirs = () => {
    if (!conflict) return;
    const c = conflict.current;
    setArticle(c);
    setForm(fromArticle(c));
    setBaseVersion(c.version);
    setMergeMine(null);
    setConflict(null);
    clearDraft(userId, slug);
    notify("ok", t("Their version {v} is loaded; your changes were dropped.", { v: c.version }));
  };
  const mergeByHand = () => {
    if (!conflict || !form) return;
    const c = conflict.current;
    setMergeMine({ title: form.title, body_md: form.body_md, version: c.version });
    setArticle(c);
    setForm({ ...fromArticle(c), note: form.note });
    setBaseVersion(c.version);
    setConflict(null);
    setPane("edit");
  };

  const discardDraft = () => {
    clearDraft(userId, slug);
    pending.current = null;
    setForm(pristine);
    setBaseVersion(article?.version ?? null);
    setMergeMine(null);
    setRestored(null);
    setDraftAt(null);
  };

  // ---- states before the form
  const backTo = article ? articlePath(article.slug) : slug ? articlePath(slug) : "/kb";
  if (slug != null && error && !article) {
    return (
      <Empty className="py-16">
        <EmptyHeader>
          <EmptyTitle>{error.status === 404 ? t("Article not found") : t("Could not load the article")}</EmptyTitle>
          <EmptyDescription>{error.status === 404 ? t("It does not exist, or it is a draft or archived article you cannot see.") : error.text}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button asChild variant="outline" size="sm">
            <Link to="/kb">{t("All articles")}</Link>
          </Button>
        </EmptyContent>
      </Empty>
    );
  }
  if (slug != null && article && !article.can_edit) {
    return (
      <Empty className="py-16">
        <EmptyHeader>
          <EmptyTitle>{t("You cannot edit this article")}</EmptyTitle>
          <EmptyDescription>{t("Ask an admin if it needs a change.")}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button asChild variant="outline" size="sm">
            <Link to={backTo}>{t("Back to the article")}</Link>
          </Button>
        </EmptyContent>
      </Empty>
    );
  }
  if (!form || (slug != null && loading && !article)) return <LoadingState label={t("Loading article…")} shape="lines" />;

  const stale = article != null && restored?.base_version != null && restored.base_version < article.version;
  const saveButton = (
    <Button size="sm" onClick={() => void save()} disabled={saving || problems.length > 0 || (!dirty && article != null)}>
      {saving && <Spinner data-icon="inline-start" className="size-3" />}
      {article ? t("Save") : t("Create draft")}
    </Button>
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Button variant="ghost" size="icon-sm" asChild className="-ml-1 shrink-0">
            <Link to={backTo} aria-label={t("Back")}>
              <ArrowLeft />
            </Link>
          </Button>
          <div className="flex min-w-0 flex-col">
            <h1 className="truncate text-lg font-semibold">{article ? t("Edit article") : t("New article")}</h1>
            <p className="text-[11px] text-muted-foreground">
              {article ? t("Editing version {v}", { v: baseVersion ?? article.version }) : t("New articles start as a draft; an admin publishes them.")}
              {draftAt && ` · ${t("Draft kept on this device {ago}", { ago: timeAgo(draftAt) })}`}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" asChild>
            <Link to={backTo}>{t("Cancel")}</Link>
          </Button>
          {saveButton}
        </div>
      </div>

      {restored && (
        <Alert>
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
            <span>
              {t("Your unsaved draft from {when} was restored.", { when: fmtDateTime(restored.saved_at) })}
              {stale && ` ${t("The article has been saved by someone since; saving will show you both versions.")}`}
            </span>
            <span className="flex gap-1">
              <Button size="xs" variant="ghost" onClick={() => setRestored(null)}>
                {t("Dismiss")}
              </Button>
              <Button size="xs" variant="outline" onClick={discardDraft}>
                {t("Discard draft")}
              </Button>
            </span>
          </AlertDescription>
        </Alert>
      )}
      {saveError && (
        <Alert variant="destructive">
          <AlertDescription className="flex items-center justify-between gap-2">
            {saveError}
            <Button size="xs" variant="ghost" onClick={() => setSaveError(null)}>
              {t("Dismiss")}
            </Button>
          </AlertDescription>
        </Alert>
      )}

      <Card className="gap-3 py-4">
        <CardContent className="grid gap-3 px-4 sm:grid-cols-[200px_minmax(0,1fr)]">
          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <Label htmlFor="kb-title">{t("Title")}</Label>
            <Input
              id="kb-title"
              className="h-9 text-base"
              value={form.title}
              maxLength={LIMITS.title + 50}
              onChange={(e) => set({ title: e.target.value })}
              placeholder={t("e.g. Resetting a MAX inverter after an AC fault")}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="kb-category">{t("Category")}</Label>
            <Select value={form.category} onValueChange={(v) => set({ category: v as KbCategory })}>
              <SelectTrigger id="kb-category" size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CATEGORIES.map((c) => (
                  <SelectItem key={c.value} value={c.value}>
                    <c.icon />
                    {t(c.label)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex min-w-0 flex-col gap-1.5">
            <Label htmlFor="kb-tags">{t("Tags")}</Label>
            <TagsInput id="kb-tags" tags={form.tags} onChange={(tags) => set({ tags })} suggestions={suggestions} />
          </div>
        </CardContent>
      </Card>

      {mergeMine && <MergePanel editor={form.body_md} mine={mergeMine} onDone={() => setMergeMine(null)} />}

      <Card className="gap-0 py-0">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b px-2 py-1.5 sm:px-3">
          <MarkdownToolbar onAction={onAction} disabled={pane === "preview"} />
          <Tabs value={pane} onValueChange={(v) => setPane(v as "edit" | "preview")} className="lg:hidden">
            <TabsList>
              <TabsTrigger value="edit" className="px-3 text-xs">
                {t("Edit")}
              </TabsTrigger>
              <TabsTrigger value="preview" className="px-3 text-xs">
                {t("Preview")}
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <span className="hidden text-[11px] text-muted-foreground lg:inline">{t("Preview")} →</span>
        </div>
        <div className="grid min-w-0 lg:grid-cols-2">
          <div className={cn("flex min-w-0 flex-col gap-1.5 p-3", pane === "preview" && "hidden lg:flex")}>
            <Textarea
              ref={taRef}
              aria-label={t("Article text (Markdown)")}
              className="min-h-[55vh] flex-1 resize-y text-sm leading-relaxed"
              value={form.body_md}
              onChange={(e) => set({ body_md: e.target.value })}
              onKeyDown={(e) => {
                const mod = e.ctrlKey || e.metaKey;
                if (mod && e.key.toLowerCase() === "b") {
                  // bold here, not the sidebar toggle (Layout listens for Ctrl/⌘ B on window)
                  e.preventDefault();
                  e.stopPropagation();
                  onAction("bold");
                } else if (mod && e.key.toLowerCase() === "s") {
                  e.preventDefault();
                  void save();
                }
              }}
              placeholder={t("Write in Markdown: ## heading, - list, 1. steps, **bold**")}
              spellCheck
            />
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
              <span>{t("Bold in Thai text needs ** on both sides, e.g. **word**; _ does not work inside a word.")}</span>
              <span className={cn("num", form.body_md.length > LIMITS.body && "text-red-300")}>
                {fmtInt(form.body_md.length)} / {fmtInt(LIMITS.body)}
              </span>
            </div>
          </div>
          <div className={cn("min-w-0 border-white/[0.07] p-3 lg:border-l", pane === "edit" && "hidden lg:block")}>
            <div className="max-h-[70vh] min-h-[55vh] overflow-y-auto rounded-md px-1">
              {deferredBody.trim() ? (
                <ArticleBody markdown={deferredBody} />
              ) : (
                <p className="text-sm text-muted-foreground">{t("The preview shows here as you type.")}</p>
              )}
            </div>
          </div>
        </div>
      </Card>

      <Card className="gap-3 py-4">
        <CardContent className="flex flex-col gap-3 px-4 sm:flex-row sm:items-end">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Label htmlFor="kb-note">{t("Change note")}</Label>
            <Input
              id="kb-note"
              value={form.note}
              maxLength={300}
              onChange={(e) => set({ note: e.target.value })}
              placeholder={t("What changed (optional), e.g. added step 4")}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void save();
                }
              }}
            />
          </div>
          {saveButton}
        </CardContent>
        {problems.length > 0 && (form.title.trim() !== "" || form.body_md.trim() !== "") && (
          <CardContent className="px-4">
            <ul className="callout-warn space-y-0.5">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </CardContent>
        )}
      </Card>

      <ConflictDialog
        theirs={conflict?.current ?? null}
        mine={form}
        message={conflict?.message}
        busy={saving}
        onKeepMine={keepMine}
        onTakeTheirs={takeTheirs}
        onMerge={mergeByHand}
        onClose={() => setConflict(null)}
      />
    </div>
  );
};

export default KbEditorPage;
