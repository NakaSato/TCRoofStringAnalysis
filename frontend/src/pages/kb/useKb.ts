/** Knowledge Base data: the article list (server search / filters / paging) and one article. DB
 * only, read on mount / when the query changes / after a change; never polled. */
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../../api/client";
import type { KbArticle, KbArticleList, KbArticleQuery } from "../../api/client";
import { errText } from "./format";

export function useArticleList(query: KbArticleQuery) {
  const [data, setData] = useState<KbArticleList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const key = JSON.stringify(query);

  const reload = useCallback(async () => {
    const n = ++seq.current;
    setLoading(true);
    try {
      const d = await api.listKbArticles(JSON.parse(key) as KbArticleQuery);
      if (n !== seq.current) return;
      setData(d);
      setError(null);
    } catch (e) {
      if (n !== seq.current) return;
      setError(errText(e));
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }, [key]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { data, loading, refreshing: loading && data != null, error, reload };
}

export function useArticle(slug: string | null) {
  const [article, setArticle] = useState<KbArticle | null>(null);
  const [loading, setLoading] = useState(slug != null);
  const [error, setError] = useState<{ text: string; status: number | null } | null>(null);
  const seq = useRef(0);

  const reload = useCallback(async () => {
    if (slug == null) return;
    const n = ++seq.current;
    setLoading(true);
    try {
      const a = await api.getKbArticle(slug);
      if (n !== seq.current) return;
      setArticle(a);
      setError(null);
    } catch (e) {
      if (n !== seq.current) return;
      setError({ text: errText(e), status: e instanceof ApiError ? e.status : null });
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }, [slug]);

  useEffect(() => {
    // another article: never show the old one under the new address
    setArticle(null);
    setError(null);
    void reload();
  }, [reload]);

  return { article, setArticle, loading, error, reload };
}
