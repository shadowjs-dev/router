import { type History, type HistoryUpdate, resolveLocation } from "./history";
import type { LoaderCache, LoadIntent } from "./loader-cache";
import {
  createMatcher,
  findConflicts,
  type RouteDefinition,
  type RouteMatch,
  type RouteMatcher,
} from "./matcher";
import {
  buildPathFromParams,
  canonicalizePathname,
  type ParamsOf,
  type TrailingSlashPolicy,
} from "./path";
import {
  FORBIDDEN_KEYS,
  MAX_SEARCH_LENGTH,
  parseSearch,
  type SearchPatch,
  type SearchRecord,
  stringifySearch,
} from "./search";
import { isSafeNavigationTarget, normalizeNavigationText } from "./url-safety";

/**
 * The navigation state machine: `idle -> matching -> beforeLoad -> loading -> committing -> idle`.
 *
 * Every navigation gets a generation token. A newer navigation aborts the older one's controller
 * and makes its late results irrelevant, so the last navigation always wins. `beforeLoad` runs
 * serially from the root down (and may add to the context); loaders run in parallel and only after
 * every `beforeLoad` succeeded. Redirects restart the attempt at the new target, up to
 * `maxRedirects`. Preloads run the same `beforeLoad` and loaders with their own controller, never
 * touch the location, blockers or status, and report their errors through `onError`.
 */

/**
 * A location as the navigator reports it.
 * @since 1.0.0
 */
export interface RouteLocation {
  readonly pathname: string;
  readonly search: string;
  readonly hash: string;
}

/**
 * What `beforeLoad` receives.
 * @since 1.0.0
 */
export interface BeforeLoadArgs {
  readonly params: Readonly<Record<string, string>>;
  /** The validated search of this route, or the parsed record when there is no validator. */
  readonly search: unknown;
  /** Context accumulated from the root down to this route, excluding this route's own additions. */
  readonly context: Readonly<Record<string, unknown>>;
  readonly location: RouteLocation;
  readonly intent: LoadIntent;
  readonly signal: AbortSignal;
}

/**
 * What a loader receives.
 * @since 1.0.0
 */
export interface LoaderArgs extends BeforeLoadArgs {
  /** The loader deps computed from the search, or undefined. */
  readonly deps: unknown;
}

/**
 * Context to add for this route and its children.
 * @since 1.0.0
 */
export type BeforeLoadResult = Readonly<Record<string, unknown>> | undefined | void;

/**
 * A route with navigation hooks. Routers add components and other fields on top.
 * @since 1.0.0
 */
export interface NavigationRoute extends RouteDefinition {
  readonly id: string;
  readonly path?: string;
  readonly children?: readonly NavigationRoute[];
  readonly beforeLoad?: (args: BeforeLoadArgs) => BeforeLoadResult | Promise<BeforeLoadResult>;
  readonly loader?: (args: LoaderArgs) => unknown;
  readonly loaderDeps?: (search: SearchRecord) => unknown;
  readonly validateSearch?: (search: SearchRecord) => unknown;
  readonly onSearchError?: (error: unknown, search: SearchRecord) => unknown;
  readonly tags?: readonly string[];
  readonly staleReload?: "background" | "blocking";
  /**
   * Starts loading the code the route renders with and answers when it is there. Called once per navigation, when the
   * loaders start, so the code and the data arrive together. A rejection is ignored: the render reports it.
   */
  readonly warm?: (() => Promise<unknown>) | undefined;
}

/**
 * Options for {@link NavigateOptions}.
 * @since 1.0.0
 */
export interface NavigateOptions {
  /** Replace the current entry instead of pushing. */
  readonly replace?: boolean;
  readonly state?: unknown;
}

/**
 * Thrown (not returned) from `beforeLoad` or a loader to send the navigation elsewhere. The object form of `redirect` keeps
 * its target and builds `to` on first read, so the path and search builders are bundled only where a router or server reads it.
 * @example
 * import { RedirectSignal } from "@shadow-js/router/core";
 * new RedirectSignal("/login", true).to; // "/login"
 * @since 1.0.0
 */
export class RedirectSignal {
  readonly kind = "redirect" as const;
  readonly replace: boolean;
  /**
   * True when the thrower chose `replace`. Only then does the signal decide how the redirected navigation writes history;
   * otherwise the navigation that was redirected keeps its own mode (a push stays a push, a replace stays a replace).
   */
  readonly replaceGiven: boolean;
  private target: string | RedirectTarget;

