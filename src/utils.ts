export function trimSlashes(p: string): string {
  if (!p) return "";
  return p.replace(/^\/+|\/+$/g, "");
}

export function splitPath(p: string): string[] {
  const t = trimSlashes(p);
  if (!t) return [];
  return t.split("/").filter(Boolean);
}

export function withLeadingSlash(p: string): string {
  return p.startsWith("/") ? p : `/${p}`;
}

export function joinPaths(...parts: string[]): string {
  const joined = parts
    .filter(Boolean)
    .map((x) => trimSlashes(x))
    .filter(Boolean)
    .join("/");
  return "/" + joined;
}

export function isExternalUrl(href: string): boolean {
  try {
    const u = new URL(href, window.location.href);
    return u.origin !== window.location.origin;
  } catch {
    return false;
  }
}

export function normalizeHref(href: string): string {
  // Support relative and absolute.
  try {
    const u = new URL(href, window.location.href);
    return u.pathname + u.search + u.hash;
  } catch {
    return href;
  }
}