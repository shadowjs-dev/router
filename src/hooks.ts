import { getActiveRouter } from "./context";
import type { NavigateOptions } from "./types";
import { useMemo, type Store } from "@shadow-js/core";

export function useLocation<T = unknown>(): {
  pathname: string;
  search: string;
  hash: string;
  state: T;
} {
  const r = getActiveRouter();
  return useMemo(() => ({
    pathname: r.path(),
    search: r.search(),
    hash: window.location.hash,
    state: r.state() as T,
  }));
}

export function useParams<
  T extends Record<string, string> = Record<string, string>
>(): T | undefined {
  const r = getActiveRouter();
  return useMemo(() => r.match()?.params as T | undefined);
}

export function useSearchParams(): [
  URLSearchParams | Store<URLSearchParams>,
  (
    next: Record<string, string | number | boolean | null | undefined>,
    opts?: NavigateOptions
  ) => void
] {
  const r = getActiveRouter();
  const sp = useMemo(() => new URLSearchParams(r.search() || ""));
  const set = (
    next: Record<string, string | number | boolean | null | undefined>,
    opts?: NavigateOptions
  ) => {
    const curr = new URLSearchParams(r.search() || "");
    for (const [k, v] of Object.entries(next)) {
      if (v == null || v === false) curr.delete(k);
      else curr.set(k, String(v));
    }
    const pathname = r.path();
    const search = curr.toString();
    const href = pathname + (search ? `?${search}` : "");
    r.navigate(href, opts);
  };
  return [sp, set];
}

export function navigate(to: string, opts?: NavigateOptions) {
  const r = getActiveRouter();
  r.navigate(to, opts);
}

export const redirect = navigate;