  /**
   * @param to The target location, or the object form.
   * @param replace Whether the redirected navigation replaces the current history entry. Passing it is choosing it.
   * @param replaceGiven `false` when `replace` is only the default `true` that `redirect()` reports (nothing was chosen).
   */
  constructor(to: string | RedirectTarget, replace: boolean, replaceGiven = true) {
    this.replace = replace;
    this.replaceGiven = replaceGiven;
    this.target = to;
  }

  /** The target location. @throws Error for an object target read where no router or server is running. */
  get to(): string {
    if (typeof this.target !== "string") {
      if (targetBuilder === undefined)
        throw new Error(
          __DEV__ ? "redirect(): object target needs a router" : "SHADOW_REDIRECT_TARGET",
        );
      this.target = targetBuilder(this.target);
    }
    return this.target;
  }
}

/** Builds the location of an object-form redirect; set by a router or server through {@link enableRedirectTargets}. */
let targetBuilder: ((target: RedirectTarget) => string) | undefined;

/**
 * Makes object-form redirect targets readable. Called by the navigator and by Dusk servers, which are the readers.
 * @internal
 */
export function enableRedirectTargets(): void {
  targetBuilder = redirectPath;
}

/**
 * Thrown (not returned) from `beforeLoad` or a loader to report that nothing matches.
 * @example
 * import { NotFoundSignal } from "@shadow-js/router/core";
 * new NotFoundSignal("post").routeId; // "post"
 * @since 1.0.0
 */
export class NotFoundSignal {
  readonly kind = "notFound" as const;
  readonly routeId: string | undefined;

  constructor(routeId: string | undefined) {
    this.routeId = routeId;
  }
}

/**
 * The `params` a redirect target needs: a literal pattern with params (`/posts/:id`) needs exactly its params, typed from
 * the pattern; the params of an optional segment are optional; a concrete path or a `string` keeps the open record.
 * @since 1.0.0
 */
export type RedirectParams<P extends string> = string extends P
  ? { readonly params?: Readonly<Record<string, string>> }
  : keyof ParamsOf<P> extends never
    ? { readonly params?: undefined }
    : Partial<ParamsOf<P>> extends ParamsOf<P>
      ? { readonly params?: ParamsOf<P> }
      : { readonly params: ParamsOf<P> };

/**
 * The object form of a redirect target: a path or pattern, its params, a search patch and a hash, as the link and
 * navigation APIs take them.
 * @since 1.0.0
 */
export type RedirectTarget<P extends string = string> = {
  /** A path, or a pattern with `:params` that `params` fills in. */
  readonly to: P;
  /** Search to append, serialized with the canonical codec (`undefined` values are left out). */
  readonly search?: SearchPatch;
  /** Hash to append, with or without the leading `#`. */
  readonly hash?: string;
  /** Replace the current entry instead of pushing. Default true. */
  readonly replace?: boolean;
} & RedirectParams<NoInfer<P>>;

/**
 * Builds the target string of an object-form redirect.
 */
function redirectPath(target: RedirectTarget): string {
  // A pattern with required params and no `params` throws here, like `buildPath`.
  const path = buildPathFromParams(
    target.to,
    (target.params ?? {}) as Readonly<Record<string, string>>,
  );
  const hash =
    target.hash === undefined || target.hash === "" ? "" : `#${target.hash.replace(/^#/, "")}`;
  return `${path}${target.search === undefined ? "" : stringifySearch(target.search)}${hash}`;
}

/**
 * Control flow: throw the result to redirect. Identical from `beforeLoad` and from a loader. The target is a string, or an
 * object with the same typed `params`, `search` and `hash` that links and navigation take.
 *
 * @param to Target: a path relative to the app, an absolute path, or `{ to, params?, search?, hash?, replace? }`.
 * @param options `replace` (also a member of the object form) chooses how the redirected navigation writes history: `true`
 *   replaces the current entry, `false` pushes a new one. When it is not passed, the navigation that was redirected keeps
 *   its own mode (a `navigate()` that pushes pushes the target, one that replaces replaces it), and the signal's `replace`
 *   member reads `true`.
 * @returns The signal to throw.
 * @throws RangeError when a pattern's required param is missing.
 * @example throw redirect("/login")
 * @example throw redirect({ to: "/posts/:id", params: { id: "7" }, search: { tab: "edit" } })
 * @since 1.0.0
 */
