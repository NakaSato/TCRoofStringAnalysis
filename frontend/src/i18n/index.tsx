import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { TH } from "./th";

/**
 * UI language. Thai is the default; English is the other choice. The key of every string is its
 * English text, so `t("Sign in")` shows "Sign in" in English and the Thai entry from `th.ts` in Thai.
 * A string with no Thai entry yet falls back to the English text, so pages can be translated one by one.
 * `{name}` in a string is replaced from `vars`.
 */
export type Lang = "th" | "en";

/** localStorage key for the chosen language (a per-browser preference, guarded). */
const LANG_KEY = "tcroof.lang";
export const DEFAULT_LANG: Lang = "th";

const readLang = (): Lang => {
  try {
    const v = localStorage.getItem(LANG_KEY);
    return v === "en" || v === "th" ? v : DEFAULT_LANG;
  } catch {
    return DEFAULT_LANG;
  }
};

export type Vars = Record<string, string | number | null | undefined>;

const fill = (s: string, vars?: Vars) =>
  vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k] ?? "") : m)) : s;

/** Translate without a hook (module code, callbacks): uses the language active right now. It does not
 * re-render on a switch, so components use `useI18n().t`. */
let currentLang: Lang = readLang();
export const translate = (en: string, vars?: Vars, lang: Lang = currentLang): string =>
  fill(lang === "th" ? TH[en] ?? en : en, vars);

/** The language active right now (for code outside React, e.g. chart formatters). */
export const currentLanguage = (): Lang => currentLang;

/** Locale for dates and numbers: Thai month / day names with the Gregorian year (matches Growatt, CSV
 * exports and ISO days shown elsewhere), else en-GB as before. */
export const dateLocale = (lang: Lang = currentLang) => (lang === "th" ? "th-TH-u-ca-gregory" : "en-GB");

interface I18nValue {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (en: string, vars?: Vars) => string;
  /** locale for `toLocaleDateString` / `toLocaleTimeString` */
  locale: string;
}

const I18nContext = createContext<I18nValue | null>(null);

export const I18nProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [lang, setLangState] = useState<Lang>(currentLang);
  const setLang = useCallback((l: Lang) => {
    currentLang = l;
    setLangState(l);
    try {
      localStorage.setItem(LANG_KEY, l);
    } catch {
      /* storage blocked: the choice lasts this tab only */
    }
  }, []);
  useEffect(() => {
    currentLang = lang;
    document.documentElement.lang = lang;
  }, [lang]);
  const value = useMemo<I18nValue>(
    () => ({ lang, setLang, t: (en, vars) => translate(en, vars, lang), locale: dateLocale(lang) }),
    [lang, setLang]
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
};

export const useI18n = (): I18nValue => {
  const v = useContext(I18nContext);
  if (!v) throw new Error("useI18n outside I18nProvider");
  return v;
};

/** Small switch: ไทย | EN. */
export const LanguageToggle: React.FC<{ className?: string; compact?: boolean }> = ({ className = "", compact }) => {
  const { lang, setLang, t } = useI18n();
  const opts: { v: Lang; label: string }[] = [
    { v: "th", label: "ไทย" },
    { v: "en", label: "EN" },
  ];
  return (
    <div
      role="group"
      aria-label={t("Language")}
      className={`inline-flex shrink-0 rounded-md border border-white/[0.08] bg-ink-900/80 p-0.5 text-[11px] font-semibold ${
        compact ? "flex-col" : ""
      } ${className}`}
    >
      {opts.map((o) => (
        <button
          key={o.v}
          type="button"
          onClick={() => setLang(o.v)}
          aria-pressed={lang === o.v}
          className={`rounded px-1.5 py-0.5 transition ${
            lang === o.v ? "bg-white/[0.1] text-white" : "text-slate-500 hover:text-slate-200"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
};
