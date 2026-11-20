/** Links people type (document / evidence links): only http(s) is ever made a link, so a stored
 * `javascript:` or `data:` URL can never run in the page. */
export const isWebUrl = (u: string | null | undefined): boolean => !!u && /^https?:\/\//i.test(u.trim());

export const safeHref = (u: string | null | undefined): string | undefined => (isWebUrl(u) ? u!.trim() : undefined);
