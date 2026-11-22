/** Links people type (document / evidence links): only http(s) is ever made a link, so a stored
 * `javascript:` or `data:` URL can never run in the page. */
export const isWebUrl = (u: string | null | undefined): boolean => !!u && /^https?:\/\//i.test(u.trim());

export const safeHref = (u: string | null | undefined): string | undefined => (isWebUrl(u) ? u!.trim() : undefined);

/** A path inside this app (`/alarms?sn=…`, never `//host`), opened with the router. The backend
 * accepts these for evidence and calibration links next to http(s) URLs. */
export const appPath = (u: string | null | undefined): string | undefined => {
  const v = u?.trim();
  return v && v.startsWith("/") && !v.startsWith("//") && !v.startsWith("/\\") ? v : undefined;
};

/** What a link field may hold: an http(s) URL or a path in this app. */
export const isLinkValue = (u: string): boolean => isWebUrl(u) || appPath(u) != null;