export function redirect(to: string, options?: { readonly replace?: boolean }): RedirectSignal;
export function redirect<P extends string>(target: RedirectTarget<P>): RedirectSignal;
export function redirect(
  to: string | RedirectTarget,
  options: { readonly replace?: boolean } = {},
): RedirectSignal {
  const given = typeof to === "string" ? options.replace : to.replace;
  return new RedirectSignal(to, given ?? true, given !== undefined);
}

/**
 * Control flow: throw the result to report not-found.
 *
 * @param options Optional route id to attribute the not-found to. Defaults to the throwing route.
 * @returns The signal to throw.
 * @example
 * import { notFound } from "@shadow-js/router/core";
 * throw notFound({ routeId: "post" }); // a not-found signal attributed to the "post" route
 * @since 1.0.0
 */
export function notFound(options: { readonly routeId?: string } = {}): NotFoundSignal {
  return new NotFoundSignal(options.routeId);
}

/**
 * True for a redirect signal.
 * @example
 * import { isRedirect, redirect } from "@shadow-js/router/core";
 * isRedirect(redirect("/login")); // true
 * @since 1.0.0
 */
export function isRedirect(value: unknown): value is RedirectSignal {
  return value instanceof RedirectSignal;
}

/**
 * True for a not-found signal.
 * @example
 * import { isNotFound, notFound } from "@shadow-js/router/core";
 * isNotFound(notFound()); // true
 * isNotFound(new Error("missing")); // false
 * @since 1.0.0
 */
export function isNotFound(value: unknown): value is NotFoundSignal {
  return value instanceof NotFoundSignal;
}

/**
 * How a navigation ended.
 * @since 1.0.0
 */
export type NavigationOutcome =
  | { readonly kind: "success"; readonly location: RouteLocation }
  | { readonly kind: "notFound"; readonly routeId: string | undefined }
  | { readonly kind: "error"; readonly error: unknown }
  | { readonly kind: "canceled" }
  | { readonly kind: "blocked" };

/**
 * Machine states.
 * @since 1.0.0
 */
export type NavigationStatus = "idle" | "matching" | "beforeLoad" | "loading" | "committing";

/**
 * One matched route with its data.
 * @since 1.0.0
 */
export interface NavigationMatch {
  readonly id: string;
  readonly pattern: string;
  readonly params: Readonly<Record<string, string>>;
  readonly loaderData: unknown;
  readonly context: Readonly<Record<string, unknown>>;
  readonly depth: number;
}

/**
 * The state a reactive layer subscribes to. Replaced, never mutated.
 * @since 1.0.0
 */
export interface NavigationSnapshot {
  readonly status: NavigationStatus;
  readonly location: RouteLocation | undefined;
  readonly matches: readonly NavigationMatch[];
  /** True after `pendingMs` of a navigation, for at least `pendingMinMs`. */
  readonly pending: boolean;
  /** The last error, or the NotFoundSignal of the last not-found. */
  readonly error: unknown;
}

/**
 * Options for {@link createNavigator}.
 * @since 1.0.0
 */
