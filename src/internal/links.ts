/**
 * Classification of link targets, shared by `<A>` and the router.
 */

/**
 * True for an absolute URL (any scheme) or a protocol-relative one. Those are never routed. Browsers
 * read a backslash like a slash here, so `\\host` is protocol-relative too. Call this on the raw
 * text: normalizing first would turn `//host` into the same-origin path `/host`.
 */
export function isExternalTarget(text: string): boolean {
  const first = text.charAt(0);
  const second = text.charAt(1);
  if ((first === "/" || first === "\\") && (second === "/" || second === "\\")) return true;
  const colon = text.indexOf(":");
  if (colon <= 0) return false;
  for (let at = 0; at < colon; at += 1) {
    const ch = text.charAt(at);
    if (ch === "/" || ch === "?" || ch === "#") return false;
  }
  return true;
}

/** The path without its query and hash. */
export function pathOnly(href: string): string {
  const cut = href.search(/[?#]/);
  return cut === -1 ? href : href.slice(0, cut);
}

/**
 * A pathname without its trailing slashes, for keys that treat `/a` and `/a/` as one page. Scanned from the end, so the
 * time is linear: `pathname.replace(/\/+$/, "")` retries from every start position and takes quadratic time on
 * `////...a/`. The root becomes the empty string, as before.
 */
export function withoutTrailingSlashes(pathname: string): string {
  let end = pathname.length;
  while (end > 0 && pathname.charCodeAt(end - 1) === 47) end -= 1;
  return end === pathname.length ? pathname : pathname.slice(0, end);
}

/** A pathname without a trailing slash (the root stays `/`), for active-state comparison. */
export function comparablePath(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}

/** Joins the class names that are present, or returns undefined when none is. */
export function joinClasses(...values: readonly unknown[]): string | undefined {
  const parts: string[] = [];
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") parts.push(value.trim());
  }
  return parts.length === 0 ? undefined : parts.join(" ");
}
