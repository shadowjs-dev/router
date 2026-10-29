import { type Accessor, useMemo } from "@shadow-js/core";
import {
  createSearchBatch,
  type NavigationOutcome,
  type NavigationStatus,
  parseSearch,
  type SearchRecord,
  type SearchValue,
} from "../core/index";
import { currentCore } from "../internal/render";
import type { HrefOf, NavigateArgs, NavigateToOptions, Router } from "../types";

/**
 * Hooks for navigation: the router, navigate, the current location, pending state, and search
 * parameters. Blocking (`useBlocker`, `useBeforeLeave`) is in `@shadow-js/router/blockers`.
 */

/**
 * The router the component renders under.
 * @example
 * import { useRouter } from "@shadow-js/router";
 * const router = useRouter();
 * await router.navigate("/posts/7");
 * @since 1.0.0
 */
export function useRouter(): Router {
  return currentCore("useRouter").router;
}

/**
 * A navigate function bound to the router. Resolves with the outcome; redirects, not-found and
 * canceled navigations resolve too (they never throw).
 *
 * @returns `(to, options?) => Promise<NavigationOutcome>`.
 * @since 1.0.0
 * @example const go = useNavigate(); go("/posts/7", { replace: true });
 */
export function useNavigate(): <P extends HrefOf>(
  to: P,
  ...options: NavigateArgs<P>
) => Promise<NavigationOutcome> {
  const router = useRouter();
  // The router's own method takes the open options; this function types them per target.
  return (to, ...options) => router.navigate(to, options[0] as NavigateToOptions | undefined);
}

/** The current location, app-relative (without the base path). Reactive when read. @since 1.0.0 */
export interface LocationView {
  readonly pathname: string;
  readonly search: string;
  readonly hash: string;
}

/**
 * The current location. Read the properties inside a computation to track them.
 *
 * @returns A live view.
 * @since 1.0.0
 * @example insert(el, () => useLocation().pathname);
 */
export function useLocation(): LocationView {
  const core = currentCore("useLocation");
  return {
    get pathname(): string {
      const location = core.location();
      return location === undefined ? "" : core.appPathname(location.pathname);
    },
    get search(): string {
      return core.location()?.search ?? "";
    },
    get hash(): string {
      return core.location()?.hash ?? "";
    },
  };
}

/**
 * The href of a target, resolved against the current location. Reactive: relative targets update.
 *
 * @param to Target.
 * @param options Params, search and hash.
 * @returns An accessor of the href.
 * @example
 * import { useHref } from "@shadow-js/router";
 * const href = useHref("/posts/:id", { params: { id: "7" } });
 * href(); // "/posts/7"
 * @since 1.0.0
 */
export function useHref(to: HrefOf, options: NavigateToOptions = {}): Accessor<string> {
  const router = useRouter();
  const core = currentCore("useHref");
  return useMemo<string>(() => {
    core.location();
    return router.href(to, options);
  });
}

/** Navigation in flight. Reactive when read. @since 1.0.0 */
export interface NavigationView {
  /** True after `pendingMs` of a navigation, for at least `pendingMinMs`. */
  readonly pending: boolean;
  readonly status: NavigationStatus;
  /** Where the navigation in flight is heading, app-relative. */
  readonly location: LocationView | undefined;
}

/**
 * The state of the navigation in flight, for global spinners and pending indicators.
 *
 * @returns A live view.
 * @example
 * import { useNavigation } from "@shadow-js/router";
 * const navigation = useNavigation();
 * navigation.pending; // true after the pending delay of a navigation in flight, for a global spinner
 * @since 1.0.0
 */
export function useNavigation(): NavigationView {
  const core = currentCore("useNavigation");
  return {
    get pending(): boolean {
      return core.pending();
    },
    get status(): NavigationStatus {
      return core.status();
    },
    get location(): LocationView | undefined {
      const target = core.target();
      if (target === undefined) return undefined;
      return {
        pathname: core.appPathname(target.pathname),
        search: target.search,
        hash: target.hash,
      };
    },
  };
}

/** A value a search setter accepts: a new value per key, or `undefined` to remove the key. @since 1.0.0 */
export type SearchUpdate<S> =
  | { readonly [K in keyof S & string]?: SearchValue | undefined }
  | ((previous: S) => { readonly [K in keyof S & string]?: SearchValue | undefined });

/** Options of a search setter. @since 1.0.0 */
export interface SearchSetOptions {
  /** Replace the current history entry instead of pushing one. Default false. */
  readonly replace?: boolean;
}

/**
 * Reads the query of the current location and sets keys of it. `validate` turns the parsed query into
 * a typed value (it may throw to reject a query; the throw is the caller's to handle). A setter merges
 * its keys into the query, a key set to `undefined` is removed, and the setters called in one tick
 * become one navigation: the last value of a key wins, and the entry is replaced only when every call
 * in the batch asked for it. A functional update reads the value at the time of the call, not after the
 * batch.
 *
 * @param validate Types the query. Default: the parsed query, unchanged.
 * @returns The read accessor and the setter.
 * @example
 * const [params, setParams] = useSearchParams((search) => ({ page: Number(search.page ?? 1) }));
 * setParams({ page: params().page + 1 }); // pushes ?page=2
 * @since 1.0.0
 */
export function useSearchParams<S = SearchRecord>(
  validate?: (search: SearchRecord) => S,
): readonly [Accessor<S>, (next: SearchUpdate<S>, options?: SearchSetOptions) => void] {
  const location = useLocation();
  const core = currentCore("useSearchParams");
  const router = core.router;
  const read = (): S => {
    // The router's own limit: a longer query than the default 4096 is legal when the app raised `maxSearchLength`.
    const record = parseSearch(location.search, { maxLength: core.maxSearchLength });
    return validate === undefined ? (record as S) : validate(record);
  };
  const batch = createSearchBatch((patch, replace) => {
    const hash = location.hash;
    // The current pathname is an href the app renders; the router checks it like any other target.
    void router.navigate(location.pathname as HrefOf, {
      search: patch,
      replace,
      ...(hash === "" ? {} : { hash }),
    });
  });
  const set = (next: SearchUpdate<S>, options?: SearchSetOptions): void => {
    const patch = typeof next === "function" ? next(read()) : next;
    batch.set(patch, options?.replace === true);
  };
  return [read, set];
}