export interface NavigatorOptions {
  readonly routes: readonly NavigationRoute[];
  /**
   * The matcher of these routes. A router passes the one it matches with, so a path is matched by
   * one matcher. Built from `routes` when omitted.
   */
  readonly matcher?: RouteMatcher;
  readonly history: History;
  readonly loaderCache: LoaderCache;
  readonly now: () => number;
  readonly setTimeout: (run: () => void, ms: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
  readonly createAbortController?: () => AbortController;
  /** Mount point. Applied in one place: the matcher. */
  readonly basePath?: string;
  readonly caseSensitive?: boolean;
  readonly trailingSlash?: TrailingSlashPolicy;
  readonly maxRedirects?: number;
  readonly maxSearchLength?: number;
  readonly pendingMs?: number;
  /**
   * The `pendingMs` a route sets, by route id (`undefined` when it sets none). The delay of a navigation
   * is the one of its deepest matched route that sets one, else `pendingMs`.
   */
  readonly pendingMsOf?: (routeId: string) => number | undefined;
  readonly pendingMinMs?: number;
  /** Context at the root. */
  readonly context?: Readonly<Record<string, unknown>>;
  /** Receives errors that no caller awaits: subscriber failures and preload failures. */
  readonly onError?: (error: unknown) => void;
}

/**
 * A navigator: owns one matcher, one state machine and one subscriber list.
 * @since 1.0.0
 */
export interface Navigator {
  navigate(to: string, options?: NavigateOptions): Promise<NavigationOutcome>;
  /** Warms the loader cache for a target. Never commits, never blocked, errors go to onError. */
  preload(to: string, signal?: AbortSignal): Promise<void>;
  /** Loads the current location with the hydrate intent. No history write. */
  hydrate(): Promise<NavigationOutcome>;
  /** Reloads the current location, ignoring freshness. No history write. */
  reload(): Promise<NavigationOutcome>;
  getSnapshot(): NavigationSnapshot;
  subscribe(listener: (snapshot: NavigationSnapshot) => void): () => void;
  destroy(): void;
}

type Target =
  | {
      readonly kind: "target";
      readonly pathname: string;
      readonly search: string;
      readonly hash: string;
    }
  | { readonly kind: "malformed" }
  | { readonly kind: "error"; readonly error: unknown };

type AttemptResult =
  | { readonly kind: "ok"; readonly matches: readonly NavigationMatch[] }
  | { readonly kind: "redirect"; readonly signal: RedirectSignal }
  /** `matches` are the layouts above the route that failed, with the data their loaders returned. */
  | {
      readonly kind: "notFound";
      readonly routeId: string | undefined;
      readonly matches: readonly NavigationMatch[];
    }
  | { readonly kind: "error"; readonly error: unknown }
  | { readonly kind: "canceled" };

type LoadResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: unknown };

/** Does nothing: the end of a promise nobody awaits, and the loading callback of a preload. */
const ignore = (): void => undefined;

const DEFAULT_MAX_REDIRECTS = 20;
const DEFAULT_PENDING_MS = 1000;
const DEFAULT_PENDING_MIN_MS = 500;

function hasSchemePrefix(text: string): boolean {
  const colon = text.indexOf(":");
  if (colon <= 0) return false;
  for (let index = 0; index < colon; index += 1) {
    const ch = text.charAt(index);
    if (ch === "/" || ch === "?" || ch === "#") return false;
  }
  return true;
}

function mergeContext(
  base: Readonly<Record<string, unknown>>,
  additions: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const merged: Record<string, unknown> = Object.assign(Object.create(null), base);
  for (const key of Object.keys(additions)) {
    if (!FORBIDDEN_KEYS.has(key)) merged[key] = additions[key];
  }
  return merged;
}

/**
 * Creates a navigator for a route tree.
 *
 * @param options Routes, history, loader cache, clock and timers, and policy.
 * @returns A navigator. Call `destroy()` to stop listening to history.
 * @throws Error when two routes share an id or match the same paths.
 * @example
 * const navigator = createNavigator({ routes, history, loaderCache, now: Date.now, setTimeout });
 * await navigator.navigate("/posts/7");
 * @since 1.0.0
 */
export function createNavigator(options: NavigatorOptions): Navigator {
  const conflicts = findConflicts(options.routes, {
    caseSensitive: options.caseSensitive ?? false,
  });
  if (conflicts.length > 0) {
    const details = conflicts
      .map(
        (conflict) =>
          `${conflict.ids[0]} and ${conflict.ids[1]} (${conflict.kind}, ${conflict.pattern})`,
      )
      .join("; ");
    throw new Error(__DEV__ ? `route conflicts: ${details}` : "SHADOW_ROUTE_CONFLICT");
  }

  const matcher: RouteMatcher =
    options.matcher ??
    createMatcher(options.routes, {
      caseSensitive: options.caseSensitive ?? false,
      basePath: options.basePath ?? "",
    });
  const routeById = new Map<string, NavigationRoute>();
  const stack: NavigationRoute[] = [...options.routes];
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    routeById.set(item.id, item);
    for (const child of item.children ?? []) stack.push(child);
  }

  const history = options.history;
  const loaderCache = options.loaderCache;
  const now = options.now;
  const clear = (handle: unknown): void => {
    if (options.clearTimeout !== undefined) {
      options.clearTimeout(handle);
    } else {
      globalThis.clearTimeout(handle as Parameters<typeof globalThis.clearTimeout>[0]);
    }
  };
  const newController =
    options.createAbortController ?? ((): AbortController => new AbortController());
  const trailingSlash = options.trailingSlash ?? "never";
  enableRedirectTargets();
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const maxSearchLength = options.maxSearchLength ?? MAX_SEARCH_LENGTH;
  const pendingMs = options.pendingMs ?? DEFAULT_PENDING_MS;
  const pendingMsOf = options.pendingMsOf;
  const pendingMinMs = options.pendingMinMs ?? DEFAULT_PENDING_MIN_MS;
  const baseContext: Readonly<Record<string, unknown>> = options.context ?? {};

  const listeners = new Set<(snapshot: NavigationSnapshot) => void>();
  const preloads = new Set<AbortController>();
  let destroyed = false;
  let generation = 0;
  let activeController: AbortController | undefined;
  let selfWriting = false;
  let pendingTimer: unknown;
  let pendingMinTimer: unknown;
  let pendingSince = 0;
  let navigationStarted = 0;
  let snapshot: NavigationSnapshot = {
    status: "idle",
    location: currentLocation(),
    matches: [],
    pending: false,
    error: undefined,
  };

  function report(error: unknown): void {
    if (options.onError !== undefined) options.onError(error);
  }

  function publish(next: NavigationSnapshot): void {
    snapshot = next;
    for (const listener of [...listeners]) {
      try {
        listener(snapshot);
      } catch (error) {
        report(error);
      }
    }
  }

  function setStatus(token: number, status: NavigationStatus): void {
    if (token !== generation) return;
    publish({ ...snapshot, status });
  }

  function cancelTimers(): void {
    if (pendingTimer !== undefined) clear(pendingTimer);
    if (pendingMinTimer !== undefined) clear(pendingMinTimer);
    pendingTimer = undefined;
    pendingMinTimer = undefined;
  }

  function beginPending(token: number, intent: LoadIntent): void {
    if (intent !== "navigate") return;
    // A new navigation keeps `pending` as it is but must not let an earlier minimum-display timer
    // clear it while this navigation is still loading.
    if (pendingMinTimer !== undefined) {
      clear(pendingMinTimer);
      pendingMinTimer = undefined;
    }
    navigationStarted = now();
    armPending(token, pendingMs);
  }

  /**
   * Shows the pending UI `delay` ms after the navigation started (at once when that is already past, or
   * when the delay is 0). Re-armed when the target's route matches and sets its own `pendingMs`.
   */
  function armPending(token: number, delay: number): void {
    if (pendingTimer !== undefined) clear(pendingTimer);
    pendingTimer = undefined;
    const show = (): void => {
      pendingTimer = undefined;
      if (token !== generation || snapshot.status === "idle" || snapshot.pending) return;
      pendingSince = now();
      publish({ ...snapshot, pending: true });
    };
    const remaining = delay - (now() - navigationStarted);
    if (remaining <= 0) show();
    else pendingTimer = options.setTimeout(show, remaining);
  }

  /** The delay of a navigation to `matched`: the deepest matched route that sets `pendingMs`, else the router's. */
  function pendingDelayFor(matched: readonly { readonly id: string }[]): number {
    for (let at = matched.length - 1; at >= 0; at -= 1) {
      const id = matched[at]?.id;
      const own = id === undefined ? undefined : pendingMsOf?.(id);
      if (own !== undefined) return own;
    }
    return pendingMs;
  }

  function finishPending(token: number): void {
    // After destroy() no one listens, and a new timer would only outlive the navigator.
    if (token !== generation || destroyed) return;
    if (pendingTimer !== undefined) {
      clear(pendingTimer);
      pendingTimer = undefined;
    }
    if (!snapshot.pending) return;
    const remaining = pendingMinMs - (now() - pendingSince);
    const hide = (): void => publish({ ...snapshot, pending: false });
    if (remaining > 0) {
      pendingMinTimer = options.setTimeout(() => {
        pendingMinTimer = undefined;
        hide();
      }, remaining);
    } else {
      hide();
    }
  }

  /** Parses an absolute location (from history or a redirect hop). */
  function locationTarget(pathname: string, search: string, hash: string): Target {
    const canonical = canonicalizePathname(pathname, trailingSlash);
    if (canonical === undefined) return { kind: "malformed" };
    return { kind: "target", pathname: canonical, search, hash };
  }

  /**
   * Turns a navigation target into an absolute location. A leading slash means app-relative (the
   * base path is added by the matcher); anything else resolves against the current location.
   */
  function parseTarget(
    to: string,
    current: { readonly pathname: string; readonly search: string },
  ): Target {
    const normalized = normalizeNavigationText(to);
    if (normalized === undefined || !isSafeNavigationTarget(normalized)) {
      return {
        kind: "error",
        error: new TypeError(
          __DEV__ ? `unsafe navigation target: ${JSON.stringify(to)}` : "SHADOW_UNSAFE_TARGET",
        ),
      };
    }
    if (hasSchemePrefix(normalized)) {
      return {
        kind: "error",
        error: new TypeError(
          __DEV__ ? "absolute URLs are not routed; use a path" : "SHADOW_ABSOLUTE_URL",
        ),
      };
    }
    const resolved = resolveLocation(current, normalized);
    const canonical = canonicalizePathname(resolved.pathname, trailingSlash);
    if (canonical === undefined) return { kind: "malformed" };
    const pathname = normalized.startsWith("/") ? matcher.addBase(canonical) : canonical;
    return { kind: "target", pathname, search: resolved.search, hash: resolved.hash };
  }

  function currentLocation(): {
    readonly pathname: string;
    readonly search: string;
    readonly hash: string;
  } {
    return {
      pathname: history.location.pathname,
      search: history.location.search,
      hash: history.location.hash,
    };
  }

  /** Runs beforeLoad serially and the loaders in parallel for one absolute location. */
  async function attempt(
    target: { readonly pathname: string; readonly search: string; readonly hash: string },
    intent: LoadIntent,
    signal: AbortSignal,
    isCurrent: () => boolean,
    enterLoading: () => void,
  ): Promise<AttemptResult> {
    const matched = matcher.match(target.pathname);
    if (matched.length === 0) return { kind: "notFound", routeId: undefined, matches: [] };
    // The route of this target may set its own delay for the pending UI: it is known only now.
    if (intent === "navigate" && isCurrent() && !snapshot.pending) {
      armPending(generation, pendingDelayFor(matched));
    }

    let raw: SearchRecord;
    try {
      raw = parseSearch(target.search, { maxLength: maxSearchLength });
    } catch (error) {
      return { kind: "error", error };
    }

    const location: RouteLocation = {
      pathname: target.pathname,
      search: target.search,
      hash: target.hash,
    };
    const searches: unknown[] = [];
    const contexts: Readonly<Record<string, unknown>>[] = [];
    let context: Readonly<Record<string, unknown>> = baseContext;
    // A notFound from beforeLoad stops the chain at its route. The layouts above it still load (below),
    // so the not-found UI renders inside a layout that has its data.
    let stopAt = matched.length;
    let beforeNotFound:
      | { readonly routeId: string | undefined; readonly depth: number }
      | undefined;

    for (const [depth, match] of matched.entries()) {
      const route = routeById.get(match.id);
      if (route === undefined) {
        return {
          kind: "error",
          error: new Error(__DEV__ ? `no route with id "${match.id}"` : "SHADOW_NO_ROUTE"),
        };
      }
      let search: unknown = raw;
      if (route.validateSearch !== undefined) {
        try {
          search = route.validateSearch(raw);
        } catch (error) {
          if (route.onSearchError === undefined) return { kind: "error", error };
          try {
            search = route.onSearchError(error, raw);
          } catch (second) {
            return { kind: "error", error: second };
          }
        }
      }
      searches[depth] = search;
      if (route.beforeLoad !== undefined) {
        let produced: BeforeLoadResult;
        try {
          produced = await route.beforeLoad({
            params: match.params,
            search,
            context,
            location,
            intent,
            signal,
          });
        } catch (error) {
          if (!isNotFound(error)) return classify(error);
          beforeNotFound = { routeId: error.routeId ?? route.id, depth };
          stopAt = depth;
          break;
        }
        if (!isCurrent()) return { kind: "canceled" };
        if (produced !== undefined) context = mergeContext(context, produced);
      }
      contexts[depth] = context;
    }

    if (!isCurrent()) return { kind: "canceled" };

    enterLoading();
    const loads = matched.slice(0, stopAt).map(async (match, depth): Promise<LoadResult> => {
      const route = routeById.get(match.id);
      // The code of the route's UI is requested with its data. A preload is speculative: the prefetch feature decides on chunks.
      if (intent !== "preload") route?.warm?.().catch(ignore);
      const loader = route?.loader;
      if (route === undefined || loader === undefined) return { ok: true, value: undefined };
      try {
        const deps = route.loaderDeps === undefined ? undefined : route.loaderDeps(raw);
        const value = await loaderCache.load({
          routeId: route.id,
          params: match.params,
          deps,
          tags: route.tags ?? [],
          intent,
          staleReload: route.staleReload ?? "background",
          signal,
          run: (loadSignal) =>
            Promise.resolve(
              loader({
                params: match.params,
                search: searches[depth],
                context: contexts[depth] ?? baseContext,
                location,
                intent,
                signal: loadSignal,
                deps,
              }),
            ),
        });
        return { ok: true, value };
      } catch (error) {
        return { ok: false, error };
      }
    });
    const results = await Promise.all(loads);
    if (!isCurrent()) return { kind: "canceled" };

    // One matched route with the loader result it got (undefined where its loader did not succeed).
    const matchAt = (match: RouteMatch, depth: number): NavigationMatch => {
      const result = results[depth];
      return {
        id: match.id,
        pattern: match.pattern,
        params: match.params,
        loaderData: result?.ok ? result.value : undefined,
        context: contexts[depth] ?? baseContext,
        depth,
      };
    };
    // The layouts above the route that failed keep their loader data; the failed route is left out.
    const notFoundAt = (routeId: string | undefined, cut: number): AttemptResult => ({
      kind: "notFound",
      routeId,
      matches: matched.slice(0, cut).map(matchAt),
    });

    for (const result of results) {
      if (!result.ok && isRedirect(result.error)) {
        return { kind: "redirect", signal: result.error };
      }
    }
    for (const [depth, result] of results.entries()) {
      if (!result.ok && isNotFound(result.error)) {
        const routeId = matched[depth]?.id;
        return notFoundAt(result.error.routeId ?? routeId, depth);
      }
    }
    if (beforeNotFound !== undefined)
      return notFoundAt(beforeNotFound.routeId, beforeNotFound.depth);
    for (const result of results) {
      if (!result.ok) return { kind: "error", error: result.error };
    }

    const matches: NavigationMatch[] = matched.map(matchAt);
    return { kind: "ok", matches };
  }

  /** A redirect or an error thrown by `beforeLoad` (a notFound is handled by the caller). */
  function classify(error: unknown): AttemptResult {
    if (isRedirect(error)) return { kind: "redirect", signal: error };
    return { kind: "error", error };
  }

  /** Runs one navigation from a target to its outcome, following redirects. */
  function run(request: {
    readonly start: Target;
    readonly intent: LoadIntent;
    readonly writeHistory: boolean;
    readonly replace: boolean;
    readonly state: unknown;
  }): Promise<NavigationOutcome> {
    if (destroyed) return Promise.resolve({ kind: "canceled" });
    generation += 1;
    const token = generation;
    activeController?.abort();
    const controller = newController();
    activeController = controller;
    const isCurrent = (): boolean => token === generation && !controller.signal.aborted;
    beginPending(token, request.intent);
    setStatus(token, "matching");

    return (async (): Promise<NavigationOutcome> => {
      let finalOutcome: NavigationOutcome | undefined;
      try {
        let target: Target = request.start;
        // A redirect that chose `replace` decides for the rest of the navigation; one that did not leaves it alone.
        let replace = request.replace;
        let redirects = 0;
        for (;;) {
          if (target.kind === "error") {
            finalOutcome = { kind: "error", error: target.error };
            break;
          }
          if (target.kind === "malformed") {
            finalOutcome = { kind: "notFound", routeId: undefined };
            break;
          }
          setStatus(token, "beforeLoad");
          const result = await attempt(target, request.intent, controller.signal, isCurrent, () =>
            setStatus(token, "loading"),
          );
          if (!isCurrent()) {
            finalOutcome = { kind: "canceled" };
            break;
          }
          if (result.kind === "redirect") {
            redirects += 1;
            if (redirects > maxRedirects) {
              finalOutcome = {
                kind: "error",
                error: new Error(
                  __DEV__
                    ? `redirect limit of ${maxRedirects} exceeded while navigating`
                    : "SHADOW_REDIRECT_LIMIT",
                ),
              };
              break;
            }
            const { signal } = result;
            if (signal.replaceGiven) replace = signal.replace;
            target = parseTarget(signal.to, target.kind === "target" ? target : currentLocation());
            continue;
          }
          if (result.kind === "canceled") {
            finalOutcome = { kind: "canceled" };
            break;
          }
          if (result.kind === "error") {
            publish({ ...snapshot, error: result.error });
            finalOutcome = { kind: "error", error: result.error };
            break;
          }
          setStatus(token, "committing");
          const location: RouteLocation =
            target.kind === "target"
              ? { pathname: target.pathname, search: target.search, hash: target.hash }
              : currentLocation();
          if (result.kind === "notFound") {
            commit(
              token,
              request,
              location,
              replace,
              result.matches,
              new NotFoundSignal(result.routeId),
              request.state,
            );
            finalOutcome = { kind: "notFound", routeId: result.routeId };
            break;
          }
          const committed = commit(
            token,
            request,
            location,
            replace,
            result.matches,
            undefined,
            request.state,
          );
          finalOutcome = committed ? { kind: "success", location } : { kind: "blocked" };
          break;
        }
      } catch (error) {
        report(error);
        finalOutcome = { kind: "error", error };
      } finally {
        if (token === generation) {
          finishPending(token);
          if (snapshot.status !== "idle") publish({ ...snapshot, status: "idle" });
          activeController = undefined;
        }
      }
      return finalOutcome ?? { kind: "canceled" };
    })();
  }

  /** Writes the history entry (when asked) and publishes the new snapshot. Returns false if blocked. */
  function commit(
    token: number,
    request: { readonly writeHistory: boolean },
    location: RouteLocation,
    replace: boolean,
    matches: readonly NavigationMatch[],
    error: unknown,
    state: unknown,
  ): boolean {
    if (token !== generation) return false;
    if (request.writeHistory) {
      const href = `${location.pathname}${location.search}${location.hash}`;
      let written: boolean;
      selfWriting = true;
      try {
        written = replace ? history.replace(href, state) : history.push(href, state);
      } finally {
        selfWriting = false;
      }
      if (!written) return false;
    }
    publish({ status: "committing", location, matches, pending: snapshot.pending, error });
    return true;
  }

  /** Runs the location history already holds (a pop, a reload, the first render): nothing is written back. */
  const replay = (
    intent: LoadIntent,
    location: RouteLocation = history.location,
  ): Promise<NavigationOutcome> =>
    run({
      start: locationTarget(location.pathname, location.search, location.hash),
      intent,
      writeHistory: false,
      replace: false,
      state: undefined,
    });

  const unlisten = history.listen((update: HistoryUpdate) => {
    if (!(selfWriting || destroyed)) void replay("navigate", update.location);
  });

  return {
    navigate(to: string, navigateOptions: NavigateOptions = {}): Promise<NavigationOutcome> {
      return run({
        start: parseTarget(to, currentLocation()),
        intent: "navigate",
        writeHistory: true,
        replace: navigateOptions.replace ?? false,
        state: navigateOptions.state,
      });
    },

    async preload(to: string, signal?: AbortSignal): Promise<void> {
      if (destroyed || signal?.aborted) return;
      const start = parseTarget(to, currentLocation());
      if (start.kind !== "target") {
        if (start.kind === "error") report(start.error);
        return;
      }
      const controller = newController();
      preloads.add(controller);
      const onAbort = (): void => controller.abort();
      signal?.addEventListener("abort", onAbort);
      try {
        const result = await attempt(
          start,
          "preload",
          controller.signal,
          () => !controller.signal.aborted && !destroyed,
          ignore,
        );
        if (result.kind === "error") report(result.error);
      } catch (error) {
        report(error);
      } finally {
        // The caller's signal may outlive this preload (a router-wide one): it must not keep the controller.
        signal?.removeEventListener("abort", onAbort);
        preloads.delete(controller);
      }
    },

    hydrate: () => replay("hydrate"),

    reload: () => replay("reload"),

    getSnapshot(): NavigationSnapshot {
      return snapshot;
    },

    subscribe(listener: (next: NavigationSnapshot) => void): () => void {
      listeners.add(listener);
      return (): void => {
        listeners.delete(listener);
      };
    },

    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      unlisten();
      activeController?.abort();
      for (const controller of preloads) controller.abort();
      preloads.clear();
      cancelTimers();
      listeners.clear();
    },
  };
}
